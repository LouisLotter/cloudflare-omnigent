// Checks this harness's Wrangler configurations with the staging tool's own rules, without any
// cloud call:   node worker/test/staging/wp33/validate.ts
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWranglerConfig } from "../../../../scripts/staging/cloud.ts";
import { validateDeployConfig } from "../../../../scripts/staging/guard.ts";

const here = dirname(fileURLToPath(import.meta.url));
const worker = resolve(here, "..", "..", "..");
const ACCOUNT = "0".repeat(32);
let failures = 0;

for (const [file, name] of [
  ["wrangler.platform.jsonc", "cfo-stg-wp33-platform"],
  ["wrangler.bench.jsonc", "cfo-stg-wp33-bench"],
  ["wrangler.final.jsonc", "cfo-stg-wp33-final"],
] as const) {
  try {
    validateDeployConfig(readWranglerConfig(join(here, file), worker), ACCOUNT, name);
    console.log(`ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
