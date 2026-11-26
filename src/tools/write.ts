/**
 * Tools that modify a Figma file. They run through the companion plugin (Figma's REST API cannot
 * edit layers), inside the file the plugin is open in. Passing a Figma link routes the call to
 * the plugin window for that file when several files have it open.
 */
import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { NOT_CONNECTED, bridge } from "../bridge/bridge.js";
import { figmaSend } from "../figma/rest.js";
import { parseFigmaUrl } from "../figma/url.js";
import { DESTRUCTIVE, READ_ONLY, WRITE, json, text } from "./common.js";

const fileUrl = z.string().optional().describe("Figma link (or file key) of the file to edit. Needed only when the plugin is open in more than one file.");
const nodeId = z.string().min(1).describe('Node id, e.g. "12:345" (link form "12-345" also accepted)');
const parentId = z.string().optional().describe("Parent frame/group/page id; defaults to the current page");
const props = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    `Plugin API properties to set, e.g. {"fills":"#FF5500","cornerRadius":8,"layoutMode":"VERTICAL","itemSpacing":12,"padding":[16,24],"primaryAxisAlignItems":"CENTER","layoutSizingHorizontal":"FILL","opacity":0.8,"effects":[{"type":"DROP_SHADOW","color":"#00000040","offset":{"x":0,"y":4},"radius":12,"spread":0,"visible":true,"blendMode":"NORMAL"}]}. Text: {"characters":"Hi","fontSize":16,"fontFamily":"Inter","fontStyle":"Bold","lineHeight":24}. Colors accept "#RRGGBB(AA)", "rgba()", or {r,g,b,a}.`
  );

function route(url?: string): { fileKey?: string } {
  if (!url) return {};
  return { fileKey: parseFigmaUrl(url).fileKey };
}

const clean = (id?: string) => (id ? id.replace(/^(\d+)-(\d+)$/, "$1:$2") : id);

async function call<T = unknown>(command: string, params: Record<string, unknown>, url?: string, timeoutMs?: number): Promise<T> {
  return bridge.request<T>(command, params, { ...route(url), timeoutMs });
}

export function registerWriteTools(server: McpServer) {
  server.registerTool(
    "figma_plugin_status",
    {
      title: "Plugin connection status",
      description: "Shows which Figma files have the companion plugin connected (needed for every edit tool), and how to connect it if none are.",
      annotations: READ_ONLY
    },
    async () => {
      const list = bridge.listPlugins();
      if (!list.length) return text(`No plugin connected (bridge role: ${bridge.role}). ${NOT_CONNECTED}`);
      return json({ bridge: bridge.role, connected: list });
    }
  );

  server.registerTool(
    "figma_get_selection",
    {
      title: "Get current selection",
      description: "Returns the layers currently selected in Figma (via the plugin), with ids you can pass to the other tools.",
      inputSchema: z.object({ url: fileUrl }),
      annotations: READ_ONLY
    },
    async ({ url }) => json(await call("get_selection", {}, url))
  );

  server.registerTool(
    "figma_build_layout",
    {
      title: "Build a layout tree",
      description: `Builds a whole nested layer tree in one call: screens, auto-layout stacks, text, shapes, SVG icons, components, variants and instances. Prefer this over many figma_create_node calls. Returns ids (by "ref"), warnings for anything Figma rejected, and optionally a PNG of the result to check it.

Node spec (all fields optional except where noted):
- type: frame (default) | text (default when "text" is set) | rect | ellipse | line | svg (needs "svg") | instance | component | componentSet (children become variants, named "Prop=Value")
- name, ref (id handle for later nodes and the result), children: [...]
- Layout: layout "row"|"column"|"none", gap (number or "auto" = space-between), padding (n | [y,x] | [t,r,b,l]), align (main axis: start|center|end|between), cross (start|center|end|baseline), wrap
- Size: width/height = number | "fill" | "hug" (auto-layout frames hug by default), minWidth, maxWidth, grow
- Position: x, y (in non-auto-layout parents), position "absolute" inside auto layout
- Look: fill, stroke, strokeWidth (n or {top,right,bottom,left}), strokeAlign inside|center|outside, dash, radius (n | [tl,tr,br,bl]), smoothing (0-1), opacity, clip, shadow {x,y,blur,spread,color,inset} or [..], blur, backgroundBlur, visible, rotation. Colors: "#RRGGBB(AA)" or "rgba()".
- Text: text, font "Family/Style" (e.g. "Inter/Semi Bold"; styles matched loosely), weight 400-900, size, lineHeight (px | "140%" | "auto"), letterSpacing (px | "-2%"), color, textAlign, decoration underline|strikethrough, textCase, maxLines, ranges [{start,end,color,weight,size,decoration}]. width "fill" or a number makes it wrap.
- svg: svgColor recolors all its paths.
- Tokens: bind {fill|color|stroke|gap|padding|paddingX|paddingY|radius|width|height|opacity|<field>: "variable name"}, textStyle / fillStyle / effectStyle: "style name"
- Components: componentProps [{name, type TEXT|BOOLEAN|INSTANCE_SWAP, default, layer: "layer name"}] wires a property to a layer; description
- Instances: componentRef (a ref built earlier in this call) | componentId | componentKey, variant {Prop: "Value"}, properties {Name: value}, overrides {"Layer name": "new text" | {text, color, fill, visible, ...}}
- props: raw Plugin API properties applied last.
- Pinning: anchor {left, right, top, bottom, centerX, above: "sibling name"} positions the node against its parent's edges after the whole tree is laid out (absolute inside auto layout, constraints set), e.g. a floating button {right: 16, bottom: 16, above: "Navigation bar"} or a sheet {left: 0, bottom: 0}.
- Handoff: annotation "text" | {label, category, color, properties: ["padding","itemSpacing",...]} | [..] adds native Figma annotations (shown in Dev Mode); devStatus "READY_FOR_DEV" | "COMPLETED" | {type, description} on top-level frames or sections.
- Presentation: type "section" (children positioned by x/y; the section fits around them with "padding", default 120; "fill" for its background). type "arrow" {from, to (refs or ids), fromSide?, toSide?: "top", color, strokeWidth, dash, gap} draws an orthogonal connector with an arrowhead once everything is placed, for flows between screens.`,
      inputSchema: z.object({
        url: fileUrl,
        tree: z.union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown()))]).describe("Root node spec, or an array of them (e.g. several screens placed side by side)."),
        parent_id: parentId,
        page_id: z.string().optional().describe("Switch to this page first (parent defaults to it)"),
        x: z.number().optional().describe("Left of the first top-level node; by default it goes right of existing content"),
        y: z.number().optional(),
        gap: z.number().optional().describe("Horizontal gap between top-level nodes (default 120)"),
        screenshot: z.boolean().default(true).describe("Return a PNG of the built roots to check the result"),
        screenshot_scale: z.number().min(0.1).max(4).default(1),
        outline_depth: z.number().int().min(0).max(6).default(1).describe("Depth of the returned layer outline"),
        collection: z.string().optional().describe('Variable collection that "bind" names resolve in when several collections share names (e.g. light and dark). "name@Collection" in a bind overrides it.')
      }),
      annotations: WRITE
    },
    async ({ url, tree, parent_id, page_id, x, y, gap, screenshot, screenshot_scale, outline_depth, collection }) => {
      const r = await call<{ created: number; roots: { id: string; name: string }[]; refs: Record<string, string>; warnings?: string[] }>(
        "build_layout",
        { tree, parentId: clean(parent_id), pageId: clean(page_id), x, y, gap, outlineDepth: outline_depth, collection },
        url,
        300_000
      );
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
        { type: "text", text: JSON.stringify(r, null, 2) }
      ];
      if (screenshot) {
        for (const root of r.roots.slice(0, 4)) {
          try {
            const img = await call<{ base64: string }>("export_node", { nodeId: root.id, format: "PNG", scale: screenshot_scale }, url, 120_000);
            content.push({ type: "image", data: img.base64, mimeType: "image/png" });
          } catch (e) {
            content.push({ type: "text", text: `Screenshot of ${root.id} failed: ${(e as Error).message}` });
          }
        }
        if (r.roots.length > 4) content.push({ type: "text", text: `Showing the first 4 of ${r.roots.length} roots; use figma_get_screenshot with source "plugin" for the rest.` });
      }
      return { content };
    }
  );

  server.registerTool(
    "figma_bind_tokens",
    {
      title: "Bind raw colors to variables",
      description:
        "Finds solid colors (fills, strokes and styled text ranges) in the given layers that are not bound to a variable, and binds each to the variable in a collection whose value matches exactly. Use after building or importing layers so they follow the design tokens. Returns how many paints changed and which colors had no matching token.",
      inputSchema: z.object({
        url: fileUrl,
        node_ids: z.array(nodeId).min(1).describe("Root layers to process (their whole subtrees)"),
        collection: z.string().describe("Variable collection name or id to match against"),
        skip: z.array(z.string()).optional().describe('Variables never chosen by value, e.g. role tokens that share a value with a base token ("color/on-highlight")'),
        prefer: z.array(z.string()).optional().describe("Variables chosen first when several share a value"),
        rebind: z.boolean().default(false).describe("Also re-match paints currently bound to a skipped variable"),
        translucent: z.boolean().default(false).describe("Also bind paints with opacity below 1 (scrims, tints); off by default")
      }),
      annotations: WRITE
    },
    async ({ url, node_ids, collection, skip, prefer, rebind, translucent }) =>
      json(await call("bind_tokens", { nodeIds: node_ids.map(clean), collection, skip, prefer, rebind, translucent }, url, 120_000))
  );

  server.registerTool(
    "figma_create_theme_variant",
    {
      title: "Create a theme variant (e.g. dark mode)",
      description:
        "Clones layers (usually screens) as another theme. With `mode`, the clone switches the collection to that mode (paid plans with several modes). With `to_collection`, every color bound to `from_collection` is rebound to the same-named variable in `to_collection` (works on plans limited to one mode: keep a second collection such as \"Tokens Dark\" with identical names). Reports colors that were not bound to tokens, which will not change; run figma_bind_tokens on the source first. Clones inside auto layout flow after the original; a containing section grows to fit.",
      inputSchema: z.object({
        url: fileUrl,
        node_ids: z.array(nodeId).min(1),
        from_collection: z.string().describe("Collection the source layers are bound to"),
        to_collection: z.string().optional().describe("Collection with the same variable names holding the variant values"),
        mode: z.string().optional().describe("Mode of from_collection to switch the clones to"),
        dx: z.number().optional().describe("Horizontal offset of each clone (default 0)"),
        dy: z.number().optional().describe("Vertical offset of each clone (default: height + 200)"),
        suffix: z.string().optional().describe('Appended to clone names (default " (<mode or collection>)")'),
        shadow_alpha: z.number().min(0).max(10).optional().describe("Multiply drop-shadow opacity (and make shadows black), e.g. 3 for dark themes")
      }),
      annotations: WRITE
    },
    async ({ url, node_ids, from_collection, to_collection, mode, dx, dy, suffix, shadow_alpha }) =>
      json(
        await call(
          "create_theme_variant",
          { nodeIds: node_ids.map(clean), fromCollection: from_collection, toCollection: to_collection, mode, dx, dy, suffix, shadowAlpha: shadow_alpha },
          url,
          180_000
        )
      )
  );

  const anchorSchema = z
    .object({
      left: z.number().optional(),
      right: z.number().optional(),
      top: z.number().optional(),
      bottom: z.number().optional(),
      centerX: z.boolean().optional(),
      above: z.string().optional().describe("Name of a sibling; 'bottom' is measured from its top edge")
    })
    .describe("Distances from the parent's edges");

  server.registerTool(
    "figma_anchor_nodes",
    {
      title: "Pin layers to their parent's edges",
      description:
        "Positions existing layers against their parent's edges and sets matching constraints, taking them out of auto-layout flow if needed. For floating buttons, bottom sheets, toasts and badges, e.g. {right: 16, bottom: 16, above: \"Navigation bar\"}.",
      inputSchema: z.object({ url: fileUrl, items: z.array(z.object({ node_id: nodeId, anchor: anchorSchema })).min(1) }),
      annotations: WRITE
    },
    async ({ url, items }) => json(await call("anchor_nodes", { items: items.map((i) => ({ nodeId: clean(i.node_id), anchor: i.anchor })) }, url))
  );

  server.registerTool(
    "figma_draw_arrows",
    {
      title: "Draw flow arrows",
      description:
        "Draws orthogonal connector arrows between existing layers, e.g. from a button to the screen or sheet it opens. The side is chosen from the layers' positions unless given.",
      inputSchema: z.object({
        url: fileUrl,
        parent_id: parentId.describe("Where the arrows are placed (a section or frame containing both ends); defaults to the current page"),
        arrows: z
          .array(
            z.object({
              from: nodeId,
              to: nodeId,
              fromSide: z.enum(["left", "right", "top", "bottom"]).optional(),
              toSide: z.enum(["top"]).optional(),
              color: z.string().optional().describe("Default dark grey (#4A4F5E), for light grey presentation sections"),
              strokeWidth: z.number().optional(),
              dash: z.array(z.number()).optional(),
              name: z.string().optional()
            })
          )
          .min(1)
      }),
      annotations: WRITE
    },
    async ({ url, parent_id, arrows }) =>
      json(await call("draw_arrows", { parentId: clean(parent_id), arrows: arrows.map((a) => ({ ...a, from: clean(a.from), to: clean(a.to) })) }, url))
  );

  server.registerTool(
    "figma_audit",
    {
      title: "Design QA audit",
      description: `Checks layers against accessibility and design-system standards and lists findings with node ids:
- contrast: text vs. its background, WCAG 2.2 1.4.3 (4.5:1, large text 3:1), per styled range
- nonTextContrast: outlines and icons vs. background, WCAG 1.4.11 (3:1)
- targetSize: buttons, tabs, keys, checkboxes and anything with prototype reactions, against the platform hit area (ios 44pt per Apple HIG, android 48dp per Material, web 24px per WCAG 2.5.8)
- hardcodedColor: fills/strokes not bound to a variable or style
- textStyle: text without a text style
- spacingGrid: auto-layout gap/padding off the 4px grid
- layerName: default names like "Frame 12"
- autoLayout: frames with several children and no auto layout
Layers inside instances are checked for contrast and size only (their tokens belong to the main component). Run it on screens after building them and fix errors first.`,
      inputSchema: z.object({
        url: fileUrl,
        node_ids: z.array(nodeId).min(1).describe("Screens, sections or components to audit"),
        platform: z.enum(["ios", "android", "web"]).default("web"),
        checks: z.array(z.enum(["contrast", "nonTextContrast", "targetSize", "hardcodedColor", "textStyle", "spacingGrid", "layerName", "autoLayout"])).optional().describe("Default: all"),
        max_findings: z.number().int().min(1).max(2000).default(200)
      }),
      annotations: READ_ONLY
    },
    async ({ url, node_ids, platform, checks, max_findings }) =>
      json(await call("audit", { nodeIds: node_ids.map(clean), platform, checks, maxFindings: max_findings }, url, 180_000))
  );

  server.registerTool(
    "figma_annotate",
    {
      title: "Add native annotations",
      description:
        "Adds Figma's native annotations to layers: a note (plain text or markdown), optionally pinned properties that Dev Mode shows live (e.g. padding, itemSpacing, cornerRadius, fills, textStyleId, width, height), in a category such as \"Interaction\", \"Accessibility\" or \"Content\" (created if missing). Developers see them in Dev Mode next to the design. Prefer this over drawn note text for handoff.",
      inputSchema: z.object({
        url: fileUrl,
        items: z
          .array(
            z.object({
              node_id: nodeId,
              label: z.string().describe("The note"),
              markdown: z.boolean().optional().describe("Treat label as markdown"),
              category: z.string().optional(),
              color: z.enum(["yellow", "orange", "red", "pink", "violet", "blue", "teal", "green"]).optional().describe("Color for a new category"),
              properties: z.array(z.string()).optional().describe("Annotation property types to pin, e.g. [\"padding\", \"itemSpacing\"]")
            })
          )
          .min(1),
        replace: z.boolean().default(false).describe("Replace existing annotations on those layers")
      }),
      annotations: WRITE
    },
    async ({ url, items, replace }) =>
      json(await call("annotate", { items: items.map((i) => ({ nodeId: clean(i.node_id), label: i.label, markdown: i.markdown, category: i.category, color: i.color, properties: i.properties })), replace }, url))
  );

  server.registerTool(
    "figma_set_dev_status",
    {
      title: "Mark ready for development",
      description:
        "Sets the Dev Mode status of top-level frames or sections (directly on a page or in a section): READY_FOR_DEV, COMPLETED, or none to clear. Needs a plan with Dev Mode (Professional or higher; Completed needs Organization or higher).",
      inputSchema: z.object({
        url: fileUrl,
        node_ids: z.array(nodeId).min(1),
        status: z.enum(["READY_FOR_DEV", "COMPLETED", "NONE"]),
        description: z.string().optional().describe("What changed or what to build")
      }),
      annotations: WRITE
    },
    async ({ url, node_ids, status, description }) =>
      json(await call("set_dev_status", { nodeIds: node_ids.map(clean), status: status === "NONE" ? null : status, description }, url))
  );

  server.registerTool(
    "figma_create_node",
    {
      title: "Create a layer",
      description: "Creates a FRAME, RECTANGLE, ELLIPSE, LINE, POLYGON, STAR, COMPONENT, SECTION or TEXT layer, optionally inside a parent and with properties (auto layout, fills, text…). Returns its id.",
      inputSchema: z.object({
        url: fileUrl,
        type: z.enum(["FRAME", "RECTANGLE", "ELLIPSE", "LINE", "POLYGON", "STAR", "COMPONENT", "SECTION", "TEXT"]),
        parent_id: parentId,
        name: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        index: z.number().int().min(0).optional().describe("Position among the parent's children"),
        props
      }),
      annotations: WRITE
    },
    async ({ url, type, parent_id, name, x, y, width, height, index, props: p }) =>
      json(await call("create_node", { type, parentId: clean(parent_id), name, x, y, width, height, index, props: p }, url))
  );

  server.registerTool(
    "figma_update_node",
    {
      title: "Update layer properties",
      description: "Sets properties on an existing layer: size, position, fills, strokes, radius, opacity, auto layout, sizing, effects, constraints, text style, name, visibility…",
      inputSchema: z.object({ url: fileUrl, node_id: nodeId, props: props.unwrap() }),
      annotations: WRITE
    },
    async ({ url, node_id, props: p }) => json(await call("update_node", { nodeId: clean(node_id), props: p }, url))
  );

  server.registerTool(
    "figma_set_text",
    {
      title: "Set text content",
      description: "Replaces a text layer's characters (fonts are loaded automatically) and optionally its text properties.",
      inputSchema: z.object({ url: fileUrl, node_id: nodeId, text: z.string(), props }),
      annotations: WRITE
    },
    async ({ url, node_id, text: t, props: p }) => json(await call("set_text", { nodeId: clean(node_id), text: t, props: p }, url))
  );

  server.registerTool(
    "figma_delete_nodes",
    {
      title: "Delete layers",
      description: "Deletes the given layers. Undo in Figma with Cmd/Ctrl+Z.",
      inputSchema: z.object({ url: fileUrl, node_ids: z.array(z.string()).min(1) }),
      annotations: DESTRUCTIVE
    },
    async ({ url, node_ids }) => json(await call("delete_nodes", { nodeIds: node_ids.map(clean) }, url))
  );

  server.registerTool(
    "figma_clone_node",
    {
      title: "Duplicate a layer",
      description: "Duplicates a layer, optionally into another parent and at a position.",
      inputSchema: z.object({ url: fileUrl, node_id: nodeId, parent_id: parentId, x: z.number().optional(), y: z.number().optional() }),
      annotations: WRITE
    },
    async ({ url, node_id, parent_id, x, y }) => json(await call("clone_node", { nodeId: clean(node_id), parentId: clean(parent_id), x, y }, url))
  );

  server.registerTool(
    "figma_move_node",
    {
      title: "Move / reparent / reorder a layer",
      description: "Moves a layer into another parent and/or to an index among its siblings and/or to x/y.",
      inputSchema: z.object({ url: fileUrl, node_id: nodeId, parent_id: parentId, index: z.number().int().min(0).optional(), x: z.number().optional(), y: z.number().optional() }),
      annotations: WRITE
    },
    async ({ url, node_id, parent_id, index, x, y }) => json(await call("move_node", { nodeId: clean(node_id), parentId: clean(parent_id), index, x, y }, url))
  );

  server.registerTool(
    "figma_group_nodes",
    {
      title: "Group layers",
      description: "Groups layers (or wraps them in a new frame with frame=true).",
      inputSchema: z.object({ url: fileUrl, node_ids: z.array(z.string()).min(1), name: z.string().optional(), frame: z.boolean().default(false) }),
      annotations: WRITE
    },
    async ({ url, node_ids, name, frame }) => json(await call("group_nodes", { nodeIds: node_ids.map(clean), name, frame }, url))
  );

  server.registerTool(
    "figma_create_instance",
    {
      title: "Insert a component instance",
      description: "Creates an instance of a local component (component_id; a component set uses its default variant) or a library component (component_key), optionally setting its properties/variant.",
      inputSchema: z.object({
        url: fileUrl,
        component_id: z.string().optional(),
        component_key: z.string().optional().describe("Published component key (from figma_get_components)"),
        parent_id: parentId,
        x: z.number().optional(),
        y: z.number().optional(),
        index: z.number().int().min(0).optional(),
        properties: z.record(z.string(), z.union([z.string(), z.boolean()])).optional().describe('e.g. {"Size":"Large","Label#12:0":"Buy"}')
      }),
      annotations: WRITE
    },
    async ({ url, component_id, component_key, parent_id, x, y, index, properties }) => {
      if (!component_id && !component_key) throw new Error("Pass component_id or component_key.");
      return json(await call("create_instance", { componentId: clean(component_id), componentKey: component_key, parentId: clean(parent_id), x, y, index, properties }, url));
    }
  );

  server.registerTool(
    "figma_set_instance_properties",
    {
      title: "Set instance properties / swap component",
      description: "Changes an instance's variant and component properties (short names like \"Label\" work), or swaps it to another component.",
      inputSchema: z.object({
        url: fileUrl,
        node_id: nodeId,
        properties: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
        swap_component_id: z.string().optional(),
        swap_component_key: z.string().optional()
      }),
      annotations: WRITE
    },
    async ({ url, node_id, properties, swap_component_id, swap_component_key }) =>
      json(await call("set_instance_properties", { nodeId: clean(node_id), properties, swapComponentId: clean(swap_component_id), swapComponentKey: swap_component_key }, url))
  );

  server.registerTool(
    "figma_detach_instance",
    {
      title: "Detach instance",
      description: "Detaches an instance from its component, turning it into a regular frame.",
      inputSchema: z.object({ url: fileUrl, node_id: nodeId }),
      annotations: DESTRUCTIVE
    },
    async ({ url, node_id }) => json(await call("detach_instance", { nodeId: clean(node_id) }, url))
  );

  server.registerTool(
    "figma_create_component",
    {
      title: "Create component / variant set",
      description: "Turns a layer into a component (node_id), or combines several components into a variant set (combine_node_ids).",
      inputSchema: z.object({ url: fileUrl, node_id: z.string().optional(), combine_node_ids: z.array(z.string()).optional(), name: z.string().optional() }),
      annotations: WRITE
    },
    async ({ url, node_id, combine_node_ids, name }) => {
      if (combine_node_ids?.length) return json(await call("create_component", { combineAsVariants: true, nodeIds: combine_node_ids.map(clean), name }, url));
      if (!node_id) throw new Error("Pass node_id or combine_node_ids.");
      return json(await call("create_component", { nodeId: clean(node_id), name }, url));
    }
  );

  server.registerTool(
    "figma_create_from_svg",
    {
      title: "Import SVG as layers",
      description: "Creates vector layers from SVG markup (icons, illustrations).",
      inputSchema: z.object({ url: fileUrl, svg: z.string().min(10), parent_id: parentId, x: z.number().optional(), y: z.number().optional(), name: z.string().optional() }),
      annotations: WRITE
    },
    async ({ url, svg, parent_id, x, y, name }) => json(await call("create_from_svg", { svg, parentId: clean(parent_id), x, y, name }, url))
  );

  server.registerTool(
    "figma_insert_image",
    {
      title: "Insert an image",
      description: "Places an image (from a local file path, an https URL, or base64) as a new rectangle, or as the fill of an existing layer (node_id).",
      inputSchema: z.object({
        url: fileUrl,
        image_path: z.string().optional(),
        image_url: z.string().optional(),
        base64: z.string().optional(),
        node_id: z.string().optional().describe("Fill this existing layer instead of creating a rectangle"),
        parent_id: parentId,
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        scale_mode: z.enum(["FILL", "FIT", "CROP", "TILE"]).default("FILL"),
        name: z.string().optional()
      }),
      annotations: WRITE
    },
    async ({ url, image_path, image_url, base64, node_id, parent_id, x, y, width, height, scale_mode, name }) => {
      let b64 = base64;
      if (!b64 && image_path) b64 = (await readFile(image_path)).toString("base64");
      if (!b64 && image_url) {
        const res = await fetch(image_url);
        if (!res.ok) throw new Error(`Downloading ${image_url} failed: HTTP ${res.status}`);
        b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      }
      if (!b64) throw new Error("Pass image_path, image_url or base64.");
      return json(await call("insert_image", { base64: b64, nodeId: clean(node_id), parentId: clean(parent_id), x, y, width, height, scaleMode: scale_mode, name }, url, 60_000));
    }
  );

  server.registerTool(
    "figma_select_nodes",
    {
      title: "Select and zoom to layers",
      description: "Selects layers in Figma and scrolls/zooms the viewport to them (switching page if needed). Useful to show the user what you changed.",
      inputSchema: z.object({ url: fileUrl, node_ids: z.array(z.string()).min(1), zoom: z.boolean().default(true) }),
      annotations: { ...WRITE, idempotentHint: true }
    },
    async ({ url, node_ids, zoom }) => json(await call("select_nodes", { nodeIds: node_ids.map(clean), zoom }, url))
  );

  server.registerTool(
    "figma_create_page",
    {
      title: "Create a page",
      description: "Adds a page to the file, optionally switching to it.",
      inputSchema: z.object({ url: fileUrl, name: z.string(), switch_to: z.boolean().default(false) }),
      annotations: WRITE
    },
    async ({ url, name, switch_to }) => json(await call("create_page", { name, switchTo: switch_to }, url))
  );

  server.registerTool(
    "figma_create_variable_collection",
    {
      title: "Create variable collection",
      description: 'Creates a variable collection with modes, e.g. name "Colors", modes ["Light","Dark"].',
      inputSchema: z.object({ url: fileUrl, name: z.string(), modes: z.array(z.string()).optional() }),
      annotations: WRITE
    },
    async ({ url, name, modes }) => json(await call("create_variable_collection", { name, modes }, url))
  );

  server.registerTool(
    "figma_create_variable",
    {
      title: "Create variable",
      description: 'Creates a variable in a collection with a value per mode, e.g. type COLOR, values {"Light":"#FFFFFF","Dark":"#111111"}, or an alias {"Light":{"alias":"Base/White"}}.',
      inputSchema: z.object({
        url: fileUrl,
        collection_id: z.string(),
        name: z.string().describe('Slash-separated groups allowed, e.g. "Background/Primary"'),
        type: z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]),
        values: z.record(z.string(), z.unknown()).describe("Mode name (or id) -> value"),
        description: z.string().optional(),
        scopes: z.array(z.string()).optional(),
        code_syntax: z.record(z.string(), z.string()).optional().describe('e.g. {"WEB":"var(--bg-primary)"}')
      }),
      annotations: WRITE
    },
    async ({ url, collection_id, name, type, values, description, scopes, code_syntax }) =>
      json(await call("create_variable", { collectionId: collection_id, name, type, values, description, scopes, codeSyntax: code_syntax }, url))
  );

  server.registerTool(
    "figma_set_variable_value",
    {
      title: "Set variable values",
      description: "Updates a variable's value for one or more modes.",
      inputSchema: z.object({ url: fileUrl, variable_id: z.string(), values: z.record(z.string(), z.unknown()) }),
      annotations: WRITE
    },
    async ({ url, variable_id, values }) => json(await call("set_variable_value", { variableId: variable_id, values }, url))
  );

  server.registerTool(
    "figma_bind_variable",
    {
      title: "Bind variable to a property",
      description: 'Binds a variable to a layer property: "fills"/"strokes" (color, with paint_index), or a numeric field like "itemSpacing", "paddingLeft", "cornerRadius", "width", "opacity".',
      inputSchema: z.object({ url: fileUrl, node_id: nodeId, field: z.string(), variable_id: z.string(), paint_index: z.number().int().min(0).optional() }),
      annotations: WRITE
    },
    async ({ url, node_id, field, variable_id, paint_index }) => json(await call("bind_variable", { nodeId: clean(node_id), field, variableId: variable_id, paintIndex: paint_index }, url))
  );

  server.registerTool(
    "figma_create_style",
    {
      title: "Create a style",
      description: 'Creates a local FILL (value: color or paints), TEXT (value: {fontFamily,fontStyle,fontSize,lineHeight,letterSpacing}) or EFFECT (value: effects array) style.',
      inputSchema: z.object({ url: fileUrl, type: z.enum(["FILL", "TEXT", "EFFECT"]), name: z.string(), value: z.unknown(), description: z.string().optional() }),
      annotations: WRITE
    },
    async ({ url, type, name, value, description }) => json(await call("create_style", { type, name, value, description }, url))
  );

  server.registerTool(
    "figma_apply_style",
    {
      title: "Apply a style to a layer",
      description: "Applies a local style to a layer as its fill, stroke, text or effect style.",
      inputSchema: z.object({ url: fileUrl, node_id: nodeId, style_id: z.string(), kind: z.enum(["fill", "stroke", "text", "effect"]).default("fill") }),
      annotations: WRITE
    },
    async ({ url, node_id, style_id, kind }) => json(await call("apply_style", { nodeId: clean(node_id), styleId: style_id, kind }, url))
  );

  server.registerTool(
    "figma_execute",
    {
      title: "Run Figma Plugin API code",
      description: `Runs JavaScript inside the Figma plugin with the full Plugin API, for anything the other tools don't cover (bulk edits, complex layouts, reading plugin-only data). The code is the body of an async function with \`figma\`, \`params\` and \`helpers\` ({getNode, toPaints, parseColor, applyProps, summary}) in scope; \`return\` a JSON-serializable value. Load fonts before editing text: await figma.loadFontAsync({family:"Inter",style:"Regular"}).
Example: const f = figma.createFrame(); f.layoutMode = "VERTICAL"; f.itemSpacing = 8; return helpers.summary(f);`,
      inputSchema: z.object({ url: fileUrl, code: z.string().min(1), params: z.record(z.string(), z.unknown()).optional(), timeout_ms: z.number().int().min(1000).max(600_000).default(60_000) }),
      annotations: DESTRUCTIVE
    },
    async ({ url, code, params, timeout_ms }) => json(await call("execute", { code, params }, url, timeout_ms))
  );

  // REST write: comments do not need the plugin.
  server.registerTool(
    "figma_post_comment",
    {
      title: "Post a comment",
      description: "Posts a comment on the file (optionally pinned to a node, or as a reply). Requires FIGMA_TOKEN with the file_comments:write scope.",
      inputSchema: z.object({ url: z.string().describe("Figma link; its node-id pins the comment"), message: z.string().min(1), reply_to: z.string().optional() }),
      annotations: WRITE
    },
    async ({ url, message, reply_to }, ctx) => {
      const t = parseFigmaUrl(url);
      const body: Record<string, unknown> = { message };
      if (reply_to) body.comment_id = reply_to;
      else if (t.nodeId) body.client_meta = { node_id: t.nodeId, node_offset: { x: 0, y: 0 } };
      return json(await figmaSend("POST", `/v1/files/${t.mainFileKey}/comments`, body, ctx.mcpReq.signal));
    }
  );
}
