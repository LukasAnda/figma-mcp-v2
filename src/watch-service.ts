/**
 * Background watchers that start at login: launchd (macOS), systemd --user or XDG autostart
 * (Linux), the Startup folder (Windows). "Watch this file" in any AI app ends here, through the
 * figma_watch_file tool or `figma-mcp-v2 watch <link> --install`.
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CREDENTIALS_PATH } from "./auth.js";
import { parseFigmaUrl } from "./figma/url.js";
import { AGENTS, which, type AgentName, type WatchOptions } from "./watch.js";

export const WATCH_DIR = path.join(path.dirname(CREDENTIALS_PATH), "watch");
const REGISTRY = path.join(WATCH_DIR, "watches.json");

export interface WatchEntry {
  id: string;
  url: string;
  agent: AgentName;
  exec?: string;
  cwd: string;
  tag: string;
  interval: number;
  from?: string[];
  anyone: boolean;
  log: string;
  service: string;
  installedAt: string;
}

/** PATH for background processes: launchd and Claude Desktop start with a minimal one. */
export function servicePath(): string {
  const home = os.homedir();
  const extra =
    process.platform === "win32"
      ? [path.join(process.env.APPDATA ?? "", "npm"), path.join(home, ".local", "bin")]
      : [path.join(home, ".local/bin"), path.join(home, ".claude/local"), path.join(home, ".npm-global/bin"), path.join(home, ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const parts = [...(process.env.PATH ?? "").split(path.delimiter), ...extra].filter(Boolean);
  return [...new Set(parts)].join(path.delimiter);
}

/** How to start this server/CLI again from a service, wherever it is running from. */
export function selfCommand(): { cmd: string; args: string[]; env: Record<string, string> } {
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  const env: Record<string, string> = {};
  if (process.env.ELECTRON_RUN_AS_NODE) env.ELECTRON_RUN_AS_NODE = process.env.ELECTRON_RUN_AS_NODE; // Claude Desktop's built-in Node
  if (entry.includes(`${path.sep}_npx${path.sep}`)) {
    // Started through npx: services use @latest, and the watcher restarts itself onto new versions.
    const npx = withPath(() => which("npx"));
    if (npx) return { cmd: npx, args: ["-y", "figma-mcp-v2@latest"], env };
  }
  return { cmd: process.execPath, args: [entry], env };
}

function withPath<T>(fn: () => T): T {
  const old = process.env.PATH;
  process.env.PATH = servicePath();
  try {
    return fn();
  } finally {
    process.env.PATH = old;
  }
}

export function detectAgent(): AgentName {
  return withPath(() => (["claude", "gemini", "codex"] as const).find((a) => which(AGENTS[a].bin))) ?? "notify";
}

export function watchId(url: string, cwd: string): string {
  return createHash("sha1").update(parseFigmaUrl(url).fileKey + "\n" + path.resolve(cwd)).digest("hex").slice(0, 8);
}

function readRegistry(): WatchEntry[] {
  try {
    return JSON.parse(readFileSync(REGISTRY, "utf8")) as WatchEntry[];
  } catch {
    return [];
  }
}
function writeRegistry(list: WatchEntry[]) {
  mkdirSync(WATCH_DIR, { recursive: true });
  writeFileSync(REGISTRY, JSON.stringify(list, null, 2));
}

const label = (id: string) => `com.figma-mcp-v2.watch.${id}`;
const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sdQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
const winQuote = (s: string) => `"${s.replace(/"/g, '""')}"`;

export function serviceFiles(e: WatchEntry, cmd: { cmd: string; args: string[]; env: Record<string, string> }, platform = process.platform) {
  const argv = [cmd.cmd, ...cmd.args, "watch", e.url, "--id", e.id, "--tag", e.tag, "--interval", String(e.interval), "--agent", e.agent];
  if (e.exec) argv.push("--exec", e.exec);
  if (e.from?.length) argv.push("--from", e.from.join(","));
  if (e.anyone) argv.push("--anyone");
  const env = { ...cmd.env, PATH: servicePath() };
  if (platform === "darwin") {
    const file = path.join(os.homedir(), "Library/LaunchAgents", `${label(e.id)}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(e.id)}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xmlEsc(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xmlEsc(e.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${xmlEsc(k)}</key><string>${xmlEsc(v)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xmlEsc(e.log)}</string>
  <key>StandardErrorPath</key><string>${xmlEsc(e.log)}</string>
</dict>
</plist>
`;
    return { file, content };
  }
  if (platform === "win32") {
    const startup = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData/Roaming"), "Microsoft/Windows/Start Menu/Programs/Startup");
    const file = path.join(startup, `figma-mcp-v2-watch-${e.id}.vbs`);
    const line = `cmd /c "${argv.map(winQuote).join(" ")} >> ${winQuote(e.log)} 2>&1"`;
    const content = [
      "' figma-mcp-v2: watches a Figma file for #plsfix comments (started at login, runs hidden)",
      'Set sh = CreateObject("WScript.Shell")',
      `sh.CurrentDirectory = "${e.cwd.replace(/"/g, '""')}"`,
      ...Object.entries(env).map(([k, v]) => `sh.Environment("Process")("${k}") = "${v.replace(/"/g, '""')}"`),
      `sh.Run "${line.replace(/"/g, '""')}", 0, False`,
      ""
    ].join("\r\n");
    return { file, content };
  }
  const unit = `figma-mcp-v2-watch-${e.id}.service`;
  const file = path.join(os.homedir(), ".config/systemd/user", unit);
  const content = `[Unit]
Description=figma-mcp-v2: watch ${e.url} for ${e.tag} comments

[Service]
ExecStart=${argv.map(sdQuote).join(" ")}
WorkingDirectory=${e.cwd}
${Object.entries(env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`).join("\n")}
Restart=always
RestartSec=30
StandardOutput=append:${e.log}
StandardError=append:${e.log}

[Install]
WantedBy=default.target
`;
  return { file, content, unit };
}

export async function installWatch(o: Omit<WatchOptions, "agent" | "once"> & { agent?: AgentName | "auto"; once?: boolean; cwd: string }): Promise<{ entry: WatchEntry; summary: string }> {
  parseFigmaUrl(o.url); // validate
  let cwd = path.resolve(o.cwd);
  if (cwd === path.parse(cwd).root) cwd = os.homedir(); // Claude Desktop starts servers in "/"
  const agent: AgentName = !o.agent || o.agent === "auto" ? (o.exec ? "notify" : detectAgent()) : o.agent;
  const id = watchId(o.url, cwd);
  mkdirSync(WATCH_DIR, { recursive: true });
  const entry: WatchEntry = { id, url: o.url, agent, exec: o.exec, cwd, tag: o.tag, interval: o.interval, from: o.from, anyone: o.anyone, log: path.join(WATCH_DIR, `${id}.log`), service: "", installedAt: new Date().toISOString() };
  await stopWatch(id); // replace an existing watcher for the same file and folder
  const self = selfCommand();
  const svc = serviceFiles(entry, self);
  mkdirSync(path.dirname(svc.file), { recursive: true });
  writeFileSync(svc.file, svc.content);
  entry.service = svc.file;
  if (process.platform === "darwin") {
    const uid = os.userInfo().uid;
    spawnSync("launchctl", ["bootout", `gui/${uid}/${label(id)}`], { stdio: "ignore" });
    const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, svc.file], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`launchctl could not start the watcher: ${r.stderr || r.stdout}`);
  } else if (process.platform === "win32") {
    spawn("wscript.exe", [svc.file], { detached: true, stdio: "ignore" }).unref();
  } else {
    const ok = spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" }).status === 0 && spawnSync("systemctl", ["--user", "enable", "--now", svc.unit!], { stdio: "ignore" }).status === 0;
    if (!ok) {
      // No systemd user session: XDG autostart for next login, and start it now.
      rmSync(svc.file, { force: true });
      const desktop = path.join(os.homedir(), ".config/autostart", `figma-mcp-v2-watch-${id}.desktop`);
      const argv = [self.cmd, ...self.args, "watch", o.url, "--id", id, "--tag", o.tag, "--interval", String(o.interval), "--agent", agent];
      mkdirSync(path.dirname(desktop), { recursive: true });
      writeFileSync(desktop, `[Desktop Entry]\nType=Application\nName=figma-mcp-v2 watch ${id}\nExec=sh -c ${sdQuote(`cd ${JSON.stringify(cwd)} && exec ${argv.map((a) => JSON.stringify(a)).join(" ")} >> ${JSON.stringify(entry.log)} 2>&1`)}\nX-GNOME-Autostart-enabled=true\n`);
      entry.service = desktop;
      const out = (await import("node:fs")).openSync(entry.log, "a");
      spawn(self.cmd, argv.slice(1), { cwd, detached: true, stdio: ["ignore", out, out], env: { ...process.env, ...self.env, PATH: servicePath() } }).unref();
    }
  }
  writeRegistry([...readRegistry().filter((w) => w.id !== id), entry]);
  const how =
    agent === "notify"
      ? "New requests show a desktop notification; then ask your AI to \"fix the #plsfix comments\" in that file."
      : `New requests are handed to ${AGENTS[agent].note.replace(/ with .*/, "")} (${AGENTS[agent].bin}), working in ${cwd}.`;
  return {
    entry,
    summary: [
      `Watching ${o.url} for ${o.tag} comments every ${o.interval}s (watcher ${id}). It starts again at login.`,
      how,
      o.anyone ? "It acts on requests from anyone who can comment." : o.from?.length ? `It acts on requests from: ${o.from.join(", ")}.` : "It acts only on your own comments (the owner of your Figma token).",
      `Replies in a thread continue the conversation; resolving the thread ends it.`,
      `Log: ${entry.log}`
    ].join("\n")
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopWatch(id: string): Promise<boolean> {
  const e = readRegistry().find((w) => w.id === id);
  let found = !!e;
  if (process.platform === "darwin") spawnSync("launchctl", ["bootout", `gui/${os.userInfo().uid}/${label(id)}`], { stdio: "ignore" });
  else if (process.platform !== "win32") spawnSync("systemctl", ["--user", "disable", "--now", `figma-mcp-v2-watch-${id}.service`], { stdio: "ignore" });
  const pidPath = path.join(WATCH_DIR, `${id}.pid`);
  if (existsSync(pidPath)) {
    const pid = Number(readFileSync(pidPath, "utf8"));
    if (pid && alive(pid)) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
    rmSync(pidPath, { force: true });
    found = true;
  }
  if (e?.service) rmSync(e.service, { force: true });
  return found;
}

export async function uninstallWatch(idOrUrl: string): Promise<string> {
  const list = readRegistry();
  const matches = list.filter((w) => w.id === idOrUrl || (idOrUrl.includes("figma.com") && parseFigmaUrl(w.url).fileKey === parseFigmaUrl(idOrUrl).fileKey));
  if (!matches.length) return `No watcher matches ${idOrUrl}.`;
  for (const m of matches) await stopWatch(m.id);
  writeRegistry(list.filter((w) => !matches.includes(w)));
  return `Stopped ${matches.map((m) => `${m.id} (${m.url})`).join(", ")}.`;
}

export function listWatches(): (WatchEntry & { running: boolean })[] {
  return readRegistry().map((w) => {
    const pidPath = path.join(WATCH_DIR, `${w.id}.pid`);
    const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, "utf8")) : 0;
    return { ...w, running: !!pid && alive(pid) };
  });
}
