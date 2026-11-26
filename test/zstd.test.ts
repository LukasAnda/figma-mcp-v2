import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as zlib from "node:zlib";
import { decompress } from "fzstd";
import { zstdRawFrame, zstdDecompress } from "../src/util/zstd.js";

const native = zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer; zstdDecompressSync?: (b: Buffer) => Buffer };
const sample = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 31) % 251));

test("raw zstd frames decode with fzstd (and native zstd where available)", () => {
  for (const data of [Buffer.alloc(0), Buffer.from("hello"), sample]) {
    const frame = zstdRawFrame(data);
    assert.deepEqual(Buffer.from(decompress(frame)), data);
    if (native.zstdDecompressSync) assert.deepEqual(native.zstdDecompressSync(frame), data);
  }
});

test("decompress handles real compressed frames", { skip: !native.zstdCompressSync }, () => {
  const c = native.zstdCompressSync!(sample);
  assert.deepEqual(zstdDecompress(c), sample);
  assert.deepEqual(Buffer.from(decompress(c)), sample);
});
