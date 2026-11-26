/**
 * Figma variables -> W3C Design Tokens Community Group format 2025.10
 * (https://www.designtokens.org/tr/2025.10/): one token file per collection and mode, plus a
 * resolver document whose modifiers switch modes (e.g. theme: light/dark).
 */

export interface VariableData {
  collections: { id?: string; name: string; modes?: unknown }[];
  variables: {
    id?: string;
    name: string;
    collection: string;
    type?: string;
    description?: string;
    values: Record<string, unknown>;
    scopes?: string[];
    codeSyntax?: Record<string, string>;
  }[];
}

export interface DtcgOptions {
  /** Name of the design system, used for the resolver file name. */
  name: string;
  /**
   * Collections that are alternatives of each other (on plans with one mode per collection, a light
   * and a dark collection with the same variable names). They become contexts of one modifier.
   */
  themeCollections?: string[];
  themeModifier?: string;
}

export interface DtcgOutput {
  files: Record<string, unknown>;
  resolverPath: string;
  stats: { tokens: number; collections: number; files: number; aliases: number; skipped: string[] };
}

const slug = (s: string) => s.normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "x";
// DTCG names can't contain "{", "}" or "." or start with "$".
const segment = (s: string) => s.trim().replace(/[{}.]/g, "_").replace(/^\$/, "_");
const path = (name: string) => name.split("/").map(segment).filter(Boolean);

const SPATIAL_SCOPES = new Set(["GAP", "WIDTH_HEIGHT", "CORNER_RADIUS", "STROKE_FLOAT", "FONT_SIZE", "LINE_HEIGHT", "LETTER_SPACING", "PARAGRAPH_SPACING", "PARAGRAPH_INDENT", "EFFECT_FLOAT"]);
const SPATIAL_NAME = /(^|\/)(space|spacing|gap|padding|margin|radius|radii|size|sizes|width|height|border-width|stroke)(\/|$|-)/i;

export function parseColor(v: string): { components: [number, number, number]; alpha: number; hex: string } | null {
  const s = v.trim();
  let r: number, g: number, b: number, a = 1;
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (hex) {
    r = parseInt(hex[1].slice(0, 2), 16);
    g = parseInt(hex[1].slice(2, 4), 16);
    b = parseInt(hex[1].slice(4, 6), 16);
    if (hex[2]) a = parseInt(hex[2], 16) / 255;
  } else if (fn) {
    const p = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    [r, g, b] = p;
    if (p.length > 3) a = p[3];
  } else return null;
  const h = (x: number) => Math.round(x).toString(16).padStart(2, "0");
  const round = (x: number) => Math.round(x * 10000) / 10000;
  return { components: [round(r / 255), round(g / 255), round(b / 255)], alpha: round(a), hex: `#${h(r)}${h(g)}${h(b)}` };
}

function modeNames(c: VariableData["collections"][number], vars: VariableData["variables"]): string[] {
  const m = c.modes as unknown;
  if (Array.isArray(m) && m.length) return m.map((x) => (typeof x === "string" ? x : (x as { name: string }).name));
  const set = new Set<string>();
  for (const v of vars) if (v.collection === c.name) for (const k of Object.keys(v.values)) set.add(k);
  return [...set];
}

export function toDtcg(data: VariableData, opts: DtcgOptions): DtcgOutput {
  const themed = (opts.themeCollections ?? []).filter((n) => data.collections.some((c) => c.name === n));
  if (themed.length >= 2) {
    // Tokens that only some alternative collections define (e.g. spacing kept in the light collection)
    // don't vary by theme: move them to a shared base collection that every theme gets.
    const namesIn = themed.map((c) => new Set(data.variables.filter((v) => v.collection === c).map((v) => v.name)));
    const shared = new Set([...namesIn[0]].filter((n) => namesIn.every((s) => s.has(n))));
    const baseName = `${themed[0]} base`;
    const seen = new Set<string>();
    const variables = data.variables.flatMap((v) => {
      if (!themed.includes(v.collection) || shared.has(v.name)) return [v];
      if (seen.has(v.name)) return [];
      seen.add(v.name);
      const [only] = Object.values(v.values).length ? [Object.values(v.values)[0]] : [undefined];
      return [{ ...v, collection: baseName, values: { Value: only } }];
    });
    if (seen.size) {
      data = { collections: [{ name: baseName, modes: [{ name: "Value" }] }, ...data.collections], variables };
    }
  }
  return convert(data, opts);
}

function convert(data: VariableData, opts: DtcgOptions): DtcgOutput {
  const files: Record<string, unknown> = {};
  const skipped: string[] = [];
  let tokens = 0, aliases = 0;
  const sets: Record<string, unknown> = {};
  const modifiers: Record<string, unknown> = {};
  const order: { $ref: string }[] = [];
  const theme = new Set(opts.themeCollections ?? []);
  const themeContexts: Record<string, { $ref: string }[]> = {};
  let themeDefault: string | undefined;

  for (const c of data.collections) {
    const vars = data.variables.filter((v) => v.collection === c.name);
    if (!vars.length) continue;
    const modes = modeNames(c, vars);
    const fileFor: Record<string, string> = {};
    for (const mode of modes) {
      const root: Record<string, unknown> = {};
      for (const v of vars) {
        if (!(mode in v.values)) continue;
        const raw = v.values[mode];
        const token: Record<string, unknown> = {};
        const alias = raw && typeof raw === "object" && "alias" in (raw as object) ? String((raw as { alias: string }).alias) : undefined;
        const kind = (v.type ?? "").toUpperCase();
        if (alias) {
          token.$value = `{${path(alias).join(".")}}`;
          aliases++;
        }
        if (kind === "COLOR") {
          token.$type = "color";
          if (!alias) {
            const col = typeof raw === "string" ? parseColor(raw) : null;
            if (!col) { skipped.push(`${c.name}/${v.name} (${mode}): unreadable color ${JSON.stringify(raw)}`); continue; }
            token.$value = { colorSpace: "srgb", components: col.components, alpha: col.alpha, hex: col.hex };
          }
        } else if (kind === "FLOAT" || typeof raw === "number") {
          const spatial = (v.scopes ?? []).some((s) => SPATIAL_SCOPES.has(s)) || SPATIAL_NAME.test(v.name);
          token.$type = spatial ? "dimension" : "number";
          if (!alias) token.$value = spatial ? { value: raw, unit: "px" } : raw;
        } else if (kind === "BOOLEAN" || typeof raw === "boolean") {
          // DTCG has no boolean type; Figma's importer reads number + com.figma.type.
          token.$type = "number";
          if (!alias) token.$value = raw ? 1 : 0;
          token.$extensions = { "com.figma.type": "boolean" };
        } else {
          const isFont = (v.scopes ?? []).includes("FONT_FAMILY");
          if (isFont) token.$type = "fontFamily";
          else token.$extensions = { "com.figma.type": "string" };
          if (!alias) token.$value = raw;
        }
        if (v.description) token.$description = v.description;
        const fig: Record<string, unknown> = {};
        if (v.scopes?.length && !(v.scopes.length === 1 && v.scopes[0] === "ALL_SCOPES")) fig.scopes = v.scopes;
        if (v.codeSyntax && Object.keys(v.codeSyntax).length) fig.codeSyntax = v.codeSyntax;
        if (Object.keys(fig).length) token.$extensions = { ...(token.$extensions as object), "com.figma": fig };
        let node = root;
        const parts = path(v.name);
        for (const p of parts.slice(0, -1)) {
          const next = node[p];
          if (next && typeof next === "object" && "$value" in (next as object)) {
            // A token and a group share a name ("color/ink" and "color/ink/soft"): DTCG's $root.
            node[p] = { $root: next };
          }
          node = (node[p] ??= {}) as Record<string, unknown>;
        }
        const leaf = parts[parts.length - 1];
        if (node[leaf] && typeof node[leaf] === "object" && !("$value" in (node[leaf] as object))) (node[leaf] as Record<string, unknown>).$root = token;
        else node[leaf] = token;
        tokens++;
      }
      const file = `${slug(c.name)}/${slug(mode)}.tokens.json`;
      files[file] = root;
      fileFor[mode] = file;
    }
    if (theme.has(c.name) && modes.length === 1) {
      themeContexts[slug(c.name)] = [{ $ref: fileFor[modes[0]] }];
      themeDefault ??= slug(c.name);
    } else if (modes.length === 1) {
      sets[slug(c.name)] = { description: `${c.name} (Figma collection)`, sources: [{ $ref: fileFor[modes[0]] }] };
      order.push({ $ref: `#/sets/${slug(c.name)}` });
    } else {
      modifiers[slug(c.name)] = {
        description: `${c.name} modes`,
        contexts: Object.fromEntries(modes.map((m) => [slug(m), [{ $ref: fileFor[m] }]])),
        default: slug(modes[0])
      };
      order.push({ $ref: `#/modifiers/${slug(c.name)}` });
    }
  }
  if (Object.keys(themeContexts).length >= 2) {
    const key = opts.themeModifier ?? "theme";
    modifiers[key] = { description: `Alternative collections: ${[...theme].join(", ")}`, contexts: themeContexts, default: themeDefault };
    order.push({ $ref: `#/modifiers/${key}` });
  } else if (Object.keys(themeContexts).length === 1) {
    const [k, v] = Object.entries(themeContexts)[0];
    sets[k] = { sources: v };
    order.unshift({ $ref: `#/sets/${k}` });
  }
  const resolverPath = `${slug(opts.name)}.resolver.json`;
  files[resolverPath] = {
    $schema: "https://www.designtokens.org/schemas/2025.10/resolver.json",
    name: opts.name,
    version: "2025.10",
    description: "Exported from Figma variables by figma-mcp-v2",
    ...(Object.keys(sets).length ? { sets } : {}),
    ...(Object.keys(modifiers).length ? { modifiers } : {}),
    resolutionOrder: order
  };
  return { files, resolverPath, stats: { tokens, collections: data.collections.length, files: Object.keys(files).length, aliases, skipped } };
}
