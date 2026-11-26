/**
 * Child process that rasterizes one SVG with resvg. resvg can abort the whole process on some
 * inputs (a Rust panic), so the MCP server never runs it in-process.
 * stdin: JSON {svg, scale}; stdout: PNG bytes.
 */
import { Resvg } from "@resvg/resvg-js";

const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", () => {
  const { svg, scale } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { svg: string; scale: number };
  const r = new Resvg(svg, { fitTo: { mode: "zoom", value: scale }, font: { loadSystemFonts: true }, shapeRendering: 2, textRendering: 1, imageRendering: 0 });
  process.stdout.write(Buffer.from(r.render().asPng()));
});
