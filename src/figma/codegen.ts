/**
 * Reference code generation from raw Figma nodes: React + Tailwind (arbitrary values), or
 * HTML + CSS. Like Figma's own Dev Mode output, it is a starting point to adapt to the
 * project's components and tokens, not production code.
 */
import type { RestNode } from "./rest.js";
import { colorToCss, paintToCss } from "./simplify.js";

type Box = { x: number; y: number; width: number; height: number };
type Css = Record<string, string>;

export type CodegenFormat = "react-tailwind" | "html-css" | "react-css";

const r = (n: number) => Math.round(n * 100) / 100;
const px = (n: number) => `${r(n)}px`;

const VECTOR_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "REGULAR_POLYGON", "POLYGON"]);

function isIconLike(n: RestNode, top = true): boolean {
  if (top && (n.type === "ELLIPSE" || n.type === "LINE")) return false;
  if (VECTOR_TYPES.has(n.type)) return true;
  if (!top && (n.type === "ELLIPSE" || n.type === "LINE" || n.type === "RECTANGLE")) return true;
  if (n.type === "TEXT" || !n.children?.length) return false;
  if (top && (n.layoutMode === "HORIZONTAL" || n.layoutMode === "VERTICAL" || n.layoutMode === "GRID")) return false;
  const kids = n.children.filter((c) => c.visible !== false);
  return kids.length > 0 && kids.every((k) => isIconLike(k, false));
}

const mode0 = (n?: RestNode) => (n?.layoutMode as string | undefined) ?? "NONE";

export function nodeCss(n: RestNode, parent?: RestNode): Css {
  const css: Css = {};
  const bb = n.absoluteBoundingBox as Box | undefined;
  const pb = parent?.absoluteBoundingBox as Box | undefined;
  const parentAuto = parent?.layoutMode === "HORIZONTAL" || parent?.layoutMode === "VERTICAL" || parent?.layoutMode === "GRID";

  // Positioning
  if (parent && pb && bb && (!parentAuto || n.layoutPositioning === "ABSOLUTE") && parent.type !== "CANVAS") {
    css.position = "absolute";
    css.left = px(bb.x - pb.x);
    css.top = px(bb.y - pb.y);
  }
  const isAuto = mode0(n) !== "NONE";
  if (n.children?.some((c) => c.layoutPositioning === "ABSOLUTE") || (n.children?.length && !isAuto && n.type !== "GROUP")) {
    css.position ??= "relative";
  }

  // Size
  if (bb) {
    const h = n.layoutSizingHorizontal as string | undefined;
    const v = n.layoutSizingVertical as string | undefined;
    const parentDir = parent?.layoutMode;
    if (h === "FILL") {
      if (parentDir === "HORIZONTAL") css.flex = "1 1 0";
      else css.alignSelf = "stretch";
    } else if (h !== "HUG" || n.type !== "TEXT") {
      if (h !== "HUG") css.width = px(bb.width);
    }
    if (v === "FILL") {
      if (parentDir === "VERTICAL") css.flex = "1 1 0";
      else css.alignSelf = "stretch";
    } else if (v !== "HUG" && n.type !== "TEXT") css.height = px(bb.height);
    if (n.type === "TEXT" && h === undefined && v === undefined) css.width = px(bb.width);
  }
  for (const k of ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const) {
    if (typeof n[k] === "number") css[k] = px(n[k] as number);
  }

  // Auto layout
  const mode = n.layoutMode as string | undefined;
  if (mode === "HORIZONTAL" || mode === "VERTICAL") {
    css.display = "flex";
    css.flexDirection = mode === "HORIZONTAL" ? "row" : "column";
    if (n.layoutWrap === "WRAP") css.flexWrap = "wrap";
    const justify = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between" }[(n.primaryAxisAlignItems as string) ?? "MIN"];
    const align = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", BASELINE: "baseline" }[(n.counterAxisAlignItems as string) ?? "MIN"];
    if (justify && justify !== "flex-start") css.justifyContent = justify;
    if (align && align !== "flex-start") css.alignItems = align;
    if (n.itemSpacing && n.primaryAxisAlignItems !== "SPACE_BETWEEN") css.gap = px(n.itemSpacing as number);
    if (n.counterAxisSpacing && n.layoutWrap === "WRAP") css.rowGap = px(n.counterAxisSpacing as number);
  } else if (mode === "GRID") {
    css.display = "grid";
    if (n.gridColumnCount) css.gridTemplateColumns = `repeat(${n.gridColumnCount}, minmax(0, 1fr))`;
    if (n.gridColumnGap) css.columnGap = px(n.gridColumnGap as number);
    if (n.gridRowGap) css.rowGap = px(n.gridRowGap as number);
  }
  const pad = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].map((k) => (n[k] as number | undefined) ?? 0);
  if (pad.some(Boolean)) css.padding = pad.map(px).join(" ");
  if (n.clipsContent) css.overflow = "hidden";

  // Paint
  if (n.type !== "TEXT") {
    const fills = ((n.fills as { visible?: boolean; type: string }[] | undefined) ?? []).filter((f) => f.visible !== false);
    const css2 = fills.map((f) => paintToCss(f as never)).filter((x): x is string => !!x).reverse();
    if (css2.length === 1 && !css2[0].includes("gradient") && !css2[0].startsWith("image(")) css.backgroundColor = css2[0];
    else if (css2.length) css.background = css2.map((c) => (c.startsWith("image(") ? `url(./assets/${String(n.name).replace(/[^\w-]+/g, "_")}.png) center / cover` : c)).join(", ");
  } else {
    const fill = ((n.fills as { visible?: boolean; type: string }[] | undefined) ?? []).find((f) => f.visible !== false);
    if (fill) css.color = paintToCss(fill as never) ?? "inherit";
  }
  const strokes = ((n.strokes as { visible?: boolean; type: string }[] | undefined) ?? []).filter((s) => s.visible !== false);
  if (strokes.length) {
    const color = paintToCss(strokes[0] as never) ?? "currentColor";
    const ind = n.individualStrokeWeights as { top: number; right: number; bottom: number; left: number } | undefined;
    const style = (n.strokeDashes as number[] | undefined)?.length ? "dashed" : "solid";
    if (ind) {
      for (const side of ["top", "right", "bottom", "left"] as const) if (ind[side]) css[`border${side[0].toUpperCase()}${side.slice(1)}`] = `${px(ind[side])} ${style} ${color}`;
    } else if (n.strokeAlign === "OUTSIDE") css.outline = `${px((n.strokeWeight as number) ?? 1)} ${style} ${color}`;
    else css.border = `${px((n.strokeWeight as number) ?? 1)} ${style} ${color}`;
  }
  const radii = n.rectangleCornerRadii as number[] | undefined;
  if (radii?.some(Boolean)) css.borderRadius = radii.every((x) => x === radii[0]) ? px(radii[0]) : radii.map(px).join(" ");
  else if (typeof n.cornerRadius === "number" && n.cornerRadius) css.borderRadius = px(n.cornerRadius);
  else if (n.type === "ELLIPSE") css.borderRadius = "9999px";
  if (typeof n.opacity === "number" && n.opacity < 1) css.opacity = String(r(n.opacity));

  const effects = (n.effects as { type: string; visible?: boolean; radius: number; spread?: number; color?: never; offset?: { x: number; y: number } }[] | undefined) ?? [];
  const shadows = effects
    .filter((e) => e.visible !== false && (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW"))
    .map((e) => `${e.type === "INNER_SHADOW" ? "inset " : ""}${px(e.offset?.x ?? 0)} ${px(e.offset?.y ?? 0)} ${px(e.radius)} ${px(e.spread ?? 0)} ${e.color ? colorToCss(e.color) : "#000"}`);
  if (shadows.length) css.boxShadow = shadows.join(", ");
  const blur = effects.find((e) => e.visible !== false && e.type === "LAYER_BLUR");
  if (blur) css.filter = `blur(${px(blur.radius / 2)})`;
  const bgBlur = effects.find((e) => e.visible !== false && e.type === "BACKGROUND_BLUR");
  if (bgBlur) css.backdropFilter = `blur(${px(bgBlur.radius / 2)})`;

  // Text
  if (n.type === "TEXT") {
    const s = (n.style as Record<string, unknown> | undefined) ?? {};
    if (s.fontFamily) css.fontFamily = `"${s.fontFamily}"`;
    if (s.fontSize) css.fontSize = px(s.fontSize as number);
    if (s.fontWeight) css.fontWeight = String(s.fontWeight);
    if (s.italic) css.fontStyle = "italic";
    if (s.lineHeightUnit === "PIXELS" && s.lineHeightPx) css.lineHeight = px(s.lineHeightPx as number);
    else if (s.lineHeightUnit === "FONT_SIZE_%" && s.lineHeightPercentFontSize) css.lineHeight = String(r((s.lineHeightPercentFontSize as number) / 100));
    if (s.letterSpacing) css.letterSpacing = px(s.letterSpacing as number);
    if (s.textAlignHorizontal && s.textAlignHorizontal !== "LEFT") css.textAlign = String(s.textAlignHorizontal).toLowerCase() === "justified" ? "justify" : String(s.textAlignHorizontal).toLowerCase();
    if (s.textCase === "UPPER") css.textTransform = "uppercase";
    else if (s.textCase === "LOWER") css.textTransform = "lowercase";
    else if (s.textCase === "TITLE") css.textTransform = "capitalize";
    if (s.textDecoration === "UNDERLINE") css.textDecoration = "underline";
    else if (s.textDecoration === "STRIKETHROUGH") css.textDecoration = "line-through";
  }
  return css;
}

// ---------- Tailwind mapping ----------

const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
const arb = (v: string) => v.replace(/\s+/g, "_");

function tailwind(css: Css): string[] {
  const out: string[] = [];
  const map: Record<string, (v: string) => string | undefined> = {
    position: (v) => v,
    left: (v) => `left-[${v}]`,
    top: (v) => `top-[${v}]`,
    width: (v) => `w-[${v}]`,
    height: (v) => `h-[${v}]`,
    minWidth: (v) => `min-w-[${v}]`,
    maxWidth: (v) => `max-w-[${v}]`,
    minHeight: (v) => `min-h-[${v}]`,
    maxHeight: (v) => `max-h-[${v}]`,
    flex: () => "flex-1",
    alignSelf: (v) => (v === "stretch" ? "self-stretch" : `self-[${v}]`),
    display: (v) => (v === "flex" ? "flex" : v === "grid" ? "grid" : `[display:${v}]`),
    flexDirection: (v) => (v === "column" ? "flex-col" : "flex-row"),
    flexWrap: () => "flex-wrap",
    justifyContent: (v) => ({ center: "justify-center", "flex-end": "justify-end", "space-between": "justify-between" })[v],
    alignItems: (v) => ({ center: "items-center", "flex-end": "items-end", baseline: "items-baseline" })[v],
    gap: (v) => `gap-[${v}]`,
    rowGap: (v) => `gap-y-[${v}]`,
    columnGap: (v) => `gap-x-[${v}]`,
    gridTemplateColumns: (v) => `grid-cols-[${arb(v)}]`,
    padding: (v) => {
      const [t, rr, b, l] = v.split(" ");
      if (t === b && rr === l) return t === rr ? `p-[${t}]` : `px-[${rr}] py-[${t}]`;
      return `pt-[${t}] pr-[${rr}] pb-[${b}] pl-[${l}]`;
    },
    overflow: (v) => `overflow-${v}`,
    backgroundColor: (v) => `bg-[${arb(v)}]`,
    background: (v) => `[background:${arb(v)}]`,
    color: (v) => `text-[${arb(v)}]`,
    border: (v) => `[border:${arb(v)}]`,
    borderTop: (v) => `[border-top:${arb(v)}]`,
    borderRight: (v) => `[border-right:${arb(v)}]`,
    borderBottom: (v) => `[border-bottom:${arb(v)}]`,
    borderLeft: (v) => `[border-left:${arb(v)}]`,
    outline: (v) => `[outline:${arb(v)}]`,
    borderRadius: (v) => (v === "9999px" ? "rounded-full" : `rounded-[${arb(v)}]`),
    opacity: (v) => `opacity-[${v}]`,
    boxShadow: (v) => `shadow-[${arb(v)}]`,
    filter: (v) => `[filter:${arb(v)}]`,
    backdropFilter: (v) => `backdrop-[${arb(v)}]`,
    fontFamily: (v) => `font-[${arb(v.replace(/"/g, "'"))}]`,
    fontSize: (v) => `text-[${v}]`,
    fontWeight: (v) => `font-[${v}]`,
    fontStyle: () => "italic",
    lineHeight: (v) => `leading-[${v}]`,
    letterSpacing: (v) => `tracking-[${v}]`,
    textAlign: (v) => `text-${v}`,
    textTransform: (v) => v,
    textDecoration: (v) => v
  };
  for (const [k, v] of Object.entries(css)) {
    const f = map[k];
    const cls = f ? f(v) : `[${kebab(k)}:${arb(v)}]`;
    if (cls) out.push(cls);
  }
  return out;
}

// ---------- Emitters ----------

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/{/g, "&#123;").replace(/}/g, "&#125;");
const fileSafe = (s: string) => s.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "asset";

export interface CodegenResult {
  code: string;
  css?: string;
  assets: { nodeId: string; file: string; format: "svg" | "png" }[];
  componentInstances: string[];
}

export function generateCode(root: RestNode, format: CodegenFormat, opts: { maxDepth?: number } = {}): CodegenResult {
  const assets: CodegenResult["assets"] = [];
  const instances = new Set<string>();
  const cssRules: string[] = [];
  let classCounter = 0;
  const jsx = format !== "html-css";
  const classAttr = jsx ? "className" : "class";

  const visit = (n: RestNode, parent: RestNode | undefined, depth: number, indent: string): string => {
    if (n.visible === false) return "";
    const css = nodeCss(n, parent);
    const comment = n.type === "INSTANCE" ? ` data-component="${escapeText(n.name)}"` : "";
    if (n.type === "INSTANCE") instances.add(n.name);

    let attrs: string;
    if (format === "react-tailwind") attrs = `${classAttr}="${tailwind(css).join(" ")}"`;
    else {
      const cls = `${fileSafe(n.name).toLowerCase().slice(0, 24)}-${++classCounter}`;
      cssRules.push(`.${cls} {\n${Object.entries(css).map(([k, v]) => `  ${kebab(k)}: ${v};`).join("\n")}\n}`);
      attrs = `${classAttr}="${cls}"`;
    }
    const nameAttr = ` data-name="${escapeText(n.name)}"${comment}`;

    if (n.type !== "TEXT" && isIconLike(n)) {
      const file = `${fileSafe(n.name)}.svg`;
      assets.push({ nodeId: n.id, file, format: "svg" });
      return `${indent}<img ${attrs}${nameAttr} src="./assets/${file}" alt="${escapeText(n.name)}"${jsx ? " /" : ""}>`;
    }
    if ((n.fills as { type: string; visible?: boolean }[] | undefined)?.some((f) => f.type === "IMAGE" && f.visible !== false)) {
      assets.push({ nodeId: n.id, file: `${fileSafe(n.name)}.png`, format: "png" });
    }
    if (n.type === "TEXT") {
      const lines = String(n.characters ?? "").split("\n").map(escapeText);
      const text = lines.join(jsx ? "<br />" : "<br>");
      return `${indent}<p ${attrs}${nameAttr}>${text}</p>`;
    }
    const kids = n.children ?? [];
    if (!kids.length) return `${indent}<div ${attrs}${nameAttr}${jsx ? " />" : "></div>"}`;
    if (opts.maxDepth !== undefined && depth >= opts.maxDepth) {
      const note = `${kids.length} children omitted: request node ${n.id}`;
      return `${indent}<div ${attrs}${nameAttr}>${jsx ? `{/* ${note} */}` : `<!-- ${note} -->`}</div>`;
    }
    const inner = kids.map((c) => visit(c, n, depth + 1, indent + "  ")).filter(Boolean).join("\n");
    return `${indent}<div ${attrs}${nameAttr}>\n${inner}\n${indent}</div>`;
  };

  const body = visit(root, undefined, 0, jsx ? "    " : "");
  let code: string;
  const compName = fileSafe(root.name).replace(/(^|_)(\w)/g, (_, __, c: string) => c.toUpperCase()).replace(/^\d/, "C$&") || "Component";
  if (jsx) {
    code = `${format === "react-css" ? `import "./${compName}.css";\n\n` : ""}export function ${compName}() {\n  return (\n${body}\n  );\n}\n`;
  } else code = body + "\n";
  return {
    code,
    ...(format !== "react-tailwind" ? { css: cssRules.join("\n\n") + "\n" } : {}),
    assets,
    componentInstances: [...instances]
  };
}
