/**
 * Parses Figma links into the file key and node id the REST API and plugin need.
 *
 * Handles:
 *   https://www.figma.com/design/<key>/<name>?node-id=12-345
 *   https://www.figma.com/file/<key>/<name>?node-id=12%3A345
 *   https://www.figma.com/design/<key>/branch/<branchKey>/<name>
 *   https://www.figma.com/proto/<key>/<name>?node-id=...
 *   https://www.figma.com/board/<key>/...   (FigJam)
 *   https://www.figma.com/slides/<key>/...
 *   https://www.figma.com/make/<key>/...
 *   a bare file key, optionally with a node id passed separately
 */

export interface FigmaTarget {
  /** File key to send to the REST API (the branch key when the link points at a branch). */
  fileKey: string;
  /** The main file key, even when the link points at a branch. */
  mainFileKey: string;
  branchKey?: string;
  /** Node id in API form ("12:345"), when the link selects a node. */
  nodeId?: string;
  kind: "design" | "file" | "proto" | "board" | "slides" | "make" | "site" | "key";
  fileName?: string;
}

const KINDS = new Set(["design", "file", "proto", "board", "slides", "make", "site", "deck"]);

/** "12-345" / "12%3A345" / "12:345" / "I12:3;4:5" -> API node id. */
export function normalizeNodeId(raw: string): string {
  const decoded = decodeURIComponent(raw.trim());
  // Instance-sublayer ids look like "I12:3;4:5" and keep their colons. Link form uses dashes.
  if (decoded.includes(":")) return decoded;
  return decoded.replace(/-/g, ":");
}

export function parseFigmaUrl(input: string, nodeIdOverride?: string): FigmaTarget {
  const value = input.trim();
  if (!value) throw new Error("Empty Figma link. Pass a link like https://www.figma.com/design/<fileKey>/<name>?node-id=1-2");

  // Bare file key
  if (/^[A-Za-z0-9]{10,}$/.test(value)) {
    return {
      fileKey: value,
      mainFileKey: value,
      kind: "key",
      ...(nodeIdOverride ? { nodeId: normalizeNodeId(nodeIdOverride) } : {})
    };
  }

  let url: URL;
  try {
    url = new URL(value.startsWith("http") ? value : `https://${value}`);
  } catch {
    throw new Error(`Not a Figma link or file key: "${value}". Expected https://www.figma.com/design/<fileKey>/...`);
  }
  if (!/(^|\.)figma\.com$/.test(url.hostname)) {
    throw new Error(`"${url.hostname}" is not figma.com. Pass a link copied from Figma (Share > Copy link, or right-click a layer > Copy link).`);
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const kindIdx = parts.findIndex((p) => KINDS.has(p));
  if (kindIdx === -1 || !parts[kindIdx + 1]) {
    throw new Error(`Could not find a file key in "${value}". Expected a path like /design/<fileKey>/<name>.`);
  }
  const rawKind = parts[kindIdx];
  const kind = (rawKind === "deck" ? "slides" : rawKind) as FigmaTarget["kind"];
  const mainFileKey = parts[kindIdx + 1];
  let branchKey: string | undefined;
  let nameIdx = kindIdx + 2;
  if (parts[kindIdx + 2] === "branch" && parts[kindIdx + 3]) {
    branchKey = parts[kindIdx + 3];
    nameIdx = kindIdx + 4;
  }
  const fileName = parts[nameIdx] ? decodeURIComponent(parts[nameIdx]).replace(/-/g, " ") : undefined;

  const rawNode = nodeIdOverride ?? url.searchParams.get("node-id") ?? undefined;
  return {
    fileKey: branchKey ?? mainFileKey,
    mainFileKey,
    kind,
    ...(branchKey ? { branchKey } : {}),
    ...(rawNode ? { nodeId: normalizeNodeId(rawNode) } : {}),
    ...(fileName ? { fileName } : {})
  };
}

/** Builds a link back to a node, for showing to the user. */
export function nodeUrl(fileKey: string, nodeId: string): string {
  return `https://www.figma.com/design/${fileKey}/?node-id=${encodeURIComponent(nodeId.replace(/:/g, "-"))}`;
}
