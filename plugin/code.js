// Figma MCP Bridge — runs inside Figma and executes commands from the figma-mcp-v2 server.
// The UI iframe holds the WebSocket; this main thread has the Figma API.

figma.showUI(__html__, { width: 300, height: 190, title: "Figma MCP Bridge", themeColors: true });

// Reads that need extra manifest permissions must not stop the plugin from starting.
function safe(f) {
  try {
    return f();
  } catch (e) {
    return undefined;
  }
}

function fileInfo() {
  return {
    fileKey: safe(() => figma.fileKey) || undefined,
    fileName: figma.root.name,
    pageName: figma.currentPage.name,
    user: safe(() => (figma.currentUser ? figma.currentUser.name : undefined)),
    editorType: figma.editorType,
    pluginVersion: "0.4.0"
  };
}
figma.ui.postMessage({ type: "info", info: fileInfo() });
figma.on("currentpagechange", () => figma.ui.postMessage({ type: "info_update", info: { pageName: figma.currentPage.name } }));

// ---------- helpers ----------

async function getNode(id) {
  if (!id) throw new Error("nodeId is required");
  const n = await figma.getNodeByIdAsync(String(id).replace(/-/g, ":"));
  if (!n) throw new Error("Node " + id + " not found in this file");
  return n;
}

async function getParent(id) {
  if (!id) return figma.currentPage;
  const p = await getNode(id);
  if (!("appendChild" in p)) throw new Error("Node " + id + " (" + p.type + ") cannot have children");
  return p;
}

function hexToRgba(hex) {
  let h = String(hex).trim().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) throw new Error("Invalid color: " + hex);
  const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

function parseColor(c) {
  if (typeof c === "string") {
    const m = /^rgba?\(([^)]+)\)$/i.exec(c.trim());
    if (m) {
      const p = m[1].split(",").map((s) => parseFloat(s));
      return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p.length > 3 ? p[3] : 1 };
    }
    return hexToRgba(c);
  }
  if (c && typeof c === "object" && "r" in c) {
    const big = c.r > 1 || c.g > 1 || c.b > 1;
    const d = big ? 255 : 1;
    return { r: c.r / d, g: c.g / d, b: c.b / d, a: c.a === undefined ? 1 : c.a };
  }
  throw new Error("Invalid color: " + JSON.stringify(c));
}

// Accepts "#hex", {r,g,b,a}, a Paint, or an array of those.
function toPaints(v) {
  if (v === null || v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((p) => {
    if (p && typeof p === "object" && p.type) {
      if (p.type === "SOLID" && p.color) {
        const c = parseColor(p.color);
        return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: p.opacity !== undefined ? p.opacity : c.a, visible: p.visible !== false };
      }
      return p;
    }
    const c = parseColor(p);
    return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
  });
}

async function loadFontsFor(node) {
  if (node.type !== "TEXT") return;
  if (node.fontName === figma.mixed) {
    const fonts = node.getRangeAllFontNames(0, node.characters.length);
    await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
  } else await figma.loadFontAsync(node.fontName);
}

async function setFont(node, family, style) {
  const fontName = { family: family || (node.fontName !== figma.mixed ? node.fontName.family : "Inter"), style: style || "Regular" };
  await figma.loadFontAsync(fontName);
  node.fontName = fontName;
}

function summary(n) {
  const s = { id: n.id, name: n.name, type: n.type };
  if ("x" in n) Object.assign(s, { x: n.x, y: n.y, width: n.width, height: n.height });
  if (n.parent) s.parentId = n.parent.id;
  if (n.type === "TEXT") s.characters = n.characters;
  return s;
}

// Applies a flat property bag to a node. Unknown keys are assigned directly (Figma validates them).
async function applyProps(node, props) {
  if (!props) return;
  const p = Object.assign({}, props);
  if (node.type === "TEXT") {
    await loadFontsFor(node);
    if (p.fontFamily || p.fontStyle) {
      await setFont(node, p.fontFamily, p.fontStyle);
      delete p.fontFamily;
      delete p.fontStyle;
    }
    if (p.fontName) {
      await figma.loadFontAsync(p.fontName);
      node.fontName = p.fontName;
      delete p.fontName;
    }
    if (p.characters !== undefined) {
      node.characters = String(p.characters);
      delete p.characters;
    }
    if (typeof p.lineHeight === "number") p.lineHeight = { value: p.lineHeight, unit: "PIXELS" };
    if (typeof p.letterSpacing === "number") p.letterSpacing = { value: p.letterSpacing, unit: "PIXELS" };
  }
  if (p.width !== undefined || p.height !== undefined) {
    if ("resize" in node) node.resize(p.width !== undefined ? p.width : node.width, p.height !== undefined ? p.height : node.height);
    delete p.width;
    delete p.height;
  }
  if (p.fills !== undefined) {
    node.fills = toPaints(p.fills);
    delete p.fills;
  }
  if (p.fill !== undefined) {
    node.fills = toPaints(p.fill);
    delete p.fill;
  }
  if (p.strokes !== undefined) {
    node.strokes = toPaints(p.strokes);
    delete p.strokes;
  }
  if (p.stroke !== undefined) {
    node.strokes = toPaints(p.stroke);
    delete p.stroke;
  }
  if (p.padding !== undefined) {
    const v = p.padding;
    const [t, r, b, l] = Array.isArray(v) ? (v.length === 2 ? [v[0], v[1], v[0], v[1]] : v) : [v, v, v, v];
    Object.assign(node, { paddingTop: t, paddingRight: r, paddingBottom: b, paddingLeft: l });
    delete p.padding;
  }
  if (p.effects !== undefined) {
    node.effects = p.effects.map((e) => (e.color ? Object.assign({}, e, { color: parseColor(e.color) }) : e));
    delete p.effects;
  }
  // Auto layout must be on before sizing modes that depend on it.
  if (p.layoutMode !== undefined) {
    node.layoutMode = p.layoutMode;
    delete p.layoutMode;
  }
  const errors = [];
  for (const k of Object.keys(p)) {
    try {
      node[k] = p[k];
    } catch (e) {
      errors.push(k + ": " + e.message);
    }
  }
  if (errors.length) throw new Error("Some properties could not be set: " + errors.join("; "));
}

function walkIds(v, out) {
  if (Array.isArray(v)) v.forEach((x) => walkIds(x, out));
  else if (v && typeof v === "object") {
    if (v.type === "VARIABLE_ALIAS" && v.id) out.add(v.id);
    for (const k in v) walkIds(v[k], out);
  }
}

// ---------- build_layout: declarative tree -> real Figma layers ----------

const LAYOUT = { row: "HORIZONTAL", column: "VERTICAL", horizontal: "HORIZONTAL", vertical: "VERTICAL", grid: "GRID", none: "NONE" };
const MAIN = { start: "MIN", center: "CENTER", end: "MAX", between: "SPACE_BETWEEN", "space-between": "SPACE_BETWEEN" };
const CROSS = { start: "MIN", center: "CENTER", end: "MAX", baseline: "BASELINE" };
const TEXT_ALIGN = { left: "LEFT", center: "CENTER", right: "RIGHT", justify: "JUSTIFIED", justified: "JUSTIFIED" };
const WEIGHTS = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };
const norm = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, "");

function newBuildCtx() {
  return { refs: {}, warnings: [], count: 0, fonts: {}, available: null, vars: null, styles: null, anchors: [], arrows: [], notes: [], statuses: [] };
}

async function resolveFont(ctx, family, style) {
  const key = family + "/" + style;
  if (ctx.fonts[key]) return ctx.fonts[key];
  let fn = { family, style };
  try {
    await figma.loadFontAsync(fn);
  } catch (e) {
    // Style names differ between families ("SemiBold" vs "Semi Bold"); match loosely.
    if (!ctx.available) ctx.available = await figma.listAvailableFontsAsync();
    const fam = ctx.available.filter((f) => norm(f.fontName.family) === norm(family));
    const hit = fam.find((f) => norm(f.fontName.style) === norm(style)) || fam.find((f) => norm(f.fontName.style) === "regular") || fam[0];
    if (hit) fn = hit.fontName;
    else {
      ctx.warnings.push("Font " + family + " is not available in this Figma; used Inter instead.");
      fn = { family: "Inter", style: norm(style) === "semibold" ? "Semi Bold" : norm(style) === "extrabold" ? "Extra Bold" : style };
      try { await figma.loadFontAsync(fn); } catch (e2) { fn = { family: "Inter", style: "Regular" }; }
    }
    if (hit && norm(hit.fontName.style) !== norm(style)) ctx.warnings.push("Font " + key + " not found; used " + fn.family + " " + fn.style + ".");
    await figma.loadFontAsync(fn);
  }
  ctx.fonts[key] = fn;
  return fn;
}

// Variable by name. "name@Collection" picks a collection; otherwise ctx.collection (the build's default)
// is preferred, since light/dark collections often share variable names.
async function findVariable(ctx, name) {
  if (!ctx.vars) ctx.vars = await figma.variables.getLocalVariablesAsync();
  if (!ctx.cols) ctx.cols = await figma.variables.getLocalVariableCollectionsAsync();
  let colName = ctx.collection;
  let varName = name;
  const at = name.lastIndexOf("@");
  if (at > 0) { varName = name.slice(0, at); colName = name.slice(at + 1); }
  const col = colName ? ctx.cols.find((c) => c.name === colName || c.id === colName) : null;
  if (colName && !col) throw new Error("Variable collection '" + colName + "' not found");
  const matches = ctx.vars.filter((x) => (x.name === varName || x.id === varName) && (!col || x.variableCollectionId === col.id));
  if (!matches.length) throw new Error("Variable '" + name + "' not found");
  return matches[0];
}

async function findStyle(ctx, kind, name) {
  if (!ctx.styles) ctx.styles = {};
  if (!ctx.styles[kind]) {
    ctx.styles[kind] =
      kind === "text" ? await figma.getLocalTextStylesAsync() : kind === "effect" ? await figma.getLocalEffectStylesAsync() : await figma.getLocalPaintStylesAsync();
  }
  const s = ctx.styles[kind].find((x) => x.name === name || x.id === name);
  if (!s) throw new Error(kind + " style '" + name + "' not found");
  return s;
}

function isAutoLayout(n) {
  return !!n && n.type !== "PAGE" && typeof n.layoutMode === "string" && n.layoutMode !== "NONE";
}

function toEffects(spec) {
  const out = [];
  const shadows = spec.shadow ? (Array.isArray(spec.shadow) ? spec.shadow : [spec.shadow]) : [];
  for (const s of shadows) {
    const c = parseColor(s.color || "#00000026");
    out.push({ type: s.inset ? "INNER_SHADOW" : "DROP_SHADOW", color: c, offset: { x: s.x || 0, y: s.y || 0 }, radius: s.blur || 0, spread: s.spread || 0, visible: true, blendMode: "NORMAL" });
  }
  if (spec.blur) out.push({ type: "LAYER_BLUR", radius: spec.blur, visible: true });
  if (spec.backgroundBlur) out.push({ type: "BACKGROUND_BLUR", radius: spec.backgroundBlur, visible: true });
  return out;
}

async function applyVisual(node, spec, ctx) {
  if (spec.fill !== undefined && "fills" in node) node.fills = toPaints(spec.fill);
  if (spec.stroke !== undefined && "strokes" in node) {
    node.strokes = toPaints(spec.stroke);
    if (spec.strokeAlign) node.strokeAlign = String(spec.strokeAlign).toUpperCase();
  }
  if (spec.strokeWidth !== undefined) {
    const w = spec.strokeWidth;
    if (typeof w === "number") node.strokeWeight = w;
    else Object.assign(node, { strokeTopWeight: w.top || 0, strokeRightWeight: w.right || 0, strokeBottomWeight: w.bottom || 0, strokeLeftWeight: w.left || 0 });
  }
  if (spec.dash) node.dashPattern = spec.dash;
  if (spec.radius !== undefined && "cornerRadius" in node) {
    const r = spec.radius;
    if (Array.isArray(r)) Object.assign(node, { topLeftRadius: r[0], topRightRadius: r[1], bottomRightRadius: r[2], bottomLeftRadius: r[3] });
    else node.cornerRadius = r;
  }
  if (spec.smoothing !== undefined) node.cornerSmoothing = spec.smoothing;
  if (spec.opacity !== undefined) node.opacity = spec.opacity;
  if (spec.visible !== undefined) node.visible = spec.visible;
  if (spec.clip !== undefined && "clipsContent" in node) node.clipsContent = !!spec.clip;
  if (spec.shadow || spec.blur || spec.backgroundBlur) node.effects = toEffects(spec);
  if (spec.rotation !== undefined) node.rotation = spec.rotation;
  if (spec.blendMode) node.blendMode = spec.blendMode;
  if (spec.fillStyle) await node.setFillStyleIdAsync((await findStyle(ctx, "fill", spec.fillStyle)).id);
  if (spec.strokeStyle) await node.setStrokeStyleIdAsync((await findStyle(ctx, "fill", spec.strokeStyle)).id);
  if (spec.effectStyle) await node.setEffectStyleIdAsync((await findStyle(ctx, "effect", spec.effectStyle)).id);
}

function applyLayout(node, spec) {
  if (!("layoutMode" in node)) return;
  if (spec.layout) {
    const m = LAYOUT[String(spec.layout).toLowerCase()];
    if (!m) throw new Error("layout must be row, column or none");
    node.layoutMode = m;
    // New auto-layout frames hug their content unless a size is given.
    if (m !== "NONE") {
      node.primaryAxisSizingMode = "AUTO";
      node.counterAxisSizingMode = "AUTO";
    }
  }
  if (!isAutoLayout(node)) return;
  if (spec.gap !== undefined) {
    if (spec.gap === "auto") node.primaryAxisAlignItems = "SPACE_BETWEEN";
    else node.itemSpacing = spec.gap;
  }
  if (spec.rowGap !== undefined) node.counterAxisSpacing = spec.rowGap;
  if (spec.padding !== undefined) {
    const v = spec.padding;
    const [t, r, b, l] = Array.isArray(v) ? (v.length === 2 ? [v[0], v[1], v[0], v[1]] : v.length === 3 ? [v[0], v[1], v[2], v[1]] : v) : [v, v, v, v];
    Object.assign(node, { paddingTop: t, paddingRight: r, paddingBottom: b, paddingLeft: l });
  }
  if (spec.align) node.primaryAxisAlignItems = MAIN[spec.align] || spec.align;
  if (spec.cross) node.counterAxisAlignItems = CROSS[spec.cross] || spec.cross;
  if (spec.wrap) node.layoutWrap = "WRAP";
  if (spec.strokesIncluded !== undefined) node.strokesIncludedInLayout = !!spec.strokesIncluded;
  if (spec.reverseZ) node.itemReverseZIndex = true;
}

function applySize(node, spec, parent, ctx, path) {
  const parentAuto = isAutoLayout(parent);
  // Frames given auto layout here hug on any axis without an explicit size.
  const hugDefault = spec.layout && isAutoLayout(node) && node.type !== "INSTANCE";
  const w = spec.width !== undefined ? spec.width : hugDefault ? "hug" : undefined;
  const h = spec.height !== undefined ? spec.height : hugDefault ? "hug" : undefined;
  if (typeof w === "number" || typeof h === "number") {
    if (node.type === "LINE") node.resize(typeof w === "number" ? w : node.width, 0);
    else node.resize(typeof w === "number" ? Math.max(w, 0.01) : node.width, typeof h === "number" ? Math.max(h, 0.01) : node.height);
  }
  const canSize = parentAuto || isAutoLayout(node) || node.type === "TEXT";
  for (const [v, prop] of [[w, "layoutSizingHorizontal"], [h, "layoutSizingVertical"]]) {
    if (v === undefined) continue;
    let mode = typeof v === "number" ? "FIXED" : String(v).toUpperCase();
    if (mode === "AUTO") mode = "HUG";
    if (mode === "FILL" && !parentAuto) {
      ctx.warnings.push(path + ": '" + v + "' needs an auto-layout parent; size left as is.");
      continue;
    }
    if (mode === "HUG" && !(isAutoLayout(node) || node.type === "TEXT")) {
      ctx.warnings.push(path + ": 'hug' needs auto layout on this frame.");
      continue;
    }
    if (!canSize) continue;
    try {
      node[prop] = mode;
    } catch (e) {
      ctx.warnings.push(path + ": " + prop + "=" + mode + ": " + e.message);
    }
  }
  if (spec.minWidth !== undefined) node.minWidth = spec.minWidth;
  if (spec.maxWidth !== undefined) node.maxWidth = spec.maxWidth;
  if (spec.minHeight !== undefined) node.minHeight = spec.minHeight;
  if (spec.maxHeight !== undefined) node.maxHeight = spec.maxHeight;
  if (spec.grow !== undefined) node.layoutGrow = spec.grow;
}

async function applyText(node, spec, ctx) {
  let family = "Inter", style = "Regular";
  if (typeof spec.font === "string") {
    const [f, s] = spec.font.split("/");
    family = f;
    if (s) style = s;
  } else if (spec.font) {
    family = spec.font.family || family;
    style = spec.font.style || style;
  }
  if (spec.weight) style = WEIGHTS[spec.weight] || style;
  if (spec.italic) style = style === "Regular" ? "Italic" : style + " Italic";
  if (spec.textStyle) {
    const ts = await findStyle(ctx, "text", spec.textStyle);
    await figma.loadFontAsync(ts.fontName);
    node.fontName = ts.fontName;
    node.characters = String(spec.text !== undefined ? spec.text : "");
    await node.setTextStyleIdAsync(ts.id);
  } else {
    node.fontName = await resolveFont(ctx, family, style);
    node.characters = String(spec.text !== undefined ? spec.text : "");
    if (spec.size) node.fontSize = spec.size;
  }
  if (spec.lineHeight !== undefined) {
    const lh = spec.lineHeight;
    node.lineHeight = lh === "auto" ? { unit: "AUTO" } : typeof lh === "string" && lh.endsWith("%") ? { value: parseFloat(lh), unit: "PERCENT" } : { value: Number(lh), unit: "PIXELS" };
  }
  if (spec.letterSpacing !== undefined) {
    const ls = spec.letterSpacing;
    node.letterSpacing = typeof ls === "string" && ls.endsWith("%") ? { value: parseFloat(ls), unit: "PERCENT" } : { value: Number(ls), unit: "PIXELS" };
  }
  if (spec.color !== undefined) node.fills = toPaints(spec.color);
  if (spec.textAlign) node.textAlignHorizontal = TEXT_ALIGN[spec.textAlign] || spec.textAlign;
  if (spec.verticalAlign) node.textAlignVertical = { top: "TOP", center: "CENTER", bottom: "BOTTOM" }[spec.verticalAlign] || spec.verticalAlign;
  if (spec.decoration) node.textDecoration = { underline: "UNDERLINE", strikethrough: "STRIKETHROUGH", "line-through": "STRIKETHROUGH", none: "NONE" }[spec.decoration] || spec.decoration;
  if (spec.textCase) node.textCase = { upper: "UPPER", lower: "LOWER", title: "TITLE", "small-caps": "SMALL_CAPS", none: "ORIGINAL" }[spec.textCase] || spec.textCase;
  if (spec.features) node.setRangeOpenTypeFeatures && node.setRangeOpenTypeFeatures(0, node.characters.length, spec.features);
  if (spec.maxLines) {
    node.textTruncation = "ENDING";
    node.maxLines = spec.maxLines;
  }
  // Text sizing: fixed width wraps; "fill" wraps within the parent; otherwise grows to fit.
  if (typeof spec.width === "number") node.textAutoResize = typeof spec.height === "number" ? "NONE" : "HEIGHT";
  else node.textAutoResize = "WIDTH_AND_HEIGHT";
}

// Styled ranges: [{start, end, color?, weight?, font?, size?, decoration?}]. Applied after token
// bindings, which would otherwise repaint the whole text.
async function applyRanges(node, spec, ctx) {
  for (const r of spec.ranges || []) {
    const end = Math.min(r.end, node.characters.length);
    if (r.color) node.setRangeFills(r.start, end, toPaints(r.color));
    if (r.weight || r.font) {
      const f = typeof r.font === "string" ? r.font.split("/") : [node.getRangeFontName(r.start, r.start + 1).family, WEIGHTS[r.weight] || "Regular"];
      node.setRangeFontName(r.start, end, await resolveFont(ctx, f[0], f[1] || "Regular"));
    }
    if (r.size) node.setRangeFontSize(r.start, end, r.size);
    if (r.decoration) node.setRangeTextDecoration(r.start, end, r.decoration === "underline" ? "UNDERLINE" : "STRIKETHROUGH");
  }
}

async function applyBindings(node, bind, ctx, path) {
  for (const field of Object.keys(bind || {})) {
    try {
      const v = await findVariable(ctx, bind[field]);
      if (field === "fill" || field === "color" || field === "stroke") {
        const key = field === "stroke" ? "strokes" : "fills";
        const paints = node[key].length ? node[key].slice() : toPaints("#000000");
        paints[0] = figma.variables.setBoundVariableForPaint(paints[0], "color", v);
        node[key] = paints;
      } else if (field === "padding") {
        for (const k of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) node.setBoundVariable(k, v);
      } else if (field === "paddingX") {
        node.setBoundVariable("paddingLeft", v);
        node.setBoundVariable("paddingRight", v);
      } else if (field === "paddingY") {
        node.setBoundVariable("paddingTop", v);
        node.setBoundVariable("paddingBottom", v);
      } else if (field === "radius") {
        for (const k of ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"]) node.setBoundVariable(k, v);
      } else if (field === "gap") node.setBoundVariable("itemSpacing", v);
      else node.setBoundVariable(field, v);
    } catch (e) {
      ctx.warnings.push(path + ": bind " + field + ": " + e.message);
    }
  }
}

async function setInstanceProps(inst, props) {
  const defs = inst.componentProperties;
  const resolved = {};
  for (const k of Object.keys(props)) {
    const full = defs[k] ? k : Object.keys(defs).find((d) => d.split("#")[0] === k);
    if (!full) throw new Error("Unknown property '" + k + "'. Available: " + Object.keys(defs).map((d) => d.split("#")[0]).join(", "));
    resolved[full] = props[k];
  }
  inst.setProperties(resolved);
}

async function applyOverrides(inst, overrides, ctx, path) {
  for (const name of Object.keys(overrides || {})) {
    const target = inst.findOne((n) => n.name === name);
    if (!target) {
      ctx.warnings.push(path + ": no layer named '" + name + "' to override");
      continue;
    }
    const o = typeof overrides[name] === "string" ? { text: overrides[name] } : overrides[name];
    try {
      if (target.type === "TEXT" && (o.text !== undefined || o.color || o.decoration)) {
        await loadFontsFor(target);
        if (o.text !== undefined) target.characters = String(o.text);
        if (o.color) target.fills = toPaints(o.color);
        if (o.decoration) target.textDecoration = o.decoration === "none" ? "NONE" : o.decoration === "underline" ? "UNDERLINE" : "STRIKETHROUGH";
      }
      if (target.type === "INSTANCE" && (o.variant || o.properties)) await setInstanceProps(target, Object.assign({}, o.variant || {}, o.properties || {}));
      await applyVisual(target, o, ctx);
      if (o.bind) await applyBindings(target, o.bind, ctx, path + "/" + name);
    } catch (e) {
      ctx.warnings.push(path + ": override '" + name + "': " + e.message);
    }
  }
}

async function addComponentProps(comp, defs, ctx, path) {
  for (const d of defs || []) {
    try {
      const type = String(d.type || "TEXT").toUpperCase();
      let def = d.default;
      if (type === "INSTANCE_SWAP") {
        const c = d.defaultRef ? ctx.refs[d.defaultRef] : await getNode(d.default);
        def = c.type === "COMPONENT_SET" ? c.defaultVariant.id : c.id;
      }
      if (def === undefined) def = type === "BOOLEAN" ? true : "";
      const key = comp.addComponentProperty(d.name, type, def);
      for (const layerName of [].concat(d.layer || d.layers || [])) {
        // In a component set every variant's layer with this name gets the property.
        const layers = comp.findAll((n) => n.name === layerName);
        if (!layers.length) {
          ctx.warnings.push(path + ": component property '" + d.name + "': no layer named '" + layerName + "'");
          continue;
        }
        const field = type === "TEXT" ? "characters" : type === "BOOLEAN" ? "visible" : "mainComponent";
        for (const layer of layers) layer.componentPropertyReferences = Object.assign({}, layer.componentPropertyReferences || {}, { [field]: key });
      }
    } catch (e) {
      ctx.warnings.push(path + ": component property '" + d.name + "': " + e.message);
    }
  }
}

async function buildNode(spec, parent, ctx, path, index) {
  const type = String(spec.type || (spec.text !== undefined ? "text" : "frame")).toLowerCase();
  path = path + "/" + (spec.name || type);
  let node;

  if (type === "componentset" || type === "component_set" || type === "variants") {
    const variants = [];
    for (const child of spec.children || []) {
      const c = await buildNode(Object.assign({}, child, { type: "component" }), parent, ctx, path);
      if (c) variants.push(c);
    }
    if (!variants.length) throw new Error(path + ": a component set needs component children");
    node = figma.combineAsVariants(variants, parent);
    if (spec.name) node.name = spec.name;
    applyLayout(node, Object.assign({ layout: "row", gap: 24, padding: 24 }, spec));
    await applyVisual(node, Object.assign({ stroke: "#9747FF", dash: [6, 4], radius: 8 }, spec), ctx);
    if (spec.x !== undefined) node.x = spec.x;
    if (spec.y !== undefined) node.y = spec.y;
    if (spec.description) node.description = spec.description;
    if (spec.componentProps) await addComponentProps(node, spec.componentProps, ctx, path);
    if (spec.ref) ctx.refs[spec.ref] = node;
    ctx.count++;
    return node;
  }

  if (type === "arrow") {
    // Drawn after the whole tree exists, when both ends have their final positions.
    ctx.arrows.push({ spec, parent, path });
    return null;
  }

  if (type === "section") {
    node = figma.createSection();
    parent.appendChild(node);
    ctx.count++;
    if (spec.name) node.name = spec.name;
    if (spec.ref) ctx.refs[spec.ref] = node;
    if (spec.x !== undefined) node.x = spec.x;
    if (spec.y !== undefined) node.y = spec.y;
    if (spec.fill !== undefined) node.fills = toPaints(spec.fill);
    for (const child of spec.children || []) {
      try {
        await buildNode(child, node, ctx, path);
      } catch (e) {
        ctx.warnings.push(e.message);
      }
    }
    // Sections have no auto layout: fit them around their content with even padding.
    const pad = spec.padding !== undefined ? spec.padding : 120;
    const kids = node.children;
    if (kids.length) {
      const minX = Math.min.apply(null, kids.map((k) => k.x)), minY = Math.min.apply(null, kids.map((k) => k.y));
      for (const k of kids) { k.x += pad - minX; k.y += pad - minY; }
      const maxX = Math.max.apply(null, kids.map((k) => k.x + k.width)), maxY = Math.max.apply(null, kids.map((k) => k.y + k.height));
      node.resizeWithoutConstraints(typeof spec.width === "number" ? spec.width : maxX + pad, typeof spec.height === "number" ? spec.height : maxY + pad);
    } else if (typeof spec.width === "number") node.resizeWithoutConstraints(spec.width, spec.height || 400);
    if (spec.bind) await applyBindings(node, spec.bind, ctx, path);
    if (spec.devStatus) ctx.statuses.push({ node, status: spec.devStatus, path });
    return node;
  }

  switch (type) {
    case "frame": node = figma.createFrame(); node.fills = []; break;
    case "component": node = figma.createComponent(); node.fills = []; break;
    case "rect": case "rectangle": node = figma.createRectangle(); break;
    case "ellipse": case "circle": node = figma.createEllipse(); break;
    case "line": node = figma.createLine(); break;
    case "text": node = figma.createText(); break;
    case "svg": case "vector": case "icon": {
      if (!spec.svg) throw new Error(path + ": svg is required");
      node = figma.createNodeFromSvg(spec.svg);
      break;
    }
    case "instance": {
      let comp = spec.componentRef ? ctx.refs[spec.componentRef] : spec.componentKey ? await figma.importComponentByKeyAsync(spec.componentKey) : await getNode(spec.componentId);
      if (!comp) throw new Error(path + ": unknown componentRef '" + spec.componentRef + "' (components must be built before their instances)");
      if (comp.type === "COMPONENT_SET") comp = comp.defaultVariant;
      node = comp.createInstance();
      break;
    }
    default: throw new Error(path + ": unknown type '" + spec.type + "'. Use frame, text, rect, ellipse, line, svg, instance, component or componentSet.");
  }
  if (index !== undefined) parent.insertChild(index, node);
  else parent.appendChild(node);
  ctx.count++;
  if (spec.name) node.name = spec.name;
  if (spec.ref) ctx.refs[spec.ref] = node;

  try {
    if (type === "text") await applyText(node, spec, ctx);
    if (type === "instance") {
      if (spec.properties || spec.variant) await setInstanceProps(node, Object.assign({}, spec.variant || {}, spec.properties || {}));
      if (spec.overrides) await applyOverrides(node, spec.overrides, ctx, path);
    }
    applyLayout(node, spec);
    if (type !== "text") await applyVisual(node, spec, ctx);
    else {
      const vis = Object.assign({}, spec);
      delete vis.fill;
      await applyVisual(node, vis, ctx);
      if (spec.fill !== undefined && spec.color === undefined) node.fills = toPaints(spec.fill);
    }
    if (spec.svgColor && "findAll" in node) {
      // Recolor the drawn shapes only; the wrapper frames an SVG import creates must stay transparent.
      const SHAPES = ["VECTOR", "BOOLEAN_OPERATION", "ELLIPSE", "RECTANGLE", "POLYGON", "STAR", "LINE"];
      for (const v of node.findAll((n) => SHAPES.indexOf(n.type) >= 0)) {
        if (v.fills && v.fills.length) v.fills = toPaints(spec.svgColor);
        if (v.strokes && v.strokes.length) v.strokes = toPaints(spec.svgColor);
      }
    }
    if (spec.position === "absolute" && isAutoLayout(parent)) node.layoutPositioning = "ABSOLUTE";
    if (spec.x !== undefined && (!isAutoLayout(parent) || spec.position === "absolute")) node.x = spec.x;
    if (spec.y !== undefined && (!isAutoLayout(parent) || spec.position === "absolute")) node.y = spec.y;
    if (spec.constraints) node.constraints = spec.constraints;
    if (spec.anchor) ctx.anchors.push({ node, anchor: spec.anchor, path });
    if (spec.annotation) ctx.notes.push({ node, note: spec.annotation, path });
    if (spec.devStatus) ctx.statuses.push({ node, status: spec.devStatus, path });
    applySize(node, spec, parent, ctx, path);
    if (type === "text" && (spec.width === "fill" || typeof spec.width === "number") && spec.height === undefined) node.textAutoResize = "HEIGHT";
  } catch (e) {
    ctx.warnings.push(path + ": " + e.message);
  }

  if ("appendChild" in node && type !== "instance") {
    for (const child of spec.children || []) {
      try {
        await buildNode(child, node, ctx, path);
      } catch (e) {
        ctx.warnings.push(e.message);
      }
    }
  }
  if (type === "component") {
    if (spec.description) node.description = spec.description;
    if (spec.componentProps) await addComponentProps(node, spec.componentProps, ctx, path);
  }
  if (spec.bind) await applyBindings(node, spec.bind, ctx, path);
  if (type === "text" && spec.ranges) {
    try {
      await applyRanges(node, spec, ctx);
    } catch (e) {
      ctx.warnings.push(path + ": ranges: " + e.message);
    }
  }
  if (spec.props) {
    try {
      await applyProps(node, spec.props);
    } catch (e) {
      ctx.warnings.push(path + ": " + e.message);
    }
  }
  return node;
}

// Pins a node to its parent's edges after layout: {left, right, top, bottom, above: "sibling name"}.
// "above" measures bottom from that sibling's top edge (e.g. a button floating over a nav bar).
function resolveAnchor(node, a, ctx, path) {
  const parent = node.parent;
  if (isAutoLayout(parent)) node.layoutPositioning = "ABSOLUTE";
  const c = { horizontal: "MIN", vertical: "MIN" };
  if (a.left !== undefined) node.x = a.left;
  if (a.right !== undefined) { node.x = parent.width - a.right - node.width; c.horizontal = a.left !== undefined ? "STRETCH" : "MAX"; }
  if (a.centerX) { node.x = (parent.width - node.width) / 2; c.horizontal = "CENTER"; }
  if (a.top !== undefined) node.y = a.top;
  let bottomEdge = parent.height;
  if (a.above) {
    const sib = parent.children.find((k) => k.name === a.above && k !== node);
    if (sib) bottomEdge = sib.y;
    else ctx.warnings.push(path + ": anchor.above: no sibling named '" + a.above + "'");
  }
  if (a.bottom !== undefined || a.above) { node.y = bottomEdge - (a.bottom || 0) - node.height; c.vertical = a.above ? "MAX" : a.top !== undefined ? "STRETCH" : "MAX"; }
  try { node.constraints = c; } catch (e) {}
}

function absBox(n) {
  const t = n.absoluteTransform;
  return { x: t[0][2], y: t[1][2], w: n.width, h: n.height };
}

// Orthogonal connector between two nodes, with an arrowhead at the end.
async function drawArrow(item, ctx) {
  const { spec, parent, path } = item;
  const from = typeof spec.from === "string" && ctx.refs[spec.from] ? ctx.refs[spec.from] : await getNode(spec.from);
  const to = typeof spec.to === "string" && ctx.refs[spec.to] ? ctx.refs[spec.to] : await getNode(spec.to);
  const a = absBox(from), b = absBox(to);
  const origin = parent.type === "PAGE" ? { x: 0, y: 0 } : absBox(parent);
  const gap = spec.gap !== undefined ? spec.gap : 16;
  let side = spec.fromSide;
  if (!side) side = b.x >= a.x + a.w ? "right" : b.x + b.w <= a.x ? "left" : b.y >= a.y + a.h ? "bottom" : "top";
  let p1, p2, pts;
  if (side === "right" || side === "left") {
    const dir = side === "right" ? 1 : -1;
    p1 = { x: side === "right" ? a.x + a.w + gap : a.x - gap, y: a.y + a.h / 2 };
    p2 = { x: side === "right" ? b.x - gap : b.x + b.w + gap, y: b.y + b.h / 2 };
    if (spec.toSide === "top") { p2 = { x: b.x + b.w / 2, y: b.y - gap }; pts = [p1, { x: p2.x, y: p1.y }, p2]; }
    else { const mx = p1.x + (p2.x - p1.x) / 2; pts = Math.abs(p1.y - p2.y) < 1 ? [p1, p2] : [p1, { x: mx, y: p1.y }, { x: mx, y: p2.y }, p2]; }
    void dir;
  } else {
    p1 = { x: a.x + a.w / 2, y: side === "bottom" ? a.y + a.h + gap : a.y - gap };
    p2 = { x: b.x + b.w / 2, y: side === "bottom" ? b.y - gap : b.y + b.h + gap };
    const my = p1.y + (p2.y - p1.y) / 2;
    pts = Math.abs(p1.x - p2.x) < 1 ? [p1, p2] : [p1, { x: p1.x, y: my }, { x: p2.x, y: my }, p2];
  }
  const minX = Math.min.apply(null, pts.map((p) => p.x)), minY = Math.min.apply(null, pts.map((p) => p.y));
  const v = figma.createVector();
  parent.appendChild(v);
  if (isAutoLayout(parent)) v.layoutPositioning = "ABSOLUTE";
  await v.setVectorNetworkAsync({
    vertices: pts.map((p, i) => Object.assign({ x: p.x - minX, y: p.y - minY }, i === pts.length - 1 ? { strokeCap: "ARROW_LINES" } : {})),
    segments: pts.slice(1).map((_, i) => ({ start: i, end: i + 1 })),
    regions: []
  });
  v.x = minX - origin.x;
  v.y = minY - origin.y;
  v.name = spec.name || "Arrow " + (from.name || "") + " → " + (to.name || "");
  v.strokes = toPaints(spec.color || "#4A4F5E");
  v.strokeWeight = spec.strokeWidth || 2;
  v.strokeJoin = "ROUND";
  v.cornerRadius = spec.radius !== undefined ? spec.radius : 16;
  if (spec.dash) v.dashPattern = spec.dash;
  if (spec.ref) ctx.refs[spec.ref] = v;
  ctx.count++;
  void path;
}

// Grows a section so all its children fit, keeping the current left/top padding on the other sides.
function fitSection(sec) {
  const kids = sec.children;
  if (!kids.length) return;
  const pad = Math.max(0, Math.min.apply(null, kids.map((k) => Math.min(k.x, k.y))));
  const maxX = Math.max.apply(null, kids.map((k) => k.x + k.width)), maxY = Math.max.apply(null, kids.map((k) => k.y + k.height));
  sec.resizeWithoutConstraints(Math.max(sec.width, maxX + pad), Math.max(sec.height, maxY + pad));
}

function enclosingSection(n) {
  for (let p = n.parent; p; p = p.parent) if (p.type === "SECTION") return p;
  return null;
}

async function finishBuild(ctx) {
  for (const a of ctx.anchors) {
    try { resolveAnchor(a.node, a.anchor, ctx, a.path); } catch (e) { ctx.warnings.push(a.path + ": anchor: " + e.message); }
  }
  for (const item of ctx.arrows) {
    try { await drawArrow(item, ctx); } catch (e) { ctx.warnings.push(item.path + ": arrow: " + e.message); }
  }
  for (const it of ctx.notes) {
    const notes = Array.isArray(it.note) ? it.note : [it.note];
    try {
      await commands.annotate({ items: notes.map((x) => Object.assign({ nodeId: it.node.id }, typeof x === "string" ? { label: x } : x)) });
    } catch (e) { ctx.warnings.push(it.path + ": annotation: " + e.message); }
  }
  for (const it of ctx.statuses) {
    const st = typeof it.status === "string" ? { type: it.status } : it.status;
    try { it.node.devStatus = st; } catch (e) { ctx.warnings.push(it.path + ": devStatus: " + e.message + " (needs a top-level frame or section, and a plan with Dev Mode)"); }
  }
}


// ---------- design QA ----------

const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const luminance = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
// WCAG 2.2 contrast ratio between two opaque colors.
function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const over = (top, alpha, bottom) => ({ r: top.r * alpha + bottom.r * (1 - alpha), g: top.g * alpha + bottom.g * (1 - alpha), b: top.b * alpha + bottom.b * (1 - alpha) });

function visibleSolid(paints) {
  if (!paints || paints === figma.mixed) return null;
  for (let i = paints.length - 1; i >= 0; i--) {
    const p = paints[i];
    if (p.visible === false) continue;
    if (p.type === "SOLID") return p;
    return { unknown: true }; // image or gradient on top: background can't be computed reliably
  }
  return null;
}

// Color behind a node: the nearest opaque solid fill among its ancestors, with translucent fills in between blended over it.
function backgroundOf(node) {
  const layers = [];
  for (let p = node.parent; p && p.type !== "PAGE" && p.type !== "DOCUMENT"; p = p.parent) {
    if (!("fills" in p)) continue;
    const f = visibleSolid(p.fills);
    if (!f) continue;
    if (f.unknown) return null;
    const a = (f.opacity === undefined ? 1 : f.opacity) * (p.opacity === undefined ? 1 : p.opacity);
    layers.push({ color: f.color, a });
    if (a >= 0.999) break;
  }
  let bg = { r: 1, g: 1, b: 1 }; // canvas
  for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i].color, layers[i].a, bg);
  return bg;
}

function effectiveOpacity(n) {
  let a = 1;
  for (let p = n; p && p.type !== "PAGE"; p = p.parent) if ("opacity" in p) a *= p.opacity;
  return a;
}

function insideInstance(n) {
  for (let p = n.parent; p; p = p.parent) if (p.type === "INSTANCE") return true;
  return false;
}

function isHidden(n) {
  for (let p = n; p && p.type !== "PAGE"; p = p.parent) if (p.visible === false) return true;
  return false;
}

const DEFAULT_NAME = /^(Frame|Group|Rectangle|Ellipse|Vector|Line|Text|Polygon|Star|Component|Instance|Section|Image|Union|Subtract)( \d+)?$/;
const INTERACTIVE = /button|btn|\bkey\b|^key |tab|checkbox|toggle|switch|chip|\bfab\b|add task|link|icon button|radio/i;
const TARGETS = { ios: 44, android: 48, web: 24 };

// ---------- tokens and themes ----------

const hexOf = (c) => "#" + [c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("").toUpperCase();

async function collectionByName(name) {
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const c = cols.find((x) => x.name === name || x.id === name);
  if (!c) throw new Error("Variable collection '" + name + "' not found. Collections: " + cols.map((x) => x.name).join(", "));
  return c;
}

// Rewrites every solid paint (fills, strokes, text ranges) in the subtrees through fn(paint, node) -> paint.
async function mapPaints(roots, fn) {
  let changed = 0;
  const visit = async (n) => {
    if (n.type === "TEXT" && n.fills === figma.mixed) {
      let loaded = false;
      for (const seg of n.getStyledTextSegments(["fills"])) {
        const next = seg.fills.map((p) => (p.type === "SOLID" ? fn(p, n) : p));
        if (next.some((p, i) => p !== seg.fills[i])) {
          if (!loaded) { for (const f of n.getRangeAllFontNames(0, n.characters.length)) await figma.loadFontAsync(f); loaded = true; }
          n.setRangeFills(seg.start, seg.end, next);
          changed++;
        }
      }
    } else if ("fills" in n && n.fills !== figma.mixed && n.fills.length) {
      const next = n.fills.map((p) => (p.type === "SOLID" ? fn(p, n) : p));
      if (next.some((p, i) => p !== n.fills[i])) { n.fills = next; changed++; }
    }
    if ("strokes" in n && n.strokes.length) {
      const next = n.strokes.map((p) => (p.type === "SOLID" ? fn(p, n) : p));
      if (next.some((p, i) => p !== n.strokes[i])) { n.strokes = next; changed++; }
    }
  };
  for (const r of roots) {
    await visit(r);
    if ("findAll" in r) for (const n of r.findAll(() => true)) await visit(n);
  }
  return changed;
}

function outline(n, depth) {
  const o = { id: n.id, name: n.name, type: n.type, w: Math.round(n.width), h: Math.round(n.height) };
  if (depth > 0 && "children" in n && n.type !== "INSTANCE" && n.children.length) o.children = n.children.map((c) => outline(c, depth - 1));
  return o;
}

// ---------- commands ----------

const commands = {
  async get_document_info() {
    await figma.loadAllPagesAsync();
    return Object.assign(fileInfo(), {
      pages: figma.root.children.map((p) => ({ id: p.id, name: p.name, isCurrent: p === figma.currentPage, topLevel: p.children.length })),
      currentPage: { id: figma.currentPage.id, name: figma.currentPage.name, children: figma.currentPage.children.map(summary) }
    });
  },

  async get_selection() {
    return { pageId: figma.currentPage.id, selection: figma.currentPage.selection.map(summary) };
  },

  async export_rest_json({ nodeIds }) {
    const nodes = [];
    for (const id of nodeIds && nodeIds.length ? nodeIds : [figma.currentPage.id]) {
      const node = await getNode(id);
      let res;
      if (node.type === "PAGE") {
        // Pages cannot be exported; export their top-level children instead.
        const children = [];
        for (const c of node.children) children.push((await c.exportAsync({ format: "JSON_REST_V1" })).document);
        res = { document: { id: node.id, name: node.name, type: "CANVAS", children } };
      } else res = await node.exportAsync({ format: "JSON_REST_V1" });
      const ids = new Set();
      walkIds(res.document, ids);
      const variables = {};
      for (const vid of ids) {
        try {
          const v = await figma.variables.getVariableByIdAsync(vid);
          if (v) variables[vid] = v.name;
        } catch (e) {}
      }
      nodes.push(Object.assign({}, res, { variables }));
    }
    return { nodes, fileName: figma.root.name };
  },

  async export_node({ nodeId, format, scale }) {
    const node = await getNode(nodeId);
    const settings = { format: format || "PNG" };
    if (settings.format === "PNG" || settings.format === "JPG") settings.constraint = { type: "SCALE", value: scale || 1 };
    if (settings.format === "SVG") settings.svgOutlineText = true;
    const bytes = await node.exportAsync(settings);
    return { base64: figma.base64Encode(bytes), width: "width" in node ? node.width * (scale || 1) : undefined, height: "height" in node ? node.height * (scale || 1) : undefined };
  },

  async get_image_bytes({ hash }) {
    const img = figma.getImageByHash(hash);
    if (!img) throw new Error("No image with hash " + hash);
    return { base64: figma.base64Encode(await img.getBytesAsync()) };
  },

  async get_variables() {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const vars = await figma.variables.getLocalVariablesAsync();
    const byId = {};
    vars.forEach((v) => (byId[v.id] = v));
    const fmt = async (val) => {
      if (val && val.type === "VARIABLE_ALIAS") {
        const t = byId[val.id] || (await figma.variables.getVariableByIdAsync(val.id));
        return { alias: t ? t.name : val.id };
      }
      if (val && typeof val === "object" && "r" in val) {
        const h = (x) => Math.round(x * 255).toString(16).padStart(2, "0");
        return ("#" + h(val.r) + h(val.g) + h(val.b) + (val.a !== undefined && val.a < 1 ? h(val.a) : "")).toUpperCase();
      }
      return val;
    };
    const out = [];
    for (const v of vars) {
      const c = collections.find((x) => x.id === v.variableCollectionId);
      const values = {};
      for (const modeId of Object.keys(v.valuesByMode)) {
        const mode = c ? c.modes.find((m) => m.modeId === modeId) : null;
        values[mode ? mode.name : modeId] = await fmt(v.valuesByMode[modeId]);
      }
      out.push({ id: v.id, name: v.name, collection: c ? c.name : v.variableCollectionId, type: v.resolvedType, description: v.description || undefined, codeSyntax: v.codeSyntax, scopes: v.scopes, values });
    }
    return { collections: collections.map((c) => ({ id: c.id, name: c.name, modes: c.modes })), variables: out };
  },

  async get_styles() {
    const out = [];
    for (const s of await figma.getLocalPaintStylesAsync()) out.push({ id: s.id, name: s.name, type: "FILL", description: s.description, value: s.paints });
    for (const s of await figma.getLocalTextStylesAsync())
      out.push({ id: s.id, name: s.name, type: "TEXT", description: s.description, value: { fontName: s.fontName, fontSize: s.fontSize, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing, textCase: s.textCase, textDecoration: s.textDecoration } });
    for (const s of await figma.getLocalEffectStylesAsync()) out.push({ id: s.id, name: s.name, type: "EFFECT", description: s.description, value: s.effects });
    for (const s of await figma.getLocalGridStylesAsync()) out.push({ id: s.id, name: s.name, type: "GRID", description: s.description, value: s.layoutGrids });
    return { styles: out };
  },

  async get_local_components({ pageId }) {
    await figma.loadAllPagesAsync();
    const roots = pageId ? [await getNode(pageId)] : figma.root.children;
    const out = [];
    for (const r of roots) {
      for (const n of r.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] })) {
        if (n.type === "COMPONENT" && n.parent && n.parent.type === "COMPONENT_SET") continue;
        const item = { id: n.id, name: n.name, type: n.type, key: n.key, description: n.description || undefined, page: r.name };
        try {
          item.properties = n.componentPropertyDefinitions;
        } catch (e) {}
        if (n.type === "COMPONENT_SET") item.variants = n.children.map((c) => ({ id: c.id, name: c.name, key: c.key }));
        out.push(item);
      }
    }
    return { components: out };
  },

  async create_node({ type, parentId, name, x, y, width, height, props, index }) {
    const parent = await getParent(parentId);
    let node;
    switch (String(type || "FRAME").toUpperCase()) {
      case "FRAME": node = figma.createFrame(); break;
      case "RECTANGLE": node = figma.createRectangle(); break;
      case "ELLIPSE": node = figma.createEllipse(); break;
      case "LINE": node = figma.createLine(); break;
      case "POLYGON": node = figma.createPolygon(); break;
      case "STAR": node = figma.createStar(); break;
      case "COMPONENT": node = figma.createComponent(); break;
      case "SECTION": node = figma.createSection(); break;
      case "TEXT": {
        node = figma.createText();
        await figma.loadFontAsync({ family: "Inter", style: "Regular" });
        node.fontName = { family: "Inter", style: "Regular" };
        node.characters = "";
        break;
      }
      default: throw new Error("Unsupported type " + type + ". Use FRAME, RECTANGLE, ELLIPSE, LINE, POLYGON, STAR, COMPONENT, SECTION or TEXT; use create_from_svg for vectors.");
    }
    if (index !== undefined) parent.insertChild(index, node);
    else parent.appendChild(node);
    if (name) node.name = name;
    if (x !== undefined) node.x = x;
    if (y !== undefined) node.y = y;
    if ((width !== undefined || height !== undefined) && "resize" in node) node.resize(width || node.width || 100, height || node.height || 100);
    if (type === "FRAME" && !(props && (props.fills || props.fill))) node.fills = [];
    await applyProps(node, props);
    return summary(node);
  },

  async update_node({ nodeId, props }) {
    const node = await getNode(nodeId);
    await applyProps(node, props);
    return summary(node);
  },

  async set_text({ nodeId, text, props }) {
    const node = await getNode(nodeId);
    if (node.type !== "TEXT") throw new Error("Node " + nodeId + " is " + node.type + ", not TEXT");
    await loadFontsFor(node);
    node.characters = String(text);
    await applyProps(node, props);
    return summary(node);
  },

  async delete_nodes({ nodeIds }) {
    const deleted = [];
    for (const id of nodeIds) {
      const n = await getNode(id);
      n.remove();
      deleted.push(id);
    }
    return { deleted };
  },

  async clone_node({ nodeId, parentId, x, y }) {
    const n = await getNode(nodeId);
    const c = n.clone();
    if (parentId) (await getParent(parentId)).appendChild(c);
    if (x !== undefined) c.x = x;
    if (y !== undefined) c.y = y;
    return summary(c);
  },

  async move_node({ nodeId, parentId, index, x, y }) {
    const n = await getNode(nodeId);
    if (parentId) {
      const p = await getParent(parentId);
      if (index !== undefined) p.insertChild(index, n);
      else p.appendChild(n);
    } else if (index !== undefined && n.parent) n.parent.insertChild(index, n);
    if (x !== undefined) n.x = x;
    if (y !== undefined) n.y = y;
    return summary(n);
  },

  async group_nodes({ nodeIds, name, frame }) {
    const nodes = [];
    for (const id of nodeIds) nodes.push(await getNode(id));
    const parent = nodes[0].parent;
    let g;
    if (frame) {
      g = figma.createFrame();
      g.fills = [];
      parent.appendChild(g);
      const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
      const x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys);
      const x1 = Math.max.apply(null, nodes.map((n) => n.x + n.width)), y1 = Math.max.apply(null, nodes.map((n) => n.y + n.height));
      g.x = x0; g.y = y0; g.resize(x1 - x0, y1 - y0);
      for (const n of nodes) { const ax = n.x, ay = n.y; g.appendChild(n); n.x = ax - x0; n.y = ay - y0; }
    } else g = figma.group(nodes, parent);
    if (name) g.name = name;
    return summary(g);
  },

  async create_instance({ componentId, componentKey, parentId, x, y, index, properties }) {
    let comp;
    if (componentKey) comp = await figma.importComponentByKeyAsync(componentKey);
    else comp = await getNode(componentId);
    if (comp.type === "COMPONENT_SET") comp = comp.defaultVariant;
    if (comp.type !== "COMPONENT") throw new Error("Node is " + comp.type + ", not a COMPONENT");
    const inst = comp.createInstance();
    const parent = await getParent(parentId);
    if (index !== undefined) parent.insertChild(index, inst);
    else parent.appendChild(inst);
    if (x !== undefined) inst.x = x;
    if (y !== undefined) inst.y = y;
    if (properties) inst.setProperties(properties);
    return summary(inst);
  },

  async set_instance_properties({ nodeId, properties, swapComponentId, swapComponentKey }) {
    const n = await getNode(nodeId);
    if (n.type !== "INSTANCE") throw new Error("Node " + nodeId + " is not an INSTANCE");
    if (swapComponentKey) n.swapComponent(await figma.importComponentByKeyAsync(swapComponentKey));
    else if (swapComponentId) n.swapComponent(await getNode(swapComponentId));
    if (properties) {
      // Accept short names ("Label") as well as full keys ("Label#12:3").
      const defs = n.componentProperties;
      const resolved = {};
      for (const k of Object.keys(properties)) {
        const full = defs[k] ? k : Object.keys(defs).find((d) => d.split("#")[0] === k);
        if (!full) throw new Error("Unknown property '" + k + "'. Available: " + Object.keys(defs).join(", "));
        resolved[full] = properties[k];
      }
      n.setProperties(resolved);
    }
    const main = await n.getMainComponentAsync();
    return Object.assign(summary(n), { mainComponent: main ? main.name : undefined, properties: n.componentProperties });
  },

  async detach_instance({ nodeId }) {
    const n = await getNode(nodeId);
    if (n.type !== "INSTANCE") throw new Error("Node is not an INSTANCE");
    return summary(n.detachInstance());
  },

  async create_component({ nodeId, combineAsVariants, nodeIds, name }) {
    if (combineAsVariants) {
      const comps = [];
      for (const id of nodeIds) comps.push(await getNode(id));
      const set = figma.combineAsVariants(comps, comps[0].parent);
      if (name) set.name = name;
      return summary(set);
    }
    const n = await getNode(nodeId);
    const c = figma.createComponentFromNode(n);
    if (name) c.name = name;
    return Object.assign(summary(c), { key: c.key });
  },

  async create_from_svg({ svg, parentId, x, y, name }) {
    const n = figma.createNodeFromSvg(svg);
    (await getParent(parentId)).appendChild(n);
    if (x !== undefined) n.x = x;
    if (y !== undefined) n.y = y;
    if (name) n.name = name;
    return summary(n);
  },

  async insert_image({ base64, nodeId, parentId, x, y, width, height, scaleMode, name }) {
    const img = figma.createImage(figma.base64Decode(base64));
    let target;
    if (nodeId) target = await getNode(nodeId);
    else {
      target = figma.createRectangle();
      (await getParent(parentId)).appendChild(target);
      const size = await img.getSizeAsync();
      target.resize(width || size.width, height || size.height);
      if (x !== undefined) target.x = x;
      if (y !== undefined) target.y = y;
      target.name = name || "Image";
    }
    target.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode: scaleMode || "FILL" }];
    return Object.assign(summary(target), { imageHash: img.hash });
  },

  async select_nodes({ nodeIds, zoom }) {
    const nodes = [];
    for (const id of nodeIds) nodes.push(await getNode(id));
    const page = nodes[0] && nodes[0].type !== "PAGE" ? (function find(n) { while (n && n.type !== "PAGE") n = n.parent; return n; })(nodes[0]) : null;
    if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
    figma.currentPage.selection = nodes.filter((n) => n.type !== "PAGE");
    if (zoom !== false && nodes.length) figma.viewport.scrollAndZoomIntoView(nodes);
    return { selected: nodes.map(summary) };
  },

  async create_page({ name, switchTo }) {
    const p = figma.createPage();
    if (name) p.name = name;
    if (switchTo) await figma.setCurrentPageAsync(p);
    return { id: p.id, name: p.name };
  },

  async set_current_page({ pageId }) {
    const p = await getNode(pageId);
    await figma.setCurrentPageAsync(p);
    return { id: p.id, name: p.name };
  },

  async create_variable_collection({ name, modes }) {
    const c = figma.variables.createVariableCollection(name);
    if (modes && modes.length) {
      c.renameMode(c.modes[0].modeId, modes[0]);
      for (const m of modes.slice(1)) c.addMode(m);
    }
    return { id: c.id, name: c.name, modes: c.modes };
  },

  async create_variable({ collectionId, name, type, values, description, scopes, codeSyntax }) {
    const c = await figma.variables.getVariableCollectionByIdAsync(collectionId);
    if (!c) throw new Error("Collection " + collectionId + " not found");
    const v = figma.variables.createVariable(name, c, type);
    if (description) v.description = description;
    if (scopes) v.scopes = scopes;
    if (codeSyntax) for (const platform of Object.keys(codeSyntax)) v.setVariableCodeSyntax(platform, codeSyntax[platform]);
    await commands.set_variable_value({ variableId: v.id, values });
    return { id: v.id, name: v.name, type: v.resolvedType };
  },

  async set_variable_value({ variableId, values }) {
    const v = await figma.variables.getVariableByIdAsync(variableId);
    if (!v) throw new Error("Variable " + variableId + " not found");
    const c = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
    for (const modeKey of Object.keys(values || {})) {
      const mode = c.modes.find((m) => m.modeId === modeKey || m.name === modeKey);
      if (!mode) throw new Error("Mode '" + modeKey + "' not in collection " + c.name + ". Modes: " + c.modes.map((m) => m.name).join(", "));
      let val = values[modeKey];
      if (val && typeof val === "object" && val.alias) {
        const all = await figma.variables.getLocalVariablesAsync();
        const target = all.find((x) => x.name === val.alias || x.id === val.alias);
        if (!target) throw new Error("Alias target " + val.alias + " not found");
        val = figma.variables.createVariableAlias(target);
      } else if (v.resolvedType === "COLOR") val = parseColor(val);
      v.setValueForMode(mode.modeId, val);
    }
    return { id: v.id, name: v.name };
  },

  async bind_variable({ nodeId, field, variableId, paintIndex }) {
    const n = await getNode(nodeId);
    const v = await figma.variables.getVariableByIdAsync(variableId);
    if (!v) throw new Error("Variable " + variableId + " not found");
    if (field === "fills" || field === "strokes") {
      const paints = n[field].slice();
      const i = paintIndex || 0;
      if (!paints[i]) throw new Error("Node has no " + field + "[" + i + "] paint to bind");
      paints[i] = figma.variables.setBoundVariableForPaint(paints[i], "color", v);
      n[field] = paints;
    } else n.setBoundVariable(field, v);
    return summary(n);
  },

  async create_style({ type, name, value, description }) {
    let s;
    if (type === "FILL") {
      s = figma.createPaintStyle();
      s.paints = toPaints(value);
    } else if (type === "TEXT") {
      s = figma.createTextStyle();
      const fontName = value.fontName || { family: value.fontFamily || "Inter", style: value.fontStyle || "Regular" };
      await figma.loadFontAsync(fontName);
      s.fontName = fontName;
      if (value.fontSize) s.fontSize = value.fontSize;
      if (value.lineHeight) s.lineHeight = typeof value.lineHeight === "number" ? { value: value.lineHeight, unit: "PIXELS" } : value.lineHeight;
      if (value.letterSpacing !== undefined) s.letterSpacing = typeof value.letterSpacing === "number" ? { value: value.letterSpacing, unit: "PIXELS" } : value.letterSpacing;
    } else if (type === "EFFECT") {
      s = figma.createEffectStyle();
      s.effects = value.map((e) => (e.color ? Object.assign({}, e, { color: parseColor(e.color) }) : e));
    } else throw new Error("type must be FILL, TEXT or EFFECT");
    s.name = name;
    if (description) s.description = description;
    return { id: s.id, name: s.name, key: s.key };
  },

  async apply_style({ nodeId, styleId, kind }) {
    const n = await getNode(nodeId);
    const k = kind || "fill";
    if (k === "fill") await n.setFillStyleIdAsync(styleId);
    else if (k === "stroke") await n.setStrokeStyleIdAsync(styleId);
    else if (k === "text") await n.setTextStyleIdAsync(styleId);
    else if (k === "effect") await n.setEffectStyleIdAsync(styleId);
    else throw new Error("kind must be fill, stroke, text or effect");
    return summary(n);
  },

  async build_layout({ tree, parentId, pageId, x, y, gap, select, outlineDepth, collection }) {
    if (pageId) await figma.setCurrentPageAsync(await getNode(pageId));
    const parent = await getParent(parentId);
    const ctx = newBuildCtx();
    ctx.collection = collection;
    const specs = Array.isArray(tree) ? tree : [tree];
    // Top-level nodes on a page go to the right of existing content unless positioned.
    let cursorX = x;
    if (parent.type === "PAGE" && cursorX === undefined) {
      const kids = parent.children;
      cursorX = kids.length ? Math.max.apply(null, kids.map((k) => k.x + k.width)) + 200 : 0;
    }
    const roots = [];
    for (const spec of specs) {
      const s = Object.assign({}, spec);
      if (parent.type === "PAGE" || !isAutoLayout(parent)) {
        if (s.x === undefined && cursorX !== undefined) s.x = cursorX;
        if (s.y === undefined && y !== undefined) s.y = y;
      }
      let n;
      try {
        n = await buildNode(s, parent, ctx, "");
      } catch (e) {
        ctx.warnings.push(e.message);
        continue;
      }
      if (!n) continue;
      roots.push(n);
      if (cursorX !== undefined && spec.x === undefined) cursorX = n.x + n.width + (gap !== undefined ? gap : 120);
    }
    await finishBuild(ctx);
    if (select !== false && roots.length && parent.type === "PAGE") {
      figma.currentPage.selection = roots;
      figma.viewport.scrollAndZoomIntoView(roots);
    }
    const refs = {};
    for (const k of Object.keys(ctx.refs)) refs[k] = ctx.refs[k].id;
    return {
      created: ctx.count,
      roots: roots.map((r) => outline(r, outlineDepth === undefined ? 1 : outlineDepth)),
      refs,
      warnings: ctx.warnings.length ? ctx.warnings : undefined
    };
  },

  // Binds raw solid colors to the variables of a collection whose value matches exactly.
  async bind_tokens({ nodeIds, collection, skip, prefer, rebind, translucent }) {
    const col = await collectionByName(collection);
    const vars = (await figma.variables.getLocalVariablesAsync("COLOR")).filter((v) => v.variableCollectionId === col.id);
    const modeId = col.defaultModeId || col.modes[0].modeId;
    const skipSet = new Set(skip || []);
    const byHex = {};
    const ordered = vars.slice().sort((a, b) => ((prefer || []).indexOf(b.name) >= 0) - ((prefer || []).indexOf(a.name) >= 0));
    for (const v of ordered) {
      if (skipSet.has(v.name)) continue;
      let val = v.valuesByMode[modeId];
      if (!val || val.type === "VARIABLE_ALIAS") continue;
      const h = hexOf(val);
      if (!byHex[h]) byHex[h] = v;
    }
    const byId = {};
    for (const v of vars) byId[v.id] = v;
    const roots = [];
    for (const id of nodeIds) roots.push(await getNode(id));
    const unmatched = {};
    const changed = await mapPaints(roots, (p) => {
      const cur = p.boundVariables && p.boundVariables.color;
      if (cur && !(rebind && byId[cur.id] && skipSet.has(byId[cur.id].name))) return p;
      // Translucent paints (scrims, outlines on photos) are usually not the token itself.
      if (!translucent && p.opacity !== undefined && p.opacity < 1) return p;
      const v = byHex[hexOf(p.color)];
      if (!v) { unmatched[hexOf(p.color)] = (unmatched[hexOf(p.color)] || 0) + 1; return p; }
      return figma.variables.setBoundVariableForPaint(p, "color", v);
    });
    return { changed, tokens: Object.keys(byHex).length, unmatched };
  },

  // Clones nodes as a theme variant: switches the collection's mode when it has one by that name,
  // otherwise rebinds every color variable to the same-named variable in another collection.
  async create_theme_variant({ nodeIds, fromCollection, toCollection, mode, dx, dy, suffix, shadowAlpha }) {
    const from = await collectionByName(fromCollection);
    const vars = await figma.variables.getLocalVariablesAsync();
    const fromById = {};
    for (const v of vars) if (v.variableCollectionId === from.id) fromById[v.id] = v;
    let to = null, toByName = {};
    if (toCollection) {
      to = await collectionByName(toCollection);
      for (const v of vars) if (v.variableCollectionId === to.id) toByName[v.name] = v;
    }
    const out = [];
    for (const id of nodeIds) {
      const src = await getNode(id);
      const c = src.clone();
      if (src.parent && c.parent !== src.parent) src.parent.appendChild(c);
      c.name = src.name + (suffix !== undefined ? suffix : " (" + (mode || (to && to.name) || "variant") + ")");
      c.x = src.x + (dx || 0);
      c.y = src.y + (dy !== undefined ? dy : dx ? 0 : src.height + 200);
      const stats = { rebound: 0, missing: {}, unbound: 0 };
      if (mode) {
        const m = from.modes.find((x) => x.name === mode);
        if (!m) throw new Error("Collection " + from.name + " has no mode '" + mode + "'. Modes: " + from.modes.map((x) => x.name).join(", ") + ". On plans limited to one mode, pass toCollection instead.");
        c.setExplicitVariableModeForCollection(from, m.modeId);
      } else if (to) {
        await mapPaints([c], (p) => {
          const b = p.boundVariables && p.boundVariables.color;
          if (!b) { stats.unbound++; return p; }
          const lv = fromById[b.id];
          const tv = lv && toByName[lv.name];
          if (!tv) { if (lv) stats.missing[lv.name] = true; return p; }
          stats.rebound++;
          return figma.variables.setBoundVariableForPaint(p, "color", tv);
        });
      } else throw new Error("Pass mode (a mode of fromCollection) or toCollection.");
      if (shadowAlpha !== undefined) {
        for (const n of [c].concat(c.findAll ? c.findAll((x) => "effects" in x && x.effects.length) : [])) {
          if (!("effects" in n) || !n.effects.length) continue;
          n.effects = n.effects.map((e) => (e.type === "DROP_SHADOW" ? Object.assign({}, e, { color: { r: 0, g: 0, b: 0, a: Math.min(1, e.color.a * shadowAlpha) } }) : e));
        }
      }
      const sec = enclosingSection(c);
      if (sec) fitSection(sec);
      out.push({ id: c.id, name: c.name, rebound: stats.rebound, unboundColors: stats.unbound, missingTokens: Object.keys(stats.missing) });
    }
    return { created: out };
  },

  // Design QA: WCAG contrast, platform touch targets, untokenized colors, text without styles,
  // off-grid spacing, default layer names, frames without auto layout.
  async audit({ nodeIds, platform, checks, maxFindings }) {
    const want = new Set(checks && checks.length ? checks : ["contrast", "nonTextContrast", "targetSize", "hardcodedColor", "textStyle", "spacingGrid", "layerName", "autoLayout"]);
    const target = TARGETS[platform || "web"] || 24;
    const findings = [];
    const counts = {};
    const add = (check, severity, n, detail) => {
      counts[check] = (counts[check] || 0) + 1;
      findings.push({ check, severity, nodeId: n.id, name: n.name, detail });
    };
    const roots = [];
    for (const id of nodeIds) roots.push(await getNode(id));
    const seen = new Set();
    const nodes = [];
    for (const r of roots) for (const n of [r].concat("findAll" in r ? r.findAll(() => true) : [])) if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); }
    let checked = 0;
    for (const n of nodes) {
      if (isHidden(n)) continue;
      checked++;
      const ownLayer = !insideInstance(n);
      if (n.type === "TEXT" && (want.has("contrast") || want.has("textStyle"))) {
        if (want.has("contrast")) {
          const bg = backgroundOf(n);
          if (bg) {
            const op = effectiveOpacity(n);
            for (const seg of n.getStyledTextSegments(["fills", "fontSize", "fontWeight"])) {
              const f = visibleSolid(seg.fills);
              if (!f || f.unknown) continue;
              const a = (f.opacity === undefined ? 1 : f.opacity) * op;
              const fg = over(f.color, a, bg);
              const ratio = contrastRatio(fg, bg);
              const large = seg.fontSize >= 24 || (seg.fontSize >= 18.66 && seg.fontWeight >= 700);
              const need = large ? 3 : 4.5;
              if (ratio < need) {
                add("contrast", ratio < need - 1 ? "error" : "warning", n, "Text contrast " + ratio.toFixed(2) + ":1, needs " + need + ":1 (" + (large ? "large" : "normal") + " text " + Math.round(seg.fontSize) + "px, WCAG 1.4.3): \"" + n.characters.slice(seg.start, Math.min(seg.end, seg.start + 40)) + "\"");
                break;
              }
            }
          }
        }
        if (want.has("textStyle") && ownLayer && !n.textStyleId) add("textStyle", "warning", n, "Text has no text style");
      }
      if (want.has("nonTextContrast") && n.type !== "TEXT" && "strokes" in n && n.width <= 64 && n.height <= 64) {
        const s = visibleSolid(n.strokes);
        const fill = "fills" in n ? visibleSolid(n.fills) : null;
        if (s && !s.unknown && !fill && n.strokeWeight !== figma.mixed && n.strokeWeight > 0) {
          const bg = backgroundOf(n);
          if (bg) {
            const fg = over(s.color, (s.opacity === undefined ? 1 : s.opacity) * effectiveOpacity(n), bg);
            const ratio = contrastRatio(fg, bg);
            if (ratio < 3) add("nonTextContrast", "warning", n, "Outline/icon contrast " + ratio.toFixed(2) + ":1, needs 3:1 for UI components and meaningful graphics (WCAG 1.4.11)");
          }
        }
      }
      if (want.has("targetSize") && (n.type === "INSTANCE" || n.type === "FRAME" || n.type === "COMPONENT")) {
        let label = n.name;
        if (n.type === "INSTANCE") {
          try { const m = await n.getMainComponentAsync(); if (m) label = (m.parent && m.parent.type === "COMPONENT_SET" ? m.parent.name : m.name) + " " + n.name; } catch (e) {}
        }
        const interactive = ("reactions" in n && n.reactions && n.reactions.length > 0) || INTERACTIVE.test(label);
        if (interactive && (n.width < target || n.height < target) && !(n.parent && n.parent.type === "INSTANCE" && INTERACTIVE.test(n.parent.name))) {
          add("targetSize", "warning", n, "Interactive element is " + Math.round(n.width) + "×" + Math.round(n.height) + "; " + (platform || "web") + " needs a " + target + "×" + target + " hit area (" + (platform === "ios" ? "Apple HIG" : platform === "android" ? "Material 48dp" : "WCAG 2.5.8") + "). Fine if a larger parent row is the tap target.");
        }
      }
      if (want.has("hardcodedColor") && ownLayer) {
        for (const key of ["fills", "strokes"]) {
          if (!(key in n) || n[key] === figma.mixed) continue;
          const styled = key === "fills" ? n.fillStyleId : n.strokeStyleId;
          if (styled) continue;
          const raw = n[key].filter((p) => p.visible !== false && p.type === "SOLID" && !(p.boundVariables && p.boundVariables.color));
          if (raw.length) add("hardcodedColor", "info", n, key + " use " + raw.map((p) => hexOf(p.color) + (p.opacity !== undefined && p.opacity < 1 ? " @" + Math.round(p.opacity * 100) + "%" : "")).join(", ") + " without a variable or style");
        }
      }
      if (want.has("spacingGrid") && ownLayer && isAutoLayout(n)) {
        const off = [];
        for (const k of ["itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) {
          const v = n[k];
          if (typeof v === "number" && v % 4 !== 0 && !(n.boundVariables && n.boundVariables[k])) off.push(k + " " + v);
        }
        if (off.length) add("spacingGrid", "info", n, "Off the 4px grid: " + off.join(", "));
      }
      if (want.has("layerName") && ownLayer && DEFAULT_NAME.test(n.name)) add("layerName", "info", n, "Default layer name; name it by what it is");
      if (want.has("autoLayout") && ownLayer && n.type === "FRAME" && !isAutoLayout(n) && n.children.length >= 2) {
        const abs = n.children.every((c) => c.type === "VECTOR" || c.type === "BOOLEAN_OPERATION");
        if (!abs) add("autoLayout", "info", n, "Frame with " + n.children.length + " children and no auto layout");
      }
    }
    const order = { error: 0, warning: 1, info: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity]);
    const limit = maxFindings || 200;
    return { platform: platform || "web", targetSize: target, nodesChecked: checked, counts, findings: findings.slice(0, limit), truncated: findings.length > limit ? findings.length - limit : undefined };
  },

  // Native Figma annotations (visible in Dev Mode), grouped by category.
  async annotate({ items, replace }) {
    const cats = await figma.annotations.getAnnotationCategoriesAsync();
    const catId = async (label, color) => {
      if (!label) return undefined;
      let c = cats.find((x) => x.label === label);
      if (!c) {
        c = await figma.annotations.addAnnotationCategoryAsync({ label, color: color || "blue" });
        cats.push(c);
      }
      return c.id;
    };
    let count = 0;
    for (const it of items) {
      const n = await getNode(it.nodeId);
      const a = {};
      if (it.markdown) a.labelMarkdown = it.label;
      else a.label = it.label;
      if (it.properties && it.properties.length) a.properties = it.properties.map((t) => ({ type: t }));
      const id = await catId(it.category, it.color);
      if (id) a.categoryId = id;
      // Figma reads annotations back with both label and labelMarkdown filled in, but only accepts one.
      const keep = replace ? [] : (n.annotations || []).map((x) => {
        const y = x.labelMarkdown ? { labelMarkdown: x.labelMarkdown } : x.label ? { label: x.label } : {};
        if (x.properties && x.properties.length) y.properties = x.properties.map((q) => ({ type: q.type }));
        if (x.categoryId) y.categoryId = x.categoryId;
        return y;
      });
      n.annotations = keep.concat([a]);
      count++;
    }
    return { annotated: count, categories: cats.map((c) => c.label) };
  },

  // Dev Mode status on top-level frames/sections.
  async set_dev_status({ nodeIds, status, description }) {
    const done = [];
    for (const id of nodeIds) {
      const n = await getNode(id);
      n.devStatus = status ? Object.assign({ type: status }, description ? { description } : {}) : null;
      done.push({ id: n.id, name: n.name, devStatus: n.devStatus });
    }
    return { updated: done };
  },

  // Pins existing nodes to their parent's edges (see resolveAnchor).
  async anchor_nodes({ items }) {
    const ctx = newBuildCtx();
    for (const it of items) resolveAnchor(await getNode(it.nodeId), it.anchor, ctx, it.nodeId);
    return { anchored: items.length, warnings: ctx.warnings.length ? ctx.warnings : undefined };
  },

  // Draws connector arrows between existing nodes.
  async draw_arrows({ arrows, parentId }) {
    const ctx = newBuildCtx();
    const parent = await getParent(parentId);
    for (const a of arrows) ctx.arrows.push({ spec: a, parent: a.parentId ? await getParent(a.parentId) : parent, path: "arrow" });
    await finishBuild(ctx);
    return { created: ctx.count, warnings: ctx.warnings.length ? ctx.warnings : undefined };
  },

  async notify({ message }) {
    figma.notify(String(message));
    return { ok: true };
  },

  // Runs arbitrary Plugin API code. `figma`, `params` and the helpers are in scope; return a JSON-able value.
  async execute({ code, params }) {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction("figma", "params", "helpers", code);
    const result = await fn(figma, params || {}, { getNode, toPaints, parseColor, applyProps, summary, build: (tree, parent) => buildNode(tree, parent || figma.currentPage, newBuildCtx(), "") });
    return result === undefined ? null : JSON.parse(JSON.stringify(result));
  }
};

figma.ui.onmessage = async (msg) => {
  if (!msg || msg.type !== "request") return;
  const handler = commands[msg.command];
  try {
    if (!handler) throw new Error("Unknown command " + msg.command + ". Update the plugin (it may be older than the server).");
    const result = await handler(msg.params || {});
    figma.ui.postMessage({ type: "response", id: msg.id, command: msg.command, ok: true, result });
  } catch (e) {
    figma.ui.postMessage({ type: "response", id: msg.id, command: msg.command, ok: false, error: e && e.message ? e.message : String(e) });
  }
};
