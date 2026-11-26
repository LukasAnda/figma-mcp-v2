/**
 * WebSocket bridge between MCP server processes and the companion Figma plugin.
 *
 * The first MCP process to start binds 127.0.0.1:FIGMA_BRIDGE_PORT (default 3055) and becomes
 * the hub. Plugins connect to the hub. Further MCP processes (e.g. several editor windows)
 * find the port taken and connect to the hub as relay clients; the hub forwards their
 * requests to the right plugin. If the hub process exits, a relay client takes over.
 *
 * Requests are routed by file key: each plugin reports the key of the file it runs in, so a
 * tool call carrying a Figma link reaches the plugin window for that file.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

export interface PluginInfo {
  connectionId: string;
  fileKey?: string;
  fileName?: string;
  pageName?: string;
  user?: string;
  editorType?: string;
  pluginVersion?: string;
  connectedAt: string;
}

type Msg =
  | { type: "hello"; role: "plugin"; info: Omit<PluginInfo, "connectionId" | "connectedAt"> }
  | { type: "hello"; role: "mcp" }
  | { type: "plugin_update"; info: Partial<PluginInfo> }
  | { type: "request"; id: string; command: string; params: unknown; fileKey?: string; timeoutMs?: number }
  | { type: "response"; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: "plugins"; plugins: PluginInfo[] }
  | { type: "ping" }
  | { type: "pong" };

export class BridgeError extends Error {}

const PORT = Number(process.env.FIGMA_BRIDGE_PORT ?? 3055);
const HOST = "127.0.0.1";
const DEFAULT_TIMEOUT = Number(process.env.FIGMA_BRIDGE_TIMEOUT_MS ?? 30_000);

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

function send(ws: WebSocket, msg: Msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export class Bridge {
  private mode: "idle" | "hub" | "client" = "idle";
  private wss?: WebSocketServer;
  private plugins = new Map<WebSocket, PluginInfo>();
  /** hub: request id -> the relay socket waiting for the answer */
  private relayed = new Map<string, WebSocket>();
  private pending = new Map<string, Pending>();
  private hubSocket?: WebSocket;
  private remotePlugins: PluginInfo[] = [];
  private starting?: Promise<void>;
  private stopped = false;

  constructor(private port = PORT) {}

  get role() {
    return this.mode;
  }

  start(): Promise<void> {
    this.starting ??= this.tryHub().finally(() => (this.starting = undefined));
    return this.starting;
  }

  stop() {
    this.stopped = true;
    // ws v8: close() stops accepting but leaves open sockets; terminate them so relays notice.
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    this.wss?.close();
    this.hubSocket?.terminate();
    this.plugins.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new BridgeError("The bridge stopped."));
    }
    this.pending.clear();
  }

  private tryHub(): Promise<void> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ host: HOST, port: this.port, verifyClient: ({ origin }: { origin?: string; req: IncomingMessage }) => this.allowOrigin(origin) });
      wss.once("listening", () => {
        this.wss = wss;
        this.mode = "hub";
        console.error(`[figma-bridge] hub listening on ws://${HOST}:${this.port}`);
        wss.on("connection", (ws) => this.onHubConnection(ws));
        resolve();
      });
      wss.once("error", (err: NodeJS.ErrnoException) => {
        wss.close();
        if (err.code === "EADDRINUSE") {
          this.connectAsClient().then(resolve, () => resolve());
        } else {
          console.error(`[figma-bridge] could not start: ${err.message}`);
          resolve();
        }
      });
    });
  }

  /** Browsers always send Origin; Figma plugin iframes send "null". Node clients send none. */
  private allowOrigin(origin?: string): boolean {
    if (!origin || origin === "null") return true;
    if (/^https:\/\/([\w-]+\.)*figma\.com$/.test(origin)) return true;
    const extra = (process.env.FIGMA_BRIDGE_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return extra.includes(origin);
  }

  // ---------- Hub side ----------

  private onHubConnection(ws: WebSocket) {
    let role: "plugin" | "mcp" | undefined;
    ws.on("message", (raw) => {
      let msg: Msg;
      try {
        msg = JSON.parse(String(raw)) as Msg;
      } catch {
        return;
      }
      if (msg.type === "hello") {
        role = msg.role;
        if (msg.role === "plugin") {
          const info: PluginInfo = { ...msg.info, connectionId: randomUUID(), connectedAt: new Date().toISOString() };
          this.plugins.set(ws, info);
          console.error(`[figma-bridge] plugin connected: ${info.fileName ?? "?"} (${info.fileKey ?? "no file key"})`);
          this.broadcastPlugins();
        } else {
          send(ws, { type: "plugins", plugins: this.listPlugins() });
        }
        return;
      }
      if (msg.type === "ping") return send(ws, { type: "pong" });
      if (msg.type === "plugin_update" && role === "plugin") {
        const cur = this.plugins.get(ws);
        if (cur) Object.assign(cur, msg.info);
        this.broadcastPlugins();
        return;
      }
      if (msg.type === "request" && role === "mcp") {
        // Relay from another MCP process.
        try {
          const target = this.pickPlugin(msg.fileKey);
          this.relayed.set(msg.id, ws);
          send(target, msg);
        } catch (e) {
          send(ws, { type: "response", id: msg.id, ok: false, error: (e as Error).message });
        }
        return;
      }
      if (msg.type === "response" && role === "plugin") {
        const relay = this.relayed.get(msg.id);
        if (relay) {
          this.relayed.delete(msg.id);
          send(relay, msg);
          return;
        }
        this.settle(msg);
      }
    });
    ws.on("close", () => {
      if (this.plugins.delete(ws)) {
        console.error("[figma-bridge] plugin disconnected");
        this.broadcastPlugins();
      }
    });
    ws.on("error", () => ws.close());
  }

  private broadcastPlugins() {
    if (!this.wss) return;
    const list = this.listPlugins();
    for (const client of this.wss.clients) if (!this.plugins.has(client)) send(client, { type: "plugins", plugins: list });
  }

  private pickPlugin(fileKey?: string): WebSocket {
    const entries = [...this.plugins.entries()];
    if (entries.length === 0) throw new BridgeError(NOT_CONNECTED);
    if (fileKey) {
      const match = entries.find(([, p]) => p.fileKey === fileKey);
      if (match) return match[0];
      // Plugins without access to figma.fileKey cannot be matched; use one if it is the only candidate.
      const unknown = entries.filter(([, p]) => !p.fileKey);
      if (entries.length === 1 && unknown.length === 1) return unknown[0][0];
      throw new BridgeError(
        `The Figma plugin is not running in file ${fileKey}. Connected files: ${entries.map(([, p]) => `${p.fileName ?? "?"} (${p.fileKey ?? "unknown key"})`).join(", ")}. Open that file in Figma and run the "Figma MCP Bridge" plugin there.`
      );
    }
    if (entries.length > 1) {
      throw new BridgeError(
        `The plugin is connected in ${entries.length} files (${entries.map(([, p]) => p.fileName ?? p.fileKey).join(", ")}). Pass a Figma link (figma_url) so the call goes to the right one.`
      );
    }
    return entries[0][0];
  }

  // ---------- Relay-client side ----------

  private connectAsClient(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${HOST}:${this.port}`);
      ws.once("open", () => {
        this.mode = "client";
        this.hubSocket = ws;
        send(ws, { type: "hello", role: "mcp" });
        console.error(`[figma-bridge] relaying through existing hub on port ${this.port}`);
        resolve();
      });
      ws.on("message", (raw) => {
        let msg: Msg;
        try {
          msg = JSON.parse(String(raw)) as Msg;
        } catch {
          return;
        }
        if (msg.type === "plugins") this.remotePlugins = msg.plugins;
        else if (msg.type === "response") this.settle(msg);
      });
      ws.once("error", (e) => {
        if (this.mode !== "client") reject(e);
      });
      ws.on("close", () => {
        if (this.hubSocket !== ws) return;
        this.hubSocket = undefined;
        this.mode = "idle";
        this.remotePlugins = [];
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new BridgeError("Lost the connection to the bridge hub. Retry the call."));
          this.pending.delete(id);
        }
        // The hub went away; try to take over.
        if (!this.stopped) setTimeout(() => void this.start(), 500 + Math.random() * 1000);
      });
    });
  }

  // ---------- Shared ----------

  private settle(msg: Extract<Msg, { type: "response" }>) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new BridgeError(msg.error ?? "The plugin reported an unknown error."));
  }

  listPlugins(): PluginInfo[] {
    if (this.mode === "client") return this.remotePlugins;
    return [...this.plugins.values()];
  }

  isConnected(fileKey?: string): boolean {
    const list = this.listPlugins();
    if (!fileKey) return list.length > 0;
    return list.some((p) => p.fileKey === fileKey) || (list.length === 1 && !list[0].fileKey);
  }

  async request<T = unknown>(command: string, params: unknown, opts: { fileKey?: string; timeoutMs?: number } = {}): Promise<T> {
    if (this.mode === "idle") await this.start();
    const id = randomUUID();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    const msg: Msg = { type: "request", id, command, params, fileKey: opts.fileKey, timeoutMs };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.relayed.delete(id);
        reject(new BridgeError(`The Figma plugin did not answer "${command}" within ${timeoutMs / 1000}s. Check the plugin window is still open (Figma pauses plugins in background tabs).`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        if (this.mode === "hub") send(this.pickPlugin(opts.fileKey), msg);
        else if (this.mode === "client" && this.hubSocket) send(this.hubSocket, msg);
        else throw new BridgeError(`The plugin bridge is not running (port ${this.port} unavailable). ${NOT_CONNECTED}`);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
}

export const NOT_CONNECTED =
  'The Figma plugin is not connected. In Figma desktop: Plugins > Development > Import plugin from manifest... and pick plugin/manifest.json from figma-mcp-v2 (one-time), then run "Figma MCP Bridge" in the file you want to work on.';

export const bridge = new Bridge();
