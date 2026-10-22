// WP2.1 staging: confirms, read-only, that the deployment is gone after
// `pnpm stg teardown --suffix wp21-ingress`.
//
//   node worker/test/staging/ingress/teardown-check.ts [out.json]

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cf, generated, NAME, STATE, stagingConfig } from "./config.ts";

async function main(): Promise<void> {
  const out = process.argv[2];
  const { accountId } = stagingConfig();
  const { hostname } = generated();
  const worker = spawnSync("cf", ["workers", "get", NAME], {
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  const apps = cf(
    ["zero-trust", "access", "applications", "list", "--domain", hostname, "--exact"],
    accountId,
  ) as unknown[];
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
      worker.status !== 0 && (worker.stderr ?? "").includes("[10007]")
        ? "absent ([10007] 404)"
        : "PRESENT or unknown",
    accessApplicationsOnHostname: apps.length,
    stagingRegistryEntries: registry.deployments.filter((d) => d.name === NAME).length,
    httpsToHostname: http,
  };
  const gone =
    checks.workerLookup.startsWith("absent") &&
    checks.accessApplicationsOnHostname === 0 &&
    checks.stagingRegistryEntries === 0;
  const text = `${JSON.stringify({ ...checks, gone }, null, 2).replaceAll(hostname, "<host>")}\n`;
  if (out) writeFileSync(out, text);
  console.log(text);
  if (!gone) process.exitCode = 1;
}

await main();
