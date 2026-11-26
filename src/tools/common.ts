import * as z from "zod/v4";
import { parseFigmaUrl, type FigmaTarget } from "../figma/url.js";

export const MAX_OUTPUT_CHARS = Number(process.env.FIGMA_MAX_OUTPUT_CHARS ?? 60_000);

export const urlField = z
  .string()
  .min(1)
  .describe(
    "Figma link, e.g. https://www.figma.com/design/<fileKey>/<name>?node-id=12-345 (right-click a layer > Copy link to selection). A bare file key also works."
  );

export const nodeIdField = z
  .string()
  .optional()
  .describe('Node id to use instead of the one in the link, e.g. "12:345", "12-345", or an instance sublayer "I12:345;67:89".');

export const sourceField = z
  .enum(["auto", "web", "rest", "plugin"])
  .default("auto")
  .describe(
    "Where to read from. auto (default): Figma's viewer protocol (no token, no Dev Mode), then the REST API if FIGMA_TOKEN is set, then the plugin. web/rest/plugin force one."
  );

export function target(url: string, nodeId?: string): FigmaTarget {
  return parseFigmaUrl(url, nodeId);
}

export function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

export function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
