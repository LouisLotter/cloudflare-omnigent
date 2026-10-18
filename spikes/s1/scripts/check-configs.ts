// Runs the staging tool's own local configuration checks on S1's Wrangler configurations,
// without touching Cloudflare: the same validateDeployConfig that `pnpm stg deploy` runs first.
//
//   node spikes/s1/scripts/check-configs.ts

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWranglerConfig } from "../../../scripts/staging/cloud.ts";
import { validateDeployConfig } from "../../../scripts/staging/guard.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const worker = join(root, "worker");
// A syntactically valid placeholder; the check only compares it with the config's account_id.
const account = "0".repeat(32);
const configs: [string, string][] = [
  ["spikes/s1/wrangler.jsonc", "cfo-stg-s1-life"],
  ["spikes/s1/wrangler-dopolicy.jsonc", "cfo-stg-s1-dop"],
];
for (const [path, name] of configs) {
  validateDeployConfig(readWranglerConfig(join(root, path), worker), account, name);
  console.log(`${path}: accepted for ${name}`);
}
