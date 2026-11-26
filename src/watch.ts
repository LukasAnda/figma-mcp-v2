/**
 * `figma-mcp-v2 watch <link>`: polls a file for #plsfix conversations and, for each new turn,
 * runs an agent (Claude Code, Gemini CLI, Codex, or any command) or shows a desktop notification.
 * Figma webhooks need a public server; polling works on a laptop. `--install` makes it start at
 * login (see watch-service.ts).
 *
 * Safety: comment text reaches an AI agent, so by default only requests by the owner of FIGMA_TOKEN
 * are acted on. Others must be allowed with --from, or everyone with --anyone.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CREDENTIALS_PATH, loadStoredCredentials, refreshOAuthIfNeeded } from "./auth.js";
import { fixPrompt, isActionable, loadFixRequests, respondToFixRequest, whoAmI, type FixRequest } from "./comments.js";
import { parseFigmaUrl } from "./figma/url.js";

export type AgentName = "notify" | "claude" | "gemini" | "codex";

/** Headless invocations; the prompt is passed as an argument. */
export const AGENTS: Record<Exclude<AgentName, "notify">, { bin: string; args: (prompt: string) => string[]; note: string }> = {
  // The watcher writes an MCP config for this server ("figma-watch"), so Claude Code doesn't need it configured.
  claude: {
    bin: "claude",
    args: (p) =>
      process.env.FIGMA_WATCH_MCP_CONFIG
        ? ["-p", p, "--mcp-config", process.env.FIGMA_WATCH_MCP_CONFIG, "--permission-mode", "acceptEdits", "--allowedTools", "mcp__figma-watch"]
        : ["-p", p, "--permission-mode", "acceptEdits", "--allowedTools", "mcp__figma"],
    note: "Claude Code"
  },
  gemini: { bin: "gemini", args: (p) => ["-p", p, "--approval-mode", "yolo"], note: "Gemini CLI (with this server configured in Gemini)" },
  codex: { bin: "codex", args: (p) => ["exec", "--full-auto", p], note: "Codex CLI (with this server configured in Codex)" }
};

export interface WatchOptions {
  url: string;
  tag: string;
  interval: number;
  from?: string[];
  anyone: boolean;
  agent: AgentName | "auto";
  exec?: string;
  once: boolean;
  id?: string;
}

export function parseWatchArgs(args: string[]): WatchOptions & { install?: boolean; cwd?: string } {
  const o: WatchOptions & { install?: boolean; cwd?: string } = { url: "", tag: "#plsfix", interval: 60, anyone: false, agent: "auto", once: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--tag") o.tag = next();
    else if (a === "--interval") o.interval = Math.max(15, Number(next()) || 60);
    else if (a === "--from") o.from = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--anyone") o.anyone = true;
    else if (a === "--agent") {
      const v = next() as AgentName | "auto";
      if (!["auto", "notify", "claude", "gemini", "codex"].includes(v)) throw new Error(`--agent must be auto, notify, claude, gemini or codex`);
      o.agent = v;
    } else if (a === "--exec") o.exec = next();
    else if (a === "--once") o.once = true;
    else if (a === "--install") o.install = true;
    else if (a === "--cwd") o.cwd = next();
    else if (a === "--id") o.id = next();
    else if (!a.startsWith("--")) o.url = a;
    else throw new Error(`Unknown option ${a}`);
  }
  if (!o.url) throw new Error('Pass a Figma file link: figma-mcp-v2 watch <link> [--agent claude|gemini|codex|notify] [--exec "<command>"]');
  return o;
}

/** Desktop notification on macOS, Windows and Linux. Best effort. */
export function notify(title: string, body: string): void {
  try {
    if (process.platform === "darwin") {
      spawn("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32") {
      const ps =
        "Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(10000, $env:FMCP_TITLE, $env:FMCP_BODY, 'Info'); Start-Sleep -Seconds 11; $n.Dispose()";
      spawn("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], { stdio: "ignore", detached: true, env: { ...process.env, FMCP_TITLE: title, FMCP_BODY: body } }).unref();
    } else spawn("notify-send", [title, body], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* no notifier available */
  }
}

/** Absolute path of a command on PATH, or undefined. */
export function which(bin: string): string | undefined {
  const r = process.platform === "win32" ? spawnSync("where", [bin], { encoding: "utf8" }) : spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  const line = r.status === 0 ? r.stdout.split(/\r?\n/).find(Boolean) : undefined;
  return line?.trim() || undefined;
}

function runAgent(o: WatchOptions, prompt: string, r: FixRequest): Promise<number> {
  return new Promise((resolve) => {
    const env = { ...process.env, FIGMA_FIX_URL: o.url, FIGMA_FIX_COMMENT_ID: r.commentId, FIGMA_FIX_REQUEST: r.request };
    const child = o.exec
      ? spawn(o.exec, { shell: true, stdio: ["pipe", "inherit", "inherit"], env }) // custom command: prompt on stdin
      : spawn(AGENTS[o.agent as Exclude<AgentName, "notify">].bin, AGENTS[o.agent as Exclude<AgentName, "notify">].args(prompt), { stdio: ["ignore", "inherit", "inherit"], env });
    if (o.exec) child.stdin!.end(prompt);
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(127));
  });
}

const pidFile = (id: string) => path.join(path.dirname(CREDENTIALS_PATH), "watch", `${id}.pid`);

export async function runWatch(args: string[]): Promise<number> {
  let o: ReturnType<typeof parseWatchArgs>;
  try {
    o = parseWatchArgs(args);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (o.install) {
    const { installWatch } = await import("./watch-service.js");
    const r = await installWatch({ ...o, cwd: o.cwd ?? process.cwd() });
    console.log(r.summary);
    return 0;
  }
  loadStoredCredentials();
  await refreshOAuthIfNeeded();
  setInterval(() => void refreshOAuthIfNeeded(), 6 * 3600_000).unref();
  const target = parseFigmaUrl(o.url);
  const log = (s: string) => console.error(`[watch ${new Date().toLocaleString()}] ${s}`);
  if (o.id) {
    mkdirSync(path.dirname(pidFile(o.id)), { recursive: true });
    writeFileSync(pidFile(o.id), String(process.pid));
    process.on("exit", () => rmSync(pidFile(o.id!), { force: true }));
  }
  const svc = await import("./watch-service.js");
  process.env.PATH = svc.servicePath();
  if (o.agent === "auto") o.agent = o.exec ? "notify" : svc.detectAgent();
  if (o.agent !== "notify" && !o.exec && !which(AGENTS[o.agent].bin)) {
    log(`${AGENTS[o.agent].bin} is not on PATH; falling back to notifications`);
    o.agent = "notify";
  }
  if (o.agent === "claude" && !o.exec) {
    // Give the headless agent this server directly, whatever the user's Claude Code config says.
    const self = svc.selfCommand();
    const file = path.join(svc.WATCH_DIR, "claude-mcp.json");
    mkdirSync(svc.WATCH_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: { "figma-watch": { command: self.cmd, args: self.args, env: self.env } } }, null, 2));
    process.env.FIGMA_WATCH_MCP_CONFIG = file;
  }
  // Wait for credentials instead of exiting, so a service doesn't crash-loop before `login`.
  let authors = o.from;
  for (let attempt = 0; ; attempt++) {
    try {
      if (!authors && !o.anyone) {
        const owner = await whoAmI("user");
        authors = [owner.id];
        log(`acting on ${o.tag} threads started by ${owner.handle} only (add people with --from, or --anyone)`);
      }
      const bot = await whoAmI("bot");
      log(`watching ${o.url} every ${o.interval}s; replies come from ${bot.handle}; ${o.exec ? `running: ${o.exec}` : o.agent === "notify" ? "notifying" : `running ${AGENTS[o.agent as Exclude<AgentName, "notify">].note}`}`);
      break;
    } catch (e) {
      const msg = (e as Error).message;
      if (/\b403\b/.test(msg) && !authors && !o.anyone) {
        log("can't tell whose comments to act on: the login lacks the current_user:read scope. Log in again (figma-mcp-v2 login), or pass --from <your Figma handle>.");
      } else log(`waiting for Figma access: ${msg}`);
      loadStoredCredentials(); // pick up a login that happened meanwhile
      if (o.once) return 1;
      await new Promise((r) => setTimeout(r, Math.min(300, 30 * (attempt + 1)) * 1000));
    }
  }
  const handled = new Set<string>();
  for (;;) {
    try {
      const { requests } = await loadFixRequests(target, { tag: o.tag, authors });
      const fresh = requests.filter((r) => isActionable(r) && !handled.has(r.commentId));
      if (fresh.length) log(`${fresh.length} new request(s)`);
      if (o.agent === "notify" && !o.exec) {
        for (const r of fresh) handled.add(r.commentId);
        if (fresh.length) {
          notify(
            fresh.length === 1 ? `Figma ${o.tag}: ${fresh[0].author}` : `${fresh.length} new Figma ${o.tag} requests`,
            fresh.length === 1 ? `${fresh[0].request.slice(0, 120)}\nAsk your AI: "fix the ${o.tag} comments in this file"` : `Ask your AI: "fix the ${o.tag} comments in ${o.url}"`
          );
          for (const r of fresh) console.log(`\n--- ${r.commentId} (${r.author}${r.followUp ? ", follow-up" : ""}) ---\n${fixPrompt(r, o.url)}\n`);
        }
      } else {
        for (const r of fresh) {
          handled.add(r.commentId);
          await respondToFixRequest(target, r.commentId, { status: "in_progress" });
          log(`${r.commentId}${r.followUp ? " (follow-up)" : ""}: "${r.request.slice(0, 60)}"`);
          const code = await runAgent(o, fixPrompt(r, o.url), r);
          if (code !== 0) {
            log(`${r.commentId}: agent exited with ${code}`);
            await respondToFixRequest(target, r.commentId, {
              status: "needs_info",
              message: `I couldn't finish this automatically (the agent exited with code ${code}). Reply in this thread with more detail and I'll try again.`
            }).catch(() => {});
          }
        }
      }
    } catch (e) {
      log(`error: ${(e as Error).message}`);
    }
    if (o.once) return 0;
    await new Promise((r) => setTimeout(r, o.interval * 1000));
  }
}
