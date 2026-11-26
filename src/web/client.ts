/**
 * Read-only client for Figma's multiplayer WebSocket, the channel the web app itself uses to
 * load a file. It works for anyone who can view the file in a browser: anonymously for files
 * shared as "anyone with the link can view", or with FIGMA_COOKIE for files that need a login.
 * No API token and no Dev Mode seat are involved.
 *
 * Protocol (observed):
 *   1. The server's first frame is "fig-wire" + u32 version + zstd(kiwi binary schema).
 *   2. Then JOIN_START (sessionID, access), USER_CHANGES, SIGNALs, JOIN_END.
 *   3. Files load incrementally: the client sends SCENE_GRAPH_QUERY messages naming the nodes
 *      it wants; the server answers with NODE_CHANGES (+ blobs) and then SCENE_GRAPH_REPLY.
 *   Later NODE_CHANGES are live edits by other people; we apply them to keep the graph fresh.
 *
 * This client only ever sends SCENE_GRAPH_QUERY. It never sends NODE_CHANGES, so it cannot
 * modify a file (and as a viewer the server grants READ_ONLY access anyway).
 */
import { zstdCompress, zstdDecompress } from "../util/zstd.js";
import { WebSocket } from "ws";
// kiwi-schema ships CommonJS without types.
import * as kiwiNs from "kiwi-schema";

type KiwiCompiled = { decodeMessage(b: Uint8Array): KMessage; encodeMessage(m: unknown): Uint8Array };
const kiwi = ((kiwiNs as unknown as { default?: unknown }).default ?? kiwiNs) as {
  decodeBinarySchema(b: Uint8Array): unknown;
  compileSchema(s: unknown): KiwiCompiled;
};

export interface Guid {
  sessionID: number;
  localID: number;
}

/** A raw kiwi NodeChange. Fields vary by node type; see the schema the server sends. */
export interface KNode {
  guid: Guid;
  phase?: string;
  parentIndex?: { guid: Guid; position: string };
  type?: string;
  name?: string;
  [key: string]: unknown;
}

interface KMessage {
  type: string;
  sessionID?: number;
  access?: string;
  nodeChanges?: KNode[];
  blobs?: { bytes: Uint8Array }[];
  signalName?: string;
  signalPayload?: string;
}

export const guidStr = (g: Guid) => `${g.sessionID}:${g.localID}`;
export function parseGuid(id: string): Guid {
  const m = /^(\d+):(\d+)$/.exec(id);
  if (!m) throw new Error(`"${id}" is not a plain node id like "12:345". Instance sublayer ids (I…;…) resolve through their top-level instance.`);
  return { sessionID: Number(m[1]), localID: Number(m[2]) };
}

const PROTOCOL_VERSION = process.env.FIGMA_WEB_PROTOCOL_VERSION ?? "500";
const QUERY_TIMEOUT_MS = Number(process.env.FIGMA_WEB_TIMEOUT_MS ?? 60_000);
const IDLE_CLOSE_MS = Number(process.env.FIGMA_WEB_IDLE_MS ?? 5 * 60_000);

export class FigmaWebError extends Error {}

/** All nodes and blobs received for one file. */
export class DocGraph {
  nodes = new Map<string, KNode>();
  children = new Map<string, string[]>();
  blobs: Uint8Array[] = [];
  /** Subtrees fully loaded by a query (key = guid string). */
  loadedSubtrees = new Set<string>();
  private childrenDirty = true;

  apply(changes: KNode[], blobs: { bytes: Uint8Array }[] = []) {
    const base = this.blobs.length;
    for (const b of blobs) this.blobs.push(b.bytes);
    for (const ch of changes) {
      if (base) remapBlobs(ch, base);
      const id = guidStr(ch.guid);
      if (ch.phase === "REMOVED") {
        this.nodes.delete(id);
      } else {
        const cur = this.nodes.get(id);
        if (cur) Object.assign(cur, ch);
        else this.nodes.set(id, ch);
      }
    }
    this.childrenDirty = true;
  }

  get(id: string): KNode | undefined {
    return this.nodes.get(id);
  }

  childrenOf(id: string): KNode[] {
    if (this.childrenDirty) this.rebuildChildren();
    return (this.children.get(id) ?? []).map((c) => this.nodes.get(c)!).filter(Boolean);
  }

  parentOf(n: KNode): KNode | undefined {
    return n.parentIndex ? this.nodes.get(guidStr(n.parentIndex.guid)) : undefined;
  }

  /** The CANVAS (page) a node lives on. */
  pageOf(n: KNode): KNode | undefined {
    let cur: KNode | undefined = n;
    while (cur && cur.type !== "CANVAS") cur = this.parentOf(cur);
    return cur;
  }

  private rebuildChildren() {
    const tmp = new Map<string, { id: string; pos: string }[]>();
    for (const [id, n] of this.nodes) {
      if (!n.parentIndex) continue;
      const p = guidStr(n.parentIndex.guid);
      let arr = tmp.get(p);
      if (!arr) tmp.set(p, (arr = []));
      arr.push({ id, pos: n.parentIndex.position ?? "" });
    }
    this.children.clear();
    // Fractional-index positions sort by plain code unit order.
    for (const [p, arr] of tmp) this.children.set(p, arr.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0)).map((x) => x.id));
    this.childrenDirty = false;
  }
}

/** Blob references are indexes into the message's blob list; shift them into the graph-wide list. */
function remapBlobs(v: unknown, base: number): void {
  if (Array.isArray(v)) {
    for (const x of v) remapBlobs(x, base);
    return;
  }
  if (!v || typeof v !== "object" || v instanceof Uint8Array) return;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    const x = o[k];
    if (typeof x === "number" && (k === "commandsBlob" || k === "dataBlob" || k === "vectorNetworkBlob" || k.endsWith("Blob"))) o[k] = x + base;
    else if (x && typeof x === "object") remapBlobs(x, base);
  }
}

/** One live viewer connection to one file. */
export class WebFileSession {
  readonly graph = new DocGraph();
  access?: string;
  private ws?: WebSocket;
  private compiled?: KiwiCompiled;
  private sessionID?: number;
  private ready?: Promise<void>;
  private waiters: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  private idleTimer?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  closed = false;

  constructor(readonly fileKey: string) {}

  private connect(): Promise<void> {
    this.ready ??= new Promise<void>((resolve, reject) => {
      const params = new URLSearchParams({ role: "viewer", tracking_session_id: Math.random().toString(36).slice(2, 12), version: PROTOCOL_VERSION });
      const headers: Record<string, string> = { Origin: "https://www.figma.com", "User-Agent": "Mozilla/5.0 (figma-mcp-v2)" };
      if (process.env.FIGMA_COOKIE) headers.Cookie = process.env.FIGMA_COOKIE;
      const ws = new WebSocket(`wss://www.figma.com/api/multiplayer/${this.fileKey}?${params}`, { headers, perMessageDeflate: false });
      this.ws = ws;
      const fail = (e: Error) => {
        this.closed = true;
        reject(e);
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer);
          w.reject(e);
        }
      };
      ws.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (d: Buffer) => (body += d));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          fail(
            new FigmaWebError(
              status === 403 || status === 401
                ? `Figma refused to open file ${this.fileKey} without login (HTTP ${status}). The file is not shared as "anyone with the link can view". Set FIGMA_COOKIE (your browser's figma.com cookie) or FIGMA_TOKEN, or ask for link view access.`
                : status === 404
                  ? `File ${this.fileKey} not found. Check the link.`
                  : `Figma refused the connection (HTTP ${status}): ${body.slice(0, 200)}`
            )
          );
        });
      });
      ws.on("error", (e) => fail(new FigmaWebError(`Could not connect to Figma: ${e.message}`)));
      ws.on("close", (code) => {
        this.closed = true;
        this.ready = undefined;
        const err = new FigmaWebError(`Figma closed the connection (code ${code}).`);
        reject(err);
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer);
          w.reject(err);
        }
      });
      ws.on("message", (data: Buffer) => {
        try {
          let b: Uint8Array = Buffer.from(data);
          if (b.length >= 12 && Buffer.from(b.subarray(0, 8)).toString("latin1") === "fig-wire") {
            this.compiled = kiwi.compileSchema(kiwi.decodeBinarySchema(zstdDecompress(b.subarray(12))));
            return;
          }
          if (!this.compiled) return;
          if (b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) b = zstdDecompress(b);
          const m = this.compiled.decodeMessage(b);
          switch (m.type) {
            case "JOIN_START":
              this.sessionID = m.sessionID;
              this.access = m.access;
              break;
            case "JOIN_END":
              resolve();
              break;
            case "NOTIFY_SHOULD_UPGRADE":
            case "UPGRADE_REFRESH":
              fail(new FigmaWebError("Figma asked this client to upgrade its protocol version. Set FIGMA_WEB_PROTOCOL_VERSION to a higher number (current: " + PROTOCOL_VERSION + ")."));
              ws.close();
              break;
            case "NODE_CHANGES":
              if (m.nodeChanges?.length) this.graph.apply(m.nodeChanges, m.blobs);
              break;
            case "SCENE_GRAPH_REPLY": {
              const w = this.waiters.shift();
              if (w) {
                clearTimeout(w.timer);
                w.resolve();
              }
              break;
            }
          }
        } catch (e) {
          console.error("[figma-web] failed to decode a message:", (e as Error).message);
        }
      });
    });
    return this.ready;
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }

  close() {
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.ws?.close();
  }

  /**
   * Asks the server for nodes. depth 0 with CONTAINING_PAGE loads the whole page that contains
   * the node; depth N loads N levels below it.
   */
  query(queries: { startingNode: Guid; depth: number; behavior?: "DEFAULT" | "CONTAINING_PAGE" }[]): Promise<void> {
    const run = async () => {
      await this.connect();
      this.touch();
      if (!this.compiled || !this.ws || this.sessionID === undefined) throw new FigmaWebError("The Figma connection is not ready.");
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = this.waiters.findIndex((w) => w.timer === timer);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new FigmaWebError(`Figma did not answer the node query within ${QUERY_TIMEOUT_MS / 1000}s.`));
        }, QUERY_TIMEOUT_MS);
        this.waiters.push({ resolve, reject, timer });
      });
      const msg = this.compiled.encodeMessage({ type: "SCENE_GRAPH_QUERY", sessionID: this.sessionID, sceneGraphQueries: queries });
      this.ws.send(zstdCompress(Buffer.from(msg)));
      await done;
    };
    // One query in flight at a time, so replies match requests.
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Loads the page containing `nodeId` (or the document's page list when omitted). */
  async ensurePageOf(nodeId: string): Promise<void> {
    const n = this.graph.get(nodeId);
    const page = n ? this.graph.pageOf(n) : undefined;
    if (page && this.graph.loadedSubtrees.has(guidStr(page.guid))) return;
    await this.query([{ startingNode: parseGuid(nodeId), depth: 0, behavior: "CONTAINING_PAGE" }]);
    const loaded = this.graph.get(nodeId);
    if (!loaded) throw new FigmaWebError(`Node ${nodeId} does not exist in file ${this.fileKey} (or was deleted). Copy a fresh link from Figma.`);
    const p = this.graph.pageOf(loaded);
    if (p) this.graph.loadedSubtrees.add(guidStr(p.guid));
  }

  async ensureDocument(): Promise<void> {
    if (this.graph.get("0:0") && this.graph.loadedSubtrees.has("0:0/1")) return;
    await this.query([{ startingNode: { sessionID: 0, localID: 0 }, depth: 1 }]);
    this.graph.loadedSubtrees.add("0:0/1");
  }

  /** Loads the top-level layers of the given pages (cheap; for file overviews). */
  async ensurePageTops(pageIds: string[]): Promise<void> {
    const todo = pageIds.filter((id) => !this.graph.loadedSubtrees.has(id) && !this.graph.loadedSubtrees.has(`${id}/1`));
    if (!todo.length) return;
    await this.query(todo.map((id) => ({ startingNode: parseGuid(id), depth: 1 })));
    for (const id of todo) this.graph.loadedSubtrees.add(`${id}/1`);
  }

  /** Loads a whole page by its CANVAS id. */
  async ensurePage(pageId: string): Promise<void> {
    if (this.graph.loadedSubtrees.has(pageId)) return;
    await this.query([{ startingNode: parseGuid(pageId), depth: 0, behavior: "CONTAINING_PAGE" }]);
    this.graph.loadedSubtrees.add(pageId);
  }

  /** Loads full subtrees for nodes that are referenced but missing (e.g. component masters). */
  async ensureNodes(ids: string[]): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !this.graph.get(id) || !this.graph.loadedSubtrees.has(id));
    if (!missing.length) return;
    // depth 0 + DEFAULT loads only the node; ask for a generous depth so master subtrees come complete.
    await this.query(missing.map((id) => ({ startingNode: parseGuid(id), depth: 64 })));
    for (const id of missing) this.graph.loadedSubtrees.add(id);
  }
}

const sessions = new Map<string, WebFileSession>();

export function webSession(fileKey: string): WebFileSession {
  let s = sessions.get(fileKey);
  if (!s || s.closed) {
    s = new WebFileSession(fileKey);
    sessions.set(fileKey, s);
  }
  return s;
}

export function closeAllWebSessions() {
  for (const s of sessions.values()) s.close();
  sessions.clear();
}

/** File metadata as the web app sees it; works anonymously for link-shared files. */
export async function getWebFileMeta(fileKey: string, signal?: AbortSignal) {
  const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0 (figma-mcp-v2)", Accept: "application/json" };
  if (process.env.FIGMA_COOKIE) headers.Cookie = process.env.FIGMA_COOKIE;
  const res = await fetch(`https://www.figma.com/api/files/${fileKey}`, { headers, signal });
  if (!res.ok) throw new FigmaWebError(`Figma returned HTTP ${res.status} for file ${fileKey} metadata. The file may need a login (set FIGMA_COOKIE or FIGMA_TOKEN).`);
  const body = (await res.json()) as { meta: { name: string; updated_at: string; link_access: string; editor_type: string; thumbnail_url?: string; team_id?: string } };
  return body.meta;
}

/** Image bytes by hash (hex). Same URL the web app uses; it redirects to the blob CDN. */
export async function downloadWebImage(fileKey: string, hashHex: string, signal?: AbortSignal): Promise<{ bytes: Buffer; contentType: string }> {
  const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0 (figma-mcp-v2)" };
  if (process.env.FIGMA_COOKIE) headers.Cookie = process.env.FIGMA_COOKIE;
  const res = await fetch(`https://www.figma.com/file/${fileKey}/image/${hashHex}`, { headers, signal, redirect: "follow" });
  if (!res.ok) throw new FigmaWebError(`Downloading image ${hashHex} failed with HTTP ${res.status}.`);
  return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
}
