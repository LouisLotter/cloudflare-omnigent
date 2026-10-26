// G2 sitting (test tooling, laptop only): deploys the sitting's harness on the platform Worker
// the bootstrap installed, and dry-runs everything the sitting deploys.
//
//   node worker/test/staging/g2/deploy.ts harness    (secrets as JSON on stdin)
//   node worker/test/staging/g2/deploy.ts recovery   (the same, with an empty replica prefix)
//   node worker/test/staging/g2/deploy.ts dry-run [outdir]
//
// harness and recovery render the platform Worker's configuration exactly as the bootstrap
// does (scripts/bootstrap/settings.ts, renderPlatformConfig, from the installation's state
// file), with one change: `main` is the harness entry (platform.ts); recovery also points the
// server at an empty replica prefix. The guarded staging tool deploys it under the bootstrap's
// own deployment and owner; its secrets stay, and the image is the same (same build epoch), so
// Wrangler pushes nothing and starts no rollout.
//
// dry-run renders, from a synthetic installation, every configuration the sitting deploys (the
// buckets' holder, the production platform and web Workers as the bootstrap renders
// them, the harness and its recovery variant, and the 1 GB run), checks the staging ones with
// the staging tool's own rules, and runs `wrangler deploy --dry-run` on each. No Cloudflare
// call.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withRenderedConfig } from "../../../../scripts/bootstrap/cloud.ts";
import {
  type Installation,
  newInstallationId,
  renderPlatformConfig,
  renderWebConfig,
} from "../../../../scripts/bootstrap/settings.ts";
import { fileStateStore, statePathFor } from "../../../../scripts/bootstrap/state.ts";
import { readWranglerConfig } from "../../../../scripts/staging/cloud.ts";
import { validateDeployConfig } from "../../../../scripts/staging/guard.ts";
import { makeOwnerPin } from "../../../src/ingress/owner.ts";
import { EMPTY_REPLICA_MARK } from "./steps.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..", "..");
const WORKER = join(ROOT, "worker");

export const BASE = "g2-sitting";
export const OWNER = "G2-sitting";
export const PLATFORM = `cfo-stg-${BASE}-platform`;
export const PLATFORM_SUFFIX = `${BASE}-platform`;
export const HOLDER = `cfo-stg-${BASE}-r2`;
export const BUCKET = `${HOLDER}-db`;
/** Omnigent's artifacts, a bucket of their own beside the replica's (G2-DUR-001). */
export const ARTIFACT_BUCKET = `${HOLDER}-artifacts`;
/** VD-15 at 1 GB: WP2.6's harness under the sitting's names (resnapshot/wrangler.jsonc). */
export const BIG = `cfo-stg-${BASE}-1gb`;
/** The local server image the 1 GB run's seeder builds on. */
export const SEEDER_BASE = "cfo-g2-server:dev";
/** The harness entry, relative to worker/, where the rendered configuration is written. */
const HARNESS_MAIN = "test/staging/g2/platform.ts";

type Raw = Record<string, unknown>;

function base(file: string): Raw {
  return { ...readWranglerConfig(join(WORKER, file), WORKER).raw };
}

/** The platform configuration the bootstrap deploys, with the harness entry. */
export function harnessConfig(plan: Installation, emptyReplica?: string): Raw {
  const rendered = renderPlatformConfig(base("wrangler.jsonc"), plan);
  const vars = { ...(rendered.vars as Record<string, string>) };
  if (emptyReplica !== undefined) vars.SERVER_ENV_CFO_REPLICA_URL = emptyReplica;
  return { ...rendered, main: HARNESS_MAIN, vars };
}

function emptyReplicaUrl(plan: Installation): string {
  const bucket = new URL(plan.replica.url).hostname;
  return `s3://${bucket}${EMPTY_REPLICA_MARK}${randomBytes(4).toString("hex")}`;
}

function stg(args: readonly string[], input: string | undefined): number {
  const child = spawnSync(
    process.execPath,
    ["--no-warnings", join(ROOT, "scripts", "staging", "stg.ts"), ...args],
    {
      cwd: ROOT,
      stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
      ...(input === undefined ? {} : { input }),
    },
  );
  return child.status ?? 1;
}

function deploy(emptyReplica: boolean): number {
  const plan = fileStateStore(statePathFor(PLATFORM)).load().installation;
  if (plan.target.kind !== "staging" || plan.platformWorker !== PLATFORM) {
    throw new Error(`the state file is not the sitting's installation (${PLATFORM})`);
  }
  const secrets = readFileSync(0, "utf8").trim();
  const config = harnessConfig(plan, emptyReplica ? emptyReplicaUrl(plan) : undefined);
  return withRenderedConfig(WORKER, config, (path) => {
    const args = ["deploy", "--suffix", PLATFORM_SUFFIX, "--owner", OWNER, "--config", path];
    args.push("--days", String(plan.target.kind === "staging" ? plan.target.days : 1));
    return secrets === "" ? stg(args, undefined) : stg([...args, "--secrets-stdin"], secrets);
  });
}

async function dryRun(outdir: string): Promise<number> {
  const accountId = "0".repeat(32);
  const plan: Installation = {
    installationId: newInstallationId((n) => new Uint8Array(randomBytes(n))),
    accountId,
    platformWorker: PLATFORM,
    webWorker: `cfo-stg-${BASE}-web`,
    hostname: `cfo-stg-${BASE}-web.example.com`,
    ownerPin: await makeOwnerPin("owner@example.com", new Uint8Array(randomBytes(32))),
    ownerUsername: "owner",
    replica: {
      url: `s3://${BUCKET}/omnigent`,
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    },
    artifacts: { url: `s3://${ARTIFACT_BUCKET}` },
    target: {
      kind: "staging",
      owner: OWNER,
      platformSuffix: PLATFORM_SUFFIX,
      webSuffix: `${BASE}-web`,
      days: 1,
    },
    plannedAt: new Date().toISOString(),
  };
  const access = { teamDomain: "example.cloudflareaccess.com", aud: "a".repeat(64) };
  const configs: [string, string, Raw, boolean][] = [
    ["holder", HOLDER, base("test/staging/g2/bucket/wrangler.jsonc"), true],
    ["platform (bootstrap)", PLATFORM, renderPlatformConfig(base("wrangler.jsonc"), plan), false],
    [
      "web (bootstrap)",
      plan.webWorker,
      renderWebConfig(base("wrangler.web.jsonc"), plan, access),
      false,
    ],
    ["platform (harness)", PLATFORM, harnessConfig(plan), true],
    ["platform (recovery)", PLATFORM, harnessConfig(plan, emptyReplicaUrl(plan)), true],
    ["1 GB run", BIG, base("test/staging/g2/resnapshot/wrangler.jsonc"), true],
  ];
  // The 1 GB run's seeder builds FROM this local tag (resnapshot/wrangler.jsonc, image_vars).
  const built = spawnSync(
    "docker",
    ["build", "-q", "-f", join(ROOT, "images/server/Dockerfile"), "-t", SEEDER_BASE, ROOT],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (built.status !== 0) throw new Error(`docker build of ${SEEDER_BASE} failed`);
  let failures = 0;
  for (const [label, name, config, guarded] of configs) {
    const dir = join(outdir, label.replace(/\W+/g, "-"));
    mkdirSync(dir, { recursive: true });
    // The holder's paths are relative to its own directory; the others' to worker/.
    const at =
      label === "holder"
        ? join(HERE, "bucket")
        : label === "1 GB run"
          ? join(HERE, "resnapshot")
          : WORKER;
    const status = withRenderedConfig(at, { ...config, name }, (path) => {
      if (guarded) validateDeployConfig(readWranglerConfig(path, WORKER), accountId, name);
      const wrangler = spawnSync(
        process.execPath,
        [
          join(WORKER, "node_modules", "wrangler", "bin", "wrangler.js"),
          "deploy",
          "--dry-run",
          "--config",
          path,
          "--outdir",
          dir,
        ],
        { cwd: WORKER, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
      );
      const tail = `${wrangler.stdout}\n${wrangler.stderr}`.trim().split("\n").slice(-4);
      console.log(`${wrangler.status === 0 ? "ok  " : "FAIL"} ${label}: ${name}`);
      for (const line of tail) console.log(`       ${line}`);
      return wrangler.status ?? 1;
    });
    if (status !== 0) failures += 1;
  }
  return failures === 0 ? 0 : 1;
}

const [command, arg] = process.argv.slice(2);
try {
  switch (command) {
    case "harness":
      process.exitCode = deploy(false);
      break;
    case "recovery":
      process.exitCode = deploy(true);
      break;
    case "dry-run":
      process.exitCode = await dryRun(resolve(arg ?? join(ROOT, "worker", "dist", "g2")));
      break;
    default:
      throw new Error("usage: deploy.ts harness|recovery|dry-run [outdir]");
  }
} catch (error) {
  console.error(`deploy.ts: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
