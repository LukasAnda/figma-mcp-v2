import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("plugin install copies files, records the folder and refreshes outdated copies", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "figma-plugin-"));
  process.env.XDG_CONFIG_HOME = path.join(tmp, "config"); // keep the user's real config untouched
  const { installPlugin, refreshInstalledPlugin } = await import("../src/plugin-setup.js");
  const { VERSION } = await import("../src/version.js");
  const dir = path.join(tmp, "plugin");
  const r = await installPlugin(dir);
  assert.equal(r.manifest, path.join(dir, "manifest.json"));
  for (const f of ["manifest.json", "code.js", "ui.html"]) assert.ok(existsSync(path.join(dir, f)), f);
  assert.equal(JSON.parse(readFileSync(path.join(tmp, "config/figma-mcp-v2/plugin.json"), "utf8")).dir, dir);
  // An older copy gets replaced on the next server start.
  writeFileSync(path.join(dir, ".figma-mcp-v2-version"), "0.0.1\n");
  writeFileSync(path.join(dir, "code.js"), "old");
  await refreshInstalledPlugin();
  assert.equal(readFileSync(path.join(dir, ".figma-mcp-v2-version"), "utf8").trim(), VERSION);
  assert.notEqual(readFileSync(path.join(dir, "code.js"), "utf8"), "old");
});
