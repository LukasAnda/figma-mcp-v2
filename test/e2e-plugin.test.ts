// MCP client -> server (stdio) -> bridge -> fake plugin. No real Figma file is touched.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const PORT = String(4100 + Math.floor(Math.random() * 90));

test("write tools reach the plugin with the right command and params", async () => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], env: { ...getDefaultEnvironment(), FIGMA_BRIDGE_PORT: PORT } }));
  await new Promise((r) => setTimeout(r, 1500));

  const received: { command: string; params: Record<string, unknown> }[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { Origin: "null" } });
  await new Promise<void>((res, rej) => {
    ws.on("open", () => res());
    ws.on("error", rej);
  });
  ws.send(JSON.stringify({ type: "hello", role: "plugin", info: { fileKey: "TESTFILEKEY123", fileName: "Test" } }));
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type !== "request") return;
    received.push({ command: m.command, params: m.params });
    ws.send(JSON.stringify({ type: "response", id: m.id, ok: true, result: { id: "99:1", echo: m.command } }));
  });
  await new Promise((r) => setTimeout(r, 200));

  const status = await client.callTool({ name: "figma_plugin_status", arguments: {} });
  assert.match((status.content as { text: string }[])[0].text, /TESTFILEKEY123/);

  const url = "https://www.figma.com/design/TESTFILEKEY123/Test?node-id=1-2";
  const created = await client.callTool({
    name: "figma_create_node",
    arguments: { url, type: "FRAME", parent_id: "1-2", name: "Card", width: 320, height: 200, props: { layoutMode: "VERTICAL", itemSpacing: 8, fills: "#FFFFFF" } }
  });
  assert.ok(!created.isError, JSON.stringify(created.content));
  assert.deepEqual(received.at(-1), {
    command: "create_node",
    params: { type: "FRAME", parentId: "1:2", name: "Card", width: 320, height: 200, props: { layoutMode: "VERTICAL", itemSpacing: 8, fills: "#FFFFFF" } }
  });

  await client.callTool({ name: "figma_set_instance_properties", arguments: { url, node_id: "5-6", properties: { Size: "Large" } } });
  assert.equal(received.at(-1)!.command, "set_instance_properties");
  assert.equal(received.at(-1)!.params.nodeId, "5:6");

  await client.callTool({ name: "figma_execute", arguments: { url, code: "return 1", params: { a: 1 } } });
  assert.deepEqual(received.at(-1), { command: "execute", params: { code: "return 1", params: { a: 1 } } });

  // Plugin-sourced reads use export_rest_json.
  ws.removeAllListeners("message");
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type !== "request") return;
    received.push({ command: m.command, params: m.params });
    const doc = { id: "1:2", name: "Card", type: "FRAME", layoutMode: "VERTICAL", itemSpacing: 8, absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 200 }, fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }], children: [{ id: "1:3", name: "Title", type: "TEXT", characters: "Hello", style: { fontFamily: "Inter", fontSize: 16, fontWeight: 600 }, absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 }, fills: [] }] };
    ws.send(JSON.stringify({ type: "response", id: m.id, ok: true, result: { nodes: [{ document: doc, components: {}, styles: {} }], fileName: "Test" } }));
  });
  const design = await client.callTool({ name: "figma_get_design", arguments: { url, source: "plugin" } });
  const txt = (design.content as { text: string }[])[0].text;
  assert.ok(!design.isError, txt);
  assert.match(txt, /source: plugin/);
  assert.match(txt, /flex column; gap 8px/);
  assert.match(txt, /text: Hello/);

  // Calls for a file the plugin is not open in are refused with guidance.
  const wrong = await client.callTool({ name: "figma_get_selection", arguments: { url: "https://www.figma.com/design/OTHERFILEKEY99/x" } });
  assert.equal(wrong.isError, true);

  ws.close();
  await client.close();
});
