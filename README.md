# figma-mcp-v2

An MCP server that lets AI coding agents work with Figma. Give it a Figma link and it reads layouts,
components, variables, styles and assets. You don't need Dev Mode, a paid seat or, for files shared
by link, even a token. A companion Figma plugin adds editing: it builds whole screens with auto
layout, components and variants, binds colors to design tokens, creates dark themes, and lays work
out the way design teams present it.

```
you:    implement https://www.figma.com/design/<fileKey>/<File-name>?node-id=12-345
agent:  figma_get_screenshot → figma_get_design → figma_download_assets → writes the component
```

It works with any MCP client: Claude Code, Claude Desktop, Gemini CLI, OpenAI Codex, Cursor,
VS Code (Copilot), Windsurf, Zed, Cline and others.

## Install

Node.js 20 or newer is required. Every client runs the same command:

```bash
npx -y figma-mcp-v2
```

The package is on npm as [`figma-mcp-v2`](https://www.npmjs.com/package/figma-mcp-v2). The latest code from GitHub works too:
`npx -y github:LukasAnda/figma-mcp-v2` (the first start builds it, which takes about a minute).

### Claude Code

As a plugin, which adds the MCP server and a `figma-design` skill:

```
/plugin marketplace add LukasAnda/figma-mcp-v2
/plugin install figma-mcp-v2@figma-mcp-v2
```

Or only the server:

```bash
claude mcp add figma -- npx -y figma-mcp-v2
```

### Gemini CLI

As an extension, which adds the server and its usage guide (`CONTEXT.md`):

```bash
gemini extensions install https://github.com/LukasAnda/figma-mcp-v2
```

Or only the server, in `~/.gemini/settings.json`:

```json
{ "mcpServers": { "figma": { "command": "npx", "args": ["-y", "figma-mcp-v2"] } } }
```

### OpenAI Codex

```bash
codex mcp add figma -- npx -y figma-mcp-v2
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.figma]
command = "npx"
args = ["-y", "figma-mcp-v2"]
startup_timeout_sec = 120
```

### Claude Desktop

Download **[figma-mcp-v2.mcpb](https://github.com/LukasAnda/figma-mcp-v2/releases/latest/download/figma-mcp-v2.mcpb)**
and double-click it, or use **Settings → Extensions → Install Extension…**. It runs on Claude
Desktop's built-in Node.js, so you don't need Node, npm or npx. Its settings take an optional
Figma token for private files.

After installing, say **"set up Figma"**, or pick the *quickstart* prompt. Claude installs the
Figma plugin, puts its path on your clipboard and walks you through the three clicks. Reading
designs works right away; the plugin is only needed for editing.

Claude Desktop also offers Figma's official connector, which needs Dev Mode. If both are enabled
and Claude reaches for the other one, say "use Figma (no Dev Mode)" or turn the official connector off.

### Cursor, Windsurf, Cline

Add this to `.cursor/mcp.json` (Cursor), `~/.codeium/windsurf/mcp_config.json` (Windsurf) or the
Cline MCP settings:

```json
{
  "mcpServers": {
    "figma": {
      "command": "npx",
      "args": ["-y", "figma-mcp-v2"],
      "env": { "FIGMA_ASSETS_DIR": "src/assets/figma" }
    }
  }
}
```

### VS Code (GitHub Copilot)

```bash
code --add-mcp '{"name":"figma","command":"npx","args":["-y","figma-mcp-v2"]}'
```

### Zed

In `settings.json`:

```json
{ "context_servers": { "figma": { "command": { "path": "npx", "args": ["-y", "figma-mcp-v2"] } } } }
```

### From a clone

```bash
git clone https://github.com/LukasAnda/figma-mcp-v2 && cd figma-mcp-v2 && npm install
# then use: node /absolute/path/to/figma-mcp-v2/dist/index.js
```

## How it reads files

| Source | Needs | Notes |
|---|---|---|
| **web** (default) | Nothing for files shared as "anyone with the link can view". `login` with a cookie for private files | Uses the same viewer protocol as figma.com in a browser. Includes variables and local styles on every plan. Rendering runs locally from the file's vector data. |
| **rest** | `FIGMA_TOKEN` (personal access token) | Official REST API: stable, and rendering happens on Figma's servers. Variables need an Enterprise plan. Used automatically when the web source fails. |
| **plugin** | The "Figma MCP Bridge" plugin running in the file | Full Plugin API. Required for edits. |

`source: "auto"` (the default for every read tool) tries web, then REST (if a token is set), then the plugin.

> The web source relies on Figma's internal viewer protocol, which is not a public API and can change.
> It never sends edits: it only asks the server for nodes, and Figma grants viewers read-only access
> anyway. If it breaks, set `FIGMA_TOKEN` and reads fall back to REST.

### Log in (optional, for private files)

```bash
npx -y figma-mcp-v2 login    # paste a personal access token and/or a figma.com cookie
npx -y figma-mcp-v2 status
npx -y figma-mcp-v2 logout
```

Credentials are saved to `~/.config/figma-mcp-v2/credentials.json`, readable only by you (mode 0600).
The environment variables `FIGMA_TOKEN` and `FIGMA_COOKIE` take precedence over them.

## Editing: the Figma plugin

Figma's REST API cannot edit layers, so edits go through a small development plugin that runs in
your own signed-in Figma. You don't share any credentials with the server.

1. Get the plugin onto your computer, in whichever way is easiest:
   - Ask your AI app to **"set up Figma"**. The `figma_install_plugin` tool copies the plugin to
     `~/figma-mcp-bridge-plugin`, puts the manifest path on your clipboard, and tells you where to
     paste it.
   - Or download **[figma-mcp-bridge-plugin.zip](https://github.com/LukasAnda/figma-mcp-v2/releases/latest/download/figma-mcp-bridge-plugin.zip)** and unzip it somewhere permanent.
   - Or run `npx -y figma-mcp-v2 plugin install`.
2. In Figma desktop, right-click the canvas and choose **Plugins → Development → Import plugin from
   manifest…**. In the file dialog, paste the path: **⌘⇧G, ⌘V, Return** on macOS; click the
   **File name** box, then **Ctrl+V, Enter** on Windows; **Ctrl+L, Ctrl+V, Enter** on Linux. You only need to do this once. When the
   server updates, it refreshes the copy in `~/figma-mcp-bridge-plugin` in place.
3. In the file you want to edit, run **Plugins → Development → Figma MCP Bridge**. The window
   shows *Connected* while your MCP client is running.

The plugin connects to `ws://localhost:3055`, and the server listens on 127.0.0.1 only. When several MCP clients
run at once, the first server hosts the bridge and the others relay through it. Each call goes to
the plugin window whose file matches the link you pass.

## Tools

### Reading (no plugin needed)

| Tool | What it returns |
|---|---|
| `figma_get_file` | Pages and their top-level frames and sections, with ids and sizes. Start here when the link has no node-id. |
| `figma_get_design` | A compact spec of a node: auto layout as flex (direction, gap, padding, alignment), sizing (fill/hug/fixed), fills, strokes, radius, shadows, typography and text, the component, variant and props of instances, bound variables by name, and which layers are assets. YAML by default, trimmed automatically to fit the context window. |
| `figma_get_screenshot` | PNG of a node, returned as an image and optionally saved. |
| `figma_get_code` | Reference code as React + Tailwind, React + CSS, or HTML + CSS. |
| `figma_get_metadata` | Layer outline, or search by name, type or text. |
| `figma_download_assets` | Icons as SVG, image fills in their original format, and explicit renders (png/jpg/svg/pdf at any scale). Identical files are saved once. |
| `figma_get_components` | Components and component sets with variants, property definitions, descriptions and usage counts. |
| `figma_get_variables` | Collections, modes and per-mode values, with aliases resolved by name. |
| `figma_get_styles` | Color, text, effect and grid styles with their values. |
| `figma_get_comments` | File comments (needs `FIGMA_TOKEN`). |
| `figma_get_fix_requests` | Open `#plsfix` comments: the request, who asked, the linked layer, the thread and the status. |
| `figma_export_tokens` | Variables as W3C Design Tokens (DTCG format 2025.10): one `.tokens.json` per collection and mode, plus a `.resolver.json` that switches themes. The output validates against the official schemas. Feed it to Style Dictionary to generate CSS, Swift or Kotlin. |

### Building and editing (via the plugin)

| Tool | What it does |
|---|---|
| `figma_build_layout` | Builds a whole nested tree in one call and returns a screenshot. The tree can contain:<br>• screens with auto layout (direction, gap, padding, alignment, fill/hug/fixed sizing)<br>• text with text styles and styled ranges<br>• SVG icons<br>• components, variant sets with component properties, and instances with variants, properties and overrides<br>• colors, spacing and radii bound to variables by name<br>• elements pinned to their parent's edges<br>• presentation **sections** and flow **arrows**<br><br>Anything Figma rejects comes back as a warning with the layer path; the build doesn't stop. |
| `figma_audit` | Design QA with node ids for every finding:<br>• WCAG 2.2 text contrast (4.5:1, large text 3:1) and non-text contrast (3:1)<br>• touch targets per platform (iOS 44 pt, Android 48 dp, web 24 px)<br>• colors not bound to a token, and text without a text style<br>• spacing off the 4 px grid, default layer names, and frames without auto layout |
| `figma_annotate` | Native Figma annotations (Interaction, Accessibility, Content…), with optional pinned properties such as padding, which developers see in Dev Mode. |
| `figma_set_dev_status` | Marks sections or frames *Ready for dev* or *Completed*. |
| `figma_bind_tokens` | Binds raw colors (fills, strokes, text ranges) to the variable whose value matches, so layers follow the design tokens. |
| `figma_create_theme_variant` | Clones screens as another theme. On paid plans it switches the variable mode; on plans with one mode per collection it rebinds every color to a same-named variable in another collection, such as "Tokens Dark". |
| `figma_anchor_nodes` | Pins existing layers to their parent's edges, for floating buttons, bottom sheets and toasts. |
| `figma_draw_arrows` | Draws connector arrows between screens or elements. |
| `figma_respond_to_fix_request` | Replies in a `#plsfix` thread as the bot account and sets the 👀/✅/❓ status reaction. |
| `figma_install_plugin` | Quickstart for the Figma plugin: copies it to `~/figma-mcp-bridge-plugin`, puts the manifest path on the clipboard, and returns the steps for macOS, Windows or Linux, including the file-dialog paste shortcut. |
| `figma_execute` | Runs Plugin API code for anything the other tools don't cover. Clients that honor tool annotations ask before running it. |

Single-layer tools: `figma_plugin_status`, `figma_get_selection`, `figma_create_node`,
`figma_update_node`, `figma_set_text`, `figma_delete_nodes`, `figma_clone_node`, `figma_move_node`,
`figma_group_nodes`, `figma_create_instance`, `figma_set_instance_properties`,
`figma_detach_instance`, `figma_create_component`, `figma_create_from_svg`, `figma_insert_image`,
`figma_select_nodes`, `figma_create_page`, `figma_create_variable_collection`,
`figma_create_variable`, `figma_set_variable_value`, `figma_bind_variable`, `figma_create_style`,
`figma_apply_style`, and `figma_post_comment` (REST, needs a token).

**Prompt:** `implement_figma_design(url, notes?)` walks the agent through screenshot → spec → assets →
implementation → visual comparison.

## Fix requests from Figma comments (#plsfix)

Write a comment in Figma that includes **#plsfix**, for example *"#plsfix the header needs 24px
top padding"* on a layer. The agent picks it up, fixes it, and answers in the thread:

| Reaction from the agent | Meaning |
|---|---|
| 👀 | Picked up, working on it |
| ✅ | Fixed. The reply says what changed |
| ❓ | Needs more information. The reply asks a question; answer with another #plsfix |

Design fixes are made in Figma through the plugin. If you run the agent inside a project that
implements the design, code fixes go there. Figma's API can't resolve comments, so you resolve
them after checking; resolved comments count as done.

**In a chat:** "fix the #plsfix comments in &lt;Figma link&gt;", or the `fix_figma_comments` prompt.

**Automatically:** `watch` polls the file and hands each new request to an agent, one at a time:

```bash
npx -y figma-mcp-v2 watch "https://www.figma.com/design/<fileKey>/<name>" \
  --exec "claude -p --allowedTools mcp__figma"     # any CLI agent that reads the task from stdin
```

Options: `--tag` (default `#plsfix`), `--interval` seconds (default 60), `--once`, and `--from`.
Comment text reaches an AI agent, so by default only **your own** comments are acted on (the
owner of `FIGMA_TOKEN`). Allow others with `--from alice,bob@example.com`, or everyone with
`--anyone`. Without `--exec`, `watch` only prints the requests.

**Replying as its own user:** create a separate free Figma account (for example "Claude"), invite
it to the file, and give its personal access token to `figma-mcp-v2 login` (bot account), the
Claude Desktop extension settings, or `FIGMA_BOT_TOKEN`. It needs the scopes `file_content:read`,
`file_comments:read` and `file_comments:write`. Without a bot token, replies come from your own
account.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FIGMA_TOKEN` | – | Personal access token (REST source, comments, private files) |
| `FIGMA_BOT_TOKEN` | – | Token of a separate Figma account that replies to #plsfix comments |
| `FIGMA_COOKIE` | – | figma.com cookie, for private files through the web source |
| `FIGMA_SOURCE` | auto | Force `web`, `rest` or `plugin` |
| `FIGMA_ASSETS_DIR` | `figma-assets` | Default output folder for `figma_download_assets` |
| `FIGMA_BRIDGE_PORT` | 3055 | Plugin bridge port (also change it in the plugin window) |
| `FIGMA_NO_BRIDGE` | – | `1` disables the plugin bridge |
| `FIGMA_MAX_OUTPUT_CHARS` | 60000 | Size at which design/code output gets trimmed |
| `FIGMA_WEB_PROTOCOL_VERSION` | 500 | Viewer protocol version sent to Figma |

## Fidelity and limits

- **Instances** are expanded the way Figma does it: overrides, nested instances, swaps,
  text/boolean/swap component properties, and Figma's own computed layout for each instance.
- **Local rendering** (web source) draws fills, gradients, images, strokes, corner clipping,
  masks, opacity, drop shadows and layer blur. Text is drawn from Figma's own glyph outlines.
  Masks are applied as clipping. Inner shadows, blend modes and background blur are not
  rendered. For pixel-exact output, use the REST source or the plugin.
- **PDF and JPG export** needs the REST source or the plugin; the web source exports SVG and PNG.
- **Mixed text styles** in one text layer are reported with the layer's base style.

## Security

- The bridge listens on 127.0.0.1 only and rejects browser connections from any origin other than
  Figma's plugin sandbox, so websites cannot drive your Figma.
- `figma_execute` runs arbitrary code in your open Figma file and is annotated as destructive.
- Credentials never leave your machine except in requests to figma.com.

## Development

```bash
npm install && npm test                                  # build + unit, bridge, plugin and end-to-end tests
npx tsx scripts/smoke.ts "<figma link with node-id>"     # read-only checks against a real file
npx tsx scripts/call.ts figma_get_design '{"url":"<link>"}'
npx @modelcontextprotocol/inspector node dist/index.js   # interactive
```

See [AGENTS.md](AGENTS.md) for the code layout. It is also linked from `CLAUDE.md` and `GEMINI.md`.

## License

MIT
