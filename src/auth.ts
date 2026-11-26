/**
 * Stored credentials for `figma-mcp-v2 login`.
 *
 *   token  – Figma personal access token (REST source, comments, private files).
 *   cookie – figma.com browser cookie (web source for private files without a token).
 *
 * Saved to ~/.config/figma-mcp-v2/credentials.json with 0600 permissions. Environment
 * variables (FIGMA_TOKEN, FIGMA_COOKIE) take precedence over the stored values.
 */
import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export interface Credentials {
  token?: string;
  cookie?: string;
  user?: string;
  savedAt?: string;
}

export const CREDENTIALS_PATH = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "figma-mcp-v2", "credentials.json");

/** Applies stored credentials to process.env unless the env already sets them. */
export function loadStoredCredentials(): Credentials {
  try {
    const c = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")) as Credentials;
    if (c.token && !process.env.FIGMA_TOKEN && !process.env.FIGMA_ACCESS_TOKEN && !process.env.FIGMA_OAUTH_TOKEN) process.env.FIGMA_TOKEN = c.token;
    if (c.cookie && !process.env.FIGMA_COOKIE) process.env.FIGMA_COOKIE = c.cookie;
    return c;
  } catch {
    return {};
  }
}

async function save(c: Credentials) {
  await mkdir(path.dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
  await writeFile(CREDENTIALS_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
  await chmod(CREDENTIALS_PATH, 0o600);
}

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) {
      // Echo nothing while the secret is typed or pasted.
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

async function whoAmI(token: string): Promise<string> {
  const res = await fetch("https://api.figma.com/v1/me", { headers: { "X-Figma-Token": token } });
  if (!res.ok) throw new Error(`Figma rejected the token (HTTP ${res.status}).`);
  const me = (await res.json()) as { handle?: string; email?: string };
  return me.handle ?? me.email ?? "unknown user";
}

export async function runAuthCli(cmd: string): Promise<number> {
  const log = (s: string) => process.stderr.write(s + "\n");
  if (cmd === "logout") {
    await rm(CREDENTIALS_PATH, { force: true });
    log(`Removed ${CREDENTIALS_PATH}.`);
    return 0;
  }
  if (cmd === "status") {
    let c: Credentials = {};
    try {
      c = JSON.parse(await readFile(CREDENTIALS_PATH, "utf8"));
    } catch {
      /* none */
    }
    log(`Stored credentials (${CREDENTIALS_PATH}): ${c.token ? `token for ${c.user ?? "?"}` : "no token"}, ${c.cookie ? "cookie set" : "no cookie"}.`);
    log(`Environment: FIGMA_TOKEN ${process.env.FIGMA_TOKEN ? "set" : "unset"}, FIGMA_COOKIE ${process.env.FIGMA_COOKIE ? "set" : "unset"}.`);
    log("Without either, only files shared as \"anyone with the link can view\" can be read.");
    return 0;
  }
  // login
  log("Log in to Figma for figma-mcp-v2.\n");
  log("1) Personal access token (recommended): Figma > Settings > Security > Personal access tokens.");
  log("   Scopes: file_content:read (plus file_comments:write to post comments, file_variables:read on Enterprise).");
  log("2) Browser cookie (optional, lets the no-token web source open private files): copy the `cookie` request header");
  log("   from any figma.com request in your browser's dev tools.\n");
  const current = loadStoredCredentials();
  const next: Credentials = { ...current };
  const token = await ask("Personal access token (Enter to skip): ", true);
  if (token) {
    next.user = await whoAmI(token);
    next.token = token;
    log(`Token OK — logged in as ${next.user}.`);
  }
  const cookie = await ask("figma.com cookie (Enter to skip): ", true);
  if (cookie) next.cookie = cookie;
  if (!token && !cookie) {
    log("Nothing entered; credentials unchanged.");
    return 1;
  }
  next.savedAt = new Date().toISOString();
  await save(next);
  log(`Saved to ${CREDENTIALS_PATH} (readable only by you). Restart your MCP client to pick it up.`);
  return 0;
}
