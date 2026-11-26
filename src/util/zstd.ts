/**
 * zstd for the viewer protocol. Node gained zlib.zstd* in 22.15; older Node versions decompress with
 * fzstd (pure JS) and compress by wrapping the data in a valid zstd frame of raw (stored) blocks.
 */
import * as zlib from "node:zlib";
import { decompress as fzstdDecompress } from "fzstd";

type ZstdZlib = { zstdCompressSync?: (b: Buffer) => Buffer; zstdDecompressSync?: (b: Buffer) => Buffer };
// FIGMA_ZSTD_FALLBACK=1 forces the Node 20 code path (for testing on newer Node).
const native: ZstdZlib = process.env.FIGMA_ZSTD_FALLBACK === "1" ? {} : (zlib as unknown as ZstdZlib);

export function zstdDecompress(b: Uint8Array): Buffer {
  if (native.zstdDecompressSync) return native.zstdDecompressSync(Buffer.from(b));
  return Buffer.from(fzstdDecompress(b));
}

export function zstdCompress(b: Uint8Array, forceRaw = false): Buffer {
  if (native.zstdCompressSync && !forceRaw) return native.zstdCompressSync(Buffer.from(b));
  return zstdRawFrame(b);
}

const MAX_BLOCK = 128 * 1024;

/** A spec-compliant zstd frame holding the data uncompressed (Raw_Block blocks, 128 KiB window). */
export function zstdRawFrame(data: Uint8Array): Buffer {
  const parts: Buffer[] = [Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x38])]; // magic, FHD, window 2^17
  let off = 0;
  do {
    const size = Math.min(MAX_BLOCK, data.length - off);
    const last = off + size >= data.length ? 1 : 0;
    const h = last | (0 << 1) | (size << 3);
    parts.push(Buffer.from([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff]), Buffer.from(data.subarray(off, off + size)));
    off += size;
  } while (off < data.length);
  return Buffer.concat(parts);
}
