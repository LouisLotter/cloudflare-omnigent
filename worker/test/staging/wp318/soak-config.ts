// WP3.18 staging soak: renders and deploys the soak's two Workers through the guarded staging
// tool, from the bootstrap's own state for the staging installation `wp318` (laptop only).
//
//   node worker/test/staging/wp318/soak-config.ts platform <build stamp>
//       the bootstrap's platform configuration (scripts/bootstrap/settings.ts) with soak.ts as
//       main, the SOAK binding (migration v4) and the RESULTS bucket added; each call is a new
//       version (WP318_BUILD), with identical images
//   node worker/test/staging/wp318/soak-config.ts web
//       the bootstrap's web configuration again, with ingress's variables: a new version
//   node worker/test/staging/wp318/soak-config.ts check
//       renders both and prints them with the installation's values masked (no deploy)
//
// The rendered files sit next to the checked-in configurations, so that their relative paths
// resolve, under the bootstrap's ignored name (.cfo-bootstrap.*.jsonc), and are removed after use.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAccess, withRenderedConfig } from "../../../../scripts/bootstrap/cloud.ts";
import { renderPlatformConfig, renderWebConfig } from "../../../../scripts/bootstrap/settings.ts";
import { parseState, statePathFor } from "../../../../scripts/bootstrap/state.ts";
import { readWranglerConfig, spawnRunner } from "../../../../scripts/staging/cloud.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const WORKER = join(ROOT, "worker");
/** The bootstrap's staging installation for this soak (`plan --staging wp318`). */
const PLATFORM = "cfo-stg-wp318-platform";

type Raw = Record<string, unknown>;

export function soakPlatformConfig(rendered: Readonly<Raw>, build: string): Raw {
  const objects = (rendered.durable_objects as { bindings: unknown[] }).bindings;
  const migrations = rendered.migrations as { tag: string }[];
  return {
    ...rendered,
    main: "test/staging/wp318/soak.ts",
    durable_objects: { bindings: [...objects, { name: "SOAK", class_name: "SoakRun" }] },
    migrations: [
      ...migrations,
      { tag: `v${migrations.length + 1}`, new_sqlite_classes: ["SoakRun"] },
    ],
    r2_buckets: [
      ...((rendered.r2_buckets as unknown[]) ?? []),
      { binding: "RESULTS", bucket_name: `${String(rendered.name)}-results` },
    ],
    vars: { ...(rendered.vars as Raw), WP318_BUILD: build },
  };
}

function plan() {
  const state = parseState(readFileSync(statePathFor(PLATFORM), "utf8"));
  const installation = state.installation;
  if (installation.target.kind !== "staging") throw new Error("not a staging installation");
  return { installation, target: installation.target };
}

function stg(args: readonly string[]): void {
  const child = spawnSync(
    process.execPath,
    ["--no-warnings", join(ROOT, "scripts", "staging", "stg.ts"), ...args],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (child.status !== 0) throw new Error(`stg ${args[0]} exited with ${child.status}`);
}

function deploy(config: Raw, suffix: string, owner: string, days: number): void {
  withRenderedConfig(WORKER, config, (path) =>
    stg(["deploy", "--suffix", suffix, "--owner", owner, "--config", path, "--days", String(days)]),
  );
}

function masked(config: Raw): string {
  return JSON.stringify(
    { ...config, account_id: "<account>", vars: Object.keys((config.vars as Raw) ?? {}) },
    null,
    2,
  );
}

async function main(): Promise<void> {
  const [command, build] = process.argv.slice(2);
  const { installation, target } = plan();
  const base = (file: string) => readWranglerConfig(join(WORKER, file), WORKER).raw;
  if (command === "platform" || command === "check") {
    const config = soakPlatformConfig(
      renderPlatformConfig(base("wrangler.jsonc"), installation),
      build ?? "check",
    );
    if (command === "check") console.log(masked(config));
    else deploy(config, target.platformSuffix, target.owner, target.days);
  }
  if (command === "web" || command === "check") {
    const access = await readAccess(spawnRunner(installation.accountId), installation);
    const config = renderWebConfig(base("wrangler.web.jsonc"), installation, access);
    if (command === "check") console.log(masked(config));
    else deploy(config, target.webSuffix, target.owner, target.days);
  }
  if (!["platform", "web", "check"].includes(command ?? "")) {
    throw new Error("soak-config.ts platform <build> | web | check");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
