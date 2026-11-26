/**
 * `figma-mcp-v2 watch <link>`: polls a file for #plsfix comments and hands each new request to an
 * agent command (e.g. `claude -p`), one at a time. Figma webhooks need a public server; polling
 * works on a laptop.
 *
 * Safety: comment text reaches an AI agent, so by default only requests by the owner of FIGMA_TOKEN
 * are acted on. Others must be allowed with --from, or everyone with --anyone.
 */
import { spawn } from "node:child_process";
import { loadStoredCredentials } from "./auth.js";
import { fixPrompt, loadFixRequests, respondToFixRequest, whoAmI, type FixRequest } from "./comments.js";
import { parseFigmaUrl } from "./figma/url.js";

interface Opts { url: string; tag: string; interval: number; from?: string[]; anyone: boolean; exec?: string; once: boolean }

function parse(args: string[]): Opts {
  const o: Opts = { url: "", tag: "#plsfix", interval: 60, anyone: false, once: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    if (a === "--tag") o.tag = next();
    else if (a === "--interval") o.interval = Math.max(15, Number(next()));
    else if (a === "--from") o.from = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--anyone") o.anyone = true;
    else if (a === "--exec") o.exec = next();
    else if (a === "--once") o.once = true;
    else if (!a.startsWith("--")) o.url = a;
    else throw new Error(`Unknown option ${a}`);
  }
  if (!o.url) throw new Error("Pass a Figma file link: figma-mcp-v2 watch <link> [--exec \"claude -p\"]");
  return o;
}

function runAgent(cmd: string, prompt: string, r: FixRequest, url: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, FIGMA_FIX_URL: url, FIGMA_FIX_COMMENT_ID: r.commentId, FIGMA_FIX_REQUEST: r.request } });
    child.stdin.end(prompt);
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(127));
  });
}

export async function runWatch(args: string[]): Promise<number> {
  let o: Opts;
  try {
    o = parse(args);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  loadStoredCredentials();
  const target = parseFigmaUrl(o.url);
  const log = (s: string) => console.error(`[watch ${new Date().toLocaleTimeString()}] ${s}`);
  let authors = o.from;
  if (!authors && !o.anyone) {
    const owner = await whoAmI("user");
    authors = [owner.id];
    log(`acting on ${o.tag} comments by ${owner.handle} only (add people with --from, or --anyone)`);
  }
  const bot = await whoAmI("bot");
  log(`replies come from ${bot.handle}${process.env.FIGMA_BOT_TOKEN ? "" : " (set FIGMA_BOT_TOKEN to reply as a separate account)"}`);
  const dispatched = new Set<string>();
  for (;;) {
    try {
      const { requests } = await loadFixRequests(target, { tag: o.tag, authors });
      const fresh = requests.filter((r) => r.status === "open" && !dispatched.has(r.commentId));
      if (fresh.length) log(`${fresh.length} new request(s)`);
      for (const r of fresh) {
        dispatched.add(r.commentId);
        const prompt = fixPrompt(r, o.url);
        if (!o.exec) {
          console.log(`\n--- ${r.commentId} (${r.author}) ---\n${prompt}\n`);
          continue;
        }
        await respondToFixRequest(target, r.commentId, { status: "in_progress" });
        log(`${r.commentId}: "${r.request.slice(0, 60)}" -> ${o.exec}`);
        const code = await runAgent(o.exec, prompt, r, o.url);
        if (code !== 0) {
          log(`${r.commentId}: agent exited with ${code}`);
          await respondToFixRequest(target, r.commentId, { status: "needs_info", message: `I couldn't finish this automatically (the agent exited with code ${code}). Could you add details, or I'll pick it up again when you reply with ${o.tag}?` }).catch(() => {});
        }
      }
    } catch (e) {
      log(`error: ${(e as Error).message}`);
    }
    if (o.once) return 0;
    await new Promise((r) => setTimeout(r, o.interval * 1000));
  }
}
