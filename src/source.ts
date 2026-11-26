/**
 * One read interface over three backends:
 *   web    – Figma's own viewer protocol. No token, no Dev Mode; anonymous for link-shared files,
 *            FIGMA_COOKIE for private ones. Includes variables and local styles on every plan.
 *   rest   – Figma REST API with FIGMA_TOKEN. Official, stable, server-side rendering.
 *   plugin – The companion plugin running in an open Figma file (also needed for edits).
 *
 * "auto" tries web first, then REST (if a token is set), then the plugin (if connected).
 */
import { bridge } from "./bridge/bridge.js";
import { getNodes, getFile, hasRestAuth, type RestNode, type RestComponentMeta, type RestStyleMeta, getLocalVariables } from "./figma/rest.js";
import type { SimplifyContext } from "./figma/simplify.js";
import type { FigmaTarget } from "./figma/url.js";
import { webSession, guidStr, type WebFileSession } from "./web/client.js";
import { GraphConverter } from "./web/convert.js";

export type SourceName = "auto" | "web" | "rest" | "plugin";
export type ConcreteSource = Exclude<SourceName, "auto">;

export interface LoadedNodes {
  source: ConcreteSource;
  roots: RestNode[];
  ctx: SimplifyContext;
  fileName?: string;
  /** Present for the web source: the converter, for variables/styles listings. */
  converter?: GraphConverter;
  session?: WebFileSession;
}

export function defaultOrder(requested: SourceName): ConcreteSource[] {
  if (requested !== "auto") return [requested];
  const env = (process.env.FIGMA_SOURCE ?? "").toLowerCase();
  if (env === "web" || env === "rest" || env === "plugin") return [env];
  const order: ConcreteSource[] = ["web"];
  if (hasRestAuth()) order.push("rest");
  order.push("plugin");
  return order;
}

/** Runs `fn` against each source in order until one succeeds; errors are collected for the message. */
export async function withSource<T>(requested: SourceName, target: FigmaTarget, fn: (s: ConcreteSource) => Promise<T>): Promise<T> {
  const errors: string[] = [];
  for (const s of defaultOrder(requested)) {
    if (s === "plugin" && requested === "auto" && !bridge.isConnected(target.fileKey)) {
      errors.push("plugin: not connected");
      continue;
    }
    try {
      return await fn(s);
    } catch (e) {
      errors.push(`${s}: ${(e as Error).message}`);
      if (requested !== "auto") break;
    }
  }
  throw new Error(`Could not read the design.\n- ${errors.join("\n- ")}`);
}

// ---------- web ----------

/** "I1:2;3:4" -> top-level instance "1:2"; plain ids unchanged. */
export function topLevelId(nodeId: string): string {
  return nodeId.startsWith("I") ? nodeId.slice(1).split(";")[0] : nodeId;
}

export function findInTree(root: RestNode, id: string): RestNode | undefined {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const f = findInTree(c, id);
    if (f) return f;
  }
  return undefined;
}

async function loadMasters(session: WebFileSession, ids: string[]) {
  for (let i = 0; i < 8; i++) {
    const missing = new GraphConverter(session.graph).missingMasters(ids);
    if (!missing.length) return;
    await session.ensureNodes(missing);
  }
}

export async function webLoad(target: FigmaTarget, nodeIds: string[], maxDepth?: number): Promise<LoadedNodes> {
  const session = webSession(target.fileKey);
  if (!nodeIds.length) {
    await session.ensureDocument();
    const conv = new GraphConverter(session.graph);
    const doc = conv.convert("0:0", { maxDepth: 1 })!;
    const r = conv.result(doc);
    return { source: "web", roots: [doc], ctx: ctxOf(r), converter: conv, session };
  }
  const tops = [...new Set(nodeIds.map(topLevelId))];
  for (const id of tops) await session.ensurePageOf(id);
  await loadMasters(session, tops);
  const conv = new GraphConverter(session.graph);
  const roots: RestNode[] = [];
  for (const id of nodeIds) {
    const top = topLevelId(id);
    const tree = conv.convert(top, { maxDepth: id === top ? maxDepth : undefined });
    if (!tree) throw new Error(`Node ${id} not found in the file.`);
    const node = id === top ? tree : findInTree(tree, id);
    if (!node) throw new Error(`Node ${id} not found inside instance ${top}.`);
    roots.push(node);
  }
  const r = conv.result(roots[0]);
  return { source: "web", roots, ctx: ctxOf(r), converter: conv, session };
}

function ctxOf(r: { components: Record<string, RestComponentMeta>; componentSets: Record<string, RestComponentMeta>; styles: Record<string, RestStyleMeta>; variables: Record<string, string> }): SimplifyContext {
  return { components: r.components, componentSets: r.componentSets, styles: r.styles, variables: r.variables };
}

/** Loads the internal canvas (local styles, variables, library copies). */
export async function webLoadDefinitions(target: FigmaTarget): Promise<GraphConverter> {
  const session = webSession(target.fileKey);
  await session.ensureDocument();
  const internal = [...session.graph.nodes.values()].find((n) => n.type === "CANVAS" && (n.name === "Internal Only Canvas" || n.internalOnly));
  if (internal) await session.ensureNodes([guidStr(internal.guid)]);
  return new GraphConverter(session.graph);
}

/** Loads every page (needed for file-wide component listings). */
export async function webLoadAllPages(target: FigmaTarget, pageIds?: string[]): Promise<{ session: WebFileSession; pages: string[] }> {
  const session = webSession(target.fileKey);
  await session.ensureDocument();
  const pages = pageIds ?? session.graph.childrenOf("0:0").filter((p) => p.type === "CANVAS" && p.name !== "Internal Only Canvas" && !p.internalOnly).map((p) => guidStr(p.guid));
  for (const p of pages) await session.ensurePage(p);
  return { session, pages };
}

// ---------- rest ----------

let variableNameCache = new Map<string, Record<string, string> | null>();

async function restVariableNames(fileKey: string, signal?: AbortSignal): Promise<Record<string, string> | undefined> {
  if (variableNameCache.has(fileKey)) return variableNameCache.get(fileKey) ?? undefined;
  try {
    const v = await getLocalVariables(fileKey, signal);
    const map = Object.fromEntries(Object.values(v.meta.variables).map((x) => [x.id, x.name]));
    variableNameCache.set(fileKey, map);
    return map;
  } catch {
    variableNameCache.set(fileKey, null);
    return undefined;
  }
}

export async function restLoad(target: FigmaTarget, nodeIds: string[], maxDepth?: number, signal?: AbortSignal, geometry = false): Promise<LoadedNodes> {
  if (!hasRestAuth()) throw new Error("FIGMA_TOKEN is not set.");
  // The REST depth counts from the requested node; ask for one extra level so truncation notes are accurate.
  const depth = maxDepth !== undefined ? maxDepth + 1 : undefined;
  if (!nodeIds.length) {
    const f = await getFile(target.fileKey, { depth: 2 }, signal);
    return { source: "rest", roots: [f.document], ctx: { components: f.components, componentSets: f.componentSets, styles: f.styles }, fileName: f.name };
  }
  const res = await getNodes(target.fileKey, nodeIds, { depth, geometry }, signal);
  const roots: RestNode[] = [];
  const ctx: SimplifyContext = { components: {}, componentSets: {}, styles: {} };
  for (const id of nodeIds) {
    const entry = res.nodes[id];
    if (!entry) throw new Error(`Node ${id} not found in file ${target.fileKey}.`);
    roots.push(entry.document);
    Object.assign(ctx.components!, entry.components);
    Object.assign(ctx.componentSets!, entry.componentSets);
    Object.assign(ctx.styles!, entry.styles);
  }
  const vars = await restVariableNames(target.fileKey, signal);
  if (vars) ctx.variables = vars;
  return { source: "rest", roots, ctx, fileName: res.name };
}

// ---------- plugin ----------

interface PluginExport {
  document: RestNode;
  components?: Record<string, RestComponentMeta>;
  componentSets?: Record<string, RestComponentMeta>;
  styles?: Record<string, RestStyleMeta>;
  variables?: Record<string, string>;
}

export async function pluginLoad(target: FigmaTarget, nodeIds: string[]): Promise<LoadedNodes> {
  const res = await bridge.request<{ nodes: PluginExport[]; fileName?: string }>("export_rest_json", { nodeIds }, { fileKey: target.fileKey, timeoutMs: 120_000 });
  const ctx: SimplifyContext = { components: {}, componentSets: {}, styles: {}, variables: {} };
  for (const n of res.nodes) {
    Object.assign(ctx.components!, n.components ?? {});
    Object.assign(ctx.componentSets!, n.componentSets ?? {});
    Object.assign(ctx.styles!, n.styles ?? {});
    Object.assign(ctx.variables!, n.variables ?? {});
  }
  return { source: "plugin", roots: res.nodes.map((n) => n.document), ctx, fileName: res.fileName };
}

export async function loadNodes(source: ConcreteSource, target: FigmaTarget, nodeIds: string[], maxDepth?: number, signal?: AbortSignal): Promise<LoadedNodes> {
  if (source === "web") return webLoad(target, nodeIds, maxDepth);
  if (source === "rest") return restLoad(target, nodeIds, maxDepth, signal);
  return pluginLoad(target, nodeIds);
}
