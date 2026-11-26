/**
 * Installs the companion Figma plugin into a stable, easy-to-find folder.
 *
 * Figma remembers a development plugin by the absolute path of its manifest. Inside npx caches or
 * Claude Desktop extension folders that path is hidden and changes on updates, so we copy the
 * plugin to ~/figma-mcp-bridge-plugin (or a chosen folder), remember where, and refresh that copy
 * whenever a newer server starts.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CREDENTIALS_PATH } from "./auth.js";
import { VERSION } from "./version.js";

const FILES = ["manifest.json", "code.js", "ui.html"];
const MARKER = ".figma-mcp-v2-version";
const STATE = path.join(path.dirname(CREDENTIALS_PATH), "plugin.json");

export const bundledPluginDir = () => fileURLToPath(new URL("../plugin/", import.meta.url));
export const defaultPluginDir = () => path.join(os.homedir(), "figma-mcp-bridge-plugin");

export interface PluginInstall {
  dir: string;
  manifest: string;
  version: string;
  updated: boolean;
}

export async function installPlugin(dir = defaultPluginDir()): Promise<PluginInstall> {
  const target = path.resolve(dir);
  await mkdir(target, { recursive: true });
  let current: string | undefined;
  try {
    current = (await readFile(path.join(target, MARKER), "utf8")).trim();
  } catch {
    /* fresh install */
  }
  for (const f of FILES) await copyFile(path.join(bundledPluginDir(), f), path.join(target, f));
  await writeFile(path.join(target, MARKER), VERSION + "\n");
  await mkdir(path.dirname(STATE), { recursive: true });
  await writeFile(STATE, JSON.stringify({ dir: target, version: VERSION }, null, 2));
  return { dir: target, manifest: path.join(target, "manifest.json"), version: VERSION, updated: current !== undefined && current !== VERSION };
}

/** On startup: if the plugin was installed before and is older than this server, update the copy. */
export async function refreshInstalledPlugin(): Promise<void> {
  try {
    const { dir } = JSON.parse(readFileSync(STATE, "utf8")) as { dir: string };
    const have = (await readFile(path.join(dir, MARKER), "utf8")).trim();
    if (have !== VERSION) {
      await installPlugin(dir);
      console.error(`[figma-mcp-v2] updated the Figma plugin in ${dir} to ${VERSION}; re-run it in Figma to load the new version`);
    }
  } catch {
    /* never installed, or the folder was removed */
  }
}

/** Shows the file in Finder / Explorer / the Linux file manager. Best effort. */
export function reveal(file: string): boolean {
  try {
    const [cmd, args] =
      process.platform === "darwin" ? ["open", ["-R", file]] : process.platform === "win32" ? ["explorer", [`/select,${file}`]] : ["xdg-open", [path.dirname(file)]];
    spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

export function importSteps(manifest: string): string[] {
  return [
    "Open the Figma desktop app (browser Figma can't load development plugins).",
    "Right-click the canvas > Plugins > Development > Import plugin from manifest…",
    `Choose ${manifest}` + (process.platform === "darwin" ? " (in the file dialog, ⌘⇧G and paste the path)." : "."),
    "Then in the file you want to work on: Plugins > Development > Figma MCP Bridge. Its window says Connected.",
    "The import is one-time; updates of this server refresh the plugin files in place."
  ];
}
