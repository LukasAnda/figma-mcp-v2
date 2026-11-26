/**
 * Converts the multiplayer node graph (kiwi NodeChanges) into the Figma REST API node shape,
 * so the same simplifier, code generator and asset logic work for every data source.
 *
 * The hard part is instances: in the kiwi format an INSTANCE has no children. Its subtree is
 * the master component's subtree with the instance's symbolOverrides, component property
 * assignments and derivedSymbolData (sizes/positions computed by Figma's layout engine)
 * applied. Overrides address descendants by guidPath, a list of node keys that crosses nested
 * instance boundaries. Child ids follow the REST convention "I<instance>;<child>".
 */
import type { RestComponentMeta, RestNode, RestStyleMeta } from "../figma/rest.js";
import { DocGraph, guidStr, type Guid, type KNode } from "./client.js";

// ---------- Geometry ----------

export interface Matrix {
  m00: number;
  m01: number;
  m02: number;
  m10: number;
  m11: number;
  m12: number;
}
const IDENTITY: Matrix = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

export function mul(a: Matrix, b: Matrix): Matrix {
  return {
    m00: a.m00 * b.m00 + a.m01 * b.m10,
    m01: a.m00 * b.m01 + a.m01 * b.m11,
    m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02,
    m10: a.m10 * b.m00 + a.m11 * b.m10,
    m11: a.m10 * b.m01 + a.m11 * b.m11,
    m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12
  };
}

export function invert(m: Matrix): Matrix {
  const det = m.m00 * m.m11 - m.m01 * m.m10 || 1e-9;
  return {
    m00: m.m11 / det,
    m01: -m.m01 / det,
    m02: (m.m01 * m.m12 - m.m11 * m.m02) / det,
    m10: -m.m10 / det,
    m11: m.m00 / det,
    m12: (m.m10 * m.m02 - m.m00 * m.m12) / det
  };
}

const apply = (m: Matrix, x: number, y: number) => ({ x: m.m00 * x + m.m01 * y + m.m02, y: m.m10 * x + m.m11 * y + m.m12 });

function bbox(m: Matrix, w: number, h: number) {
  const pts = [apply(m, 0, 0), apply(m, w, 0), apply(m, 0, h), apply(m, w, h)];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/** Decodes a geometry blob (command byte + float32 LE coordinates) into an SVG path string. */
export function blobToPath(bytes: Uint8Array | undefined, scale = 1, dx = 0, dy = 0, flipY = false): string {
  if (!bytes) return "";
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: string[] = [];
  let i = 0;
  const f = () => {
    const v = dv.getFloat32(i, true);
    i += 4;
    return v;
  };
  const X = (v: number) => +(v * scale + dx).toFixed(3);
  const Y = (v: number) => +((flipY ? -v : v) * scale + dy).toFixed(3);
  while (i < bytes.length) {
    const cmd = bytes[i++];
    if (cmd === 0) {
      if (out.length) out.push("Z");
    } else if (cmd === 1) {
      if (i + 8 > bytes.length) break;
      out.push(`M${X(f())} ${Y(f())}`);
    } else if (cmd === 2) {
      if (i + 8 > bytes.length) break;
      out.push(`L${X(f())} ${Y(f())}`);
    } else if (cmd === 3) {
      if (i + 16 > bytes.length) break;
      out.push(`Q${X(f())} ${Y(f())} ${X(f())} ${Y(f())}`);
    } else if (cmd === 4) {
      if (i + 24 > bytes.length) break;
      out.push(`C${X(f())} ${Y(f())} ${X(f())} ${Y(f())} ${X(f())} ${Y(f())}`);
    } else break; // unknown command: stop rather than emit garbage
  }
  return out.join("");
}

// ---------- Converter ----------

const SKIP_TYPES = new Set(["VARIABLE", "VARIABLE_SET", "VARIABLE_OVERRIDE", "KEYFRAME", "KEYFRAME_TRACK", "BRUSH", "MANAGED_STRING", "RESPONSIVE_SET", "CODE_LIBRARY", "CODE_FILE", "CODE_COMPONENT", "CODE_INSTANCE", "ASSISTED_LAYOUT", "INTERACTIVE_SLIDE_ELEMENT", "VARIABLE_COLLECTION"]);

type Override = Record<string, unknown> & { guidPath?: { guids: Guid[] } };

interface Scope {
  /** Overrides keyed by guidPath string, relative to the current instance. */
  overrides: Map<string, Override>;
  derived: Map<string, Override>;
  /** Component property values visible to nodes in this instance's subtree. */
  props: Map<string, Record<string, unknown>>;
  /** Keys of the nested instances crossed since the scope root (guidPaths only grow at instance boundaries). */
  path: string[];
  /** REST id prefix, e.g. "I12:3;" */
  idPrefix: string;
}

export interface ConvertResult {
  document: RestNode;
  components: Record<string, RestComponentMeta>;
  componentSets: Record<string, RestComponentMeta>;
  styles: Record<string, RestStyleMeta>;
  variables: Record<string, string>;
}

const nodeKey = (n: KNode) => guidStr(((n.overrideKey as Guid | undefined) ?? n.guid) as Guid);
const pathKey = (guids: Guid[]) => guids.map(guidStr).join("/");

function fontWeightFromStyle(style = "", fallback?: number): number {
  const s = style.toLowerCase().replace(/[\s_-]/g, "");
  const table: [string, number][] = [
    ["thin", 100], ["hairline", 100], ["extralight", 200], ["ultralight", 200], ["light", 300], ["regular", 400], ["normal", 400], ["book", 400],
    ["medium", 500], ["semibold", 600], ["demibold", 600], ["extrabold", 800], ["ultrabold", 800], ["bold", 700], ["black", 900], ["heavy", 900]
  ];
  for (const [k, w] of table) if (s.includes(k)) return w;
  const numeric = /\b([1-9]00)\b/.exec(style);
  if (numeric) return Number(numeric[1]);
  return fallback ?? 400;
}

export class GraphConverter {
  private components: Record<string, RestComponentMeta> = {};
  private componentSets: Record<string, RestComponentMeta> = {};
  private styles: Record<string, RestStyleMeta> = {};
  private variables: Record<string, string> = {};
  private keyIndex?: Map<string, KNode>;

  constructor(private g: DocGraph) {
    for (const n of g.nodes.values()) if (n.type === "VARIABLE" && n.name) this.variables[guidStr(n.guid)] = n.name;
  }

  /** Every symbol id referenced below `id` (masters, swaps, prop-driven swaps) that is not loaded yet. */
  missingMasters(rootIds: string[]): string[] {
    const missing = new Set<string>();
    const seen = new Set<string>();
    const visitSymbol = (sid: string) => {
      const m = this.g.get(sid);
      if (!m) missing.add(sid);
      else visit(m);
    };
    const visit = (n: KNode) => {
      const id = guidStr(n.guid);
      if (seen.has(id)) return;
      seen.add(id);
      const sd = n.symbolData as { symbolID?: Guid; symbolOverrides?: Override[] } | undefined;
      if (sd?.symbolID) visitSymbol(guidStr(sd.symbolID));
      for (const o of sd?.symbolOverrides ?? []) {
        if (o.overriddenSymbolID) visitSymbol(guidStr(o.overriddenSymbolID as Guid));
        for (const a of (o.componentPropAssignments as { value?: { guidValue?: Guid } }[] | undefined) ?? []) if (a.value?.guidValue) visitSymbol(guidStr(a.value.guidValue));
      }
      for (const a of (n.componentPropAssignments as { value?: { guidValue?: Guid } }[] | undefined) ?? []) if (a.value?.guidValue) visitSymbol(guidStr(a.value.guidValue));
      for (const c of this.g.childrenOf(id)) visit(c);
    };
    for (const id of rootIds) {
      const n = this.g.get(id);
      if (n) visit(n);
      else missing.add(id);
    }
    // A guid of all-ones means "no symbol"
    missing.delete("4294967295:4294967295");
    return [...missing];
  }

  private byKey(key: string): KNode | undefined {
    if (!this.keyIndex) {
      this.keyIndex = new Map();
      for (const n of this.g.nodes.values()) {
        for (const k of ["key", "componentKey", "styleKey"]) if (typeof n[k] === "string") this.keyIndex.set(n[k] as string, n);
      }
    }
    return this.keyIndex.get(key);
  }

  /** Resolves a style or variable reference ({guid} or {assetRef:{key}}) to its node. */
  private resolveRef(ref: unknown): KNode | undefined {
    const r = ref as { guid?: Guid; assetRef?: { key: string } } | undefined;
    if (!r) return undefined;
    if (r.guid && r.guid.sessionID !== 4294967295) return this.g.get(guidStr(r.guid));
    if (r.assetRef?.key) return this.byKey(r.assetRef.key);
    return undefined;
  }

  private variableId(data: unknown): string | undefined {
    const alias = (data as { value?: { alias?: unknown } } | undefined)?.value?.alias;
    const node = this.resolveRef(alias);
    if (node) {
      const id = guidStr(node.guid);
      if (node.name) this.variables[id] = node.name;
      return id;
    }
    const a = alias as { guid?: Guid; assetRef?: { key: string } } | undefined;
    return a?.guid ? guidStr(a.guid) : a?.assetRef?.key;
  }

  // ---- property conversion ----

  private paint(p: Record<string, unknown>): Record<string, unknown> | undefined {
    const type = p.type as string;
    const out: Record<string, unknown> = { type, visible: p.visible !== false, opacity: p.opacity ?? 1, blendMode: p.blendMode ?? "NORMAL" };
    if (type === "SOLID") out.color = p.color;
    else if (type.startsWith("GRADIENT")) {
      out.gradientStops = ((p.stops as { color: unknown; position: number }[] | undefined) ?? []).map((s) => ({ color: s.color, position: s.position }));
      const t = invert((p.transform as Matrix) ?? IDENTITY);
      out.gradientHandlePositions = [apply(t, 0, 0.5), apply(t, 1, 0.5), apply(t, 0, 1)];
    } else if (type === "IMAGE") {
      const img = p.image as { hash?: Uint8Array; name?: string } | undefined;
      if (img?.hash) out.imageRef = Buffer.from(img.hash).toString("hex");
      out.scaleMode = p.imageScaleMode === "STRETCH" ? "CROP" : (p.imageScaleMode ?? "FILL");
      if (p.originalImageWidth) out.originalSize = { width: p.originalImageWidth, height: p.originalImageHeight };
    }
    const cv = p.colorVar;
    if (cv) {
      const id = this.variableId(cv);
      if (id) out.boundVariables = { color: { type: "VARIABLE_ALIAS", id } };
    }
    return out;
  }

  private convertProps(n: KNode, abs: Matrix, parent: KNode | undefined, out: RestNode) {
    const size = (n.size as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
    const rel = (n.transform as Matrix | undefined) ?? IDENTITY;
    out.absoluteBoundingBox = bbox(abs, size.x, size.y);
    out.size = { x: size.x, y: size.y };
    out.relativeTransform = [[rel.m00, rel.m01, rel.m02], [rel.m10, rel.m11, rel.m12]];
    const rot = Math.atan2(rel.m10, rel.m00);
    if (Math.abs(rot) > 1e-4) out.rotation = -rot;
    if (n.visible === false) out.visible = false;
    if (typeof n.opacity === "number" && n.opacity < 1) out.opacity = n.opacity;
    if (n.blendMode && n.blendMode !== "PASS_THROUGH" && n.blendMode !== "NORMAL") out.blendMode = n.blendMode;
    if (n.isMask) out.isMask = true;

    const bound: Record<string, unknown> = {};
    const fills = ((n.fillPaints as Record<string, unknown>[] | undefined) ?? []).map((p) => this.paint(p)).filter(Boolean) as Record<string, unknown>[];
    out.fills = fills;
    const fillVars = fills.map((f) => (f.boundVariables as { color?: unknown } | undefined)?.color).filter(Boolean);
    if (fillVars.length) bound.fills = fillVars;
    const strokes = ((n.strokePaints as Record<string, unknown>[] | undefined) ?? []).map((p) => this.paint(p)).filter(Boolean) as Record<string, unknown>[];
    out.strokes = strokes;
    const strokeVars = strokes.map((f) => (f.boundVariables as { color?: unknown } | undefined)?.color).filter(Boolean);
    if (strokeVars.length) bound.strokes = strokeVars;
    if (strokes.length) {
      out.strokeWeight = n.strokeWeight ?? 1;
      out.strokeAlign = n.strokeAlign ?? "INSIDE";
      if ((n.dashPattern as number[] | undefined)?.length) out.strokeDashes = n.dashPattern;
      if (n.borderStrokeWeightsIndependent) {
        out.individualStrokeWeights = { top: n.borderTopWeight ?? 0, right: n.borderRightWeight ?? 0, bottom: n.borderBottomWeight ?? 0, left: n.borderLeftWeight ?? 0 };
      }
    }

    const radii = [n.rectangleTopLeftCornerRadius, n.rectangleTopRightCornerRadius, n.rectangleBottomRightCornerRadius, n.rectangleBottomLeftCornerRadius] as (number | undefined)[];
    if (n.rectangleCornerRadiiIndependent && radii.some((r) => typeof r === "number")) out.rectangleCornerRadii = radii.map((r) => r ?? 0);
    else if (typeof n.cornerRadius === "number" && n.cornerRadius > 0) out.cornerRadius = n.cornerRadius;

    const effects = (n.effects as Record<string, unknown>[] | undefined) ?? [];
    if (effects.length) {
      out.effects = effects.map((e) => ({ type: e.type, visible: e.visible !== false, radius: e.radius ?? 0, spread: e.spread ?? 0, color: e.color, offset: e.offset, blendMode: e.blendMode }));
    }

    // Clipping (frames clip unless the mask is disabled)
    if (["FRAME", "SYMBOL", "INSTANCE"].includes(String(n.type))) out.clipsContent = n.frameMaskDisabled === false;

    // Auto layout
    const mode = n.stackMode as string | undefined;
    if (mode === "HORIZONTAL" || mode === "VERTICAL" || mode === "GRID") {
      out.layoutMode = mode;
      out.itemSpacing = n.stackSpacing ?? 0;
      const pl = (n.stackHorizontalPadding as number | undefined) ?? 0;
      const pt = (n.stackVerticalPadding as number | undefined) ?? 0;
      out.paddingLeft = pl;
      out.paddingRight = (n.stackPaddingRight as number | undefined) ?? pl;
      out.paddingTop = pt;
      out.paddingBottom = (n.stackPaddingBottom as number | undefined) ?? pt;
      const pa = (n.stackPrimaryAlignItems as string | undefined) ?? "MIN";
      out.primaryAxisAlignItems = pa === "SPACE_EVENLY" || pa === "SPACE_BETWEEN" ? "SPACE_BETWEEN" : pa;
      out.counterAxisAlignItems = (n.stackCounterAlignItems as string | undefined) ?? "MIN";
      if (n.stackWrap === "WRAP") {
        out.layoutWrap = "WRAP";
        out.counterAxisSpacing = n.stackCounterSpacing ?? 0;
      }
      if (mode === "GRID") {
        out.gridColumnCount = (n.gridColumnsSizing as { entries?: unknown[] } | undefined)?.entries?.length ?? 1;
        out.gridRowCount = (n.gridRowsSizing as { entries?: unknown[] } | undefined)?.entries?.length ?? 1;
        out.gridRowGap = n.gridRowGap ?? n.stackSpacing ?? 0;
        out.gridColumnGap = n.gridColumnGap ?? n.stackCounterSpacing ?? 0;
      }
    } else if (["FRAME", "SYMBOL", "INSTANCE"].includes(String(n.type))) out.layoutMode = "NONE";
    if (n.stackPositioning === "ABSOLUTE") out.layoutPositioning = "ABSOLUTE";
    if (n.stackChildPrimaryGrow) out.layoutGrow = n.stackChildPrimaryGrow;
    if (n.stackChildAlignSelf === "STRETCH") out.layoutAlign = "STRETCH";

    // Sizing modes
    const hug = (v: unknown) => typeof v === "string" && v.startsWith("RESIZE_TO_FIT");
    let h: string = "FIXED";
    let v: string = "FIXED";
    if (mode === "HORIZONTAL" || mode === "VERTICAL" || mode === "GRID") {
      // Absent primary sizing means "auto" (hug), absent counter sizing means fixed — same as the plugin API defaults.
      const primaryHug = n.stackPrimarySizing === undefined || hug(n.stackPrimarySizing);
      const counterHug = hug(n.stackCounterSizing);
      if (mode === "VERTICAL") {
        v = primaryHug ? "HUG" : "FIXED";
        h = counterHug ? "HUG" : "FIXED";
      } else {
        h = primaryHug ? "HUG" : "FIXED";
        v = counterHug ? "HUG" : "FIXED";
      }
    }
    if (n.type === "TEXT") {
      const ar = n.textAutoResize as string | undefined;
      if (ar === "WIDTH_AND_HEIGHT") h = v = "HUG";
      else if (ar === "HEIGHT") v = "HUG";
    }
    const pm = parent?.stackMode as string | undefined;
    if ((pm === "HORIZONTAL" || pm === "VERTICAL") && n.stackPositioning !== "ABSOLUTE") {
      const grow = !!n.stackChildPrimaryGrow;
      const stretch = n.stackChildAlignSelf === "STRETCH";
      if (pm === "HORIZONTAL") {
        if (grow) h = "FILL";
        if (stretch) v = "FILL";
      } else {
        if (grow) v = "FILL";
        if (stretch) h = "FILL";
      }
    }
    if (pm || mode) {
      out.layoutSizingHorizontal = h;
      out.layoutSizingVertical = v;
    }
    const minSize = n.minSize as { value?: { x: number; y: number } } | undefined;
    const maxSize = n.maxSize as { value?: { x: number; y: number } } | undefined;
    if (minSize?.value?.x) out.minWidth = minSize.value.x;
    if (minSize?.value?.y) out.minHeight = minSize.value.y;
    if (maxSize?.value?.x && maxSize.value.x < 1e6) out.maxWidth = maxSize.value.x;
    if (maxSize?.value?.y && maxSize.value.y < 1e6) out.maxHeight = maxSize.value.y;

    // Constraints
    if (n.horizontalConstraint || n.verticalConstraint) {
      const map: Record<string, string> = { MIN: "LEFT", MAX: "RIGHT", CENTER: "CENTER", STRETCH: "LEFT_RIGHT", SCALE: "SCALE" };
      const mapV: Record<string, string> = { MIN: "TOP", MAX: "BOTTOM", CENTER: "CENTER", STRETCH: "TOP_BOTTOM", SCALE: "SCALE" };
      out.constraints = { horizontal: map[(n.horizontalConstraint as string) ?? "MIN"], vertical: mapV[(n.verticalConstraint as string) ?? "MIN"] };
    }

    // Text
    if (n.type === "TEXT") {
      const td = n.textData as { characters?: string } | undefined;
      out.characters = td?.characters ?? "";
      const fn = (n.fontName as { family?: string; style?: string; postscript?: string } | undefined) ?? {};
      const fontSize = (n.fontSize as number | undefined) ?? 12;
      const meta = (n.derivedTextData as { fontMetaData?: { fontWeight?: number; fontStyle?: string }[] } | undefined)?.fontMetaData?.[0];
      const style: Record<string, unknown> = {
        fontFamily: fn.family,
        fontPostScriptName: fn.postscript || undefined,
        fontStyle: fn.style,
        // The style name is authoritative; derived font metadata can be stale after font swaps.
        fontWeight: fontWeightFromStyle(fn.style, meta?.fontWeight),
        fontSize,
        textAlignHorizontal: n.textAlignHorizontal ?? "LEFT",
        textAlignVertical: n.textAlignVertical ?? "TOP",
        textAutoResize: n.textAutoResize ?? "NONE"
      };
      if (/italic|oblique/i.test(fn.style ?? "") || meta?.fontStyle === "ITALIC") style.italic = true;
      const lh = n.lineHeight as { value: number; units: string } | undefined;
      if (lh) {
        if (lh.units === "PIXELS") {
          style.lineHeightPx = lh.value;
          style.lineHeightUnit = "PIXELS";
        } else if (lh.units === "PERCENT") {
          style.lineHeightPercentFontSize = lh.value;
          style.lineHeightPx = (lh.value / 100) * fontSize;
          style.lineHeightUnit = "FONT_SIZE_%";
        } else if (lh.units === "RAW") {
          style.lineHeightPercentFontSize = lh.value * 100;
          style.lineHeightPx = lh.value * fontSize;
          style.lineHeightUnit = "FONT_SIZE_%";
        }
      }
      const ls = n.letterSpacing as { value: number; units: string } | undefined;
      if (ls && ls.value) style.letterSpacing = ls.units === "PERCENT" ? (ls.value / 100) * fontSize : ls.value;
      if (n.textCase && n.textCase !== "ORIGINAL") style.textCase = n.textCase;
      if (n.textDecoration && n.textDecoration !== "NONE") style.textDecoration = n.textDecoration;
      if (n.paragraphSpacing) style.paragraphSpacing = n.paragraphSpacing;
      if (n.textTruncation === "ENDING") style.textTruncation = "ENDING";
      if (n.maxLines) style.maxLines = n.maxLines;
      out.style = style;
    }

    // Shared styles
    const styleRefs: Record<string, string> = {};
    const styleField = (field: string, key: string) => {
      const node = this.resolveRef(n[field]);
      if (!node) return;
      const id = guidStr(node.guid);
      styleRefs[key] = id;
      this.styles[id] = { key: (node.key as string) ?? "", name: node.name ?? id, styleType: (node.styleType as RestStyleMeta["styleType"]) ?? "FILL", description: (node.styleDescription as string) || undefined };
    };
    styleField("styleIdForFill", "fill");
    styleField("styleIdForStrokeFill", "stroke");
    styleField("styleIdForText", "text");
    styleField("styleIdForEffect", "effect");
    styleField("styleIdForGrid", "grid");
    if (Object.keys(styleRefs).length) out.styles = styleRefs;

    // Variables bound to non-paint fields
    const consumption = [
      ...((n.parameterConsumptionMap as { entries?: { variableData: unknown; variableField: string }[] } | undefined)?.entries ?? []),
      ...((n.variableConsumptionMap as { entries?: { variableData: unknown; variableField: string }[] } | undefined)?.entries ?? [])
    ];
    const fieldNames: Record<string, string> = {
      STACK_SPACING: "itemSpacing", STACK_PADDING_LEFT: "paddingLeft", STACK_PADDING_RIGHT: "paddingRight", STACK_PADDING_TOP: "paddingTop", STACK_PADDING_BOTTOM: "paddingBottom",
      CORNER_RADIUS: "cornerRadius", RECTANGLE_TOP_LEFT_CORNER_RADIUS: "topLeftRadius", RECTANGLE_TOP_RIGHT_CORNER_RADIUS: "topRightRadius", RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: "bottomLeftRadius",
      RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: "bottomRightRadius", WIDTH: "width", HEIGHT: "height", OPACITY: "opacity", FONT_FAMILY: "fontFamily", FONT_SIZE: "fontSize", FONT_STYLE: "fontStyle",
      LINE_HEIGHT: "lineHeight", LETTER_SPACING: "letterSpacing", STROKE_WEIGHT: "strokeWeight", VISIBLE: "visible", TEXT_DATA: "characters", PARAGRAPH_SPACING: "paragraphSpacing",
      STACK_COUNTER_SPACING: "counterAxisSpacing", MIN_WIDTH: "minWidth", MAX_WIDTH: "maxWidth", MIN_HEIGHT: "minHeight", MAX_HEIGHT: "maxHeight"
    };
    for (const e of consumption) {
      let data = e.variableData as { value?: { fontStyleValue?: { asFloat?: unknown } } };
      if (data?.value?.fontStyleValue?.asFloat) data = data.value.fontStyleValue.asFloat as typeof data;
      const id = this.variableId(data);
      if (id) bound[fieldNames[e.variableField] ?? e.variableField.toLowerCase()] = { type: "VARIABLE_ALIAS", id };
    }
    if (Object.keys(bound).length) out.boundVariables = bound;

    // Export settings
    const es = n.exportSettings as { imageType?: string; suffix?: string }[] | undefined;
    if (es?.length) out.exportSettings = es.map((e) => ({ format: e.imageType ?? "PNG", suffix: e.suffix ?? "" }));

    // Geometry (node-local coordinates) for SVG export
    const geo = (list: unknown) =>
      ((list as { commandsBlob?: number; windingRule?: string }[] | undefined) ?? [])
        .map((x) => ({ path: blobToPath(x.commandsBlob !== undefined ? this.g.blobs[x.commandsBlob] : undefined), windingRule: x.windingRule === "ODD" ? "EVENODD" : "NONZERO" }))
        .filter((x) => x.path);
    out.fillGeometry = geo(n.fillGeometry);
    out.strokeGeometry = geo(n.strokeGeometry);
    out._abs = abs;
    if (n.type === "TEXT") {
      const dtd = n.derivedTextData as { glyphs?: { commandsBlob?: number; position: { x: number; y: number }; fontSize: number }[] } | undefined;
      if (dtd?.glyphs?.length) {
        out._glyphPath = dtd.glyphs
          .map((gl) => (gl.commandsBlob !== undefined ? blobToPath(this.g.blobs[gl.commandsBlob], gl.fontSize, gl.position.x, gl.position.y, true) : ""))
          .join("");
      }
    }
  }

  // ---- component info ----

  private stateGroupOf(sym: KNode): KNode | undefined {
    const p = this.g.parentOf(sym);
    return p && p.isStateGroup ? p : undefined;
  }

  private registerComponent(sym: KNode) {
    const id = guidStr(sym.guid);
    if (this.components[id]) return;
    const set = this.stateGroupOf(sym);
    this.components[id] = {
      key: (sym.componentKey as string) ?? "",
      name: sym.name ?? id,
      description: (sym.symbolDescription as string) || undefined,
      ...(set ? { componentSetId: guidStr(set.guid) } : {}),
      remote: !!sym.sourceLibraryKey || undefined
    };
    if (set) {
      const sid = guidStr(set.guid);
      this.componentSets[sid] ??= { key: (set.componentKey as string) ?? "", name: set.name ?? sid, description: (set.symbolDescription as string) || undefined };
    }
  }

  private propDefs(sym: KNode): { id: string; name: string; type: string; initial: unknown; sort: string }[] {
    type Def = { id: Guid; name: string; type: string; initialValue?: unknown; sortPosition?: string };
    const defs = (sym.componentPropDefs as Def[] | undefined) ?? (this.stateGroupOf(sym)?.componentPropDefs as Def[] | undefined) ?? [];
    return defs.map((d) => ({ id: guidStr(d.id), name: d.name, type: d.type, initial: d.initialValue, sort: d.sortPosition ?? "" }));
  }

  /** Components and component sets defined in the loaded graph (optionally limited to some pages). */
  listComponents(pageIds?: string[]) {
    const pages = pageIds ? new Set(pageIds) : undefined;
    const usage = new Map<string, number>();
    for (const n of this.g.nodes.values()) {
      const sid = (n.symbolData as { symbolID?: Guid } | undefined)?.symbolID;
      if (n.type === "INSTANCE" && sid) usage.set(guidStr(sid), (usage.get(guidStr(sid)) ?? 0) + 1);
    }
    const out: { id: string; name: string; type: "COMPONENT" | "COMPONENT_SET"; page?: string; description?: string; key?: string; fromLibrary?: boolean; instances: number; properties?: Record<string, unknown>; variants?: { id: string; name: string; instances: number }[] }[] = [];
    for (const n of this.g.nodes.values()) {
      const isSet = n.type === "FRAME" && !!n.isStateGroup;
      if (n.type !== "SYMBOL" && !isSet) continue;
      if (n.type === "SYMBOL" && this.stateGroupOf(n)) continue; // listed under its set
      const page = this.g.pageOf(n);
      if (!page) continue;
      const internal = page.name === "Internal Only Canvas" || !!page.internalOnly;
      if (pages && !pages.has(guidStr(page.guid)) && !internal) continue;
      const id = guidStr(n.guid);
      const item: (typeof out)[number] = {
        id,
        name: n.name ?? id,
        type: isSet ? "COMPONENT_SET" : "COMPONENT",
        page: internal ? undefined : page.name,
        description: (n.symbolDescription as string) || undefined,
        key: (n.componentKey as string) || undefined,
        fromLibrary: internal || !!n.sourceLibraryKey || undefined,
        instances: usage.get(id) ?? 0
      };
      const defs = this.componentPropertyDefinitions(n);
      if (defs) item.properties = defs;
      if (isSet) {
        item.variants = this.g.childrenOf(id).filter((c) => c.type === "SYMBOL").map((c) => ({ id: guidStr(c.guid), name: c.name ?? "", instances: usage.get(guidStr(c.guid)) ?? 0 }));
        item.instances = item.variants.reduce((a, v) => a + v.instances, 0);
      }
      out.push(item);
    }
    return out.sort((a, b) => (a.fromLibrary === b.fromLibrary ? a.name.localeCompare(b.name) : a.fromLibrary ? 1 : -1));
  }

  private componentPropertyDefinitions(n: KNode): Record<string, unknown> | undefined {
    const defs = (n.componentPropDefs as { id: Guid; name: string; type: string; initialValue?: Record<string, unknown> }[] | undefined) ?? [];
    if (!defs.length) return undefined;
    const out: Record<string, unknown> = {};
    for (const d of defs) {
      if (d.type === "VARIANT") {
        const options = new Set<string>();
        for (const c of this.g.childrenOf(guidStr(n.guid))) {
          for (const part of (c.name ?? "").split(",")) {
            const [k, v] = part.split("=").map((s) => s.trim());
            if (k === d.name && v) options.add(v);
          }
        }
        out[d.name] = { type: "VARIANT", defaultValue: [...options][0], variantOptions: [...options] };
      } else {
        const iv = d.initialValue ?? {};
        const value = iv.textValue !== undefined ? (iv.textValue as { characters?: string }).characters ?? iv.textValue : iv.boolValue ?? (iv.guidValue ? guidStr(iv.guidValue as Guid) : undefined);
        out[`${d.name}#${guidStr(d.id)}`] = { type: d.type === "TEXT" ? "TEXT" : d.type === "BOOL" ? "BOOLEAN" : d.type === "INSTANCE_SWAP" ? "INSTANCE_SWAP" : d.type, defaultValue: value };
      }
    }
    return out;
  }

  // ---- tree building ----

  convert(rootId: string, opts: { maxDepth?: number } = {}): RestNode | undefined {
    const n = this.g.get(rootId);
    if (!n) return undefined;
    // Absolute transform of the root = product of ancestors' transforms up to the page.
    let abs = (n.transform as Matrix | undefined) ?? IDENTITY;
    let p = this.g.parentOf(n);
    while (p && p.type !== "CANVAS" && p.type !== "DOCUMENT") {
      abs = mul((p.transform as Matrix | undefined) ?? IDENTITY, abs);
      p = this.g.parentOf(p);
    }
    if (n.type === "CANVAS" || n.type === "DOCUMENT") abs = IDENTITY;
    return this.build(n, abs, this.g.parentOf(n), undefined, 0, opts.maxDepth ?? Infinity);
  }

  private build(raw: KNode, abs: Matrix, parent: KNode | undefined, scope: Scope | undefined, depth: number, maxDepth: number): RestNode | undefined {
    if (!raw.type || SKIP_TYPES.has(raw.type)) return undefined;
    if (raw.type === "CANVAS" && (raw.name === "Internal Only Canvas" || raw.internalOnly)) return undefined;

    // Apply instance-scope overrides, derived layout and component props to a copy.
    let n = raw;
    const key = nodeKey(raw);
    const myPath = scope ? [...scope.path, key] : [];
    if (scope) {
      n = { ...raw };
      const pk = myPath.join("/");
      const ov = scope.overrides.get(pk);
      if (ov) for (const [k, v] of Object.entries(ov)) if (k !== "guidPath" && k !== "overrideLevel") n[k] = v;
      const refs = (raw.componentPropRefs as { defID: Guid; componentPropNodeField: string; isDeleted?: boolean }[] | undefined) ?? [];
      for (const r of refs) {
        if (r.isDeleted) continue;
        const val = scope.props.get(guidStr(r.defID));
        if (!val) continue;
        if (r.componentPropNodeField === "TEXT_DATA" && val.textValue) n.textData = val.textValue;
        else if (r.componentPropNodeField === "VISIBLE" && typeof val.boolValue === "boolean") n.visible = val.boolValue;
        else if (r.componentPropNodeField === "OVERRIDDEN_SYMBOL_ID" && val.guidValue) n.overriddenSymbolID = val.guidValue;
      }
      const dv = scope.derived.get(pk);
      if (dv) for (const k of ["size", "transform", "fillGeometry", "strokeGeometry", "derivedTextData"]) if (dv[k] !== undefined) n[k] = dv[k];
    }

    const id = scope ? `${scope.idPrefix}${guidStr(raw.guid)}` : guidStr(raw.guid);
    const isStateGroup = !!raw.isStateGroup && raw.type === "FRAME";
    const type = raw.type === "SYMBOL" ? "COMPONENT" : isStateGroup ? "COMPONENT_SET" : raw.type === "ROUNDED_RECTANGLE" ? "RECTANGLE" : raw.type;
    const out: RestNode = { id, name: n.name ?? "", type };
    if (type === "DOCUMENT") {
      // nothing else
    } else if (type === "CANVAS") {
      const bg = (n.backgroundColor as unknown) ?? undefined;
      if (bg) out.backgroundColor = bg;
    } else {
      this.convertProps(n, abs, parent, out);
    }
    if (n.type === "SYMBOL") {
      this.registerComponent(raw);
      const defs = this.componentPropertyDefinitions(raw);
      if (defs) out.componentPropertyDefinitions = defs;
    }
    if (isStateGroup) {
      const defs = this.componentPropertyDefinitions(raw);
      if (defs) out.componentPropertyDefinitions = defs;
      const sid = guidStr(raw.guid);
      this.componentSets[sid] ??= { key: (raw.componentKey as string) ?? "", name: raw.name ?? sid, description: (raw.symbolDescription as string) || undefined };
    }

    let kids: { node: KNode; scope: Scope | undefined; parentAbs: Matrix }[] = [];
    if (n.type === "INSTANCE") {
      const sd = (n.symbolData as { symbolID?: Guid; symbolOverrides?: Override[] } | undefined) ?? {};
      const symId = guidStr(((n.overriddenSymbolID as Guid | undefined) ?? sd.symbolID ?? { sessionID: 0, localID: 0 }) as Guid);
      const master = this.g.get(symId);
      out.componentId = symId;
      if (!master) {
        out.missingComponent = true;
      } else {
        this.registerComponent(master);
        // Own overrides first, then the enclosing scope's overrides for paths under this instance (outer wins).
        const overrides = new Map<string, Override>();
        const derived = new Map<string, Override>();
        for (const o of sd.symbolOverrides ?? []) if (o.guidPath?.guids?.length) merge(overrides, pathKey(o.guidPath.guids), o);
        for (const d of (n.derivedSymbolData as Override[] | undefined) ?? []) if (d.guidPath?.guids?.length) merge(derived, pathKey(d.guidPath.guids), d);
        if (scope) {
          const prefix = myPath.join("/") + "/";
          for (const [k, v] of scope.overrides) if (k.startsWith(prefix)) merge(overrides, k.slice(prefix.length), v);
          for (const [k, v] of scope.derived) if (k.startsWith(prefix)) merge(derived, k.slice(prefix.length), v);
        }
        // Component property values: defaults, then the instance's assignments.
        const props = new Map<string, Record<string, unknown>>();
        const defs = this.propDefs(master);
        for (const d of defs) if (d.initial) props.set(d.id, d.initial as Record<string, unknown>);
        for (const a of (n.componentPropAssignments as { defID: Guid; value: Record<string, unknown> }[] | undefined) ?? []) props.set(guidStr(a.defID), a.value);
        // Report instance props like the REST API.
        const cp: Record<string, { type: string; value: unknown }> = {};
        for (const d of defs) {
          if (d.type === "VARIANT") continue;
          const v = props.get(d.id);
          if (!v) continue;
          const value = v.textValue !== undefined ? (v.textValue as { characters?: string }).characters : v.boolValue ?? (v.guidValue ? this.g.get(guidStr(v.guidValue as Guid))?.name ?? guidStr(v.guidValue as Guid) : undefined);
          cp[`${d.name}#${d.id}`] = { type: d.type === "BOOL" ? "BOOLEAN" : d.type, value };
        }
        for (const part of (master.name ?? "").split(",")) {
          const [k, v] = part.split("=").map((s) => s.trim());
          if (k && v !== undefined && this.stateGroupOf(master)) cp[k] = { type: "VARIANT", value: v };
        }
        if (Object.keys(cp).length) out.componentProperties = cp;
        const childScope: Scope = { overrides, derived, props, path: [], idPrefix: id.startsWith("I") ? `${id};` : `I${id};` };
        // Children are positioned relative to the instance; Figma keeps the master's relative transforms.
        kids = this.g.childrenOf(symId).map((c) => ({ node: c, scope: childScope, parentAbs: abs }));
      }
    } else {
      // guidPaths only grow at instance boundaries: inside one master every node is addressed by its own key.
      kids = this.g.childrenOf(guidStr(raw.guid)).map((c) => ({ node: c, scope, parentAbs: abs }));
    }

    if (kids.length) {
      if (depth >= maxDepth) {
        out.children = [];
        out.childCount = kids.length;
      } else {
        const children: RestNode[] = [];
        for (const k of kids) {
          const local = (this.peekTransform(k.node, k.scope) ?? IDENTITY) as Matrix;
          const childAbs = n.type === "CANVAS" || n.type === "DOCUMENT" ? local : mul(k.parentAbs, local);
          const c = this.build(k.node, childAbs, n, k.scope, depth + 1, maxDepth);
          if (c) children.push(c);
        }
        out.children = children;
      }
    }
    return out;
  }

  /** The child's transform after derived-layout overrides, needed before building it. */
  private peekTransform(child: KNode, scope: Scope | undefined): Matrix | undefined {
    if (scope) {
      const pk = [...scope.path, nodeKey(child)].join("/");
      const d = scope.derived.get(pk)?.transform ?? scope.overrides.get(pk)?.transform;
      if (d) return d as Matrix;
    }
    return child.transform as Matrix | undefined;
  }

  result(document: RestNode): ConvertResult {
    return { document, components: this.components, componentSets: this.componentSets, styles: this.styles, variables: this.variables };
  }

  /** Every variable and collection in the loaded graph, with resolved values per mode. */
  listVariables() {
    const sets = new Map<string, { id: string; name: string; modes: { modeId: string; name: string }[] }>();
    for (const n of this.g.nodes.values()) {
      if (n.type !== "VARIABLE_SET") continue;
      const modes = ((n.variableSetModes as { id: Guid; name: string }[] | undefined) ?? []).map((m) => ({ modeId: guidStr(m.id), name: m.name }));
      sets.set(guidStr(n.guid), { id: guidStr(n.guid), name: n.name ?? "", modes });
    }
    const vars: { id: string; name: string; collection: string; type: string; description?: string; values: Record<string, unknown> }[] = [];
    for (const n of this.g.nodes.values()) {
      if (n.type !== "VARIABLE") continue;
      const setId = guidStr(((n.variableSetID as { guid?: Guid } | undefined)?.guid ?? { sessionID: 0, localID: 0 }) as Guid);
      const set = sets.get(setId);
      const values: Record<string, unknown> = {};
      for (const e of (n.variableDataValues as { entries?: { modeID: Guid; variableData: { value?: Record<string, unknown>; dataType?: string } }[] } | undefined)?.entries ?? []) {
        const modeName = set?.modes.find((m) => m.modeId === guidStr(e.modeID))?.name ?? guidStr(e.modeID);
        values[modeName] = this.variableValue(e.variableData);
      }
      vars.push({ id: guidStr(n.guid), name: n.name ?? "", collection: set?.name ?? setId, type: (n.variableResolvedType as string) ?? "?", description: (n.description as string) || undefined, values });
    }
    return { collections: [...sets.values()], variables: vars };
  }

  private variableValue(d: { value?: Record<string, unknown>; dataType?: string }): unknown {
    const v = d.value ?? {};
    if (v.alias) {
      const node = this.resolveRef(v.alias);
      return { alias: node?.name ?? "(library variable)" };
    }
    if (v.colorValue) {
      const c = v.colorValue as { r: number; g: number; b: number; a: number };
      const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
      return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}${c.a < 1 ? hex(c.a) : ""}`.toUpperCase();
    }
    if (v.floatValue !== undefined) return v.floatValue;
    if (v.boolValue !== undefined) return v.boolValue;
    if (v.textValue !== undefined) return v.textValue;
    return v;
  }

  /** Local styles (fill/text/effect/grid) defined in the file. */
  listStyles() {
    const out: { id: string; name: string; type: string; description?: string; value: unknown }[] = [];
    for (const n of this.g.nodes.values()) {
      if (!n.styleType || n.type === "VARIABLE") continue;
      const tmp: RestNode = { id: guidStr(n.guid), name: n.name ?? "", type: String(n.type) };
      this.convertProps(n, IDENTITY, undefined, tmp);
      let value: unknown;
      if (n.styleType === "FILL") value = tmp.fills;
      else if (n.styleType === "TEXT") value = tmp.style;
      else if (n.styleType === "EFFECT") value = tmp.effects;
      else value = n.layoutGrids;
      out.push({ id: tmp.id, name: tmp.name, type: String(n.styleType), description: (n.styleDescription as string) || undefined, value });
    }
    return out;
  }
}

function merge(map: Map<string, Override>, key: string, o: Override) {
  const cur = map.get(key);
  map.set(key, cur ? { ...cur, ...o } : { ...o });
}
