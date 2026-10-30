// `bootstrap.ts services [add <id> [--origin <url>] | remove <id>]` (WP5.10): wires the MCP
// services step (services.ts) to the installation's state file, its locks, the manifests this
// checkout ships (images/server/services) and the bootstrap's own Cloudflare adapter, the one
// `run` uses. Typed values come from the terminal, never an argument; the secrets reach
// Cloudflare only through that adapter's transport (an unlinked file on a descriptor).

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { readWranglerConfig } from "../staging/cloud.ts";
import { acquireLock } from "../staging/lock.ts";
import { accountCloud } from "./cloud.ts";
import {
  changeServices,
  readManifest,
  type ServiceManifest,
  type ServicesChange,
  ServicesRefusal,
  servicesListing,
  servicesMessage,
} from "./services.ts";
import { stagingCloud } from "./staging.ts";
import { fileStateStore, resourceLockPaths, stagingStateProblem } from "./state.ts";

export interface ServicesCommandOptions {
  readonly root: string;
  /** `add`, `remove`, or nothing (list). */
  readonly action?: string;
  readonly id?: string;
  readonly origin?: string;
  readonly replace: boolean;
}

/** The manifests this checkout ships: the ones the release's server image holds. */
export function shippedManifests(root: string): Map<string, ServiceManifest> {
  const dir = join(root, "images", "server", "services");
  const manifests = new Map<string, ServiceManifest>();
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const name = file.slice(0, -".json".length);
    manifests.set(name, readManifest(name, JSON.parse(readFileSync(join(dir, file), "utf8"))));
  }
  return manifests;
}

/** One line from the terminal: echoed as typed, or, for a secret, never shown. */
function ask(question: string, options: { readonly secret: boolean }): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return Promise.reject(
      new ServicesRefusal("this step asks for values in a terminal: run it in one"),
    );
  }
  if (!options.secret) {
    const rl = createInterface({ input: stdin, output: process.stdout });
    return new Promise((resolve) =>
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      }),
    );
  }
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    let line = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(line);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f") line = line.slice(0, -1);
        else line += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * Runs the step for the installation in the state file at `path`. Exit status 0 (ready, or
 * nothing to change, or the list), 3 (stored, not confirmed yet) or 1 (off or held), or throws.
 */
export async function servicesCommand(
  path: string,
  options: ServicesCommandOptions,
): Promise<number> {
  const store = fileStateStore(path);
  const installation = store.load().installation;
  const manifests = shippedManifests(options.root);
  if (options.action === undefined) {
    console.log(`MCP services of ${installation.platformWorker} (this state file's record):`);
    for (const line of servicesListing(manifests, store.load().journal.mcpServices)) {
      console.log(`  ${line}`);
    }
    console.log(
      "Turn one on: bootstrap.ts services add <id>; off: bootstrap.ts services remove <id>.",
    );
    return 0;
  }
  if ((options.action !== "add" && options.action !== "remove") || options.id === undefined) {
    throw new Error("usage: bootstrap.ts services [add <id> [--origin <url>] | remove <id>]");
  }
  if (options.action === "remove" && options.origin !== undefined) {
    throw new Error("--origin goes with add");
  }
  const change: ServicesChange =
    options.action === "add"
      ? {
          kind: "add",
          id: options.id,
          ...(options.origin === undefined ? {} : { origin: options.origin }),
        }
      : { kind: "remove", id: options.id };
  const misplaced = stagingStateProblem(installation, path);
  if (misplaced !== undefined) throw new ServicesRefusal(misplaced);
  const releases: (() => void)[] = [];
  try {
    // Never alongside another step on the same Workers: the same locks as `run`.
    for (const lock of resourceLockPaths(installation)) {
      releases.push(acquireLock(lock, 0, `pid ${process.pid}, bootstrap services, ${path}`));
    }
    const worker = join(options.root, "worker");
    const cloud =
      installation.target.kind === "staging"
        ? stagingCloud(installation, {
            root: options.root,
            base: { web: readWranglerConfig(join(worker, "wrangler.web.jsonc"), worker).raw },
          })
        : accountCloud(installation, { workerDir: worker });
    const outcome = await changeServices(
      installation,
      {
        cloud,
        store,
        manifests,
        ask,
        random: (n) => new Uint8Array(randomBytes(n)),
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        log: (message) => console.log(`bootstrap: ${message}`),
      },
      change,
      { replace: options.replace },
    );
    const last = servicesMessage(installation, change, manifests, outcome);
    for (const line of last.lines) console.log(`bootstrap: ${line}`);
    return last.exitCode;
  } finally {
    for (const release of releases.reverse()) release();
  }
}
