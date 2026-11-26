import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("connect page: shows the steps, rejects foreign posts and bad tokens, saves a good one", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "figma-login-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.FIGMA_LOGIN_NO_BROWSER = "1";
  process.env.FIGMA_LOGIN_PORT = "39562";
  const { loginInBrowser } = await import("../src/auth.js");
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:39562")) return real(input, init);
    if (url === "https://api.figma.com/v1/me") {
      const t = new Headers(init?.headers).get("x-figma-token");
      return t === "figd_good" ? new Response(JSON.stringify({ handle: "lukas" })) : new Response("{}", { status: 401 });
    }
    throw new Error("unexpected " + url);
  }) as typeof fetch;
  try {
    let pageUrl = "";
    const done = loginInBrowser("user", (u) => (pageUrl = u));
    await new Promise((r) => setTimeout(r, 100));
    const page = await (await real(pageUrl)).text();
    assert.match(page, /Open Figma settings/);
    assert.match(page, /Current user: read/);
    const nonce = /name="nonce" value="([0-9a-f]+)"/.exec(page)![1];
    const post = (body: Record<string, string>) => real(pageUrl + "save", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
    assert.equal((await post({ nonce: "other", token: "figd_good" })).status, 403);
    const bad = await post({ nonce, token: "figd_bad" });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /doesn&#39;t accept|doesn't accept/);
    const good = await post({ nonce, token: "figd_good" });
    assert.match(await good.text(), /Connected as lukas/);
    assert.deepEqual(await done, { name: "lukas" });
    const file = path.join(tmp, "figma-mcp-v2/credentials.json");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).token, "figd_good");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    globalThis.fetch = real;
  }
});
