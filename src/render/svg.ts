/**
 * Renders a converted node subtree to SVG using the vector geometry Figma stores in the file
 * (fill/stroke outlines and text glyph outlines), and to PNG through resvg. This is how
 * screenshots and vector exports work without the REST API's render endpoint.
 *
 * Fidelity: fills (solid, gradients, images), strokes, corner clipping, opacity, masks, drop
 * and inner shadows (approximate), layer blur. Not covered: blend modes, background blur,
 * angular/diamond gradients (approximated), and text with missing glyph data (falls back to
 * <text> with the font family named in the design).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RestNode } from "../figma/rest.js";
import { invert, mul, type Matrix } from "../web/convert.js";

type Color = { r: number; g: number; b: number; a: number };
type Paint = {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: Color;
  gradientStops?: { position: number; color: Color }[];
  gradientHandlePositions?: { x: number; y: number }[];
  imageRef?: string;
  scaleMode?: string;
};

const IDENTITY: Matrix = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n3 = (v: number) => +v.toFixed(3);
const rgb = (c: Color) => `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
const mat = (m: Matrix) => `matrix(${n3(m.m00)} ${n3(m.m10)} ${n3(m.m01)} ${n3(m.m11)} ${n3(m.m02)} ${n3(m.m12)})`;

/** True when a path encloses no area (all points on one horizontal or vertical line). Such paths
 * paint nothing, and as the only content of a clipped/filtered/translucent group they crash resvg. */
export function isDegeneratePath(d: string): boolean {
  if (!d) return true;
  if (/[Aa]/.test(d)) return false; // our own rect/ellipse paths, only emitted with positive size
  const nums = d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) ?? [];
  if (nums.length < 4) return true;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    minX = Math.min(minX, nums[i]);
    maxX = Math.max(maxX, nums[i]);
    minY = Math.min(minY, nums[i + 1]);
    maxY = Math.max(maxY, nums[i + 1]);
  }
  return !(maxX - minX > 1e-3 && maxY - minY > 1e-3) || !Number.isFinite(minX + maxX + minY + maxY);
}

function nodeMatrix(n: RestNode): Matrix {
  if (n._abs) return n._abs as Matrix;
  // REST nodes: no absolute transform; fall back to the bounding box origin (ignores rotation).
  const bb = n.absoluteBoundingBox as { x: number; y: number } | undefined;
  return bb ? { ...IDENTITY, m02: bb.x, m12: bb.y } : IDENTITY;
}

export interface RenderOptions {
  /** imageRef -> data: URI */
  images?: Record<string, string>;
  /** Draw the root's own background/fills (default true). */
  includeRootBackground?: boolean;
}

/** Every image fill hash used in the subtree, so the caller can fetch them before rendering. */
export function collectImageRefs(n: RestNode, out = new Set<string>()): Set<string> {
  if (n.visible === false) return out;
  for (const p of ((n.fills as Paint[] | undefined) ?? []).concat((n.strokes as Paint[] | undefined) ?? [])) if (p.type === "IMAGE" && p.imageRef && p.visible !== false) out.add(p.imageRef);
  for (const c of n.children ?? []) collectImageRefs(c, out);
  return out;
}

export function renderSvg(root: RestNode, opts: RenderOptions = {}): { svg: string; width: number; height: number } {
  const size = (root.size as { x: number; y: number } | undefined) ?? {
    x: (root.absoluteBoundingBox as { width: number } | undefined)?.width ?? 100,
    y: (root.absoluteBoundingBox as { height: number } | undefined)?.height ?? 100
  };
  const rootInv = invert(nodeMatrix(root));
  const defs: string[] = [];
  let uid = 0;
  // Ids are namespaced per node so several exported SVGs can be inlined into one page without clashing.
  const ns = String(root.id).replace(/[^\w]+/g, "_");
  const id = (p: string) => `${p}${ns}_${++uid}`;

  const paintRef = (p: Paint, m: Matrix, w: number, h: number): { fill: string; opacity: number } | undefined => {
    if (p.visible === false) return undefined;
    const op = p.opacity ?? 1;
    if (p.type === "SOLID" && p.color) return { fill: rgb(p.color), opacity: op * (p.color.a ?? 1) };
    if (p.type.startsWith("GRADIENT") && p.gradientStops) {
      const gid = id("g");
      const stops = p.gradientStops.map((s) => `<stop offset="${n3(s.position)}" stop-color="${rgb(s.color)}" stop-opacity="${n3(s.color.a ?? 1)}"/>`).join("");
      const hp = p.gradientHandlePositions ?? [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }];
      if (p.type === "GRADIENT_LINEAR") {
        defs.push(`<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${n3(hp[0].x * w)}" y1="${n3(hp[0].y * h)}" x2="${n3(hp[1].x * w)}" y2="${n3(hp[1].y * h)}">${stops}</linearGradient>`);
      } else {
        const cx = hp[0].x * w;
        const cy = hp[0].y * h;
        const rx = Math.hypot((hp[1].x - hp[0].x) * w, (hp[1].y - hp[0].y) * h);
        const ry = Math.hypot((hp[2].x - hp[0].x) * w, (hp[2].y - hp[0].y) * h);
        const angle = (Math.atan2((hp[1].y - hp[0].y) * h, (hp[1].x - hp[0].x) * w) * 180) / Math.PI;
        defs.push(
          `<radialGradient id="${gid}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(${n3(cx)} ${n3(cy)}) rotate(${n3(angle)}) scale(${n3(rx || 1)} ${n3(ry || 1)})">${stops}</radialGradient>`
        );
      }
      return { fill: `url(#${gid})`, opacity: op };
    }
    if (p.type === "IMAGE" && p.imageRef) {
      const href = opts.images?.[p.imageRef];
      if (!href) return { fill: "rgb(200,200,200)", opacity: op };
      const pid = id("p");
      const par = p.scaleMode === "FIT" ? "xMidYMid meet" : p.scaleMode === "CROP" || p.scaleMode === "STRETCH" ? "none" : "xMidYMid slice";
      defs.push(
        `<pattern id="${pid}" patternUnits="userSpaceOnUse" width="${n3(w)}" height="${n3(h)}"><image href="${href}" width="${n3(w)}" height="${n3(h)}" preserveAspectRatio="${par}"/></pattern>`
      );
      return { fill: `url(#${pid})`, opacity: op };
    }
    return undefined;
  };

  const rectPath = (n: RestNode, w: number, h: number): string => {
    const radii = (n.rectangleCornerRadii as number[] | undefined) ?? (typeof n.cornerRadius === "number" ? [n.cornerRadius, n.cornerRadius, n.cornerRadius, n.cornerRadius] : [0, 0, 0, 0]);
    const [tl, tr, br, bl] = radii.map((r) => Math.min(r, w / 2, h / 2));
    if (n.type === "ELLIPSE") return `M${w / 2} 0A${w / 2} ${h / 2} 0 1 1 ${w / 2} ${h}A${w / 2} ${h / 2} 0 1 1 ${w / 2} 0Z`;
    return `M${tl} 0H${w - tr}${tr ? `A${tr} ${tr} 0 0 1 ${w} ${tr}` : ""}V${h - br}${br ? `A${br} ${br} 0 0 1 ${w - br} ${h}` : ""}H${bl}${bl ? `A${bl} ${bl} 0 0 1 0 ${h - bl}` : ""}V${tl}${tl ? `A${tl} ${tl} 0 0 1 ${tl} 0` : ""}Z`;
  };

  const effectsFilter = (n: RestNode): string | undefined => {
    const effects = ((n.effects as { type: string; visible?: boolean; radius: number; spread?: number; color?: Color; offset?: { x: number; y: number } }[] | undefined) ?? []).filter(
      (e) => e.visible !== false
    );
    if (!effects.length) return undefined;
    const parts: string[] = [];
    const merge: string[] = [];
    let i = 0;
    for (const e of effects) {
      if (e.type === "DROP_SHADOW") {
        const r = `s${i++}`;
        parts.push(
          `<feGaussianBlur in="SourceAlpha" stdDeviation="${n3(e.radius / 2)}"/><feOffset dx="${n3(e.offset?.x ?? 0)}" dy="${n3(e.offset?.y ?? 0)}" result="o${r}"/><feFlood flood-color="${rgb(e.color ?? { r: 0, g: 0, b: 0, a: 1 })}" flood-opacity="${n3(e.color?.a ?? 1)}"/><feComposite in2="o${r}" operator="in" result="${r}"/>`
        );
        merge.push(r);
      }
    }
    const blur = effects.find((e) => e.type === "LAYER_BLUR");
    const fid = id("f");
    const src = blur ? `<feGaussianBlur in="SourceGraphic" stdDeviation="${n3(blur.radius / 2)}" result="src"/>` : "";
    if (!merge.length && !blur) return undefined;
    defs.push(
      // User-space region: objectBoundingBox units break on zero-height content (lines), which crashes resvg.
      `<filter id="${fid}" filterUnits="userSpaceOnUse" x="${-size.x}" y="${-size.y}" width="${size.x * 3}" height="${size.y * 3}" color-interpolation-filters="sRGB">${parts.join("")}${src}<feMerge>${merge.map((m) => `<feMergeNode in="${m}"/>`).join("")}<feMergeNode in="${blur ? "src" : "SourceGraphic"}"/></feMerge></filter>`
    );
    return fid;
  };

  const draw = (n: RestNode, isRoot: boolean): string => {
    if (n.visible === false) return "";
    if (n.type === "DOCUMENT" || n.type === "CANVAS") return (n.children ?? []).map((c) => draw(c, false)).join("");
    const local = mul(rootInv, nodeMatrix(n));
    const sz = (n.size as { x: number; y: number } | undefined) ?? { x: (n.absoluteBoundingBox as { width: number })?.width ?? 0, y: (n.absoluteBoundingBox as { height: number })?.height ?? 0 };
    const w = sz.x;
    const h = sz.y;
    // Cull layers entirely outside the exported area (e.g. cards scrolled out of a clipped frame).
    // They are invisible, and a filtered/clipped layer whose content lies off-canvas crashes resvg.
    let dropFilter = false;
    if (!isRoot) {
      const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => ({ x: local.m00 * x + local.m01 * y + local.m02, y: local.m10 * x + local.m11 * y + local.m12 }));
      const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
      const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
      const outside = maxX <= 0 || maxY <= 0 || minX >= size.x || minY >= size.y;
      if (outside) {
        const overflowingKids = (n.children ?? []).length > 0 && !n.clipsContent;
        if (!overflowingKids) return "";
        dropFilter = true;
      }
    }
    const body: string[] = [];
    const t = mat(local);

    // Fills
    if (!(isRoot && opts.includeRootBackground === false)) {
      const fills = (n.fills as Paint[] | undefined) ?? [];
      const geo = ((n.fillGeometry as { path: string; windingRule?: string }[] | undefined) ?? []).filter((g) => !isDegeneratePath(g.path));
      if (n.type === "TEXT") {
        const glyphs = n._glyphPath as string | undefined;
        for (const p of fills) {
          const pr = paintRef(p, local, w, h);
          if (!pr) continue;
          if (glyphs && !isDegeneratePath(glyphs)) body.push(`<path transform="${t}" d="${glyphs}" fill="${pr.fill}" fill-opacity="${n3(pr.opacity)}"/>`);
          else if (!glyphs) {
            const st = (n.style as { fontFamily?: string; fontSize?: number; fontWeight?: number } | undefined) ?? {};
            body.push(
              `<text transform="${t}" y="${n3(st.fontSize ?? 12)}" font-family="${esc(st.fontFamily ?? "sans-serif")}" font-size="${st.fontSize ?? 12}" font-weight="${st.fontWeight ?? 400}" fill="${pr.fill}" fill-opacity="${n3(pr.opacity)}">${esc(String(n.characters ?? ""))}</text>`
            );
          }
        }
      } else {
        const hadGeometry = ((n.fillGeometry as unknown[] | undefined) ?? []).length > 0;
        const paths = geo.length ? geo : !hadGeometry && fills.length && w > 0.001 && h > 0.001 ? [{ path: rectPath(n, w, h), windingRule: "NONZERO" }] : [];
        for (const p of fills) {
          const pr = paintRef(p, local, w, h);
          if (!pr) continue;
          for (const g of paths) {
            body.push(`<path transform="${t}" d="${g.path}" fill="${pr.fill}" fill-opacity="${n3(pr.opacity)}"${g.windingRule === "EVENODD" ? ' fill-rule="evenodd"' : ""}/>`);
          }
        }
      }
    }

    // Children (clipped if the frame clips content)
    const kids = n.children ?? [];
    if (kids.length) {
      let childSvg = "";
      let maskId: string | undefined;
      for (const c of kids) {
        if (c.isMask && c.visible !== false) {
          // A mask clips the siblings above it.
          maskId = id("m");
          const cl = mul(rootInv, nodeMatrix(c));
          const csz = (c.size as { x: number; y: number }) ?? { x: 0, y: 0 };
          const cg = ((c.fillGeometry as { path: string }[] | undefined) ?? []).map((g) => g.path).filter((p) => !isDegeneratePath(p)).join("") || (csz.x > 0.001 && csz.y > 0.001 ? rectPath(c, csz.x, csz.y) : "M0 0H0.01V0.01H0Z");
          defs.push(`<clipPath id="${maskId}"><path transform="${mat(cl)}" d="${cg}"/></clipPath>`);
          continue;
        }
        const s = draw(c, false);
        if (s) childSvg += maskId ? `<g clip-path="url(#${maskId})">${s}</g>` : s;
      }
      if (!childSvg) {
        // nothing visible inside
      } else if (n.clipsContent && w > 0.001 && h > 0.001 && !isRoot) {
        const cid = id("c");
        defs.push(`<clipPath id="${cid}"><path transform="${t}" d="${rectPath(n, w, h)}"/></clipPath>`);
        body.push(`<g clip-path="url(#${cid})">${childSvg}</g>`);
      } else body.push(childSvg);
    }

    // Strokes (outline geometry is pre-expanded by Figma, so it is painted as a fill)
    const strokes = (n.strokes as Paint[] | undefined) ?? [];
    const sgeo = ((n.strokeGeometry as { path: string; windingRule?: string }[] | undefined) ?? []).filter((g) => !isDegeneratePath(g.path));
    for (const p of strokes) {
      const pr = paintRef(p, local, w, h);
      if (!pr) continue;
      if (sgeo.length) for (const g of sgeo) body.push(`<path transform="${t}" d="${g.path}" fill="${pr.fill}" fill-opacity="${n3(pr.opacity)}"/>`);
      else if (w > 0.001 && h > 0.001 && n.type !== "TEXT" && !((n.strokeGeometry as unknown[] | undefined) ?? []).length) {
        const sw = (n.strokeWeight as number | undefined) ?? 1;
        body.push(`<path transform="${t}" d="${rectPath(n, w, h)}" fill="none" stroke="${pr.fill}" stroke-opacity="${n3(pr.opacity)}" stroke-width="${sw}"/>`);
      }
    }

    if (!body.length) return "";
    const attrs: string[] = [];
    if (typeof n.opacity === "number" && n.opacity < 1) attrs.push(`opacity="${n3(n.opacity)}"`);
    const f = dropFilter ? undefined : effectsFilter(n);
    if (f) attrs.push(`filter="url(#${f})"`);
    return attrs.length ? `<g ${attrs.join(" ")}>${body.join("")}</g>` : body.join("");
  };

  const content = draw(root, true);
  const w = Math.max(1, Math.round(size.x * 1000) / 1000);
  const h = Math.max(1, Math.round(size.y * 1000) / 1000);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none">${defs.length ? `<defs>${defs.join("")}</defs>` : ""}${content}</svg>`;
  return { svg, width: w, height: h };
}

/** Rasterizes in a child process: a resvg panic then fails this call instead of killing the server. */
export async function svgToPng(svg: string, scale = 1, timeoutMs = 60_000): Promise<Buffer> {
  try {
    return await rasterize(svg, scale, timeoutMs);
  } catch (e) {
    // Last resort: resvg has crash bugs around filters on clipped content; drop effects and retry.
    if (!/crashed/.test((e as Error).message) || !svg.includes(" filter=")) throw e;
    return rasterize(svg.replace(/ filter="url\(#[^)]*\)"/g, ""), scale, timeoutMs);
  }
}

function rasterize(svg: string, scale: number, timeoutMs: number): Promise<Buffer> {
  const here = fileURLToPath(import.meta.url);
  const ext = here.endsWith(".ts") ? ".ts" : ".js";
  const script = path.join(path.dirname(here), `rasterize-child${ext}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, script], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const png = Buffer.concat(out);
      if (code === 0 && png.length > 8) resolve(png);
      else reject(new Error(`Rendering the PNG failed (${signal === "SIGKILL" ? "timed out" : signal ? `renderer crashed, ${signal}` : `exit ${code}`}): ${err.split("\n").find((l) => l.includes("panicked") || l.includes("Error")) ?? err.slice(0, 200)}. Try format svg, or a smaller node.`));
    });
    child.stdin.end(JSON.stringify({ svg, scale }));
  });
}
