// Runs from `npm version` (the "version" lifecycle script): copies package.json's new version into
// every other file that states it, so the tag, the npm package, the Claude plugin, the Gemini
// extension and the Figma plugin agree.
import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const edits = [
  [".claude-plugin/plugin.json", /("version":\s*")[^"]+(")/],
  ["gemini-extension.json", /("version":\s*")[^"]+(")/],
  ["src/version.ts", /(const VERSION = ")[^"]+(")/],
  ["mcpb/manifest.json", /("version":\s*")[^"]+(")/],
  ["plugin/code.js", /(pluginVersion: ")[^"]+(")/]
];
for (const [file, re] of edits) {
  const before = readFileSync(file, "utf8");
  if (!re.test(before)) throw new Error(`No version string found in ${file}`);
  writeFileSync(file, before.replace(re, `$1${version}$2`));
}
console.log(`Synced version ${version}`);
