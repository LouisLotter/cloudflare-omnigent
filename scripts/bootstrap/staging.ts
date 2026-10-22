// The bootstrap's adapter for a staging installation (WP2.4): every deploy and every secret
// change goes through the guarded staging tool (scripts/staging/stg.ts), which refuses
// unprefixed names, the wrong account and anything it did not deploy, and puts its owner-only
// Access application in front of each hostname before the Worker exists. Reads (secret names
// through the tool; Workers Logs and Access through `cf`) are read-only.
//
// Differences from an installation in the installer's own account, all the staging tool's:
//   - each Worker is deployed with `--domain <deployment>.<zone>`, so the platform Worker also
//     has a hostname, behind its own owner-only Access application (production gives it none);
//   - the web Worker's Access application is created by the tool's first deploy of the web
//     Worker, which therefore runs once without ingress's variables (it answers 503 to
//     everything) before the bootstrap reads the application's AUD.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { type Runner, spawnRunner } from "../staging/cloud.ts";
import { activeVersion, cfJson, queryWorkerLogs, readAccess, withRenderedConfig } from "./cloud.ts";
import type { BootstrapCloud } from "./machine.ts";
import { type Installation, renderWebConfig } from "./settings.ts";

export interface StagingCloudOptions {
  readonly root: string;
  readonly base: { readonly web: Readonly<Record<string, unknown>> };
  readonly runner?: Runner;
  /** Runs the staging tool; tests replace it. Returns its exit status and stdout. */
  readonly stg?: (args: readonly string[], input?: string) => { status: number; stdout: string };
}

function stagingTool(root: string) {
  return (args: readonly string[], input?: string) => {
    const child = spawnSync(
      process.execPath,
      ["--no-warnings", join(root, "scripts", "staging", "stg.ts"), ...args],
      {
        cwd: root,
        encoding: "utf8",
        // The secrets reach the tool only through this pipe.
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"],
        ...(input === undefined ? {} : { input }),
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (child.error) throw child.error;
    // A deploy's own output is long and has no secret; show it, keep it for the result.
    if (child.stdout && args[0] !== "secret-names") process.stdout.write(child.stdout);
    return { status: child.status ?? 1, stdout: child.stdout ?? "" };
  };
}

export function stagingCloud(plan: Installation, options: StagingCloudOptions): BootstrapCloud {
  const target = plan.target;
  if (target.kind !== "staging") throw new Error("not a staging installation");
  const run = options.runner ?? spawnRunner(plan.accountId);
  const stg = options.stg ?? stagingTool(options.root);
  const suffixOf = (worker: string) => {
    if (worker === plan.platformWorker) return target.platformSuffix;
    if (worker === plan.webWorker) return target.webSuffix;
    throw new Error(`${worker} is not one of this installation's Workers`);
  };
  const tool = (args: readonly string[], input?: string) => {
    const result = stg(args, input);
    if (result.status !== 0) throw new Error(`stg ${args[0]} exited with ${result.status}`);
    return result.stdout;
  };
  const deploy = (
    worker: string,
    config: Readonly<Record<string, unknown>>,
    secrets?: Readonly<Record<string, string>>,
  ) => {
    // Next to the checked-in configuration, so that its relative paths resolve.
    withRenderedConfig(join(options.root, "worker"), config, (path) => {
      const args = [
        "deploy",
        "--suffix",
        suffixOf(worker),
        "--owner",
        target.owner,
        "--config",
        path,
        "--days",
        String(target.days),
      ];
      if (secrets !== undefined && Object.keys(secrets).length > 0) {
        tool([...args, "--secrets-stdin"], JSON.stringify(secrets));
      } else tool(args);
    });
  };
  const accessApps = () =>
    cfJson(run, [
      "zero-trust",
      "access",
      "applications",
      "list",
      "--domain",
      plan.hostname,
      "--exact",
    ]);
  return {
    secretNames: async (worker) => {
      const out = tool(["secret-names", "--suffix", suffixOf(worker)])
        .trim()
        .split("\n")
        .at(-1);
      const names = JSON.parse(out ?? "null") as unknown;
      if (names === null) return null;
      if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) {
        throw new Error("stg secret-names answered something other than a list of names");
      }
      return names as string[];
    },
    access: async (p) => {
      const listed = accessApps();
      const hasApp =
        Array.isArray(listed) &&
        listed.some((app) => (app as { domain?: unknown } | null)?.domain === p.hostname);
      if (!hasApp) {
        // The staging tool creates the owner-only application with the web Worker's first
        // deploy, which has no ingress variables yet and so answers 503 to every request.
        deploy(p.webWorker, renderWebConfig(options.base.web, p, undefined));
      }
      return readAccess(run, p);
    },
    deployPlatform: async (p, config, secrets) => deploy(p.platformWorker, config, secrets),
    deployWeb: async (p, config) => deploy(p.webWorker, config),
    updateSecrets: async (worker, changes) => {
      tool(
        ["secrets", "--suffix", suffixOf(worker), "--owner", target.owner],
        JSON.stringify(changes),
      );
    },
    activeVersion: async (worker) => activeVersion(run, worker),
    logs: async (worker, fromMs, toMs) => queryWorkerLogs(run, worker, fromMs, toMs),
  };
}
