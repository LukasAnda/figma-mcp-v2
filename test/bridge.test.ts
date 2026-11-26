import { test } from "node:test";
import { strict as assert } from "node:assert";
import { WebSocket } from "ws";
import { Bridge } from "../src/bridge/bridge.js";

const PORT = 3900 + Math.floor(Math.random() * 90);

function fakePlugin(fileKey: string, fileName: string, origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, origin ? { headers: { Origin: origin } } : {});
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", role: "plugin", info: { fileKey, fileName } }));
      setTimeout(() => resolve(ws), 50);
    });
    ws.on("error", reject);
    ws.on("unexpected-response", (_q, r) => reject(new Error(`HTTP ${r.statusCode}`)));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type !== "request") return;
      if (m.command === "fail") ws.send(JSON.stringify({ type: "response", id: m.id, ok: false, error: "boom" }));
      else ws.send(JSON.stringify({ type: "response", id: m.id, ok: true, result: { file: fileName, command: m.command, params: m.params } }));
    });
  });
}

test("hub routes by file key, relays from a second process, rejects web origins", async () => {
  const hub = new Bridge(PORT);
  await hub.start();
  assert.equal(hub.role, "hub");

  const a = await fakePlugin("FILEAAAAAAAAAA", "A");
  const b = await fakePlugin("FILEBBBBBBBBBB", "B");
  assert.equal(hub.listPlugins().length, 2);

  const ra = await hub.request<{ file: string }>("get_selection", { x: 1 }, { fileKey: "FILEAAAAAAAAAA" });
  assert.equal(ra.file, "A");
  const rb = await hub.request<{ file: string }>("get_selection", {}, { fileKey: "FILEBBBBBBBBBB" });
  assert.equal(rb.file, "B");

  await assert.rejects(hub.request("get_selection", {}), /connected in 2 files/);
  await assert.rejects(hub.request("get_selection", {}, { fileKey: "OTHERKEY123456" }), /not running in file OTHERKEY123456/);
  await assert.rejects(hub.request("fail", {}, { fileKey: "FILEAAAAAAAAAA" }), /boom/);

  // A second MCP process becomes a relay client.
  const relay = new Bridge(PORT);
  await relay.start();
  assert.equal(relay.role, "client");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(relay.listPlugins().length, 2);
  const rr = await relay.request<{ file: string; params: { y: number } }>("get_selection", { y: 2 }, { fileKey: "FILEBBBBBBBBBB" });
  assert.equal(rr.file, "B");
  assert.equal(rr.params.y, 2);

  // Arbitrary websites must not be able to drive the plugin.
  await assert.rejects(fakePlugin("X", "evil", "https://evil.example"), /HTTP 401|Unexpected server response|HTTP 403/);

  // Hub goes away: relay takes over as hub.
  a.close();
  b.close();
  hub.stop();
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(relay.role, "hub");
  relay.stop();
});
