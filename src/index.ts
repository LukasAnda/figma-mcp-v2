#!/usr/bin/env node
/**
 * figma-mcp-v2: read Figma designs, components, tokens and assets without Dev Mode, and edit
 * files through a companion plugin.
 *
 * Environment:
 *   FIGMA_TOKEN        optional personal access token (enables the REST source and comments)
 *   FIGMA_COOKIE       optional figma.com cookie, for private files through the web source
 *   FIGMA_SOURCE       force a read source: web | rest | plugin (default: auto)
 *   FIGMA_BRIDGE_PORT  plugin bridge port (default 3055)
 *   FIGMA_ASSETS_DIR   default folder for figma_download_assets (default ./figma-assets)
 *   FIGMA_NO_BRIDGE=1  do not start the plugin bridge
 *
 * CLI: figma-mcp-v2 [login | logout | status | plugin | help]   (no argument: run the MCP server on stdio)
 */
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { loadStoredCredentials, runAuthCli } from "./auth.js";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { bridge } from "./bridge/bridge.js";
import { VERSION } from "./version.js";
import { importSteps, installPlugin, refreshInstalledPlugin, reveal } from "./plugin-setup.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { closeAllWebSessions } from "./web/client.js";


export function createServer(): McpServer {
  const server = new McpServer(
    { name: "figma-mcp-v2", version: VERSION },
    {
      instructions: `Figma tools. Pass Figma links as \`url\` (right-click a layer in Figma > Copy link to selection gives a link with node-id).
Reading needs no Dev Mode and no token for files shared by link: figma_get_file (pages/frames) → figma_get_design (layout/styles/tokens spec) + figma_get_screenshot (see it) → figma_get_code (starting code) → figma_download_assets (icons/images). figma_get_variables / figma_get_styles / figma_get_components describe the design system.
Editing needs the "Figma MCP Bridge" plugin running in the file; check with figma_plugin_status, and use figma_install_plugin to set it up. Never edit unless the user asked for changes.
Building designs: use figma_build_layout to create whole screens in one call (auto layout, components, variants, instances, token bindings, sections, arrows), then check the returned screenshot. Bind colors to variables (figma_bind_tokens) so themes work; figma_create_theme_variant makes dark (or other) variants. Present flows like a design team: one section per flow with a title, per-state headings with requirements, screens, short notes beside them, and arrows for navigation.`
    }
  );
  registerReadTools(server);
  registerWriteTools(server);
  server.registerPrompt(
    "implement_figma_design",
    {
      title: "Implement a Figma design",
      description: "Step-by-step: read a Figma frame, download its assets, and implement it in this codebase.",
      argsSchema: z.object({
        url: z.string().describe("Figma link with node-id"),
        notes: z.string().optional().describe("Framework, target file, or other instructions")
      })
    },
    async ({ url, notes }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Implement this Figma design in the current project: ${url}
${notes ? `\nNotes: ${notes}\n` : ""}
1. figma_get_screenshot to see it, and figma_get_design for the exact layout, spacing, typography, colors and tokens.
2. Look at the project's existing components, styles and design tokens; map Figma components (instances) and variables to them instead of hard-coding values.
3. figma_download_assets into the project's asset folder for icons and images.
4. Optionally figma_get_code for a starting structure, then write idiomatic code for this codebase.
5. Compare your result against the screenshot and fix differences.`
          }
        }
      ]
    })
  );
  return server;
}

const cli = process.argv[2];
if (cli === "login" || cli === "logout" || cli === "status") {
  process.exit(await runAuthCli(cli));
}
if (cli === "plugin") {
  if (process.argv[3] === "install") {
    // Copy the Figma plugin to a stable folder and show it, for "Import plugin from manifest".
    const r = await installPlugin(process.argv[4]);
    reveal(r.manifest);
    console.log(`Figma plugin ${r.version} installed in ${r.dir}\n\n` + importSteps(r.manifest).map((s, i) => `${i + 1}. ${s}`).join("\n"));
  } else console.log(fileURLToPath(new URL("../plugin/manifest.json", import.meta.url)));
  process.exit(0);
}
if (cli === "--version" || cli === "-v") {
  console.log(VERSION);
  process.exit(0);
}
if (cli === "help" || cli === "--help" || cli === "-h") {
  console.log(`figma-mcp-v2 ${VERSION}: MCP server for reading and editing Figma files.

Usage:
  figma-mcp-v2            run the MCP server on stdio (what MCP clients start)
  figma-mcp-v2 login      store a personal access token and/or figma.com cookie
  figma-mcp-v2 status     show which credentials are configured
  figma-mcp-v2 logout     remove stored credentials
  figma-mcp-v2 plugin install [dir]   copy the Figma plugin to ~/figma-mcp-bridge-plugin (or dir) and show it
  figma-mcp-v2 plugin     print the path of the bundled Figma plugin manifest`);
  process.exit(0);
}

loadStoredCredentials();
void refreshInstalledPlugin();
if (process.env.FIGMA_NO_BRIDGE !== "1") void bridge.start();

const shutdown = () => {
  closeAllWebSessions();
  bridge.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

serveStdio(createServer);
console.error(`figma-mcp-v2 ${VERSION} running on stdio`);
