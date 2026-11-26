# AGENTS.md

Guidance for coding agents working on this repository (Claude Code, Gemini CLI, Codex, Cursor,
and others). For using the tools in a design task, see CONTEXT.md.

## What this is

An MCP server (stdio) that reads Figma files without Dev Mode and edits them through a companion
Figma plugin. TypeScript, Node 20+, MCP TypeScript SDK v2 (`@modelcontextprotocol/server`), zod v4.

## Commands

```bash
npm install          # also builds (prepare runs tsc)
npm run build        # tsc -> dist/
npm test             # unit, bridge, plugin (mocked Figma) and MCP end-to-end tests
npx tsx scripts/smoke.ts "<figma link with node-id>"   # read-only checks against a real file
npx tsx scripts/call.ts <tool> '<json args>' [image.png] # call one tool on the built server
```

Run `npm run build && npm test` before finishing a change.

## Layout

- `src/index.ts`: server, instructions, prompt, CLI (`login`, `status`, `logout`, `plugin`).
- `src/tools/read.ts`, `src/tools/write.ts`: tool definitions. Write tools forward to the plugin.
- `src/source.ts`: picks a read source (web viewer protocol, REST, plugin).
- `src/web/`: anonymous viewer-protocol client (`client.ts`) and kiwi scene-graph -> REST-shaped
  JSON converter (`convert.ts`), including instance expansion with overrides.
- `src/figma/`: URL parsing, REST client, the design simplifier and code generator.
- `src/plugin-setup.ts`: copies the Figma plugin to a stable folder and refreshes it on updates.
- `mcpb/`: Claude Desktop extension manifest and icon; `scripts/build-bundles.mjs` packs it with
  production dependencies and resvg binaries for every platform.
- `src/comments.ts`: #plsfix threads as conversations (latest human message is the request; status
  via the bot account's reactions; Figma's API can't resolve comments).
- `src/watch.ts`: the polling watcher and agent presets (claude/gemini/codex/notify);
  `src/watch-service.ts`: starts it at login (launchd, systemd/XDG autostart, Windows Startup).
- `src/tokens/dtcg.ts`: Figma variables -> W3C DTCG 2025.10 token files and resolver.
- `src/render/`: local SVG renderer and PNG rasterizing in a child process (resvg can panic).
- `src/bridge/bridge.ts`: WebSocket hub on 127.0.0.1:3055; extra server processes relay through
  the first one; calls are routed to the plugin window whose file key matches.
- `plugin/`: the Figma plugin (`code.js` runs in Figma, `ui.html` holds the WebSocket). Plain JS,
  no build step. `build_layout`, `audit` (WCAG contrast, targets, tokens, grid), annotations, dev
  status and the token/theme/anchor/arrow commands live here.
- `test/`: node:test suites. `plugin-*.test.ts` run `plugin/code.js` in a VM with a mocked
  `figma` global that enforces the auto-layout sizing rules.

## Releasing

```bash
npm version patch   # or minor / major: bumps package.json and syncs the version into the
                    # Claude plugin, Gemini extension, server and Figma plugin, then commits and tags
git push --follow-tags
```

The `Release` workflow tests and publishes the tag to npm (trusted publishing, with provenance),
builds the Claude Desktop extension (`figma-mcp-v2.mcpb`) and the Figma plugin zip with
`npm run bundle`, and attaches both to a GitHub release. Never publish from a laptop except for the very first version.

Browser login: the release writes `src/oauth-app.ts` from the secrets `FIGMA_OAUTH_CLIENT_ID` /
`FIGMA_OAUTH_CLIENT_SECRET` (scripts/inject-oauth-app.mjs). Never commit real values to that file.

User-facing text (tool results, errors, README quick start) must not require a terminal: point to
something the user can say in chat ("set up Figma", "log me in to Figma").

Signing the Claude Desktop extension is optional. When the repository secrets `MCPB_SIGNING_CERT`
and `MCPB_SIGNING_KEY` (PEM text, plus `MCPB_SIGNING_CHAIN` for intermediates) are set, the
release runs `mcpb sign` and `mcpb verify`. Claude Desktop treats a bundle as verified only when
the certificate chains to a root in the OS trust store; a self-signed certificate signs but shows
as unverified.

## Rules

- Never send edits through the web source; it is read-only by design.
- Plugin changes: `code.js` runs unbundled in Figma's plugin sandbox, so keep it plain JavaScript
  without imports or top-level await. Add a mocked test for every new command.
- Figma reloads a development plugin when `code.js` changes, which drops the bridge connection
  briefly; the UI reconnects on its own.
- Don't commit credentials. `figma-mcp-v2 login` stores them in `~/.config/figma-mcp-v2/`.
