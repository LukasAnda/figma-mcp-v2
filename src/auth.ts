/**
 * Figma login for comments, private files and replies (reading link-shared designs needs none).
 *
 * Figma's REST API is the only API with comments, and it needs a personal access token. To keep that
 * free of terminals and chat transcripts, `login` (and the figma_login tool) opens a small page
 * served on this computer: it links to Figma's settings, lists the scopes to tick, and takes the
 * pasted token, which is checked against Figma and saved locally.
 *
 * Tokens are stored for the person ("user") and optionally for a separate bot account ("bot") that
 * replies to #plsfix comments under its own name, in ~/.config/figma-mcp-v2/credentials.json (0600).
 * Environment variables (FIGMA_TOKEN, FIGMA_OAUTH_TOKEN, FIGMA_BOT_TOKEN, FIGMA_COOKIE) take
 * precedence over stored values.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export type Who = "user" | "bot";

export interface Credentials {
  token?: string;
  cookie?: string;
  user?: string;
  botToken?: string;
  bot?: string;
  savedAt?: string;
}

export const CREDENTIALS_PATH = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "figma-mcp-v2", "credentials.json");
export const LOGIN_PORT = Number(process.env.FIGMA_LOGIN_PORT ?? 3056);
export const TOKEN_SCOPES = ["Current user: read", "File content: read", "File metadata: read", "Comments: read and write"];
const SETTINGS_URL = "https://www.figma.com/settings";

function readCreds(): Credentials {
  try {
    return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")) as Credentials;
  } catch {
    return {};
  }
}

async function save(c: Credentials) {
  await mkdir(path.dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
  await writeFile(CREDENTIALS_PATH, JSON.stringify({ ...c, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  await chmod(CREDENTIALS_PATH, 0o600);
}

/** Applies stored credentials to process.env unless the env already sets them. */
export function loadStoredCredentials(): Credentials {
  const c = readCreds();
  if (c.token && !process.env.FIGMA_TOKEN && !process.env.FIGMA_ACCESS_TOKEN && !process.env.FIGMA_OAUTH_TOKEN) process.env.FIGMA_TOKEN = c.token;
  if (c.botToken && !process.env.FIGMA_BOT_TOKEN) process.env.FIGMA_BOT_TOKEN = c.botToken;
  if (c.cookie && !process.env.FIGMA_COOKIE) process.env.FIGMA_COOKIE = c.cookie;
  return c;
}

export function openBrowser(url: string): boolean {
  if (process.env.FIGMA_LOGIN_NO_BROWSER === "1") return false;
  try {
    const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/** Who a token belongs to. Missing "Current user" scope is reported, not fatal. */
async function identify(token: string): Promise<{ ok: true; name: string } | { ok: false; status: number }> {
  const res = await fetch("https://api.figma.com/v1/me", { headers: { "X-Figma-Token": token } });
  if (!res.ok) return { ok: false, status: res.status };
  const me = (await res.json()) as { handle?: string; email?: string };
  return { ok: true, name: me.handle ?? me.email ?? "unknown user" };
}

export interface SavedLogin {
  name: string;
  scopeWarning?: string;
}

/** Checks a token with Figma and stores it. */
export async function saveToken(who: Who, raw: string): Promise<SavedLogin> {
  const token = raw.trim();
  if (!token) throw new Error("No token entered.");
  const id = await identify(token);
  if (!id.ok && id.status !== 403) throw new Error(`Figma doesn't accept this token (HTTP ${id.status}). Check it was copied completely.`);
  const c = readCreds();
  const name = id.ok ? id.name : "?";
  if (who === "bot") {
    Object.assign(c, { botToken: token, bot: name });
    process.env.FIGMA_BOT_TOKEN = token;
  } else {
    Object.assign(c, { token, user: name });
    process.env.FIGMA_TOKEN = token;
  }
  await save(c);
  return id.ok
    ? { name }
    : { name, scopeWarning: 'The token works but lacks the "Current user" scope, so watching #plsfix comments can\'t tell whose they are. A new token with that box ticked fixes it.' };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

function loginPage(who: Who, nonce: string, error?: string): string {
  const bot = who === "bot";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Figma</title>
<style>
  :root { color-scheme: light dark; --fg:#1A2147; --muted:#5A6185; --bg:#F2F3F7; --card:#fff; --pen:#2B3FE0; --line:#DDE0EA; --err:#B8352D }
  @media (prefers-color-scheme: dark) { :root { --fg:#E8EAF4; --muted:#A3A8C3; --bg:#12162B; --card:#1C2139; --pen:#8592FF; --line:#2A3051; --err:#FF7B71 } }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif }
  main { max-width:34rem; margin:8vh auto; padding:0 16px }
  .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:28px }
  h1 { font-size:1.5rem; margin:0 0 6px } p { color:var(--muted); margin:0 0 18px }
  ol { padding-left:1.2rem; margin:0 0 20px } li { margin:6px 0 } li b { color:var(--fg) }
  a.btn, button { display:inline-block; font:inherit; font-weight:600; border-radius:10px; padding:10px 16px; border:0; cursor:pointer }
  a.btn { background:transparent; color:var(--pen); border:1.5px solid var(--pen); text-decoration:none }
  button { background:var(--pen); color:#fff; width:100% }
  input { width:100%; box-sizing:border-box; font:15px ui-monospace, monospace; padding:11px 12px; border-radius:10px; border:1.5px solid var(--line); background:transparent; color:var(--fg); margin:6px 0 14px }
  input:focus-visible, button:focus-visible, a.btn:focus-visible { outline:3px solid var(--pen); outline-offset:2px }
  .err { color:var(--err); margin:0 0 12px } small { color:var(--muted) }
</style>
<main><div class="card">
<h1>${bot ? "Connect the bot account" : "Connect Figma"}</h1>
<p>${bot ? "Do this while logged in to Figma as the account that should reply to #plsfix comments (a private window helps)." : "This lets your AI read and answer comments and open private files. It takes a minute, once."}</p>
<ol>
  <li><a class="btn" href="${SETTINGS_URL}" target="_blank" rel="noopener">Open Figma settings</a></li>
  <li>Go to <b>Security</b> → <b>Personal access tokens</b> → <b>Generate new token</b>. Any name works.</li>
  <li>Tick: <b>${TOKEN_SCOPES.join("</b>, <b>")}</b>.</li>
  <li>Copy the token and paste it here.</li>
</ol>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/save">
  <input type="hidden" name="nonce" value="${nonce}">
  <label for="t">Token</label>
  <input id="t" name="token" type="password" autocomplete="off" spellcheck="false" placeholder="figd_…" required autofocus>
  <button type="submit">Connect</button>
</form>
<p style="margin:14px 0 0"><small>The token stays on this computer (${esc(CREDENTIALS_PATH)}). You can revoke it in Figma's settings any time.</small></p>
</div></main></html>`;
}

function donePage(r: SavedLogin, who: Who): string {
  return `<!doctype html><meta charset="utf-8"><title>Connected</title><body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 16px;color-scheme:light dark">
<h1 style="font-size:1.5rem">Connected${r.name !== "?" ? ` as ${esc(r.name)}` : ""}${who === "bot" ? " (bot)" : ""}</h1>
<p>${r.scopeWarning ? esc(r.scopeWarning) + " " : ""}You can close this tab and go back to your AI.</p></body>`;
}

/**
 * Opens the local login page and resolves once a working token was saved (or after 10 minutes).
 * `onUrl` receives the page address, for when no browser could be opened.
 */
export function loginInBrowser(who: Who, onUrl: (url: string) => void = () => {}): Promise<SavedLogin> {
  const nonce = randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const html = (code: number, body: string) => res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(body);
      if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) return html(200, loginPage(who, nonce));
      if (req.method === "POST" && req.url === "/save") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const form = new URLSearchParams(body);
        // Only the page this process served may submit (guards against other local pages posting here).
        if (form.get("nonce") !== nonce) return html(403, loginPage(who, nonce, "This form expired. Reload the page."));
        try {
          const r = await saveToken(who, form.get("token") ?? "");
          html(200, donePage(r, who));
          server.close();
          resolve(r);
        } catch (e) {
          html(400, loginPage(who, nonce, (e as Error).message));
        }
        return;
      }
      res.writeHead(404).end();
    });
    server.on("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "EADDRINUSE" ? new Error(`Another login page is already open (port ${LOGIN_PORT}). Finish or close that one first.`) : e)
    );
    server.listen(LOGIN_PORT, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${LOGIN_PORT}/`;
      openBrowser(url);
      onUrl(url);
    });
    setTimeout(() => {
      server.close();
      reject(new Error("The login page was open for 10 minutes without a token. Ask again when you're ready."));
    }, 600_000).unref();
  });
}

// ---------- CLI ----------

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) {
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.includes(question)) process.stderr.write(question);
      };
    }
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stderr.write("\n");
      resolve(a.trim());
    });
  });
}

export async function runAuthCli(cmd: string, args: string[] = []): Promise<number> {
  const log = (s: string) => process.stderr.write(s + "\n");
  try {
    return await authCli(cmd, args, log);
  } catch (e) {
    log(`\n${(e as Error).message}`);
    return 1;
  }
}

async function authCli(cmd: string, args: string[], log: (s: string) => void): Promise<number> {
  const c = readCreds();
  const who: Who = args.includes("--bot") ? "bot" : "user";
  if (cmd === "logout") {
    if (who === "bot") {
      delete c.botToken;
      delete c.bot;
      await save(c);
      log("Removed the bot account.");
    } else {
      await rm(CREDENTIALS_PATH, { force: true });
      log(`Removed ${CREDENTIALS_PATH}.`);
    }
    return 0;
  }
  if (cmd === "status") {
    log(`You: ${c.token ? `connected as ${c.user ?? "?"}` : "not connected"}\nBot account: ${c.botToken ? c.bot ?? "?" : "none (replies come from you)"}`);
    log("Reading designs from files shared by link works without connecting.");
    return 0;
  }
  // login
  if (args.includes("--paste")) {
    log(`Create a token at ${SETTINGS_URL} > Security > Personal access tokens, with: ${TOKEN_SCOPES.join(", ")}.`);
    const r = await saveToken(who, await ask(who === "bot" ? "Bot account's token: " : "Token: ", true));
    log(`Connected${r.name !== "?" ? ` as ${r.name}` : ""}.${r.scopeWarning ? " " + r.scopeWarning : ""}`);
    return 0;
  }
  const r = await loginInBrowser(who, (url) => log(`A page opened in your browser to connect Figma. If it didn't, open ${url}`));
  log(`Connected${r.name !== "?" ? ` as ${r.name}` : ""}${who === "bot" ? " (bot account)" : ""}.${r.scopeWarning ? " " + r.scopeWarning : ""}`);
  return 0;
}
