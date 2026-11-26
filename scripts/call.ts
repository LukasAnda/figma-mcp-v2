// Calls one tool on the built server: npx tsx scripts/call.ts <tool> '<json args>' [save-image-path]
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const [name, args, imgOut] = process.argv.slice(2);
const client = new Client({ name: "call", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...getDefaultEnvironment(), FIGMA_NO_BRIDGE: "1" }, stderr: "ignore" }));
const t0 = Date.now();
const r = await client.callTool({ name, arguments: JSON.parse(args) });
for (const c of r.content as { type: string; text?: string; data?: string }[]) {
  if (c.type === "text") console.log(c.text);
  if (c.type === "image" && imgOut) writeFileSync(imgOut, Buffer.from(c.data!, "base64"));
}
console.error(`${name}: ${Date.now() - t0} ms${r.isError ? " (ERROR)" : ""}`);
await client.close();
