// build_layout in plugin/code.js against a mocked Figma that enforces the auto-layout sizing rules.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";

type N = Record<string, any>;

function mockFigma() {
  let nextId = 1;
  const nodes = new Map<string, N>();
  const auto = (n: N) => n && n.layoutMode && n.layoutMode !== "NONE";
  const make = (type: string): N => {
    const n: N = {
      id: `2:${nextId++}`, type, name: type, x: 0, y: 0, width: 100, height: 100, children: [], parent: null, fills: [], strokes: [], effects: [], layoutMode: type === "TEXT" ? undefined : "NONE",
      resize(w: number, h: number) { n.width = w; n.height = h; },
      appendChild(c: N) { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); n.children.push(c); c.parent = n; },
      insertChild(i: number, c: N) { n.children.splice(i, 0, c); c.parent = n; },
      findOne(f: (x: N) => boolean): N | null { for (const c of n.children) { if (f(c)) return c; const r = c.findOne?.(f); if (r) return r; } return null; },
      findAll(f: (x: N) => boolean): N[] { const out: N[] = []; for (const c of n.children) { if (f(c)) out.push(c); out.push(...(c.findAll?.(f) ?? [])); } return out; },
      remove() { nodes.delete(n.id); },
      get absoluteTransform() { let x = n.x, y = n.y; for (let p = n.parent; p && p.type !== "PAGE"; p = p.parent) { x += p.x; y += p.y; } return [[1, 0, x], [0, 1, y]]; },
      resizeWithoutConstraints(w: number, h: number) { n.width = w; n.height = h; },
      clone() { const c = make(n.type); for (const k of ["name", "x", "y", "width", "height", "fills", "strokes", "effects", "layoutMode"]) c[k] = JSON.parse(JSON.stringify(n[k] ?? null)) ?? n[k]; for (const ch of n.children) c.appendChild(ch.clone()); n.parent?.appendChild(c); return c; },
      setBoundVariable(field: string, v: N) { (n.bound ??= {})[field] = v.name; },
      async setTextStyleIdAsync(id: string) { n.textStyleId = id; }
    };
    if (type === "TEXT") delete n.layoutMode;
    let hs = "FIXED", vs = "FIXED";
    Object.defineProperty(n, "layoutSizingHorizontal", { get: () => hs, set(v) { if (v === "FILL" && !auto(n.parent)) throw new Error("FILL needs an auto-layout parent"); if (v === "HUG" && !(auto(n) || type === "TEXT")) throw new Error("HUG needs auto layout"); hs = v; } });
    Object.defineProperty(n, "layoutSizingVertical", { get: () => vs, set(v) { if (v === "FILL" && !auto(n.parent)) throw new Error("FILL needs an auto-layout parent"); if (v === "HUG" && !(auto(n) || type === "TEXT")) throw new Error("HUG needs auto layout"); vs = v; } });
    nodes.set(n.id, n);
    return n;
  };
  const page = make("PAGE");
  page.layoutMode = undefined;
  const posted: N[] = [];
  const loaded: string[] = [];
  const ink = { r: 0x1a / 255, g: 0x21 / 255, b: 0x47 / 255, a: 1 };
  const vars: N[] = [
    { id: "VariableID:1", name: "color/ink", resolvedType: "COLOR", variableCollectionId: "C:light", valuesByMode: { "m:1": ink } },
    { id: "VariableID:2", name: "space/4", resolvedType: "FLOAT", variableCollectionId: "C:light", valuesByMode: { "m:1": 16 } },
    { id: "VariableID:3", name: "color/on-highlight", resolvedType: "COLOR", variableCollectionId: "C:light", valuesByMode: { "m:1": ink } },
    { id: "VariableID:9", name: "color/ink", resolvedType: "COLOR", variableCollectionId: "C:dark", valuesByMode: { "m:2": { r: 0.9, g: 0.9, b: 0.95, a: 1 } } }
  ];
  const collections = [{ id: "C:light", name: "Tokens", modes: [{ modeId: "m:1", name: "Light" }], defaultModeId: "m:1" }, { id: "C:dark", name: "Tokens Dark", modes: [{ modeId: "m:2", name: "Dark" }], defaultModeId: "m:2" }];
  const figma: N = {
    showUI() {}, on() {}, notify() {}, commitUndo() {},
    ui: { postMessage: (m: N) => posted.push(m), onmessage: null },
    root: { name: "Mock" }, currentPage: page, fileKey: "MOCK", editorType: "figma", currentUser: { name: "Dev" }, mixed: Symbol("mixed"),
    viewport: { scrollAndZoomIntoView() {} },
    annotations: {
      cats: [{ id: "cat:1", label: "Interaction" }] as N[],
      async getAnnotationCategoriesAsync() { return this.cats.slice(); },
      async addAnnotationCategoryAsync(c: N) { const n = { id: `cat:${this.cats.length + 1}`, ...c }; this.cats.push(n); return n; }
    },
    getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
    createFrame: () => make("FRAME"), createRectangle: () => make("RECTANGLE"), createEllipse: () => make("ELLIPSE"), createLine: () => make("LINE"),
    createText: () => {
      const t = Object.assign(make("TEXT"), { fontName: { family: "Inter", style: "Regular" }, characters: "" });
      t.rangeFills = [] as N[];
      t.setRangeFills = (a: number, b: number, f: N[]) => t.rangeFills.push({ a, b, f, after: !!t.fills[0]?.boundVariables });
      t.getRangeFontName = () => t.fontName;
      t.getStyledTextSegments = () => [{ start: 0, end: t.characters.length, fills: t.fills, fontSize: t.fontSize ?? 16, fontWeight: 400 }];
      return t;
    },
    createSection: () => { const sct = make("SECTION"); delete sct.layoutMode; return sct; },
    createVector: () => { const v = make("VECTOR"); v.setVectorNetworkAsync = async (net: N) => { v.net = net; }; return v; },
    createComponent: () => {
      const c = make("COMPONENT");
      c.props = {} as N;
      c.addComponentProperty = (name: string, type: string, def: unknown) => { const k = `${name}#1:${nextId++}`; c.props[k] = { type, defaultValue: def }; return k; };
      c.createInstance = () => {
        const i = make("INSTANCE");
        i.main = c;
        for (const ch of c.children) i.appendChild(Object.assign(make(ch.type), { name: ch.name, characters: ch.characters, fontName: ch.fontName }));
        i.componentProperties = Object.fromEntries(Object.entries(c.props).map(([k, v]) => [k, { ...(v as N), value: (v as N).defaultValue }]));
        if (c.parent?.type === "COMPONENT_SET") i.componentProperties.State = { type: "VARIANT", value: "Open" };
        i.setProperties = (p: N) => { i.set = { ...(i.set ?? {}), ...p }; };
        return i;
      };
      return c;
    },
    combineAsVariants: (comps: N[], parent: N) => { const s = make("COMPONENT_SET"); parent.appendChild(s); comps.forEach((c) => s.appendChild(c)); s.defaultVariant = comps[0]; return s; },
    createNodeFromSvg: (svg: string) => { const f = make("FRAME"); f.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]; const v = make("VECTOR"); v.fills = [{ type: "SOLID" }]; f.appendChild(v); f.svg = svg; return f; },
    loadFontAsync: async (f: N) => { if (f.family === "Nope" || f.style === "SemiBold") throw new Error("missing"); loaded.push(`${f.family}/${f.style}`); },
    listAvailableFontsAsync: async () => [{ fontName: { family: "Inter", style: "Regular" } }, { fontName: { family: "Inter", style: "Semi Bold" } }],
    setCurrentPageAsync: async () => {},
    getLocalTextStylesAsync: async () => [{ id: "S:1", name: "Body", fontName: { family: "Inter", style: "Regular" } }],
    variables: {
      getLocalVariablesAsync: async (t?: string) => (t ? vars.filter((v) => v.resolvedType === t) : vars),
      getLocalVariableCollectionsAsync: async () => collections,
      setBoundVariableForPaint: (p: N, _f: string, v: N) => ({ ...p, boundVariables: { color: { type: "VARIABLE_ALIAS", id: v.id } } })
    }
  };
  return { figma, posted, page, nodes, loaded };
}

const plainRanges = (r: N[]) => r.map(({ a, b, after }) => ({ a, b, after }));

async function send(ctx: ReturnType<typeof mockFigma>, command: string, params: unknown) {
  const before = ctx.posted.length;
  await ctx.figma.ui.onmessage({ type: "request", id: "r", command, params });
  return ctx.posted.slice(before).find((m) => m.type === "response")!;
}

test("build_layout builds nested auto layout, components and instances in one call", async () => {
  const ctx = mockFigma();
  vm.runInNewContext(readFileSync("plugin/code.js", "utf8"), { figma: ctx.figma, __html__: "", console, JSON, Object, Promise, Symbol, Array, String, Number, Math, parseInt, parseFloat });
  const tree = [
    {
      type: "component", ref: "row", name: "Task row", layout: "row", gap: 12, padding: [12, 16], width: 358, cross: "center",
      componentProps: [{ name: "Title", type: "TEXT", default: "Task", layer: "Title" }],
      children: [
        { type: "ellipse", name: "Check", width: 20, height: 20, stroke: "#141B3D", strokeWidth: 1.5 },
        { name: "Title", text: "Task", font: "Inter/SemiBold", size: 16, width: "fill", color: "#141B3D" }
      ]
    },
    {
      name: "Today", width: 390, height: 844, fill: "#F3F4F8", layout: "column", padding: [24, 16], gap: "auto", bind: { fill: "color/ink", gap: "space/4" },
      children: [
        { name: "Heading", text: "Thursday", size: 34, textStyle: "Body", bind: { color: "color/ink" }, ranges: [{ start: 0, end: 3, color: "#2B3FE0" }] },
        { type: "instance", componentRef: "row", width: "fill", properties: { Title: "Call the landlord" }, overrides: { Title: { color: "#9097AE" } } },
        { type: "svg", name: "Icon", svg: "<svg/>", svgColor: "#2433D6", width: 24, height: 24 },
        { name: "Badge", position: "absolute", x: 300, y: 20, width: 40, height: 20, radius: 10, fill: "#F5E663" },
        { name: "Bad", width: "fill", font: "Nope/Bold", text: "x" }
      ]
    }
  ];
  const r = await send(ctx, "build_layout", { tree });
  assert.ok(r.ok, r.error);
  const res = r.result;
  assert.equal(res.roots.length, 2);
  const row = ctx.nodes.get(res.refs.row)!;
  assert.equal(row.layoutMode, "HORIZONTAL");
  assert.equal(row.paddingLeft, 16);
  assert.equal(row.counterAxisAlignItems, "CENTER");
  assert.equal(row.layoutSizingHorizontal, "FIXED");
  assert.equal(row.layoutSizingVertical, "HUG");
  const title = row.children[1];
  assert.equal(title.layoutSizingHorizontal, "FILL");
  assert.equal(title.textAutoResize, "HEIGHT");
  assert.deepEqual(title.fontName, { family: "Inter", style: "Semi Bold" }); // loose style match
  assert.ok(title.componentPropertyReferences.characters.startsWith("Title#"));

  const screen = ctx.nodes.get(res.roots[1].id)!;
  assert.equal(screen.x, row.x + row.width + 120); // placed side by side
  assert.equal(screen.primaryAxisAlignItems, "SPACE_BETWEEN");
  assert.equal(screen.layoutSizingVertical, "FIXED");
  assert.equal(screen.fills[0].boundVariables.color.id, "VariableID:1");
  assert.equal(screen.bound.itemSpacing, "space/4");
  assert.equal(screen.children[0].textStyleId, "S:1");
  const inst = screen.children[1];
  assert.equal(inst.type, "INSTANCE");
  assert.equal(inst.layoutSizingHorizontal, "FILL");
  assert.equal(Object.keys(inst.set)[0].split("#")[0], "Title");
  assert.equal(inst.children[1].fills[0].color.r.toFixed(2), (0x90 / 255).toFixed(2));
  assert.equal(screen.children[2].children[0].fills[0].color.b.toFixed(2), (0xd6 / 255).toFixed(2));
  assert.equal(screen.children[2].fills.length === 0 || screen.children[2].fills[0].color.r === 1, true, "svg wrapper frame must not be recolored");
  assert.deepEqual(plainRanges(screen.children[0].rangeFills), [{ a: 0, b: 3, after: true }], "ranges apply after the color binding");
  assert.equal(screen.children[3].layoutPositioning, "ABSOLUTE");
  assert.equal(screen.children[3].x, 300);
  assert.ok(res.warnings.some((w: string) => w.includes("Nope")), JSON.stringify(res.warnings));
});

test("build_layout combines variants and reports bad sizing as warnings", async () => {
  const ctx = mockFigma();
  vm.runInNewContext(readFileSync("plugin/code.js", "utf8"), { figma: ctx.figma, __html__: "", console, JSON, Object, Promise, Symbol, Array, String, Number, Math, parseInt, parseFloat });
  const r = await send(ctx, "build_layout", {
    tree: [
      { type: "componentSet", ref: "check", name: "Checkbox", children: [{ name: "State=Open", width: 20, height: 20 }, { name: "State=Done", width: 20, height: 20, fill: "#2433D6" }] },
      { name: "Loose", width: 100, height: 100, children: [{ name: "Filler", width: "fill", height: 10 }, { type: "instance", componentRef: "check", variant: { State: "Done" } }] }
    ]
  });
  assert.ok(r.ok, r.error);
  const set = ctx.nodes.get(r.result.refs.check)!;
  assert.equal(set.type, "COMPONENT_SET");
  assert.equal(set.children.length, 2);
  assert.ok(r.result.warnings.some((w: string) => w.includes("needs an auto-layout parent")));
  const loose = ctx.nodes.get(r.result.roots[1].id)!;
  assert.equal(loose.children[1].set.State, "Done");
});


test("sections fit their content, anchors pin to edges, arrows connect screens", async () => {
  const ctx = mockFigma();
  vm.runInNewContext(readFileSync("plugin/code.js", "utf8"), { figma: ctx.figma, __html__: "", console, JSON, Object, Promise, Symbol, Array, String, Number, Math, parseInt, parseFloat, Set });
  const r = await send(ctx, "build_layout", {
    tree: {
      type: "section", name: "Flow", padding: 100, fill: "#666666",
      children: [
        { name: "A", ref: "a", x: 0, y: 0, width: 390, height: 844, layout: "column", children: [
          { name: "Content", width: "fill", height: 700 },
          { name: "Nav", width: "fill", height: 80 },
          { name: "FAB", width: 120, height: 56, anchor: { right: 16, bottom: 16, above: "Nav" } }
        ] },
        { name: "B", ref: "b", x: 600, y: 200, width: 390, height: 844 },
        { type: "arrow", from: "a", to: "b" }
      ]
    }
  });
  assert.ok(r.ok, r.error);
  assert.equal(r.result.warnings, undefined, JSON.stringify(r.result.warnings));
  const sec = ctx.nodes.get(r.result.roots[0].id)!;
  assert.equal(sec.type, "SECTION");
  const [a, b, arrow] = sec.children;
  assert.equal(a.x, 100);
  assert.equal(sec.width, 100 + 990 + 100);
  assert.equal(sec.height, 100 + 200 + 844 + 100);
  const fab = a.children[2];
  assert.equal(fab.layoutPositioning, "ABSOLUTE");
  assert.equal(fab.x, 390 - 16 - 120);
  assert.equal(fab.y, a.children[1].y - 16 - 56);
  assert.equal(arrow.type, "VECTOR");
  const v = arrow.net.vertices;
  assert.equal(v[v.length - 1].strokeCap, "ARROW_LINES");
  assert.equal(v.length, 4); // elbow: A's right edge -> B's left edge at different heights
  assert.equal(arrow.x + v[0].x, a.x + a.width + 16);
});

test("bind_tokens binds raw colors; create_theme_variant rebinds to another collection", async () => {
  const ctx = mockFigma();
  vm.runInNewContext(readFileSync("plugin/code.js", "utf8"), { figma: ctx.figma, __html__: "", console, JSON, Object, Promise, Symbol, Array, String, Number, Math, parseInt, parseFloat, Set });
  const built = await send(ctx, "build_layout", { tree: { name: "Screen", width: 100, height: 100, fill: "#1A2147", children: [{ type: "rect", name: "Odd", width: 10, height: 10, fill: "#123456" }] } });
  const id = built.result.roots[0].id;
  const b = await send(ctx, "bind_tokens", { nodeIds: [id], collection: "Tokens", skip: ["color/on-highlight"] });
  assert.ok(b.ok, b.error);
  assert.equal(b.result.changed, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(b.result.unmatched)), { "#123456": 1 });
  const screen = ctx.nodes.get(id)!;
  assert.equal(screen.fills[0].boundVariables.color.id, "VariableID:1"); // ink, not the skipped role token
  const t = await send(ctx, "create_theme_variant", { nodeIds: [id], fromCollection: "Tokens", toCollection: "Tokens Dark", shadowAlpha: 3 });
  assert.ok(t.ok, t.error);
  const clone = ctx.nodes.get(t.result.created[0].id)!;
  assert.equal(clone.name, "Screen (Tokens Dark)");
  assert.equal(clone.y, screen.y + 100 + 200);
  assert.equal(clone.fills[0].boundVariables.color.id, "VariableID:9");
  assert.equal(t.result.created[0].unboundColors, 1);
  const noMode = await send(ctx, "create_theme_variant", { nodeIds: [id], fromCollection: "Tokens", mode: "Dark" });
  assert.match(noMode.error, /no mode 'Dark'.*toCollection/);
});


test("audit flags low contrast, small targets, raw colors, off-grid spacing and default names", async () => {
  const ctx = mockFigma();
  vm.runInNewContext(readFileSync("plugin/code.js", "utf8"), { figma: ctx.figma, __html__: "", console, JSON, Object, Promise, Symbol, Array, String, Number, Math, parseInt, parseFloat, Set });
  const built = await send(ctx, "build_layout", { tree: { name: "Screen", width: 390, height: 300, fill: "#FFFFFF", layout: "column", gap: 10, padding: 16, children: [
    { name: "Good", text: "Readable", color: "#1A2147", size: 16 },
    { name: "Faint", text: "Too light", color: "#BBBBBB", size: 16 },
    { name: "Big", text: "Large heading", color: "#888888", size: 28 },
    { name: "Buy button", width: 30, height: 30, fill: "#2B3FE0" },
    { name: "Frame 12", width: 10, height: 10 }
  ] } });
  const id = built.result.roots[0].id;
  const r = await send(ctx, "audit", { nodeIds: [id], platform: "ios" });
  assert.ok(r.ok, r.error);
  const by = (check: string) => JSON.parse(JSON.stringify(r.result.findings.filter((f: any) => f.check === check).map((f: any) => f.name)));
  assert.deepEqual(by("contrast"), ["Faint"]); // #888 at 28px is large text: 3.54:1 passes 3:1
  assert.deepEqual(by("targetSize"), ["Buy button"]);
  assert.ok(by("hardcodedColor").includes("Screen"));
  assert.deepEqual(by("spacingGrid"), ["Screen"]); // gap 10
  assert.deepEqual(by("layerName"), ["Frame 12"]);
  assert.equal(r.result.findings[0].severity, "error"); // #BBB on white is 1.9:1
});


test("annotate keeps existing notes valid and creates categories", async () => {
  const ctx = mockFigma();
  vm.runInNewContext(readFileSync("plugin/code.js", "utf8"), { figma: ctx.figma, __html__: "", console, JSON, Object, Promise, Symbol, Array, String, Number, Math, parseInt, parseFloat, Set });
  const built = await send(ctx, "build_layout", { tree: { name: "Row", width: 100, height: 40 } });
  const node = ctx.nodes.get(built.result.roots[0].id)!;
  // Figma reads annotations back with both label fields set and rejects that on write.
  let stored: N[] = [];
  Object.defineProperty(node, "annotations", {
    get: () => stored.map((a) => ({ label: a.label ?? "x", labelMarkdown: a.labelMarkdown ?? "x", ...a })),
    set: (v: N[]) => { for (const a of v) if (a.label && a.labelMarkdown) throw new Error("Only one of label or labelMarkdown"); stored = v; }
  });
  const first = await send(ctx, "annotate", { items: [{ nodeId: node.id, label: "Tap opens the task", category: "Interaction" }] });
  assert.ok(first.ok, first.error);
  const second = await send(ctx, "annotate", { items: [{ nodeId: node.id, label: "Row is the hit area", category: "Accessibility", color: "green", properties: ["padding"] }] });
  assert.ok(second.ok, second.error);
  assert.equal(stored.length, 2);
  assert.equal(stored[0].categoryId, "cat:1");
  assert.equal(stored[1].categoryId, "cat:2");
  assert.deepEqual(JSON.parse(JSON.stringify(stored[1].properties)), [{ type: "padding" }]);
});
