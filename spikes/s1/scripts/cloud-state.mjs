// Read-only view of S1's Cloudflare resources: container applications, their instances and
// registry images whose names start with "cfo-stg-s1-". Used before and after teardown.
//
//   node spikes/s1/scripts/cloud-state.mjs
//
// The staging account comes from the staging tool's state directory and is passed to `cf` in
// the environment only. Output omits account IDs.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PREFIX = "cfo-stg-s1-";
const state =
  process.env.CFO_STAGING_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cloudflare-omnigent", "staging");
const { accountId } = JSON.parse(readFileSync(join(state, "config.json"), "utf8"));
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId };

function cf(args) {
  const result = spawnSync("cf", args, { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`cf ${args.join(" ")}: ${result.stderr.split("\n")[0]}`);
  const parsed = JSON.parse(result.stdout);
  return parsed?.result ?? parsed;
}

const redact = (text) => String(text).replaceAll(accountId, "<account>");
const apps = cf(["containers", "applications", "list"]).filter((a) => a.name?.startsWith(PREFIX));
const images = cf(["containers", "images", "list"]);
const ours = (Array.isArray(images) ? images : []).filter((entry) =>
  JSON.stringify(entry).includes(PREFIX),
);
console.log(
  JSON.stringify(
    {
      at: new Date().toISOString(),
      applications: apps.map((a) => {
        let list = [];
        try {
          const found = cf([
            "containers",
            "applications",
            "instances",
            "list",
            "--application-id",
            a.id,
          ]);
          list = (Array.isArray(found) ? found : (found?.instances ?? [])).map((i) =>
            JSON.parse(redact(JSON.stringify(i))),
          );
        } catch (error) {
          list = [`error: ${error.message}`];
        }
        return {
          name: a.name,
          scheduling_policy: a.scheduling_policy,
          instances: a.instances,
          max_instances: a.max_instances,
          instance_type: a.configuration?.instance_type,
          instanceList: list,
        };
      }),
      images: ours.map((entry) => JSON.parse(redact(JSON.stringify(entry)))),
    },
    null,
    2,
  ),
);
