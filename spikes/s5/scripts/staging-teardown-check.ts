// Spike S5: confirms, read-only, that the staging deployment is gone after
// `pnpm stg teardown --suffix s5-access`. Writes results/staging-teardown.json, redacted.
//
//   node spikes/s5/scripts/staging-teardown-check.ts

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SPIKE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE =
  process.env.CFO_STAGING_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cloudflare-omnigent", "staging");
const { accountId } = JSON.parse(readFileSync(join(STATE, "config.json"), "utf8")) as {
  accountId: string;
};
const { hostname } = JSON.parse(readFileSync(join(SPIKE, "generated", "staging.json"), "utf8")) as {
  hostname: string;
};
const NAME = "cfo-stg-s5-access";
const CONTAINER = `${NAME}-omnigent`;

function cf(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("cf", args, {
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const result = (stdout: string): unknown => {
  const parsed = JSON.parse(stdout) as { result?: unknown };
  return parsed && typeof parsed === "object" && "result" in parsed ? parsed.result : parsed;
};

const worker = cf(["workers", "get", NAME]);
const access = cf([
  "zero-trust",
  "access",
  "applications",
  "list",
  "--domain",
  hostname,
  "--exact",
]);
const apps = cf(["containers", "applications", "list", "--name", CONTAINER]);
const images = cf(["containers", "images", "list"]);
const imageRefs = JSON.stringify(result(images.stdout));
const registry = JSON.parse(readFileSync(join(STATE, "resources.json"), "utf8")) as {
  deployments: { name: string }[];
};
const http = await fetch(`https://${hostname}/`, { redirect: "manual" }).then(
  (r) => String(r.status),
  (e: unknown) =>
    `error: ${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : "unknown"}`,
);

const checks = {
  at: new Date().toISOString(),
  workerLookup:
    worker.status !== 0 && worker.stderr.includes("[10007]")
      ? "absent ([10007] 404)"
      : "PRESENT or unknown",
  accessApplicationsOnHostname: (result(access.stdout) as unknown[]).length,
  containerApplications: (result(apps.stdout) as unknown[]).filter(
    (a) => (a as { name?: string }).name === CONTAINER,
  ).length,
  registryImagesForContainer: imageRefs.includes(CONTAINER) ? "PRESENT" : "none",
  stagingRegistryEntries: registry.deployments.filter((d) => d.name.startsWith(NAME)).length,
  httpsToHostname: http,
};
const gone =
  checks.workerLookup.startsWith("absent") &&
  checks.accessApplicationsOnHostname === 0 &&
  checks.containerApplications === 0 &&
  checks.registryImagesForContainer === "none" &&
  checks.stagingRegistryEntries === 0;
const out = `${JSON.stringify({ ...checks, gone }, null, 2).replaceAll(hostname, "<host>")}\n`;
writeFileSync(join(SPIKE, "results", "staging-teardown.json"), out);
console.log(out);
