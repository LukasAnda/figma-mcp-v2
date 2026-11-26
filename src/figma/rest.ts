/**
 * Thin Figma REST API client. Works with a personal access token on any file the token's
 * owner can view; none of these endpoints require a Dev Mode seat.
 */

const API_BASE = process.env.FIGMA_API_BASE ?? "https://api.figma.com";
const TIMEOUT_MS = Number(process.env.FIGMA_TIMEOUT_MS ?? 60_000);
const CACHE_TTL_MS = Number(process.env.FIGMA_CACHE_TTL_MS ?? 60_000);

export class FigmaApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** "user" acts as the person (FIGMA_TOKEN); "bot" uses FIGMA_BOT_TOKEN when set, e.g. a separate
 * Figma account that replies to comments under its own name, and falls back to the user's token. */
export type Identity = "user" | "bot";

function authHeaders(as: Identity = "user"): Record<string, string> {
  if (as === "bot" && process.env.FIGMA_BOT_TOKEN) return { "X-Figma-Token": process.env.FIGMA_BOT_TOKEN };
  if (as === "bot" && process.env.FIGMA_BOT_OAUTH_TOKEN) return { Authorization: `Bearer ${process.env.FIGMA_BOT_OAUTH_TOKEN}` };
  const pat = process.env.FIGMA_TOKEN || process.env.FIGMA_ACCESS_TOKEN || process.env.FIGMA_API_KEY;
  const oauth = process.env.FIGMA_OAUTH_TOKEN;
  if (oauth) return { Authorization: `Bearer ${oauth}` };
  if (pat) return { "X-Figma-Token": pat };
  return {};
}

export function hasRestAuth(as: Identity = "user"): boolean {
  return Object.keys(authHeaders(as)).length > 0;
}

function errorMessage(status: number, body: string, path: string): string {
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { err?: string; message?: string };
    detail = parsed.err ?? parsed.message ?? body;
  } catch {
    /* keep raw */
  }
  switch (status) {
    case 400:
      return `Figma rejected the request (${detail}). Check the node id: links use "1-2", the API uses "1:2"; both are accepted here.`;
    case 401:
    case 403:
      if (path.includes("/variables")) {
        return `Figma refused the variables endpoint (${status}: ${detail}). The REST variables API needs an Enterprise plan; connect the companion plugin and use figma_get_variables, which reads variables through the plugin on any plan.`;
      }
      return `Figma refused access (${status}: ${detail}). Check FIGMA_TOKEN is a valid personal access token with the file_content:read scope, and that its owner can open this file.`;
    case 404:
      return `Not found (${detail}). Check the file key / node id in the link, and that the token's owner can open the file.`;
    case 429:
      return "Figma rate limit hit. Wait a minute, or request fewer/smaller nodes (use depth, or a specific node link).";
    default:
      return `Figma API returned HTTP ${status}: ${detail}`;
  }
}

const cache = new Map<string, { at: number; value: unknown }>();

export async function figmaGet<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  signal?: AbortSignal,
  opts: { cache?: boolean; as?: Identity } = {}
): Promise<T> {
  if (!hasRestAuth(opts.as)) {
    throw new FigmaApiError(
      401,
      "Not logged in to Figma. Comments and private files need a login: call figma_login, which opens figma.com in the user's browser. Reading designs from files shared by link works without it."
    );
  }
  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const key = (opts.as ?? "user") + " " + url.toString();
  const useCache = opts.cache !== false;
  const hit = cache.get(key);
  if (useCache && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;

  for (let attempt = 0; ; attempt++) {
    const signals = [AbortSignal.timeout(TIMEOUT_MS)];
    if (signal) signals.push(signal);
    let res: Response;
    try {
      res = await fetch(url, { headers: { ...authHeaders(opts.as), Accept: "application/json" }, signal: AbortSignal.any(signals) });
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") {
        throw new Error(`Figma did not respond within ${TIMEOUT_MS / 1000}s. Large files are slow: pass a node link or a smaller depth.`);
      }
      throw e;
    }
    if (res.status === 429 && attempt < 2) {
      const retryAfter = Math.min(Number(res.headers.get("retry-after") ?? 5), 30);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    if (!res.ok) throw new FigmaApiError(res.status, errorMessage(res.status, await res.text(), url.pathname));
    const value = (await res.json()) as T;
    if (useCache) cache.set(key, { at: Date.now(), value });
    return value;
  }
}

export async function figmaSend<T>(method: "POST" | "DELETE" | "PUT", path: string, body: unknown, signal?: AbortSignal, as: Identity = "user"): Promise<T> {
  if (!hasRestAuth(as)) throw new FigmaApiError(401, "Not logged in to Figma. Call figma_login, which opens figma.com in the user's browser.");
  const res = await fetch(new URL(path, API_BASE), {
    method,
    headers: { ...authHeaders(as), "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new FigmaApiError(res.status, errorMessage(res.status, await res.text(), path));
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

// ---- Typed wrappers for the endpoints the tools use ----

export interface RestNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: RestNode[];
  [key: string]: unknown;
}

export interface RestComponentMeta {
  key: string;
  name: string;
  description?: string;
  componentSetId?: string;
  documentationLinks?: { uri: string }[];
  remote?: boolean;
}

export interface RestStyleMeta {
  key: string;
  name: string;
  styleType: "FILL" | "TEXT" | "EFFECT" | "GRID";
  description?: string;
  remote?: boolean;
}

export interface RestFile {
  name: string;
  lastModified: string;
  version: string;
  thumbnailUrl?: string;
  editorType?: string;
  document: RestNode;
  components: Record<string, RestComponentMeta>;
  componentSets: Record<string, RestComponentMeta>;
  styles: Record<string, RestStyleMeta>;
}

export interface RestNodesResponse {
  name: string;
  lastModified: string;
  version: string;
  nodes: Record<
    string,
    {
      document: RestNode;
      components: Record<string, RestComponentMeta>;
      componentSets: Record<string, RestComponentMeta>;
      styles: Record<string, RestStyleMeta>;
    } | null
  >;
}

export function getFile(fileKey: string, opts: { depth?: number; geometry?: boolean }, signal?: AbortSignal) {
  return figmaGet<RestFile>(`/v1/files/${fileKey}`, { depth: opts.depth, geometry: opts.geometry ? "paths" : undefined }, signal);
}

export function getNodes(fileKey: string, ids: string[], opts: { depth?: number; geometry?: boolean }, signal?: AbortSignal) {
  return figmaGet<RestNodesResponse>(
    `/v1/files/${fileKey}/nodes`,
    { ids: ids.join(","), depth: opts.depth, geometry: opts.geometry ? "paths" : undefined },
    signal
  );
}

export type ImageFormat = "png" | "jpg" | "svg" | "pdf";

export async function renderImages(
  fileKey: string,
  ids: string[],
  opts: { format: ImageFormat; scale?: number; svgOutlineText?: boolean; svgIncludeId?: boolean; useAbsoluteBounds?: boolean },
  signal?: AbortSignal
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  // The images endpoint accepts many ids, but huge batches time out; chunk them.
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await figmaGet<{ err: string | null; images: Record<string, string | null> }>(
      `/v1/images/${fileKey}`,
      {
        ids: chunk.join(","),
        format: opts.format,
        scale: opts.format === "svg" || opts.format === "pdf" ? undefined : opts.scale,
        svg_outline_text: opts.format === "svg" ? (opts.svgOutlineText ?? true) : undefined,
        svg_include_id: opts.format === "svg" ? (opts.svgIncludeId ?? false) : undefined,
        use_absolute_bounds: opts.useAbsoluteBounds
      },
      signal,
      { cache: false }
    );
    Object.assign(out, res.images);
  }
  return out;
}

/** imageRef -> download URL for every image used as a fill in the file. */
export async function getImageFills(fileKey: string, signal?: AbortSignal): Promise<Record<string, string>> {
  const res = await figmaGet<{ meta: { images: Record<string, string> } }>(`/v1/files/${fileKey}/images`, {}, signal);
  return res.meta?.images ?? {};
}

export function getLocalVariables(fileKey: string, signal?: AbortSignal) {
  return figmaGet<{
    meta: {
      variables: Record<string, { id: string; name: string; resolvedType: string; valuesByMode: Record<string, unknown>; variableCollectionId: string; description?: string; codeSyntax?: Record<string, string>; remote?: boolean; hiddenFromPublishing?: boolean }>;
      variableCollections: Record<string, { id: string; name: string; modes: { modeId: string; name: string }[]; defaultModeId: string; remote?: boolean }>;
    };
  }>(`/v1/files/${fileKey}/variables/local`, {}, signal);
}

export function getComments(fileKey: string, signal?: AbortSignal) {
  return figmaGet<{ comments: { id: string; message: string; user: { handle: string }; created_at: string; resolved_at: string | null; client_meta?: { node_id?: string } | null; parent_id?: string }[] }>(
    `/v1/files/${fileKey}/comments`,
    {},
    signal,
    { cache: false }
  );
}

export async function download(url: string, signal?: AbortSignal): Promise<Buffer> {
  const signals = [AbortSignal.timeout(TIMEOUT_MS)];
  if (signal) signals.push(signal);
  const res = await fetch(url, { signal: AbortSignal.any(signals) });
  if (!res.ok) throw new Error(`Downloading ${url} failed with HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
