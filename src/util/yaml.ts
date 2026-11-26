/** Minimal YAML emitter for plain JSON data. Compact output for LLM context; not a full YAML implementation. */

const PLAIN = /^[A-Za-z_][\w .\/#()%,+-]*$/;
const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "~", ""]);

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  if (PLAIN.test(s) && !RESERVED.has(s.toLowerCase()) && !/^[\d.+-]/.test(s) && !s.includes(": ") && !s.endsWith(":") && !s.includes(" #") && s.trim() === s) return s;
  return JSON.stringify(s);
}

function key(k: string): string {
  return /^[A-Za-z_][\w-]*$/.test(k) ? k : JSON.stringify(k);
}

function isScalar(v: unknown): boolean {
  return v === null || v === undefined || typeof v !== "object";
}

function emit(v: unknown, indent: string, lines: string[], prefix: string): void {
  if (isScalar(v)) {
    lines.push(`${prefix}${scalar(v)}`);
    return;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) {
      lines.push(`${prefix}[]`);
      return;
    }
    if (v.every(isScalar) && v.length <= 12) {
      lines.push(`${prefix}[${v.map(scalar).join(", ")}]`);
      return;
    }
    if (prefix.trim()) lines.push(prefix.trimEnd());
    for (const item of v) {
      if (isScalar(item)) lines.push(`${indent}- ${scalar(item)}`);
      else emitObjectOrArrayItem(item, indent, lines);
    }
    return;
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  if (entries.length === 0) {
    lines.push(`${prefix}{}`);
    return;
  }
  if (prefix.trim()) lines.push(prefix.trimEnd());
  for (const [k, x] of entries) emit(x, indent + "  ", lines, `${indent}${key(k)}: `);
}

function emitObjectOrArrayItem(item: unknown, indent: string, lines: string[]): void {
  if (Array.isArray(item)) {
    emit(item, indent + "  ", lines, `${indent}- `);
    return;
  }
  const entries = Object.entries(item as Record<string, unknown>).filter(([, x]) => x !== undefined);
  if (entries.length === 0) {
    lines.push(`${indent}- {}`);
    return;
  }
  entries.forEach(([k, x], i) => {
    const p = i === 0 ? `${indent}- ${key(k)}: ` : `${indent}  ${key(k)}: `;
    emit(x, indent + "    ", lines, p);
  });
}

export function toYaml(v: unknown): string {
  const lines: string[] = [];
  if (isScalar(v) || Array.isArray(v)) emit(v, "", lines, "");
  else for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined) emit(x, "  ", lines, `${key(k)}: `);
  return lines.join("\n");
}
