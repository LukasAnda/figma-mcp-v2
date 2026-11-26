// Builds release artifacts into ./release:
//   figma-mcp-v2.mcpb            Claude Desktop extension (runs on Claude's built-in Node; no npx needed)
//   figma-mcp-bridge-plugin.zip  the Figma plugin, ready for Plugins > Development > Import plugin from manifest
// Usage: npm run build && npm run bundle
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
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
const bundle = path.join(out, `${pkg.name}.mcpb`);
run(mcpb, ["pack", stage, bundle]);

// Optional signing. MCPB_SIGNING_CERT / MCPB_SIGNING_KEY hold PEM text (a code-signing certificate
// and its private key); MCPB_SIGNING_CHAIN optionally holds the intermediate certificates.
if (process.env.MCPB_SIGNING_CERT && process.env.MCPB_SIGNING_KEY) {
  const keys = mkdtempSync(path.join(os.tmpdir(), "mcpb-sign-"));
  try {
    const cert = path.join(keys, "cert.pem"), key = path.join(keys, "key.pem"), chain = path.join(keys, "chain.pem");
    writeFileSync(cert, process.env.MCPB_SIGNING_CERT, { mode: 0o600 });
    writeFileSync(key, process.env.MCPB_SIGNING_KEY, { mode: 0o600 });
    const args = ["sign", bundle, "--cert", cert, "--key", key];
    if (process.env.MCPB_SIGNING_CHAIN) {
      writeFileSync(chain, process.env.MCPB_SIGNING_CHAIN, { mode: 0o600 });
      args.push("--intermediate", chain);
    }
    run(mcpb, args);
    // verify checks the chain against this machine's trust store: a self-signed or untrusted
    // certificate signs fine but reports "not signed". Report it without failing the release.
    try {
      run(mcpb, ["verify", bundle]);
    } catch {
      console.warn("WARNING: the extension is signed, but its certificate isn't trusted here (self-signed or unknown issuer).");
    }
  } finally {
    rmSync(keys, { recursive: true, force: true });
  }
} else console.log("MCPB_SIGNING_CERT/MCPB_SIGNING_KEY not set: the extension is unsigned.");

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
