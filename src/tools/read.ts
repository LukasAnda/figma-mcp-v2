import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { downloadAssets, renderNodes, type AssetRequest } from "../assets.js";
import { bridge } from "../bridge/bridge.js";
import { generateCode } from "../figma/codegen.js";
import { getComments, getFile, getLocalVariables, getNodes, type RestNode } from "../figma/rest.js";
import { simplify, colorToCss } from "../figma/simplify.js";
import { nodeUrl, type FigmaTarget } from "../figma/url.js";
import { loadNodes, webLoadAllPages, webLoadDefinitions, withSource, topLevelId, type ConcreteSource } from "../source.js";
import { toDtcg, type VariableData } from "../tokens/dtcg.js";
import { toYaml } from "../util/yaml.js";
import { getWebFileMeta, guidStr, webSession } from "../web/client.js";
import { GraphConverter } from "../web/convert.js";
import { MAX_OUTPUT_CHARS, READ_ONLY, WRITE, json, nodeIdField, sourceField, target, text, urlField } from "./common.js";

const formatField = z.enum(["yaml", "json"]).default("yaml").describe("yaml (default, ~30% fewer tokens) or json");

function requireNode(t: FigmaTarget, tool: string): string {
  if (!t.nodeId) {
    throw new Error(`${tool} needs a node. Use a link with ?node-id=… (right-click a frame in Figma > Copy link to selection), pass node_id, or call figma_get_file to list pages and frames.`);
  }
  return t.nodeId;
}

function maxTreeDepth(n: RestNode, d = 0): number {
  return Math.max(d, ...(n.children ?? []).map((c) => maxTreeDepth(c, d + 1)));
}


/** Variables in one shape for every source: values per mode name, aliases as { alias: name }. */
async function loadVariableData(s: ConcreteSource, t: FigmaTarget, signal?: AbortSignal): Promise<VariableData> {
  if (s === "web") return (await webLoadDefinitions(t)).listVariables() as unknown as VariableData;
  if (s === "rest") {
    const v = await getLocalVariables(t.fileKey, signal);
    const cols = Object.values(v.meta.variableCollections);
    const byId = v.meta.variables;
    return {
      collections: cols.map((c) => ({ id: c.id, name: c.name, modes: c.modes })),
      variables: Object.values(byId).map((x) => {
        const c = v.meta.variableCollections[x.variableCollectionId];
        const values: Record<string, unknown> = {};
        for (const [modeId, val] of Object.entries(x.valuesByMode)) {
          const mode = c?.modes.find((m) => m.modeId === modeId)?.name ?? modeId;
          const vv = val as { type?: string; id?: string; r?: number; g?: number; b?: number; a?: number };
          values[mode] = vv?.type === "VARIABLE_ALIAS" ? { alias: byId[vv.id!]?.name ?? vv.id } : typeof vv === "object" && vv && "r" in vv ? colorToCss(vv as never) : val;
        }
        const extra = x as unknown as { scopes?: string[]; codeSyntax?: Record<string, string> };
        return { id: x.id, name: x.name, collection: c?.name ?? x.variableCollectionId, type: x.resolvedType, description: x.description || undefined, values, scopes: extra.scopes, codeSyntax: extra.codeSyntax };
      })
    };
  }
  return bridge.request<VariableData>("get_variables", {}, { fileKey: t.fileKey });
}

export function registerReadTools(server: McpServer) {
  // ------------------------------------------------------------------ file overview
  server.registerTool(
    "figma_get_file",
    {
      title: "Get Figma file overview",
      description: `Lists a file's pages and the top-level frames/sections/components on each, with ids and sizes. Start here when a link has no node-id, then pass a frame's id to figma_get_design / figma_get_code / figma_get_screenshot.`,
      inputSchema: z.object({ url: urlField, source: sourceField }),
      annotations: READ_ONLY
    },
    async ({ url, source }, ctx) => {
      const t = target(url);
      return withSource(source, t, async (s) => {
        if (s === "web") {
          const session = webSession(t.fileKey);
          await session.ensureDocument();
          const pages = session.graph.childrenOf("0:0").filter((p) => p.type === "CANVAS" && p.name !== "Internal Only Canvas" && !p.internalOnly);
          await session.ensurePageTops(pages.map((p) => guidStr(p.guid)));
          let meta: Awaited<ReturnType<typeof getWebFileMeta>> | undefined;
          try {
            meta = await getWebFileMeta(t.fileKey, ctx.mcpReq.signal);
          } catch {
            /* optional */
          }
          const conv = new GraphConverter(session.graph);
          const out = {
            file: meta?.name ?? t.fileName ?? t.fileKey,
            fileKey: t.fileKey,
            lastModified: meta?.updated_at,
            linkAccess: meta?.link_access,
            access: session.access,
            source: "web",
            pages: pages.map((p) => ({
              id: guidStr(p.guid),
              name: p.name,
              children: session.graph
                .childrenOf(guidStr(p.guid))
                .map((c) => conv.convert(guidStr(c.guid), { maxDepth: 0 }))
                .filter((c): c is RestNode => !!c)
                .map((c) => {
                  const bb = c.absoluteBoundingBox as { width: number; height: number } | undefined;
                  return `${c.id} ${c.type} "${c.name}"${bb ? ` ${Math.round(bb.width)}x${Math.round(bb.height)}` : ""}`;
                })
            }))
          };
          return text(toYaml(out));
        }
        if (s === "rest") {
          const f = await getFile(t.fileKey, { depth: 2 }, ctx.mcpReq.signal);
          return text(
            toYaml({
              file: f.name,
              fileKey: t.fileKey,
              lastModified: f.lastModified,
              source: "rest",
              pages: (f.document.children ?? []).map((p) => ({
                id: p.id,
                name: p.name,
                children: (p.children ?? []).map((c) => {
                  const bb = c.absoluteBoundingBox as { width: number; height: number } | undefined;
                  return `${c.id} ${c.type} "${c.name}"${bb ? ` ${Math.round(bb.width)}x${Math.round(bb.height)}` : ""}`;
                })
              }))
            })
          );
        }
        return text(toYaml(await bridge.request("get_document_info", {}, { fileKey: t.fileKey })));
      });
    }
  );

  // ------------------------------------------------------------------ design spec
  server.registerTool(
    "figma_get_design",
    {
      title: "Get design spec for a node",
      description: `Returns a compact, code-oriented spec of a frame/component/layer: layout (flex direction, gap, padding, alignment, sizing fill/hug/fixed), size/position, fills, strokes, radius, effects, text content and typography, component/variant/props of instances, bound variables (design tokens) by name, and which layers should be exported as assets. Repeated styles are listed once under "styles" and referenced by id (named Figma styles keep their names).

No Dev Mode or Figma seat needed. Works from a link: https://www.figma.com/design/<key>/<name>?node-id=1-2

Use figma_get_screenshot alongside to see it, figma_get_code for a starting implementation, figma_download_assets to fetch icons/images.`,
      inputSchema: z.object({
        url: urlField,
        node_id: nodeIdField,
        depth: z.number().int().min(0).max(50).optional().describe("Levels below the node to include. Omit for everything; the result is trimmed automatically if too large."),
        include_hidden: z.boolean().default(false).describe("Include hidden layers"),
        format: formatField,
        source: sourceField
      }),
      annotations: READ_ONLY
    },
    async ({ url, node_id, depth, include_hidden, format, source }, ctx) => {
      const t = target(url, node_id);
      const nodeId = requireNode(t, "figma_get_design");
      return withSource(source, t, async (s) => {
        const loaded = await loadNodes(s, t, [nodeId], s === "rest" ? depth : undefined, ctx.mcpReq.signal);
        const root = loaded.roots[0];
        const fullDepth = maxTreeDepth(root);
        let d = depth;
        let body = "";
        let note = "";
        for (;;) {
          const design = simplify(loaded.roots, loaded.ctx, { maxDepth: d, includeHidden: include_hidden });
          body = format === "json" ? JSON.stringify(design, null, 1) : toYaml(design);
          if (body.length <= MAX_OUTPUT_CHARS) break;
          const next = Math.min(d ?? fullDepth, fullDepth) - 1;
          if (next < 1) break;
          d = next;
          note = `\nNote: output trimmed to depth ${d} to fit (${fullDepth} levels exist). Call again with node_id set to a truncated child's id to see deeper.`;
        }
        const header = `# ${root.name} (${root.id}, ${root.type}) — source: ${loaded.source}\n${nodeUrl(t.fileKey, root.id)}${note}\n`;
        return text(header + "\n" + body);
      });
    }
  );

  // ------------------------------------------------------------------ outline / search
  server.registerTool(
    "figma_get_metadata",
    {
      title: "Get layer outline / find layers",
      description: `Sparse outline of a node's layer tree: one line per layer with id, type, name, position and size (text layers show their text). Cheaper than figma_get_design for large screens. With name/type/text filters it searches the subtree and lists matches with their path, e.g. find every "Button" instance or the layer containing "Checkout".`,
      inputSchema: z.object({
        url: urlField,
        node_id: nodeIdField,
        depth: z.number().int().min(0).max(50).default(4).describe("Outline depth (ignored when filtering)"),
        name_contains: z.string().optional().describe("Case-insensitive substring of the layer name"),
        text_contains: z.string().optional().describe("Case-insensitive substring of a text layer's content"),
        types: z.array(z.string()).optional().describe('Layer types to match, e.g. ["INSTANCE","TEXT","FRAME","COMPONENT"]'),
        limit: z.number().int().min(1).max(2000).default(300),
        source: sourceField
      }),
      annotations: READ_ONLY
    },
    async ({ url, node_id, depth, name_contains, text_contains, types, limit, source }, ctx) => {
      const t = target(url, node_id);
      const nodeId = requireNode(t, "figma_get_metadata");
      return withSource(source, t, async (s) => {
        const loaded = await loadNodes(s, t, [nodeId], undefined, ctx.mcpReq.signal);
        const lines: string[] = [];
        const filtering = !!(name_contains || text_contains || types?.length);
        const nameQ = name_contains?.toLowerCase();
        const textQ = text_contains?.toLowerCase();
        const typeSet = types?.length ? new Set(types.map((x) => x.toUpperCase())) : undefined;
        let total = 0;
        const line = (n: RestNode, indent: string, pathStr?: string) => {
          const bb = n.absoluteBoundingBox as { x: number; y: number; width: number; height: number } | undefined;
          const rootBB = loaded.roots[0].absoluteBoundingBox as { x: number; y: number } | undefined;
          const pos = bb && rootBB ? ` @${Math.round(bb.x - rootBB.x)},${Math.round(bb.y - rootBB.y)} ${Math.round(bb.width)}x${Math.round(bb.height)}` : "";
          const extra = n.type === "TEXT" ? ` "${String(n.characters ?? "").slice(0, 80).replace(/\n/g, "⏎")}"` : n.visible === false ? " (hidden)" : "";
          return `${indent}${n.id} ${n.type} "${n.name}"${pos}${extra}${pathStr ? `  ← ${pathStr}` : ""}`;
        };
        const walk = (n: RestNode, d: number, trail: string[]) => {
          if (filtering) {
            const ok =
              (!nameQ || n.name.toLowerCase().includes(nameQ)) &&
              (!textQ || (n.type === "TEXT" && String(n.characters ?? "").toLowerCase().includes(textQ))) &&
              (!typeSet || typeSet.has(n.type));
            if (ok) {
              total++;
              if (lines.length < limit) lines.push(line(n, "", trail.join(" / ")));
            }
            for (const c of n.children ?? []) walk(c, d + 1, [...trail, n.name]);
            return;
          }
          total++;
          if (lines.length < limit) lines.push(line(n, "  ".repeat(d)));
          if (d < depth) for (const c of n.children ?? []) walk(c, d + 1, trail);
          else if (n.children?.length && lines.length < limit) lines.push(`${"  ".repeat(d + 1)}… ${n.children.length} children`);
        };
        walk(loaded.roots[0], 0, []);
        const more = total > lines.length ? `\n… ${total - lines.length} more; raise limit or narrow the search.` : "";
        const head = filtering ? `${total} match(es) under ${loaded.roots[0].name} (${loaded.roots[0].id}):` : `Outline of ${loaded.roots[0].name} (positions relative to it):`;
        return text(`${head}\n${lines.join("\n")}${more}`);
      });
    }
  );

  // ------------------------------------------------------------------ code
  server.registerTool(
    "figma_get_code",
    {
      title: "Generate reference code for a node",
      description: `Generates a starting implementation of a frame/component from its Figma layout: React + Tailwind (arbitrary values), React + CSS, or HTML + CSS. Auto layout becomes flexbox/grid, sizing becomes fixed/flex/stretch, icons become <img src="./assets/<name>.svg"> (download them with figma_download_assets). Adapt the output to the project's existing components and design tokens rather than pasting it verbatim; figma_get_design lists the tokens and component instances.`,
      inputSchema: z.object({
        url: urlField,
        node_id: nodeIdField,
        framework: z.enum(["react-tailwind", "react-css", "html-css"]).default("react-tailwind"),
        depth: z.number().int().min(1).max(50).optional().describe("Max nesting depth to generate"),
        source: sourceField
      }),
      annotations: READ_ONLY
    },
    async ({ url, node_id, framework, depth, source }, ctx) => {
      const t = target(url, node_id);
      const nodeId = requireNode(t, "figma_get_code");
      return withSource(source, t, async (s) => {
        const loaded = await loadNodes(s, t, [nodeId], s === "rest" ? depth : undefined, ctx.mcpReq.signal);
        const root = loaded.roots[0];
        let d = depth;
        let res = generateCode(root, framework, { maxDepth: d });
        let note = "";
        const size = () => res.code.length + (res.css?.length ?? 0);
        const full = maxTreeDepth(root);
        while (size() > MAX_OUTPUT_CHARS && (d ?? full) > 1) {
          d = (d ?? full) - 1;
          res = generateCode(root, framework, { maxDepth: d });
          note = `\nNote: trimmed to depth ${d} to fit; generate deeper parts by calling again with a child node_id.`;
        }
        const parts = [`// ${root.name} (${root.id}) — generated from Figma (${loaded.source}). Reference only: map colors/spacing to your tokens.${note}`, "", res.code];
        if (res.css) parts.push(`/* ---- ${framework === "html-css" ? "styles.css" : "styles"} ---- */`, res.css);
        if (res.assets.length) parts.push(`/* Assets referenced (${res.assets.length}): fetch with figma_download_assets\n${res.assets.map((a) => ` - ${a.file} <- node ${a.nodeId}`).join("\n")}\n*/`);
        if (res.componentInstances.length) parts.push(`/* Figma component instances used (reuse your existing components): ${res.componentInstances.join(", ")} */`);
        return text(parts.join("\n"));
      });
    }
  );

  // ------------------------------------------------------------------ screenshot
  server.registerTool(
    "figma_get_screenshot",
    {
      title: "Render a node as an image",
      description: `Renders a frame/component/layer to PNG and returns it as an image so you can see the design. Optionally saves it to save_to. The web source renders locally from the file's vector data (very close to Figma, small differences possible with blend modes and blurs); the REST source and plugin use Figma's own renderer.`,
      inputSchema: z.object({
        url: urlField,
        node_id: nodeIdField,
        scale: z.number().min(0.1).max(4).default(1).describe("Pixel ratio; large frames are scaled down automatically"),
        save_to: z.string().optional().describe("Optional file path to also write the PNG to"),
        source: sourceField
      }),
      annotations: READ_ONLY
    },
    async ({ url, node_id, scale, save_to, source }, ctx) => {
      const t = target(url, node_id);
      const nodeId = requireNode(t, "figma_get_screenshot");
      return withSource(source, t, async (s) => {
        const r = (await renderNodes(s, t, [nodeId], "png", scale, ctx.mcpReq.signal)).get(nodeId)!;
        let saved = "";
        if (save_to) {
          const p = path.resolve(save_to);
          await mkdir(path.dirname(p), { recursive: true });
          await writeFile(p, r.bytes);
          saved = ` Saved to ${p}.`;
        }
        return {
          content: [
            { type: "image" as const, data: r.bytes.toString("base64"), mimeType: "image/png" },
            { type: "text" as const, text: `Node ${nodeId}${r.width ? ` rendered at ${r.width}x${r.height}px` : ""} (${r.renderer}, source ${s}).${saved}` }
          ]
        };
      });
    }
  );

  // ------------------------------------------------------------------ assets
  server.registerTool(
    "figma_download_assets",
    {
      title: "Download icons, images and renders",
      description: `Downloads a design's assets to a folder:
- auto_detect (default on): finds icons/illustrations (vector-only layers) in the node and saves them as SVG, and saves images used as fills in their original format (png/jpg/webp/gif).
- nodes: explicit layers to render, each as png/jpg/svg/pdf at a scale (e.g. a logo at 2x).
Identical files are saved once. Returns the list of written files with the node each came from, so code can reference them.`,
      inputSchema: z.object({
        url: urlField,
        node_id: nodeIdField,
        dir: z.string().default(process.env.FIGMA_ASSETS_DIR ?? "figma-assets").describe("Output folder (relative to the server's working directory, or absolute)"),
        auto_detect: z.boolean().default(true),
        include_image_fills: z.boolean().default(true),
        nodes: z
          .array(
            z.object({
              node_id: z.string(),
              format: z.enum(["png", "jpg", "svg", "pdf"]).default("png"),
              scale: z.number().min(0.1).max(4).optional(),
              file_name: z.string().optional().describe("File name without extension")
            })
          )
          .optional(),
        png_scale: z.number().min(0.1).max(4).default(2).describe("Default scale for png/jpg renders"),
        source: sourceField
      }),
      annotations: WRITE // writes local files only; never modifies Figma
    },
    async ({ url, node_id, dir, auto_detect, include_image_fills, nodes, png_scale, source }, ctx) => {
      const t = target(url, node_id);
      if (!t.nodeId && !nodes?.length) requireNode(t, "figma_download_assets");
      const explicit: AssetRequest[] = (nodes ?? []).map((n) => ({ nodeId: n.node_id.replace(/-/g, ":"), format: n.format, scale: n.scale, fileName: n.file_name }));
      return withSource(source, t, async (s) => {
        const res = await downloadAssets({
          source: s,
          target: t,
          rootIds: t.nodeId ? [t.nodeId] : [],
          dir: path.resolve(dir),
          explicit,
          autoDetect: auto_detect && !!t.nodeId,
          includeImageFills: include_image_fills,
          pngScale: png_scale,
          signal: ctx.mcpReq.signal
        });
        const lines = res.assets.map((a) => `- ${a.duplicateOf ? `(same as ${a.duplicateOf}) ` : ""}${a.file}  [${a.kind}, ${a.bytes} B${a.width ? `, ${Math.round(a.width)}x${Math.round(a.height ?? 0)}` : ""}]  ← ${a.nodeId} "${a.name}"`);
        const skipped = res.skipped.map((x) => `- ${x.nodeId}: ${x.reason}`);
        return text(
          `Saved ${res.assets.filter((a) => !a.duplicateOf).length} file(s) to ${res.dir} (source ${s}):\n${lines.join("\n") || "(none found)"}${skipped.length ? `\n\nSkipped:\n${skipped.join("\n")}` : ""}`
        );
      });
    }
  );

  // ------------------------------------------------------------------ components
  server.registerTool(
    "figma_get_components",
    {
      title: "List components",
      description: `Lists components and component sets (with variants, property definitions, descriptions and how often each is used), so you can map Figma components to code components. scope "page" covers the page of the linked node (fast); "file" loads every page.`,
      inputSchema: z.object({
        url: urlField,
        node_id: nodeIdField,
        scope: z.enum(["page", "file"]).default("page"),
        include_library: z.boolean().default(true).describe("Include components that come from shared libraries"),
        format: formatField,
        source: sourceField
      }),
      annotations: READ_ONLY
    },
    async ({ url, node_id, scope, include_library, format, source }, ctx) => {
      const t = target(url, node_id);
      return withSource(source, t, async (s) => {
        let list: unknown;
        if (s === "web") {
          let pageIds: string[] | undefined;
          if (scope === "page" && t.nodeId) {
            const session = webSession(t.fileKey);
            await session.ensurePageOf(topLevelId(t.nodeId));
            const page = session.graph.pageOf(session.graph.get(topLevelId(t.nodeId))!);
            pageIds = page ? [guidStr(page.guid)] : undefined;
          } else await webLoadAllPages(t);
          const conv = await webLoadDefinitions(t);
          list = conv.listComponents(pageIds).filter((c) => include_library || !c.fromLibrary);
        } else if (s === "rest") {
          const f = await getFile(t.fileKey, {}, ctx.mcpReq.signal);
          const out: unknown[] = [];
          const walk = (n: RestNode, page: string) => {
            if (n.type === "COMPONENT_SET" || (n.type === "COMPONENT" && !f.componentSets[(f.components[n.id]?.componentSetId as string) ?? ""])) {
              const meta = n.type === "COMPONENT" ? f.components[n.id] : f.componentSets[n.id];
              out.push({
                id: n.id,
                name: n.name,
                type: n.type,
                page,
                key: meta?.key,
                description: meta?.description || undefined,
                properties: n.componentPropertyDefinitions,
                variants: n.type === "COMPONENT_SET" ? (n.children ?? []).map((c) => ({ id: c.id, name: c.name })) : undefined
              });
              return;
            }
            for (const c of n.children ?? []) walk(c, page);
          };
          for (const p of f.document.children ?? []) walk(p, p.name);
          list = out;
        } else list = (await bridge.request<{ components: unknown[] }>("get_local_components", {}, { fileKey: t.fileKey, timeoutMs: 120_000 })).components;
        const body = format === "json" ? JSON.stringify(list, null, 1) : toYaml({ components: list });
        return text(body.length > MAX_OUTPUT_CHARS * 2 ? body.slice(0, MAX_OUTPUT_CHARS * 2) + "\n… (truncated; use scope=page)" : body);
      });
    }
  );

  // ------------------------------------------------------------------ styles
  server.registerTool(
    "figma_get_styles",
    {
      title: "List local styles",
      description: "Lists the file's local color, text, effect and grid styles with their values (colors as hex, typography as font/size/line-height). Use to map Figma styles to CSS variables or theme tokens.",
      inputSchema: z.object({ url: urlField, format: formatField, source: sourceField }),
      annotations: READ_ONLY
    },
    async ({ url, format, source }, ctx) => {
      const t = target(url);
      return withSource(source, t, async (s) => {
        let styles: unknown;
        if (s === "web") {
          const conv = await webLoadDefinitions(t);
          styles = conv.listStyles().map((st) => ({ ...st, value: st.type === "FILL" ? cssPaints(st.value) : st.value }));
        } else if (s === "rest") {
          const f = await getFile(t.fileKey, { depth: 1 }, ctx.mcpReq.signal);
          const ids = Object.keys(f.styles);
          const nodes = ids.length ? await getNodes(t.fileKey, ids, {}, ctx.mcpReq.signal) : { nodes: {} as Record<string, { document: RestNode } | null> };
          styles = ids.map((id) => {
            const meta = f.styles[id];
            const n = nodes.nodes[id]?.document;
            const value = meta.styleType === "FILL" ? cssPaints(n?.fills) : meta.styleType === "TEXT" ? n?.style : meta.styleType === "EFFECT" ? n?.effects : n?.layoutGrids;
            return { id, name: meta.name, type: meta.styleType, description: meta.description || undefined, value };
          });
        } else styles = (await bridge.request<{ styles: unknown }>("get_styles", {}, { fileKey: t.fileKey })).styles;
        return text(format === "json" ? JSON.stringify(styles, null, 1) : toYaml({ styles }));
      });
    }
  );

  // ------------------------------------------------------------------ variables
  server.registerTool(
    "figma_get_variables",
    {
      title: "List variables (design tokens)",
      description: "Lists variable collections, modes (e.g. Light/Dark) and every variable's value per mode, with aliases shown by name. Works on any plan through the web source or the plugin; the REST source needs Enterprise.",
      inputSchema: z.object({
        url: urlField,
        collection: z.string().optional().describe("Only this collection (name substring)"),
        name_contains: z.string().optional(),
        format: formatField,
        source: sourceField
      }),
      annotations: READ_ONLY
    },
    async ({ url, collection, name_contains, format, source }, ctx) => {
      const t = target(url);
      return withSource(source, t, async (s) => {
        const data = await loadVariableData(s, t, ctx.mcpReq.signal);
        const cq = collection?.toLowerCase();
        const nq = name_contains?.toLowerCase();
        const vars = data.variables.filter((v) => (!cq || v.collection.toLowerCase().includes(cq)) && (!nq || v.name.toLowerCase().includes(nq)));
        const out = { collections: data.collections.filter((c) => !cq || c.name.toLowerCase().includes(cq)), variables: vars };
        return text(format === "json" ? JSON.stringify(out, null, 1) : toYaml(out));
      });
    }
  );


  server.registerTool(
    "figma_export_tokens",
    {
      title: "Export design tokens (W3C DTCG)",
      description:
        "Exports the file's variables as W3C Design Tokens (DTCG format 2025.10): one .tokens.json file per collection and mode, plus a .resolver.json whose modifiers switch modes (light/dark, brands, sizes). Colors become srgb color objects, spacing-like numbers become px dimensions, aliases become {group.token} references, and Figma scopes/code syntax go to $extensions. Feed the files to Style Dictionary or another DTCG tool to generate CSS, Swift or Kotlin. Works on any plan through the web source or the plugin.",
      inputSchema: z.object({
        url: urlField,
        dir: z.string().default("design-tokens").describe("Output folder (created if missing)"),
        name: z.string().optional().describe("Design system name for the resolver file (default: the file name)"),
        theme_collections: z.array(z.string()).optional().describe('Collections that are alternatives of each other, e.g. ["Tokens", "Tokens Dark"] on plans with one mode per collection; they become contexts of one "theme" modifier'),
        source: sourceField
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ url, dir, name, theme_collections, source }, ctx) => {
      const t = target(url);
      return withSource(source, t, async (s) => {
        const data = await loadVariableData(s, t, ctx.mcpReq.signal);
        if (!data.variables.length) return text("This file has no local variables to export.");
        const out = toDtcg(data, { name: name ?? t.fileName ?? "tokens", themeCollections: theme_collections });
        const root = path.resolve(dir);
        for (const [rel, content] of Object.entries(out.files)) {
          const file = path.join(root, rel);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, JSON.stringify(content, null, 2) + "\n");
        }
        return json({ dir: root, resolver: out.resolverPath, written: Object.keys(out.files), tokens: out.stats.tokens, aliases: out.stats.aliases, skipped: out.stats.skipped, source: s });
      });
    }
  );

  // ------------------------------------------------------------------ comments (REST)
  server.registerTool(
    "figma_get_comments",
    {
      title: "Read comments",
      description: "Lists comments on the file (author, text, resolved state, and the node they are pinned to). Requires FIGMA_TOKEN.",
      inputSchema: z.object({ url: urlField, include_resolved: z.boolean().default(false) }),
      annotations: READ_ONLY
    },
    async ({ url, include_resolved }, ctx) => {
      const t = target(url);
      const res = await getComments(t.mainFileKey, ctx.mcpReq.signal);
      const list = res.comments
        .filter((c) => include_resolved || !c.resolved_at)
        .map((c) => ({ id: c.id, author: c.user.handle, at: c.created_at, node: c.client_meta?.node_id, replyTo: c.parent_id || undefined, resolved: !!c.resolved_at, message: c.message }));
      return json(list);
    }
  );
}

function cssPaints(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  const out = v
    .filter((p: { visible?: boolean }) => p.visible !== false)
    .map((p: { type: string; color?: { r: number; g: number; b: number; a: number }; opacity?: number }) => (p.type === "SOLID" && p.color ? colorToCss(p.color, p.opacity ?? 1) : p));
  return out.length === 1 ? out[0] : out;
}
