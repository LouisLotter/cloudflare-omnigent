// Downloads the campaign's result files from the staging bucket with the `cf` CLI (read-only):
// results/<campaign>/<step>.json, one per step, plus campaign.json. Run before the teardown,
// which deletes the bucket.
//
//   node spikes/s3/staging/fetch-results.mjs [out-dir]   (default spikes/s3/results/staging)
//
// The staging account comes from the staging tool's state directory and is passed to `cf` in
// the environment only; it is never printed.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUCKET = "cfo-stg-s3-capture-ckpt";
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, "..", "results", "staging"));
const state =
  process.env.CFO_STAGING_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cloudflare-omnigent", "staging");
const { accountId } = JSON.parse(readFileSync(join(state, "config.json"), "utf8"));
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId };

function cf(args) {
  const result = spawnSync("cf", args, { encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0)
    throw new Error(`cf ${args.slice(0, 3).join(" ")} failed: ${result.stderr.split("\n")[0]}`);
  return result.stdout;
}

function unwrap(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && "result" in parsed ? parsed.result : parsed;
  } catch {
    return text;
  }
}

const listed = unwrap(
  cf([
    "r2",
    "objects",
    "list",
    "--bucket-name",
    BUCKET,
    "--prefix",
    "results/",
    "--per-page",
    "1000",
  ]),
);
const keys = (Array.isArray(listed) ? listed : (listed?.objects ?? []))
  .map((o) => o.key)
  .filter((k) => typeof k === "string" && k.endsWith(".json"));
for (const key of keys) {
  const body = unwrap(cf(["r2", "objects", "get", key, "--bucket-name", BUCKET]));
  const path = join(out, key.replace(/^results\//, ""));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body, null, 1));
  console.error(`saved ${path}`);
}
console.error(`${keys.length} result files`);
