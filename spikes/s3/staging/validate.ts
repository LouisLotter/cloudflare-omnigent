// Checks spikes/s3/staging/wrangler.jsonc with the staging tool's own guard,
// without contacting Cloudflare. Run from the repository root:
//   node spikes/s3/staging/validate.ts
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWranglerConfig } from "../../../scripts/staging/cloud.ts";
import { resourceName, validateDeployConfig } from "../../../scripts/staging/guard.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const view = readWranglerConfig(join(here, "wrangler.jsonc"), join(root, "worker"));
validateDeployConfig(view, "staging-account-placeholder", resourceName("s3-capture"));
console.log(`ok: ${view.path} passes the staging guard for ${resourceName("s3-capture")}`);
