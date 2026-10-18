// Teardown check: no Access application and no Worker is left on the S1 hostnames. Read-only;
// prints counts only, with the zone and account kept out of the output.
//
//   node spikes/s1/scripts/access-check.mjs [deployment names...]

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const state =
  process.env.CFO_STAGING_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cloudflare-omnigent", "staging");
const cfg = JSON.parse(readFileSync(join(state, "config.json"), "utf8"));
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: cfg.accountId };
const names = process.argv.slice(2);
for (const name of names.length > 0 ? names : ["cfo-stg-s1-life", "cfo-stg-s1-dop"]) {
  const host = `${name}.${cfg.zone}`;
  const apps = spawnSync(
    "cf",
    ["zero-trust", "access", "applications", "list", "--domain", host, "--exact"],
    { encoding: "utf8", env },
  );
  const parsed = JSON.parse(apps.stdout || "[]");
  const list = parsed.result ?? parsed;
  const worker = spawnSync("cf", ["workers", "get", name], { encoding: "utf8", env });
  const workerState =
    worker.status === 0
      ? "exists"
      : worker.stderr.includes("[10007]")
        ? "absent ([10007] 404)"
        : `unknown: ${worker.stderr.split("\n")[0]}`;
  console.log(
    `${name}.<zone>: Access applications=${Array.isArray(list) ? list.length : "?"}, Worker ${workerState}`,
  );
}
