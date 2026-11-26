import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("browser login: callback with matching state, PKCE code exchange, stored grant", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "figma-oauth-"));
  process.env.XDG_CONFIG_HOME = tmp;
  process.env.FIGMA_OAUTH_NO_BROWSER = "1";
  process.env.FIGMA_OAUTH_PORT = "39561";
  process.env.FIGMA_OAUTH_CLIENT_ID = "cid";
  process.env.FIGMA_OAUTH_CLIENT_SECRET = "secret";
  const { loginWithBrowser } = await import("../src/auth.js");

  const realFetch = globalThis.fetch;
  let exchanged: { auth: string | null; body: URLSearchParams } | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://localhost:39561")) return realFetch(input, init);
    if (url === "https://api.figma.com/v1/oauth/token") {
      exchanged = { auth: new Headers(init?.headers).get("authorization"), body: new URLSearchParams(String(init?.body)) };
      return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 7776000 }));
    }
    if (url === "https://api.figma.com/v1/me") return new Response(JSON.stringify({ handle: "lukas" }));
    throw new Error("unexpected fetch " + url);
  }) as typeof fetch;

  try {
    const lines: string[] = [];
    const done = loginWithBrowser("user", (s) => {
      lines.push(s);
      if (s.startsWith("https://www.figma.com/oauth?")) {
        const q = new URL(s).searchParams;
        assert.equal(q.get("redirect_uri"), "http://localhost:39561/callback");
        assert.equal(q.get("code_challenge_method"), "S256");
        assert.match(q.get("scope")!, /file_comments:write/);
        // A forged callback with the wrong state must not log anyone in…
        void realFetch(`http://localhost:39561/callback?code=evil&state=wrong`).then(() => {});
        (globalThis as { __challenge?: string }).__challenge = q.get("code_challenge")!;
        (globalThis as { __state?: string }).__state = q.get("state")!;
      }
    });
    // …so the login fails and nothing is saved.
    await assert.rejects(done, /state mismatch/);
    assert.throws(() => readFileSync(path.join(tmp, "figma-mcp-v2/credentials.json")));

    // A real round trip.
    const ok = loginWithBrowser("user", (s) => {
      if (s.startsWith("https://www.figma.com/oauth?")) {
        const q = new URL(s).searchParams;
        void realFetch(`http://localhost:39561/callback?code=good&state=${q.get("state")}`);
        (globalThis as { __challenge?: string }).__challenge = q.get("code_challenge")!;
      }
    });
    assert.deepEqual(await ok, { name: "lukas" });
    assert.equal(exchanged!.auth, "Basic " + Buffer.from("cid:secret").toString("base64"));
    assert.equal(exchanged!.body.get("code"), "good");
    assert.equal(exchanged!.body.get("grant_type"), "authorization_code");
    const verifier = exchanged!.body.get("code_verifier")!;
    assert.equal(createHash("sha256").update(verifier).digest("base64url"), (globalThis as { __challenge?: string }).__challenge);
    const saved = JSON.parse(readFileSync(path.join(tmp, "figma-mcp-v2/credentials.json"), "utf8"));
    assert.equal(saved.oauth.accessToken, "at");
    assert.equal(saved.user, "lukas");
    assert.equal(process.env.FIGMA_OAUTH_TOKEN, "at");
  } finally {
    globalThis.fetch = realFetch;
  }
});
