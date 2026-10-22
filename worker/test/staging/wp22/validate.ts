// Checks this harness's Wrangler configurations with the staging tool's own rules, without any
// cloud call:   node worker/test/staging/wp22/validate.ts
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWranglerConfig } from "../../../../scripts/staging/cloud.ts";
import { validateDeployConfig } from "../../../../scripts/staging/guard.ts";

const here = dirname(fileURLToPath(import.meta.url));
const worker = resolve(here, "..", "..", "..");
const ACCOUNT = "0".repeat(32);
const PLATFORM = "cfo-stg-wp22-platform";
let failures = 0;

function check(what: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok    ${what}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

check(`${PLATFORM}: the platform harness`, () => {
  validateDeployConfig(
    readWranglerConfig(join(here, "wrangler.platform.jsonc"), worker),
    ACCOUNT,
    PLATFORM,
  );
});
check("cfo-stg-wp22-web: the web Worker, bound cross-script to the platform harness", () => {
  const deployed = {
    name: PLATFORM,
    hostname: `${PLATFORM}.example.test`,
    owner: "WP2.2",
    createdAt: "2027-01-15T08:00:00.000Z",
    expiresAt: "2027-01-17T08:00:00.000Z",
    state: "deployed" as const,
  };
  validateDeployConfig(
    readWranglerConfig(join(here, "wrangler.web.jsonc"), worker),
    ACCOUNT,
    "cfo-stg-wp22-web",
    {
      registry: { owner: "WP2.2", deployments: [deployed] },
    },
  );
});
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
