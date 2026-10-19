// Checks spikes/s2/wrangler.jsonc with the staging tool's own rules, without any cloud call.
//   node spikes/s2/scripts/validate_config.ts
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWranglerConfig } from "../../../scripts/staging/cloud.ts";
import { validateDeployConfig } from "../../../scripts/staging/guard.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const view = readWranglerConfig(join(root, "spikes/s2/wrangler.jsonc"), join(root, "worker"));
// A syntactically valid placeholder account: the check compares it only with the config's own.
validateDeployConfig(view, "0".repeat(32), "cfo-stg-s2-route");
console.log("spikes/s2/wrangler.jsonc passes the staging tool's config rules");
