import { test } from "node:test";
import { strict as assert } from "node:assert";
import { blobToPath, invert, mul } from "../src/web/convert.js";

function blob(cmds: (number | number[])[]): Uint8Array {
  const parts: number[] = [];
  const buf: Buffer[] = [];
  for (const c of cmds) {
    if (typeof c === "number") buf.push(Buffer.from([c]));
    else for (const f of c) { const b = Buffer.alloc(4); b.writeFloatLE(f); buf.push(b); }
  }
  void parts;
  return new Uint8Array(Buffer.concat(buf));
}

test("decodes move/line/cubic/close", () => {
  const p = blobToPath(blob([1, [0, 0], 2, [10, 0], 4, [10, 5, 5, 10, 0, 10], 0]));
  assert.equal(p, "M0 0L10 0C10 5 5 10 0 10Z");
});

test("glyph paths flip y and scale", () => {
  assert.equal(blobToPath(blob([1, [0.5, 0.25]]), 20, 100, 50, true), "M110 45");
});

test("matrix inverse round-trips", () => {
  const m = { m00: 2, m01: 0.5, m02: 10, m10: -0.3, m11: 1.5, m12: 4 };
  const id = mul(m, invert(m));
  assert.ok(Math.abs(id.m00 - 1) < 1e-9 && Math.abs(id.m11 - 1) < 1e-9 && Math.abs(id.m02) < 1e-9 && Math.abs(id.m01) < 1e-9);
});
