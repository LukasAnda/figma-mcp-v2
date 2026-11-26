// Runs plugin/code.js in a VM with a minimal mocked `figma` global.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function mockFigma() {
  let nextId = 100;
  const nodes = new Map<string, Record<string, unknown>>();
  const make = (type: string) => {
    const n: Record<string, unknown> & { children: unknown[] } = {
      id: `1:${nextId++}`, type, name: type, x: 0, y: 0, width: 100, height: 100, children: [], parent: null as unknown,
      resize(w: number, h: number) { n.width = w; n.height = h; },
      appendChild(c: Record<string, unknown>) { n.children.push(c); c.parent = n; },
      insertChild(i: number, c: Record<string, unknown>) { n.children.splice(i, 0, c); c.parent = n; },
      remove() { nodes.delete(n.id as string); }
    };
    nodes.set(n.id as string, n);
    return n;
  };
  const page = make("PAGE");
  const posted: { type: string; ok?: boolean; result?: unknown; error?: string }[] = [];
  const figma: Record<string, unknown> = {
    showUI() {}, on() {}, notify() {},
    ui: { postMessage: (m: never) => posted.push(m), onmessage: null as unknown },
    root: { name: "Mock file" }, currentPage: page, fileKey: "MOCKKEY", editorType: "figma", currentUser: { name: "Dev" },
    mixed: Symbol("mixed"),
    getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
    createFrame: () => make("FRAME"), createRectangle: () => make("RECTANGLE"),
    createText: () => Object.assign(make("TEXT"), { fontName: { family: "Inter", style: "Regular" }, characters: "" }),
    loadFontAsync: async () => {}
  };
  return { figma, posted, page, nodes };
}

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

async function send(ctx: ReturnType<typeof mockFigma>, command: string, params: unknown) {
  const before = ctx.posted.length;
  await (ctx.figma.ui as { onmessage: (m: unknown) => Promise<void> }).onmessage({ type: "request", id: "r", command, params });
  return ctx.posted.slice(before).find((m) => m.type === "response")!;
}

test("plugin commands run against the Plugin API", async () => {
  const ctx = mockFigma();
  vm.runInNewContext(readFileSync("plugin/code.js", "utf8"), { figma: ctx.figma, __html__: "", console, JSON, Object, Promise, Symbol, Array, String, Number, Math, parseInt, parseFloat });
  assert.equal(ctx.posted[0].type, "info");

  const created = await send(ctx, "create_node", { type: "FRAME", name: "Card", width: 320, height: 200, props: { fills: "#FF000080", padding: [16, 24], layoutMode: "VERTICAL", itemSpacing: 8 } });
  assert.ok(created.ok, created.error);
  const id = (created.result as { id: string }).id;
  const node = ctx.nodes.get(id)!;
  assert.equal(node.width, 320);
  assert.deepEqual(plain(node.fills), [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 128 / 255 }]);
  assert.equal(node.paddingLeft, 24);
  assert.equal(node.paddingTop, 16);
  assert.equal(node.layoutMode, "VERTICAL");
  assert.equal(node.itemSpacing, 8);

  const text = await send(ctx, "create_node", { type: "TEXT", parentId: id, props: { characters: "Hello", fontSize: 18 } });
  assert.ok(text.ok, text.error);
  const t = ctx.nodes.get((text.result as { id: string }).id)!;
  assert.equal(t.characters, "Hello");
  assert.equal((t.parent as { id: string }).id, id);

  const upd = await send(ctx, "update_node", { nodeId: id.replace(":", "-"), props: { name: "Card v2", strokes: "rgba(0,0,255,0.5)" } });
  assert.ok(upd.ok, upd.error);
  assert.equal(node.name, "Card v2");
  assert.deepEqual(plain(node.strokes), [{ type: "SOLID", color: { r: 0, g: 0, b: 1 }, opacity: 0.5 }]);

  const exec = await send(ctx, "execute", { code: "const n = await helpers.getNode(params.id); return { name: n.name, kids: n.children.length };", params: { id } });
  assert.ok(exec.ok, exec.error);
  assert.deepEqual(plain(exec.result), { name: "Card v2", kids: 1 });

  const bad = await send(ctx, "update_node", { nodeId: "9:9", props: {} });
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /not found/);

  const unknown = await send(ctx, "no_such_command", {});
  assert.match(unknown.error!, /Unknown command/);
});
