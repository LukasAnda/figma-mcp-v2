import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseFigmaUrl, normalizeNodeId } from "../src/figma/url.js";

test("design link with node-id", () => {
  const t = parseFigmaUrl("https://www.figma.com/design/Xy7pQrStUvWxYz0123AbCd/Shop-App?node-id=12-345&t=abc-4");
  assert.equal(t.fileKey, "Xy7pQrStUvWxYz0123AbCd");
  assert.equal(t.nodeId, "12:345");
  assert.equal(t.kind, "design");
  assert.equal(t.fileName, "Shop App");
});

test("legacy file link with encoded colon", () => {
  const t = parseFigmaUrl("https://figma.com/file/abcDEF1234567/Name?node-id=12%3A34");
  assert.equal(t.fileKey, "abcDEF1234567");
  assert.equal(t.nodeId, "12:34");
});

test("branch link uses the branch key", () => {
  const t = parseFigmaUrl("https://www.figma.com/design/MAINKEY1234567/branch/BRANCHKEY12345/Name?node-id=1-2");
  assert.equal(t.fileKey, "BRANCHKEY12345");
  assert.equal(t.mainFileKey, "MAINKEY1234567");
});

test("bare key and override", () => {
  const t = parseFigmaUrl("Xy7pQrStUvWxYz0123AbCd", "1-2");
  assert.equal(t.fileKey, "Xy7pQrStUvWxYz0123AbCd");
  assert.equal(t.nodeId, "1:2");
});

test("instance sublayer ids keep their form", () => {
  assert.equal(normalizeNodeId("I1:2;3:4"), "I1:2;3:4");
});

test("rejects non-figma hosts", () => {
  assert.throws(() => parseFigmaUrl("https://example.com/design/abc/x"), /not figma\.com/);
});
