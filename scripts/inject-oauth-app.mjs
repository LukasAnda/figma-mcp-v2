// Release step: writes the OAuth app credentials from the environment into src/oauth-app.ts so the
// published package offers browser login out of the box. No-op without the secrets.
import { writeFileSync } from "node:fs";

const id = process.env.FIGMA_OAUTH_CLIENT_ID ?? "";
const secret = process.env.FIGMA_OAUTH_CLIENT_SECRET ?? "";
if (!id || !secret) {
  console.log("FIGMA_OAUTH_CLIENT_ID/SECRET not set: browser login needs setup on each machine.");
  process.exit(0);
}
writeFileSync(
  "src/oauth-app.ts",
  `// Generated at release time by scripts/inject-oauth-app.mjs.\nexport const BUILT_IN_APP = { clientId: ${JSON.stringify(id)}, clientSecret: ${JSON.stringify(secret)} };\n`
);
console.log("Built-in OAuth app set.");
