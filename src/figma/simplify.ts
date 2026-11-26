/**
 * Turns raw Figma node JSON (REST format, or the plugin's JSON_REST_V1 export) into a compact,
 * code-oriented spec: CSS-like layout and style values, component/variant info, shared style
 * names, and a list of assets that should be exported rather than rebuilt in code.
 *
 * Repeated style objects are hoisted into `styles` and referenced by id, which keeps large
 * screens small enough for an LLM context window.
 */
import type { RestComponentMeta, RestNode, RestStyleMeta } from "./rest.js";

// ---------- Types ----------

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
  boundVariables?: Record<string, unknown>;
};
type Effect = { type: string; visible?: boolean; radius: number; spread?: number; color?: Color; offset?: { x: number; y: number } };
type Box = { x: number; y: number; width: number; height: number };

export interface SimplifyContext {
  components?: Record<string, RestComponentMeta>;
  componentSets?: Record<string, RestComponentMeta>;
  styles?: Record<string, RestStyleMeta>;
  /** variable id -> name (when known, from the variables API or the plugin) */
  variables?: Record<string, string>;
}

export interface SimplifyOptions {
  /** Max depth below the root to descend (undefined = all). */
  maxDepth?: number;
  /** Include hidden layers. */
  includeHidden?: boolean;
}

export interface SimplifiedNode {
  id: string;
  name: string;
  type: string;
  text?: string;
  component?: Record<string, unknown>;
  layout?: string;
  box?: string;
  fills?: string;
  strokes?: string;
  effects?: string;
  textStyle?: string;
  radius?: string;
  opacity?: number;
  /** Export this node as an asset instead of building it in code. */
  asset?: { format: "svg" | "png"; reason: string; imageRef?: string };
  variables?: Record<string, string>;
  children?: SimplifiedNode[];
  truncated?: string;
}

export interface AssetCandidate {
  nodeId: string;
  name: string;
  format: "svg" | "png";
  reason: string;
  imageRef?: string;
}

export interface SimplifiedDesign {
  nodes: SimplifiedNode[];
  styles: Record<string, unknown>;
  components: Record<string, { name: string; key?: string; description?: string; set?: string }>;
  assets: AssetCandidate[];
}

// ---------- Small value helpers ----------

const round = (n: number, p = 2) => Math.round(n * 10 ** p) / 10 ** p;
const px = (n: number) => `${round(n)}px`;

export function colorToCss(c: Color, opacity = 1): string {
  const a = round((c.a ?? 1) * opacity, 3);
  const hex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  const base = `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`.toUpperCase();
  if (a >= 1) return base;
  return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${a})`;
}

function gradientAngle(handles?: { x: number; y: number }[]): number {
  if (!handles || handles.length < 2) return 180;
  const [a, b] = handles;
  // CSS angles: 0deg points up, clockwise.
  return round((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 90, 1);
}

export function paintToCss(p: Paint): string | undefined {
  if (p.visible === false) return undefined;
  const op = p.opacity ?? 1;
  switch (p.type) {
    case "SOLID":
      return p.color ? colorToCss(p.color, op) : undefined;
    case "GRADIENT_LINEAR": {
      const stops = (p.gradientStops ?? []).map((s) => `${colorToCss(s.color, op)} ${round(s.position * 100)}%`).join(", ");
      return `linear-gradient(${gradientAngle(p.gradientHandlePositions)}deg, ${stops})`;
    }
    case "GRADIENT_RADIAL":
    case "GRADIENT_DIAMOND": {
      const stops = (p.gradientStops ?? []).map((s) => `${colorToCss(s.color, op)} ${round(s.position * 100)}%`).join(", ");
      return `radial-gradient(${stops})`;
    }
    case "GRADIENT_ANGULAR": {
      const stops = (p.gradientStops ?? []).map((s) => `${colorToCss(s.color, op)} ${round(s.position * 360)}deg`).join(", ");
      return `conic-gradient(${stops})`;
    }
    case "IMAGE":
      return `image(${p.imageRef ?? "?"}${p.scaleMode ? `, ${p.scaleMode.toLowerCase()}` : ""})`;
    case "VIDEO":
      return "video";
    default:
      return p.type.toLowerCase();
  }
}

function effectsToCss(effects: Effect[]): string | undefined {
  const shadows: string[] = [];
  const out: string[] = [];
  for (const e of effects) {
    if (e.visible === false) continue;
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      const c = e.color ? colorToCss(e.color) : "#000";
      shadows.push(`${e.type === "INNER_SHADOW" ? "inset " : ""}${px(e.offset?.x ?? 0)} ${px(e.offset?.y ?? 0)} ${px(e.radius)} ${px(e.spread ?? 0)} ${c}`);
    } else if (e.type === "LAYER_BLUR") out.push(`filter: blur(${px(e.radius / 2)})`);
    else if (e.type === "BACKGROUND_BLUR") out.push(`backdrop-filter: blur(${px(e.radius / 2)})`);
  }
  if (shadows.length) out.unshift(`box-shadow: ${shadows.join(", ")}`);
  return out.length ? out.join("; ") : undefined;
}

// ---------- Main ----------

const VECTOR_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "ELLIPSE", "REGULAR_POLYGON", "POLYGON"]);
const CONTAINER_TYPES = new Set(["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"]);

/** True when every visible leaf below the node is vector geometry, i.e. the node is an icon/illustration. */
function isVectorOnly(n: RestNode, top = true): boolean {
  // A lone ellipse/line/rectangle is easier to build in CSS; inside an icon group it is geometry.
  if (top && (n.type === "ELLIPSE" || n.type === "LINE")) return false;
  if (VECTOR_TYPES.has(n.type)) return true;
  if (!top && n.type === "RECTANGLE" && !hasImageFill(n)) return true;
  if (n.type === "TEXT") return false;
  if (!n.children || n.children.length === 0) return false;
  if (hasImageFill(n)) return false;
  // Auto-layout containers (buttons, chips) are layout, not artwork; the icon inside is the asset.
  if (top && (n.layoutMode === "HORIZONTAL" || n.layoutMode === "VERTICAL" || n.layoutMode === "GRID")) return false;
  const kids = n.children.filter((c) => c.visible !== false);
  return kids.length > 0 && kids.every((k) => isVectorOnly(k, false));
}

function hasImageFill(n: RestNode): Paint | undefined {
  const fills = (n.fills as Paint[] | undefined) ?? [];
  return fills.find((f) => f.type === "IMAGE" && f.visible !== false);
}

export class Simplifier {
  private styleIds = new Map<string, string>();
  private styles: Record<string, unknown> = {};
  private counters: Record<string, number> = {};
  private assets: AssetCandidate[] = [];
  private usedComponents: SimplifiedDesign["components"] = {};

  constructor(
    private ctx: SimplifyContext = {},
    private opts: SimplifyOptions = {}
  ) {}

  /** Stores a style value once, returning a short id. Named Figma styles keep their name as the id. */
  private ref(kind: string, value: unknown, namedStyle?: string): string {
    const json = JSON.stringify(value);
    if (namedStyle) {
      this.styles[namedStyle] = value;
      return namedStyle;
    }
    const existing = this.styleIds.get(kind + json);
    if (existing) return existing;
    this.counters[kind] = (this.counters[kind] ?? 0) + 1;
    const id = `${kind}_${this.counters[kind]}`;
    this.styleIds.set(kind + json, id);
    this.styles[id] = value;
    return id;
  }

  private styleName(n: RestNode, key: string): string | undefined {
    const styleMap = n.styles as Record<string, string> | undefined;
    const id = styleMap?.[key];
    return id ? this.ctx.styles?.[id]?.name : undefined;
  }

  private varName(id: string): string {
    return this.ctx.variables?.[id] ?? id;
  }

  private collectVariables(n: RestNode): Record<string, string> | undefined {
    const bv = n.boundVariables as Record<string, unknown> | undefined;
    if (!bv) return undefined;
    const out: Record<string, string> = {};
    const visit = (key: string, v: unknown) => {
      if (Array.isArray(v)) v.forEach((x, i) => visit(`${key}[${i}]`, x));
      else if (v && typeof v === "object" && "id" in v && (v as { type?: string }).type === "VARIABLE_ALIAS") out[key] = this.varName(String((v as { id: string }).id));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(`${key}.${k}`, x);
    };
    for (const [k, v] of Object.entries(bv)) visit(k, v);
    return Object.keys(out).length ? out : undefined;
  }

  private layout(n: RestNode, parent?: RestNode): string | undefined {
    const parts: string[] = [];
    const mode = n.layoutMode as string | undefined;
    if (mode === "HORIZONTAL" || mode === "VERTICAL") {
      parts.push(`flex ${mode === "HORIZONTAL" ? "row" : "column"}`);
      if (n.layoutWrap === "WRAP") parts.push("wrap");
      const justify = { MIN: "start", CENTER: "center", MAX: "end", SPACE_BETWEEN: "space-between" }[(n.primaryAxisAlignItems as string) ?? "MIN"];
      const align = { MIN: "start", CENTER: "center", MAX: "end", BASELINE: "baseline" }[(n.counterAxisAlignItems as string) ?? "MIN"];
      if (justify && justify !== "start") parts.push(`justify ${justify}`);
      if (align && align !== "start") parts.push(`align ${align}`);
      if (n.itemSpacing && n.primaryAxisAlignItems !== "SPACE_BETWEEN") parts.push(`gap ${px(n.itemSpacing as number)}`);
      if (n.counterAxisSpacing && n.layoutWrap === "WRAP") parts.push(`row-gap ${px(n.counterAxisSpacing as number)}`);
    } else if (mode === "GRID") {
      parts.push("grid");
      if (n.gridColumnCount) parts.push(`cols ${n.gridColumnCount}`);
      if (n.gridRowCount) parts.push(`rows ${n.gridRowCount}`);
      if (n.gridColumnGap) parts.push(`col-gap ${px(n.gridColumnGap as number)}`);
      if (n.gridRowGap) parts.push(`row-gap ${px(n.gridRowGap as number)}`);
    }
    const pad = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].map((k) => (n[k] as number | undefined) ?? 0);
    if (pad.some((p) => p)) {
      const [t, r, b, l] = pad.map(round);
      parts.push(`padding ${t === b && r === l ? (t === r ? `${t}px` : `${t}px ${r}px`) : `${t}px ${r}px ${b}px ${l}px`}`);
    }
    if (n.clipsContent) parts.push("overflow hidden");
    if (n.layoutPositioning === "ABSOLUTE") parts.push("position absolute");
    if (parent && (parent.layoutMode === "NONE" || !parent.layoutMode) && CONTAINER_TYPES.has(parent.type) && parent.type !== "GROUP") {
      // Child of a plain frame: positioned absolutely relative to the parent.
      parts.push("position absolute");
    }
    if (n.layoutGrow === 1) parts.push("grow 1");
    if (n.layoutAlign === "STRETCH") parts.push("align-self stretch");
    return parts.length ? parts.join("; ") : undefined;
  }

  private box(n: RestNode, parent?: RestNode): string | undefined {
    const bb = n.absoluteBoundingBox as Box | undefined;
    if (!bb) return undefined;
    const hSizing = n.layoutSizingHorizontal as string | undefined;
    const vSizing = n.layoutSizingVertical as string | undefined;
    const w = hSizing === "FILL" ? "fill" : hSizing === "HUG" ? `hug(${round(bb.width)})` : px(bb.width);
    const h = vSizing === "FILL" ? "fill" : vSizing === "HUG" ? `hug(${round(bb.height)})` : px(bb.height);
    const parts = [`w ${w}`, `h ${h}`];
    const pb = parent?.absoluteBoundingBox as Box | undefined;
    const absolute = n.layoutPositioning === "ABSOLUTE" || (parent && !parent.layoutMode) || parent?.layoutMode === "NONE";
    if (pb && absolute && parent?.type !== "CANVAS") parts.push(`x ${round(bb.x - pb.x)}`, `y ${round(bb.y - pb.y)}`);
    for (const k of ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const) if (typeof n[k] === "number") parts.push(`${k} ${px(n[k] as number)}`);
    if (typeof n.rotation === "number" && Math.abs(n.rotation as number) > 0.01) parts.push(`rotate ${round(((n.rotation as number) * 180) / Math.PI, 1)}deg`);
    return parts.join("; ");
  }

  private fills(n: RestNode): string | undefined {
    const paints = ((n.fills as Paint[] | undefined) ?? []).filter((p) => p.visible !== false);
    if (!paints.length) return undefined;
    // Figma lists paints bottom-to-top; CSS backgrounds are top-to-bottom.
    const css = paints.map(paintToCss).filter(Boolean).reverse();
    if (!css.length) return undefined;
    return this.ref("fill", css.length === 1 ? css[0] : css, this.styleName(n, "fill") ?? this.styleName(n, "fills"));
  }

  private strokes(n: RestNode): string | undefined {
    const paints = ((n.strokes as Paint[] | undefined) ?? []).filter((p) => p.visible !== false);
    if (!paints.length) return undefined;
    const color = paints.map(paintToCss).filter(Boolean).join(", ");
    const ind = n.individualStrokeWeights as { top: number; right: number; bottom: number; left: number } | undefined;
    const weight = ind ? `${ind.top}px ${ind.right}px ${ind.bottom}px ${ind.left}px` : px((n.strokeWeight as number) ?? 1);
    const dashes = n.strokeDashes as number[] | undefined;
    const value = `${weight} ${dashes?.length ? "dashed" : "solid"} ${color}${n.strokeAlign && n.strokeAlign !== "INSIDE" ? ` (${String(n.strokeAlign).toLowerCase()})` : ""}`;
    return this.ref("stroke", value, this.styleName(n, "stroke") ?? this.styleName(n, "strokes"));
  }

  private radius(n: RestNode): string | undefined {
    const radii = n.rectangleCornerRadii as number[] | undefined;
    if (radii && radii.some((r) => r)) return radii.every((r) => r === radii[0]) ? px(radii[0]) : radii.map(px).join(" ");
    if (typeof n.cornerRadius === "number" && n.cornerRadius) return px(n.cornerRadius);
    if (n.type === "ELLIPSE") return "50%";
    return undefined;
  }

  private textStyle(n: RestNode): string | undefined {
    const s = n.style as Record<string, unknown> | undefined;
    if (!s) return undefined;
    const v: Record<string, unknown> = {};
    if (s.fontFamily) v.fontFamily = s.fontFamily;
    if (s.fontWeight) v.fontWeight = s.fontWeight;
    if (s.italic) v.fontStyle = "italic";
    if (s.fontSize) v.fontSize = px(s.fontSize as number);
    if (s.lineHeightUnit === "PIXELS" && s.lineHeightPx) v.lineHeight = px(s.lineHeightPx as number);
    else if (s.lineHeightUnit === "FONT_SIZE_%" && s.lineHeightPercentFontSize) v.lineHeight = `${round((s.lineHeightPercentFontSize as number) / 100, 3)}`;
    if (s.letterSpacing) v.letterSpacing = px(s.letterSpacing as number);
    if (s.textAlignHorizontal && s.textAlignHorizontal !== "LEFT") v.textAlign = String(s.textAlignHorizontal).toLowerCase();
    if (s.textAlignVertical && s.textAlignVertical !== "TOP") v.verticalAlign = String(s.textAlignVertical).toLowerCase();
    if (s.textCase && s.textCase !== "ORIGINAL") v.textTransform = { UPPER: "uppercase", LOWER: "lowercase", TITLE: "capitalize" }[s.textCase as string] ?? s.textCase;
    if (s.textDecoration && s.textDecoration !== "NONE") v.textDecoration = String(s.textDecoration).toLowerCase().replace("_", "-");
    if (s.textAutoResize === "TRUNCATE" || s.textTruncation === "ENDING") v.truncate = s.maxLines ? `${s.maxLines} lines` : true;
    if (s.paragraphSpacing) v.paragraphSpacing = px(s.paragraphSpacing as number);
    return this.ref("text", v, this.styleName(n, "text"));
  }

  private component(n: RestNode): Record<string, unknown> | undefined {
    if (n.type === "INSTANCE") {
      const id = n.componentId as string | undefined;
      const meta = id ? this.ctx.components?.[id] : undefined;
      const set = meta?.componentSetId ? this.ctx.componentSets?.[meta.componentSetId] : undefined;
      if (id && meta) this.usedComponents[id] = { name: meta.name, key: meta.key, description: meta.description || undefined, set: set?.name };
      const props = n.componentProperties as Record<string, { type: string; value: unknown }> | undefined;
      const out: Record<string, unknown> = { instanceOf: set?.name ?? meta?.name ?? id };
      if (set && meta) out.variant = meta.name;
      if (props && Object.keys(props).length) {
        out.props = Object.fromEntries(Object.entries(props).map(([k, v]) => [k.replace(/#\d+:\d+$/, ""), v.value]));
      }
      if (id) out.componentId = id;
      return out;
    }
    if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") {
      const meta = (n.type === "COMPONENT" ? this.ctx.components : this.ctx.componentSets)?.[n.id];
      const defs = n.componentPropertyDefinitions as Record<string, { type: string; defaultValue: unknown; variantOptions?: string[] }> | undefined;
      const out: Record<string, unknown> = { definition: true };
      if (meta?.description) out.description = meta.description;
      if (meta?.key) out.key = meta.key;
      if (defs) {
        out.props = Object.fromEntries(
          Object.entries(defs).map(([k, d]) => [k.replace(/#\d+:\d+$/, ""), d.variantOptions ? `${d.type}: ${d.variantOptions.join(" | ")} (default ${d.defaultValue})` : `${d.type} (default ${JSON.stringify(d.defaultValue)})`])
        );
      }
      return out;
    }
    return undefined;
  }

  private node(n: RestNode, depth: number, parent?: RestNode): SimplifiedNode | undefined {
    if (n.visible === false && !this.opts.includeHidden) return undefined;
    const out: SimplifiedNode = { id: n.id, name: n.name, type: n.type };

    if (n.type === "TEXT") out.text = String(n.characters ?? "");
    const comp = this.component(n);
    if (comp) out.component = comp;
    const layout = this.layout(n, parent);
    if (layout) out.layout = layout;
    if (n.type !== "DOCUMENT" && n.type !== "CANVAS") {
      const box = this.box(n, parent);
      if (box) out.box = box;
    }
    if (n.type === "CANVAS") {
      const bg = n.backgroundColor as Color | undefined;
      if (bg) out.fills = colorToCss(bg);
    } else {
      const fills = this.fills(n);
      if (fills) out.fills = fills;
    }
    const strokes = this.strokes(n);
    if (strokes) out.strokes = strokes;
    const effects = effectsToCss((n.effects as Effect[] | undefined) ?? []);
    if (effects) out.effects = this.ref("effect", effects, this.styleName(n, "effect"));
    const radius = this.radius(n);
    if (radius) out.radius = radius;
    if (typeof n.opacity === "number" && n.opacity < 1) out.opacity = round(n.opacity, 3);
    if (n.type === "TEXT") {
      const ts = this.textStyle(n);
      if (ts) out.textStyle = ts;
    }
    const vars = this.collectVariables(n);
    if (vars) out.variables = vars;

    // Assets: icons/illustrations become SVG, image fills become PNG.
    const img = hasImageFill(n);
    if (n.type !== "DOCUMENT" && n.type !== "CANVAS" && n.type !== "COMPONENT_SET" && n.type !== "TEXT" && isVectorOnly(n)) {
      out.asset = { format: "svg", reason: "vector graphic (icon/illustration)" };
      this.assets.push({ nodeId: n.id, name: n.name, format: "svg", reason: out.asset.reason });
      return out; // Do not descend into vector internals.
    }
    if (img) {
      out.asset = { format: "png", reason: "image fill", ...(img.imageRef ? { imageRef: img.imageRef } : {}) };
      this.assets.push({ nodeId: n.id, name: n.name, format: "png", reason: "image fill", ...(img.imageRef ? { imageRef: img.imageRef } : {}) });
    }
    if (n.exportSettings && (n.exportSettings as unknown[]).length && !out.asset) {
      const fmt = String((n.exportSettings as { format: string }[])[0].format).toLowerCase() === "svg" ? "svg" : "png";
      out.asset = { format: fmt, reason: "has export settings in Figma" };
      this.assets.push({ nodeId: n.id, name: n.name, format: fmt, reason: out.asset.reason });
    }

    if (n.children?.length) {
      if (this.opts.maxDepth !== undefined && depth >= this.opts.maxDepth) {
        out.truncated = `${n.children.length} children not shown; request node ${n.id} to see them`;
      } else {
        const kids = n.children.map((c) => this.node(c, depth + 1, n)).filter((c): c is SimplifiedNode => !!c);
        if (kids.length) out.children = kids;
      }
    }
    return out;
  }

  run(roots: RestNode[]): SimplifiedDesign {
    const nodes = roots.map((r) => this.node(r, 0)).filter((n): n is SimplifiedNode => !!n);
    return { nodes, styles: this.styles, components: this.usedComponents, assets: this.assets };
  }
}

export function simplify(roots: RestNode[], ctx: SimplifyContext = {}, opts: SimplifyOptions = {}): SimplifiedDesign {
  return new Simplifier(ctx, opts).run(roots);
}

/** Walks a raw tree and returns every node matching the predicate. */
export function findNodes(root: RestNode, pred: (n: RestNode) => boolean, out: RestNode[] = []): RestNode[] {
  if (pred(root)) out.push(root);
  for (const c of root.children ?? []) findNodes(c, pred, out);
  return out;
}
