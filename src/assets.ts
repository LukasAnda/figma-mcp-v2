/**
 * Rendering and asset export across sources, plus the auto-detecting asset downloader.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { bridge } from "./bridge/bridge.js";
import { download, getImageFills, renderImages, type RestNode } from "./figma/rest.js";
import { simplify, type AssetCandidate } from "./figma/simplify.js";
import type { FigmaTarget } from "./figma/url.js";
import { collectImageRefs, renderSvg, svgToPng } from "./render/svg.js";
import { loadNodes, type ConcreteSource } from "./source.js";
import { downloadWebImage } from "./web/client.js";

export type ExportFormat = "png" | "jpg" | "svg" | "pdf";

const MAX_PIXELS = Number(process.env.FIGMA_MAX_RENDER_PIXELS ?? 4096 * 4096);

function extFromType(ct: string): string {
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("svg")) return "svg";
  return "bin";
}

function sniffExt(b: Buffer): string {
  if (b[0] === 0x89 && b[1] === 0x50) return "png";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpg";
  if (b.subarray(0, 3).toString() === "GIF") return "gif";
  if (b.subarray(8, 12).toString() === "WEBP") return "webp";
  return "bin";
}

/** Image fill bytes by imageRef (hash). */
export async function fetchImageFill(source: ConcreteSource, target: FigmaTarget, imageRef: string, signal?: AbortSignal): Promise<{ bytes: Buffer; ext: string }> {
  if (source === "web") {
    const r = await downloadWebImage(target.fileKey, imageRef, signal);
    return { bytes: r.bytes, ext: extFromType(r.contentType) === "bin" ? sniffExt(r.bytes) : extFromType(r.contentType) };
  }
  if (source === "rest") {
    const fills = await getImageFills(target.fileKey, signal);
    const url = fills[imageRef];
    if (!url) throw new Error(`Image ${imageRef} is not in this file's image fills.`);
    const bytes = await download(url, signal);
    return { bytes, ext: sniffExt(bytes) };
  }
  const r = await bridge.request<{ base64: string }>("get_image_bytes", { hash: imageRef }, { fileKey: target.fileKey, timeoutMs: 60_000 });
  const bytes = Buffer.from(r.base64, "base64");
  return { bytes, ext: sniffExt(bytes) };
}

/** Embeds every image fill used in the subtree as data URIs, for the local renderer. */
async function imagesFor(source: ConcreteSource, target: FigmaTarget, node: RestNode, signal?: AbortSignal): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const ref of collectImageRefs(node)) {
    try {
      const img = await fetchImageFill(source, target, ref, signal);
      const mime = img.ext === "jpg" ? "image/jpeg" : `image/${img.ext}`;
      out[ref] = `data:${mime};base64,${img.bytes.toString("base64")}`;
    } catch {
      /* leave placeholder */
    }
  }
  return out;
}

export interface Rendered {
  bytes: Buffer;
  format: ExportFormat;
  width?: number;
  height?: number;
  /** How it was rendered, e.g. "figma-server" or "local". */
  renderer: string;
}

/**
 * Renders nodes in one format. Web source renders locally from geometry (svg, png);
 * REST uses Figma's render endpoint; the plugin uses exportAsync.
 */
export async function renderNodes(
  source: ConcreteSource,
  target: FigmaTarget,
  nodeIds: string[],
  format: ExportFormat,
  scale: number,
  signal?: AbortSignal,
  preloaded?: Map<string, RestNode>
): Promise<Map<string, Rendered>> {
  const out = new Map<string, Rendered>();
  if (source === "rest") {
    const urls = await renderImages(target.fileKey, nodeIds, { format, scale }, signal);
    for (const id of nodeIds) {
      const url = urls[id];
      if (!url) throw new Error(`Figma could not render node ${id} (it may be invisible or empty).`);
      out.set(id, { bytes: await download(url, signal), format, renderer: "figma-server" });
    }
    return out;
  }
  if (source === "plugin") {
    for (const id of nodeIds) {
      const r = await bridge.request<{ base64: string; width?: number; height?: number }>(
        "export_node",
        { nodeId: id, format: format.toUpperCase(), scale },
        { fileKey: target.fileKey, timeoutMs: 120_000 }
      );
      out.set(id, { bytes: Buffer.from(r.base64, "base64"), format, width: r.width, height: r.height, renderer: "figma-plugin" });
    }
    return out;
  }
  // web
  if (format === "pdf" || format === "jpg") {
    throw new Error(`The web source renders svg and png only. For ${format}, set FIGMA_TOKEN (REST) or connect the plugin, or use png.`);
  }
  const missing = nodeIds.filter((id) => !preloaded?.has(id));
  const loaded = missing.length ? await loadNodes("web", target, missing) : undefined;
  for (const id of nodeIds) {
    const node = preloaded?.get(id) ?? loaded!.roots[missing.indexOf(id)];
    const images = await imagesFor("web", target, node, signal);
    const { svg, width, height } = renderSvg(node, { images });
    if (format === "svg") {
      out.set(id, { bytes: Buffer.from(svg), format, width, height, renderer: "local" });
    } else {
      let s = scale;
      while (width * s * height * s > MAX_PIXELS && s > 0.1) s /= 2;
      out.set(id, { bytes: await svgToPng(svg, s), format, width: Math.round(width * s), height: Math.round(height * s), renderer: "local" });
    }
  }
  return out;
}

// ---------- Asset downloader ----------

export interface AssetRequest {
  nodeId: string;
  format: ExportFormat;
  scale?: number;
  fileName?: string;
}

export interface SavedAsset {
  nodeId: string;
  name: string;
  file: string;
  format: string;
  bytes: number;
  kind: "vector" | "image-fill" | "render";
  width?: number;
  height?: number;
  duplicateOf?: string;
}

const safeName = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 80) || "asset";

export async function downloadAssets(opts: {
  source: ConcreteSource;
  target: FigmaTarget;
  rootIds: string[];
  dir: string;
  explicit?: AssetRequest[];
  autoDetect: boolean;
  includeImageFills: boolean;
  pngScale: number;
  signal?: AbortSignal;
}): Promise<{ dir: string; assets: SavedAsset[]; skipped: { nodeId: string; reason: string }[] }> {
  const { source, target } = opts;
  await mkdir(opts.dir, { recursive: true });
  const used = new Set<string>();
  const byHash = new Map<string, string>();
  const assets: SavedAsset[] = [];
  const skipped: { nodeId: string; reason: string }[] = [];

  const save = async (name: string, ext: string, bytes: Buffer, meta: Omit<SavedAsset, "file" | "bytes" | "format">) => {
    const hash = createHash("sha1").update(bytes).digest("hex");
    const dup = byHash.get(hash);
    if (dup) {
      assets.push({ ...meta, file: dup, format: ext, bytes: bytes.length, duplicateOf: dup });
      return;
    }
    let base = safeName(name);
    let file = `${base}.${ext}`;
    for (let i = 2; used.has(file); i++) file = `${base}-${i}.${ext}`;
    used.add(file);
    await writeFile(path.join(opts.dir, file), bytes);
    byHash.set(hash, file);
    assets.push({ ...meta, file, format: ext, bytes: bytes.length });
  };

  // Find candidates.
  let candidates: AssetCandidate[] = [];
  const nodesById = new Map<string, RestNode>();
  if (opts.autoDetect && opts.rootIds.length) {
    const loaded = await loadNodes(source, target, opts.rootIds, undefined, opts.signal);
    const index = (n: RestNode) => {
      nodesById.set(n.id, n);
      for (const c of n.children ?? []) index(c);
    };
    loaded.roots.forEach(index);
    candidates = simplify(loaded.roots, loaded.ctx).assets;
  }

  // Vectors -> SVG
  const svgIds = [...new Set(candidates.filter((c) => c.format === "svg").map((c) => c.nodeId))];
  if (svgIds.length) {
    try {
      const rendered = await renderNodes(source, target, svgIds, "svg", 1, opts.signal, nodesById);
      for (const id of svgIds) {
        const r = rendered.get(id);
        const c = candidates.find((x) => x.nodeId === id)!;
        if (r) await save(c.name, "svg", r.bytes, { nodeId: id, name: c.name, kind: "vector", width: r.width, height: r.height });
      }
    } catch (e) {
      for (const id of svgIds) skipped.push({ nodeId: id, reason: (e as Error).message });
    }
  }

  // Image fills -> original image bytes
  if (opts.includeImageFills) {
    const seen = new Set<string>();
    for (const c of candidates.filter((x) => x.imageRef)) {
      if (seen.has(c.imageRef!)) continue;
      seen.add(c.imageRef!);
      try {
        const img = await fetchImageFill(source, target, c.imageRef!, opts.signal);
        await save(c.name, img.ext, img.bytes, { nodeId: c.nodeId, name: c.name, kind: "image-fill" });
      } catch (e) {
        skipped.push({ nodeId: c.nodeId, reason: (e as Error).message });
      }
    }
  }

  // Explicit renders
  for (const req of opts.explicit ?? []) {
    try {
      const r = (await renderNodes(source, target, [req.nodeId], req.format, req.scale ?? opts.pngScale, opts.signal, nodesById)).get(req.nodeId)!;
      const name = req.fileName ?? nodesById.get(req.nodeId)?.name ?? req.nodeId;
      await save(name.replace(/\.(png|jpg|svg|pdf)$/i, ""), req.format, r.bytes, { nodeId: req.nodeId, name, kind: "render", width: r.width, height: r.height });
    } catch (e) {
      skipped.push({ nodeId: req.nodeId, reason: (e as Error).message });
    }
  }

  return { dir: opts.dir, assets, skipped };
}
