# Using the figma-mcp-v2 tools

These tools read and edit Figma files. Users usually pass a Figma link; pass it as `url`.
A link with `node-id` points at one layer (right-click a layer in Figma > Copy link to selection).

## Implementing a design in code

1. `figma_get_screenshot` to see the frame, then `figma_get_design` for the exact spec: auto layout
   (direction, gap, padding, alignment), sizing (fill/hug/fixed), colors, typography, effects, and
   which component and variant each instance is.
2. Map Figma components and variables to the project's existing components and design tokens
   instead of hard-coding values. `figma_get_variables`, `figma_get_styles` and
   `figma_get_components` describe the design system.
3. `figma_download_assets` into the project's asset folder: icons as SVG, image fills in their
   original format, anything else as PNG.
4. `figma_get_code` gives a starting structure (React + Tailwind, React + CSS, or HTML + CSS);
   rewrite it in the project's conventions.
5. Compare the result with the screenshot and fix the differences.

Reading needs no Dev Mode and no token for files shared as "anyone with the link can view".

## Building or changing designs

Editing needs the "Figma MCP Bridge" plugin running in the file (`figma_plugin_status` checks it).
Only edit when the user asked for changes, and only in files they can edit.

- Build whole screens with `figma_build_layout` in one call, then look at the returned screenshot
  and fix what is wrong. Run `figma_audit` on the screens and fix errors before showing them. Use auto layout everywhere; size children with `fill`/`hug`.
- Make reusable parts components first (`type: "component"` / `"componentSet"` with variants and
  `componentProps`), then use instances in screens.
- Bind colors and spacing to variables (`bind`, or `figma_bind_tokens` afterwards) and text to text
  styles (`textStyle`). Then `figma_create_theme_variant` produces dark or brand variants.
- Pin floating elements (buttons over a navigation bar, bottom sheets) with `anchor`.
- Use each platform's own chrome: status bar, navigation, keyboard and controls differ between iOS
  and Android.
- Present work the way design teams do: one light grey `section` (e.g. #E4E6EB, dark text) per flow with a large title, a heading per
  state with short requirement bullets, the screens in columns, "←" notes beside them, and
  `arrow`s for navigation between screens. Keep components on their own page, grouped in sections
  (foundations, icons, controls, platform chrome) so nothing overlaps.

## Standards to apply

- Contrast (WCAG 2.2): text 4.5:1, large text (24px, or 18.66px bold) 3:1, icons and control
  outlines 3:1. Check both themes. `figma_audit` computes it against the actual background.
- Touch targets: iOS 44×44 pt (Apple HIG), Android 48×48 dp (Material), web at least 24×24 px
  (WCAG 2.5.8). A small checkbox is fine when the whole row is the tap target; say so in an
  annotation.
- Spacing on a 4/8 grid. Type from a defined scale: iOS Dynamic Type (Body 17/22, Headline 17/22
  semibold, Title 2 22/28, Large Title 34/41…) or the Material 3 scale (Body large 16/24, Title
  large 22/28, Headline small 24/32…), or the project's own text styles.
- Tokens: primitives, then semantic names by role (`text/secondary`, not `grey-500`); light and
  dark as modes, or as two collections with identical names on plans with one mode.
  `figma_export_tokens` writes them as W3C design tokens.
- Handoff: native annotations (`figma_annotate`) for behavior and accessibility notes,
  `figma_set_dev_status` READY_FOR_DEV on finished sections, and run `figma_audit` before
  handing off.
