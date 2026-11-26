/**
 * Self-check: starts the built server over stdio and calls READ-ONLY tools against a Figma link.
 * Usage: npm run build && npx tsx scripts/smoke.ts "<figma link with node-id>"
 * Safe on files you can only view: nothing here writes to Figma.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const link = process.argv[2];
if (!link) throw new Error("pass a Figma link");
const out = process.env.SMOKE_OUT ?? mkdtempSync(path.join(tmpdir(), "figma-smoke-"));
mkdirSync(out, { recursive: true });
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...getDefaultEnvironment(), FIGMA_BRIDGE_PORT: "3999" } }));

const { tools } = await client.listTools();
console.log(`${tools.length} tools:`, tools.map((t) => t.name).join(", "));

const call = async (name: string, args: Record<string, unknown>) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as { type: string; text?: string; data?: string }[];
  const txt = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n=== ${name} (${Date.now() - t0} ms)${r.isError ? " ERROR" : ""}\n${txt.slice(0, Number(process.env.SMOKE_CHARS ?? 1200))}`);
  assert.ok(!r.isError, `${name} failed: ${txt}`);
  return { r, content, txt };
};

await call("figma_get_file", { url: link });
await call("figma_get_design", { url: link, depth: 3 });
await call("figma_get_metadata", { url: link, depth: 2 });
await call("figma_get_metadata", { url: link, types: ["TEXT"], limit: 20 });
await call("figma_get_code", { url: link, framework: "react-tailwind", depth: 4 });
const shot = await call("figma_get_screenshot", { url: link, scale: 1 });
const img = shot.content.find((c) => c.type === "image");
assert.ok(img?.data, "screenshot should return an image");
writeFileSync(path.join(out, "screenshot.png"), Buffer.from(img!.data!, "base64"));
await call("figma_download_assets", { url: link, dir: path.join(out, "assets") });
await call("figma_get_components", { url: link, scope: "page" });
await call("figma_get_styles", { url: link });
await call("figma_get_variables", { url: link, collection: "Colors" });
await call("figma_plugin_status", {});

const bad = await client.callTool({ name: "figma_get_design", arguments: { url: "https://example.com/nope" } });
assert.equal(bad.isError, true, "a non-Figma link should be rejected");

await client.close();
console.log(`\nSmoke test passed. Files in ${out}`);
