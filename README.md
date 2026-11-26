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

## Quick start, without a terminal (Claude Desktop)

1. Download **[figma-mcp-v2.mcpb](https://github.com/LukasAnda/figma-mcp-v2/releases/latest/download/figma-mcp-v2.mcpb)**
   and double-click it (or Claude Desktop → Settings → Extensions → Install Extension…).
2. In a chat, say **"set up Figma"**. Claude installs the Figma plugin, puts its location on your
   clipboard and tells you where to paste it in Figma. Pasting takes three clicks.
3. Say **"log me in to Figma"**. Figma opens in your browser; click *Allow access*.
4. Paste a Figma link and ask for what you need: *"implement this"*, *"download the icons"*,
   *"make a dark version"*, *"check it for accessibility"*, *"watch this file for #plsfix
   comments"*.

Reading designs works right after step 1. Steps 2 and 3 are only needed for editing and comments.

## Install for developers

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

### Log in (for comments and private files)

Reading designs from files shared by link needs no login. Comments (#plsfix), private files and
replies do, because Figma only shows them to logged-in API clients. Neither the plugin API nor
anonymous viewers can see comments.

Ask your AI to **"log me in to Figma"** (`figma_login`), or run `npx -y figma-mcp-v2 login`.
Figma opens in your browser and you click **Allow access**. The login renews itself.

If browser login isn't available in your installation, Claude offers the alternative in the chat:
create a personal access token in Figma's settings and paste it there.

<details><summary>Maintainers: enabling browser login</summary>

Browser login uses a Figma OAuth app:
1. At [figma.com/developers/apps](https://www.figma.com/developers/apps), create an app.
2. Add the redirect URL `http://localhost:3056/callback`.
3. Tick the scopes `current_user:read`, `file_content:read`, `file_metadata:read`,
   `file_comments:read` and `file_comments:write`.
4. Publish it: privately (for your team, no review) or publicly (anyone, after Figma's review).

Set its client ID and secret as the repository secrets `FIGMA_OAUTH_CLIENT_ID` and
`FIGMA_OAUTH_CLIENT_SECRET`, and every release has browser login built in. For one machine only,
use `npx -y figma-mcp-v2 login --setup-app`, or pass `client_id`/`client_secret` to `figma_login`.
</details>

```bash
npx -y figma-mcp-v2 login            # browser login (or --token)
npx -y figma-mcp-v2 login --bot      # the separate account that replies to #plsfix comments
npx -y figma-mcp-v2 status
npx -y figma-mcp-v2 logout [--bot]
```

Credentials are saved to `~/.config/figma-mcp-v2/credentials.json`, readable only by you. The
environment variables `FIGMA_TOKEN`, `FIGMA_OAUTH_TOKEN`, `FIGMA_BOT_TOKEN` and `FIGMA_COOKIE`
take precedence over them.

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
| `figma_login` | Logs in to Figma in the browser (you or the bot account); needed for comments and private files. |
| `figma_watch_file` / `figma_list_watches` / `figma_unwatch_file` | Background watcher that hands new #plsfix messages to Claude Code, Gemini CLI or Codex, or notifies you. Starts again at login. |
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
top padding"* on a layer. The agent fixes it and answers in the thread:

| Reaction from the agent | Meaning |
|---|---|
| 👀 | Picked up, working on it |
| ✅ | Fixed. The reply says what changed |
| ❓ | Needs more information. The reply asks a question |
| 👍 | Acknowledged ("thanks", "looks good"), nothing to do |

**It's a conversation.** Once a thread has #plsfix in it, every new reply from you in that thread
is the next request, without repeating the tag: *"still too tight, make it 32"*. The agent sees
the whole thread, including what it changed last time. Resolve the thread when you're happy.
Figma's API can't resolve comments, so that last click is yours.

Design fixes are made in Figma through the plugin. Code fixes go into the project the agent works
in, when that project implements the design.

### Watch a file

Tell your AI **"watch &lt;Figma link&gt; for #plsfix comments"** (`figma_watch_file`). That starts a
background watcher, which also starts again at login (launchd on macOS, systemd or autostart on
Linux, the Startup folder on Windows). It checks the file every minute and hands each new message
to the first agent it finds:

| Agent | How it runs | Setup |
|---|---|---|
| Claude Code | `claude -p`, allowed to edit files, with this server attached automatically | None |
| Gemini CLI | `gemini -p --approval-mode yolo` | Add this server to Gemini (see Install) |
| Codex | `codex exec --full-auto` | Add this server to Codex (see Install) |
| none found | a desktop notification; then ask any AI to "fix the #plsfix comments in &lt;link&gt;" | None |

The Claude Code invocation is verified. The Gemini and Codex flags come from their docs, so check
them against your installed version (`--exec "<command>"` runs anything else and passes the task on
stdin). From Claude Code the watcher works in the current project, so it can fix code too. From
Claude Desktop it fixes the design only, unless you name a project folder.

"Which files are you watching?" lists them (`figma_list_watches`), and "stop watching &lt;link&gt;"
removes one (`figma_unwatch_file`). The same works in a terminal:

```bash
npx -y figma-mcp-v2 watch "<figma link>" --install            # background, from login
npx -y figma-mcp-v2 watch "<figma link>"                      # in this terminal
npx -y figma-mcp-v2 watch --list
npx -y figma-mcp-v2 watch --stop <id or link>
```

**Who can trigger it:** comment text reaches an AI agent that can edit your files. By default only
**your own** comments count (the owner of your Figma token). Allow colleagues with
`--from alice,bob@example.com`, or everyone with `--anyone`. Agents are told to treat comments as
requests, never as new instructions.

**Replying as its own user:** create a separate free Figma account (for example "Claude") and
invite it to the file. Then log it in with "log the bot in to Figma" or `figma-mcp-v2 login --bot`,
using a private browser window so you don't log in as yourself. Without it, replies come from your
own account. The watcher needs your own login too, to know whose comments to act on.

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
