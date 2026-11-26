/**
 * Credentials for `figma-mcp-v2 login`.
 *
 * Reading designs from link-shared files needs nothing. Comments, private files and replies need a
 * Figma login, which Figma only grants to API clients:
 *
 *   - Browser login (OAuth, default when an OAuth app is configured): opens figma.com, you click
 *     Allow, tokens are stored and refreshed automatically. The app's client id/secret come from
 *     FIGMA_OAUTH_CLIENT_ID/SECRET, from `login --setup-app`, or from the build.
 *   - Personal access token (fallback, `login --token`): pasted once.
 *
 * Each can be stored for the person ("user") and for a separate bot account ("bot") that replies to
 * #plsfix comments under its own name. Saved to ~/.config/figma-mcp-v2/credentials.json (0600).
 * Environment variables take precedence over stored values.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export type Who = "user" | "bot";

export interface OAuthGrant {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export interface Credentials {
  token?: string;
  cookie?: string;
  oauth?: OAuthGrant;
  user?: string;
  botToken?: string;
  botOauth?: OAuthGrant;
  bot?: string;
  /** OAuth app registered by whoever set this machine up (`login --setup-app`). */
  app?: { clientId: string; clientSecret: string };
  savedAt?: string;
}

export const CREDENTIALS_PATH = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "figma-mcp-v2", "credentials.json");

/** OAuth app baked into published builds (empty until one is registered for the project). */
const BUILT_IN_APP = { clientId: "", clientSecret: "" };

export const OAUTH_PORT = Number(process.env.FIGMA_OAUTH_PORT ?? 3056);
export const OAUTH_REDIRECT = `http://localhost:${OAUTH_PORT}/callback`;
export const OAUTH_SCOPES = ["current_user:read", "file_content:read", "file_metadata:read", "file_comments:read", "file_comments:write"];

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

export function oauthApp(c: Credentials = readCreds()): { clientId: string; clientSecret: string } | undefined {
  const id = process.env.FIGMA_OAUTH_CLIENT_ID ?? c.app?.clientId ?? BUILT_IN_APP.clientId;
  const secret = process.env.FIGMA_OAUTH_CLIENT_SECRET ?? c.app?.clientSecret ?? BUILT_IN_APP.clientSecret;
  return id && secret ? { clientId: id, clientSecret: secret } : undefined;
}

/** Applies stored credentials to process.env unless the env already sets them. */
export function loadStoredCredentials(): Credentials {
  const c = readCreds();
  const envUser = process.env.FIGMA_TOKEN || process.env.FIGMA_ACCESS_TOKEN || process.env.FIGMA_OAUTH_TOKEN;
  if (!envUser) {
    if (c.oauth) process.env.FIGMA_OAUTH_TOKEN = c.oauth.accessToken;
    else if (c.token) process.env.FIGMA_TOKEN = c.token;
  }
  if (!process.env.FIGMA_BOT_TOKEN && !process.env.FIGMA_BOT_OAUTH_TOKEN) {
    if (c.botOauth) process.env.FIGMA_BOT_OAUTH_TOKEN = c.botOauth.accessToken;
    else if (c.botToken) process.env.FIGMA_BOT_TOKEN = c.botToken;
  }
  if (c.cookie && !process.env.FIGMA_COOKIE) process.env.FIGMA_COOKIE = c.cookie;
  return c;
}

// ---------- OAuth ----------

async function tokenRequest(url: string, app: { clientId: string; clientSecret: string }, form: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")
    },
    body: new URLSearchParams(form)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Figma refused the login (HTTP ${res.status}): ${text.slice(0, 200)}`);
  return JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in: number };
}

/** Refreshes stored OAuth tokens that expire within `withinDays`. Safe to call at every start. */
export async function refreshOAuthIfNeeded(withinDays = 14): Promise<void> {
  const c = readCreds();
  const app = oauthApp(c);
  if (!app) return;
  let changed = false;
  for (const key of ["oauth", "botOauth"] as const) {
    const g = c[key];
    if (!g?.refreshToken || Date.parse(g.expiresAt) - Date.now() > withinDays * 864e5) continue;
    try {
      const r = await tokenRequest("https://api.figma.com/v1/oauth/refresh", app, { refresh_token: g.refreshToken });
      c[key] = { accessToken: r.access_token, refreshToken: r.refresh_token ?? g.refreshToken, expiresAt: new Date(Date.now() + r.expires_in * 1000).toISOString() };
      if (key === "oauth" && !process.env.FIGMA_TOKEN) process.env.FIGMA_OAUTH_TOKEN = r.access_token;
      if (key === "botOauth" && !process.env.FIGMA_BOT_TOKEN) process.env.FIGMA_BOT_OAUTH_TOKEN = r.access_token;
      changed = true;
    } catch (e) {
      console.error(`[figma-mcp-v2] could not refresh the Figma login (${(e as Error).message}); run figma-mcp-v2 login`);
    }
  }
  if (changed) await save(c);
}

export function openBrowser(url: string): boolean {
  if (process.env.FIGMA_OAUTH_NO_BROWSER === "1") return false;
  try {
    const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/** Browser login: local callback server, PKCE, code exchange. Returns the grant. */
export async function browserLogin(app: { clientId: string; clientSecret: string }, log: (s: string) => void, hint?: string): Promise<OAuthGrant> {
  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url =
    "https://www.figma.com/oauth?" +
    new URLSearchParams({ client_id: app.clientId, redirect_uri: OAUTH_REDIRECT, scope: OAUTH_SCOPES.join(" "), state, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" });
  const code = await new Promise<string>((resolve, reject) => {
    const page = (title: string, body: string) =>
      `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body>`;
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", OAUTH_REDIRECT);
      if (u.pathname !== "/callback") return void res.writeHead(404).end();
      const err = u.searchParams.get("error");
      if (err || u.searchParams.get("state") !== state || !u.searchParams.get("code")) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page("Login didn't complete", err ? `Figma said: ${err}` : "The response didn't match this login. Try again."));
        server.close();
        return reject(new Error(err ? `Figma login was cancelled (${err}).` : "Login response didn't match (state mismatch)."));
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("You're logged in", "figma-mcp-v2 can now read comments and reply. You can close this tab."));
      server.close();
      resolve(u.searchParams.get("code")!);
    });
    server.on("error", (e: NodeJS.ErrnoException) => reject(e.code === "EADDRINUSE" ? new Error(`Port ${OAUTH_PORT} is busy; set FIGMA_OAUTH_PORT and register that redirect URL.`) : e));
    server.listen(OAUTH_PORT, "127.0.0.1", () => {
      log(hint ?? "Opening Figma in your browser. Click \"Allow access\" there.");
      if (process.env.FIGMA_OAUTH_NO_BROWSER === "1" || !openBrowser(url)) log("Open this link to log in:");
      log(url);
    });
    setTimeout(() => {
      server.close();
      reject(new Error("No answer from the browser within 5 minutes. Run login again."));
    }, 300_000).unref();
  });
  // Codes expire after 30 seconds: exchange right away.
  const r = await tokenRequest("https://api.figma.com/v1/oauth/token", app, { redirect_uri: OAUTH_REDIRECT, code, grant_type: "authorization_code", code_verifier: verifier });
  return { accessToken: r.access_token, refreshToken: r.refresh_token ?? "", expiresAt: new Date(Date.now() + r.expires_in * 1000).toISOString() };
}

/** Browser login from inside a running server (the figma_login tool): saves and applies the grant. */
export async function loginWithBrowser(who: Who, log: (s: string) => void): Promise<{ name: string } | { setupNeeded: true }> {
  const c = readCreds();
  const app = oauthApp(c);
  if (!app) return { setupNeeded: true };
  const grant = await browserLogin(app, log);
  const id = await identify({ Authorization: `Bearer ${grant.accessToken}` });
  const name = id.ok ? id.name : "?";
  if (who === "bot") {
    Object.assign(c, { botOauth: grant, bot: name });
    process.env.FIGMA_BOT_OAUTH_TOKEN = grant.accessToken;
  } else {
    Object.assign(c, { oauth: grant, user: name });
    process.env.FIGMA_OAUTH_TOKEN = grant.accessToken;
  }
  await save(c);
  return { name };
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

/** Who a credential belongs to. Missing current_user:read is reported, not fatal. */
async function identify(headers: Record<string, string>): Promise<{ ok: true; name: string } | { ok: false; status: number }> {
  const res = await fetch("https://api.figma.com/v1/me", { headers });
  if (!res.ok) return { ok: false, status: res.status };
  const me = (await res.json()) as { handle?: string; email?: string };
  return { ok: true, name: me.handle ?? me.email ?? "unknown user" };
}

const TOKEN_HELP = [
  "Create a personal access token: Figma > Settings > Security > Personal access tokens > Generate new token.",
  "Tick these scopes: Current user (read), File content (read), File metadata (read), Comments (read and write).",
  "Copy the token right away; Figma shows it only once."
];

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
      delete c.botOauth;
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
    const you = c.oauth ? `logged in as ${c.user ?? "?"} (browser login, renews automatically)` : c.token ? `token for ${c.user ?? "?"}` : "not logged in";
    const bot = c.botOauth || c.botToken ? `${c.bot ?? "?"}` : "none (replies come from you)";
    log(`You: ${you}\nBot account: ${bot}\nBrowser login: ${oauthApp(c) ? "available" : "not set up (figma-mcp-v2 login --setup-app)"}`);
    log("Reading designs from files shared by link works without logging in.");
    return 0;
  }
  // login
  if (args.includes("--setup-app")) {
    log("One-time setup of the OAuth app that \"Log in with Figma\" uses:");
    log("1. Open https://www.figma.com/developers/apps > Create a new app (pick your team).");
    log(`2. OAuth credentials > add the redirect URL ${OAUTH_REDIRECT}`);
    log(`3. OAuth scopes > ${OAUTH_SCOPES.join(", ")}`);
    log("4. Publish it as a private app (works for your team, no review).");
    openBrowser("https://www.figma.com/developers/apps");
    const clientId = await ask("Client ID: ");
    const clientSecret = await ask("Client secret: ", true);
    if (!clientId || !clientSecret) throw new Error("Both are needed; nothing saved.");
    c.app = { clientId, clientSecret };
    await save(c);
    log("Saved. Now run: figma-mcp-v2 login");
    return 0;
  }
  const app = oauthApp(c);
  if (app && !args.includes("--token")) {
    const grant = await browserLogin(app, log, who === "bot" ? "Log in as the BOT account. If your browser is logged in as you, open the link below in a private window instead." : undefined);
    const id = await identify({ Authorization: `Bearer ${grant.accessToken}` });
    const name = id.ok ? id.name : "?";
    if (who === "bot") Object.assign(c, { botOauth: grant, bot: name });
    else Object.assign(c, { oauth: grant, user: name });
    await save(c);
    log(`\nLogged in${name !== "?" ? ` as ${name}` : ""}${who === "bot" ? " (bot account: replies to #plsfix comments come from it)" : ""}. Restart your AI app to pick it up.`);
    return 0;
  }
  if (!app && !args.includes("--token")) log("Browser login isn't set up on this machine (figma-mcp-v2 login --setup-app), so this uses a personal access token.\n");
  for (const line of TOKEN_HELP) log(line);
  openBrowser("https://www.figma.com/settings");
  const token = await ask(who === "bot" ? "\nBot account's token: " : "\nToken: ", true);
  if (!token) throw new Error("No token entered; nothing changed.");
  const id = await identify({ "X-Figma-Token": token });
  if (!id.ok && id.status !== 403) throw new Error(`Figma doesn't accept this token (HTTP ${id.status}). Check you copied all of it.`);
  const name = id.ok ? id.name : "?";
  if (who === "bot") Object.assign(c, { botToken: token, bot: name });
  else Object.assign(c, { token, user: name });
  await save(c);
  if (!id.ok) log("Saved. The token lacks the \"Current user\" scope, so I can't tell whose it is; #plsfix watching then needs --from <your handle>. Regenerate it with that scope to fix this.");
  else log(`Saved: ${name}${who === "bot" ? " (bot account)" : ""}. Restart your AI app to pick it up.`);
  return 0;
}
