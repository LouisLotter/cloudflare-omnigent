// Checks this harness's Wrangler configuration with the staging tool's own rules, without any
// cloud call:   node worker/test/staging/wp26/validate.ts
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWranglerConfig } from "../../../../scripts/staging/cloud.ts";
import { validateDeployConfig } from "../../../../scripts/staging/guard.ts";

const here = dirname(fileURLToPath(import.meta.url));
const worker = resolve(here, "..", "..", "..");
try {
  validateDeployConfig(
    readWranglerConfig(join(here, "wrangler.jsonc"), worker),
    "0".repeat(32),
    "cfo-stg-wp26-restore",
  );
  console.log("ok    cfo-stg-wp26-restore: the restore harness");
} catch (error) {
  console.log(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
