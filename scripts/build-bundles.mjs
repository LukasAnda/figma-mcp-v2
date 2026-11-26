// Builds release artifacts into ./release:
//   figma-mcp-v2.mcpb            Claude Desktop extension (runs on Claude's built-in Node; no npx needed)
//   figma-mcp-bridge-plugin.zip  the Figma plugin, ready for Plugins > Development > Import plugin from manifest
// Usage: npm run build && npm run bundle
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const out = path.join(root, "release");
const stage = path.join(out, "stage");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

if (!existsSync("dist/index.js")) throw new Error("Run npm run build first.");
rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 1. Extension contents: compiled server, Figma plugin, production dependencies.
for (const p of ["dist", "plugin", "README.md", "LICENSE", "package.json", "package-lock.json"]) cpSync(p, path.join(stage, p), { recursive: true });
cpSync("mcpb/manifest.json", path.join(stage, "manifest.json"));
cpSync("mcpb/icon.png", path.join(stage, "icon.png"));
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);

// resvg-js loads a per-platform native package; npm only installs the current platform's. Add the
// ones Claude Desktop runs on so one bundle works everywhere.
const resvg = JSON.parse(readFileSync(path.join(stage, "node_modules/@resvg/resvg-js/package.json"), "utf8")).version;
const natives = ["darwin-arm64", "darwin-x64", "win32-x64-msvc", "win32-arm64-msvc", "linux-x64-gnu", "linux-arm64-gnu"].map((p) => `@resvg/resvg-js-${p}@${resvg}`);
run("npm", ["install", "--no-save", "--force", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", ...natives], stage);
for (const n of natives) {
  const dir = path.join(stage, "node_modules", n.slice(0, n.lastIndexOf("@")));
  if (!existsSync(dir)) throw new Error(`Missing native package ${n}`);
}
rmSync(path.join(stage, "package-lock.json"));

// 2. Pack and validate the extension.
const mcpb = path.join(root, "node_modules/.bin/mcpb");
run(mcpb, ["validate", path.join(stage, "manifest.json")]);
run(mcpb, ["pack", stage, path.join(out, `${pkg.name}.mcpb`)]);

// 3. The Figma plugin as a zip with one folder inside.
const pluginStage = path.join(out, "plugin-stage", "figma-mcp-bridge-plugin");
mkdirSync(pluginStage, { recursive: true });
for (const f of ["manifest.json", "code.js", "ui.html"]) cpSync(path.join("plugin", f), path.join(pluginStage, f));
writeFileSync(
  path.join(pluginStage, "README.txt"),
  `Figma MCP Bridge ${pkg.version}\n\n1. Open the Figma desktop app.\n2. Right-click the canvas > Plugins > Development > Import plugin from manifest...\n3. Choose manifest.json in this folder.\n4. In your file: Plugins > Development > Figma MCP Bridge. It connects to the figma-mcp-v2 server running in your AI app.\n\nKeep this folder where it is: Figma loads the plugin from here.\n`
);
run("zip", ["-qr", path.join(out, "figma-mcp-bridge-plugin.zip"), "figma-mcp-bridge-plugin"], path.join(out, "plugin-stage"));

rmSync(stage, { recursive: true, force: true });
rmSync(path.join(out, "plugin-stage"), { recursive: true, force: true });
console.log(`\nBuilt ${out}/${pkg.name}.mcpb and ${out}/figma-mcp-bridge-plugin.zip`);
