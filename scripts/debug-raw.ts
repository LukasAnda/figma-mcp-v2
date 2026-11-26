import { webSession, closeAllWebSessions } from "../src/web/client.js";
import { GraphConverter } from "../src/web/convert.js";
const [fileKey, nodeId, ...ids] = process.argv.slice(2);
const s = webSession(fileKey);
await s.ensurePageOf(nodeId);
for (let i = 0; i < 6; i++) { const m = new GraphConverter(s.graph).missingMasters([nodeId]); if (!m.length) break; await s.ensureNodes(m); }
const j = (v: unknown) => JSON.stringify(v, (k, x) => (x instanceof Uint8Array ? `<${x.length}b>` : typeof x === "bigint" ? String(x) : x), 1);
for (const id of ids) { const n = s.graph.get(id); console.log("=====", id, j(n)?.slice(0, Number(process.env.LIMIT ?? 4000))); }
closeAllWebSessions();
