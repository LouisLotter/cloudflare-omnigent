// `bootstrap.ts update`'s wiring (WP3.35): the state file, `run`'s locks, the exit status and the
// one link, against the fake Cloudflare; and the code version a checkout deploys, from a real git
// repository made for the test.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock } from "../../staging/lock.ts";
import { runBootstrap } from "../machine.ts";
import type { Installation } from "../settings.ts";
import { fileStateStore, statePathFor, workerLockPath } from "../state.ts";
import { codeVersion, realPorts, type UpdatePorts, updateCommand } from "../update-command.ts";
import { FakeWorld } from "./fake-cloud.ts";
import {
  accountPlan,
  baseConfigs,
  freshState,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  ROOT,
  stagingPlan,
} from "./fixtures.ts";

const CODE = "c".repeat(40);

let dir: string;
let saved: { xdg: string | undefined; install: string | undefined };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfo-bootstrap-update-command-"));
  // The bootstrap's locks and installations live under these: keep them in this test's directory.
  saved = { xdg: process.env.XDG_CONFIG_HOME, install: process.env.CFO_INSTALL_DIR };
  process.env.XDG_CONFIG_HOME = dir;
  process.env.CFO_INSTALL_DIR = join(dir, "installations");
});

afterEach(() => {
  for (const [key, value] of [
    ["XDG_CONFIG_HOME", saved.xdg],
    ["CFO_INSTALL_DIR", saved.install],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A finished installation in a state file on disk, made by the bootstrap and the fake. */
async function finished(plan: Installation, path = statePathFor(plan.platformWorker)) {
  const world = new FakeWorld(plan);
  const store = fileStateStore(path);
  store.save(freshState(plan));
  const outcome = await runBootstrap({
    cloud: world.cloud(),
    store,
    baseConfigs: baseConfigs(),
    secrets: () => ({
      ownerPassword: OWNER_PASSWORD,
      replicaAccessKeyId: "cfo-canary-replica-key-id",
      replicaSecretAccessKey: "cfo-canary-replica-secret-key",
    }),
    random: (n) => new Uint8Array(n).fill(0xab),
    now: () => world.now,
    sleep: async (ms) => {
      world.now += ms;
    },
    log: () => undefined,
  });
  expect(outcome).toEqual({ kind: "done" });
  world.calls.length = 0;
  world.now += 3600_000;
  const lines: string[] = [];
  let next = 1;
  const ports = (over: Partial<UpdatePorts> = {}): UpdatePorts => ({
    cloud: () => world.cloud(),
    accessApi: () => undefined,
    codeVersion: () => CODE,
    random: (n) => new Uint8Array(n).map(() => next++ % 256),
    now: () => world.now,
    sleep: async (ms) => {
      world.now += ms;
    },
    log: (line) => lines.push(line),
    ...over,
  });
  return { world, path, lines, ports };
}

describe("updateCommand", () => {
  it("updates, says so with the one link, and exits 0; then is up to date", async () => {
    const plan = await accountPlan();
    const { world, path, lines, ports } = await finished(plan);
    expect(await updateCommand(path, { root: ROOT, verify: true }, ports())).toBe(0);
    expect(lines.at(-1)).toBe(`updated to ${CODE.slice(0, 12)}. Open https://${plan.hostname}`);
    expect(world.calls.filter((c) => c.startsWith("deploy"))).toEqual([
      "deployPlatform",
      "deployWeb",
    ]);
    expect(await updateCommand(path, { root: ROOT, verify: true }, ports())).toBe(0);
    expect(lines.at(-1)).toBe(`up to date: nothing to deploy. Open https://${plan.hostname}`);
    // The locks are released: another command may take them now.
    for (const worker of [plan.platformWorker, plan.webWorker]) {
      acquireLock(workerLockPath(plan.accountId, worker), 0, "test")();
    }
  });

  it("exits 3 when the check has not passed yet, and 0 once a later run checks", async () => {
    const plan = await accountPlan();
    const { world, path, lines, ports } = await finished(plan);
    expect(await updateCommand(path, { root: ROOT, verify: false }, ports())).toBe(3);
    expect(lines.at(-1)).toBe(
      `updated, but not checked yet: the check after the update was skipped. Run bootstrap.ts update again to check; it deploys nothing again. Open https://${plan.hostname}`,
    );
    world.now += 20 * 60_000;
    expect(await updateCommand(path, { root: ROOT, verify: true }, ports())).toBe(0);
    expect(world.calls.filter((c) => c === "deployPlatform")).toHaveLength(1);
  });

  it("passes Access in the installer's account and the owner's address on", async () => {
    const plan = await accountPlan();
    const { world, path, ports } = await finished(plan);
    // The hostname has no application the update knows of: it creates the owner-only one, with
    // the owner's address given to this command.
    const port = ports({ accessApi: () => world.accessApi() });
    await expect(updateCommand(path, { root: ROOT, verify: true }, port)).rejects.toThrow(
      /run again with --owner-email/,
    );
    expect(
      await updateCommand(path, { root: ROOT, verify: true, ownerEmail: OWNER_EMAIL }, port),
    ).toBe(0);
    expect(world.calls.filter((c) => c === "accessCreate")).toHaveLength(1);
    expect(fileStateStore(path).load().journal.accessApp?.id).toBeDefined();
  });

  it("refuses while another command holds the installation's lock, deploying nothing", async () => {
    const plan = await accountPlan();
    const { world, path, ports } = await finished(plan);
    const release = acquireLock(workerLockPath(plan.accountId, plan.webWorker), 0, "a run");
    try {
      await expect(updateCommand(path, { root: ROOT, verify: true }, ports())).rejects.toThrow(
        /busy: .* is held by another command \(a run\)/,
      );
    } finally {
      release();
    }
    expect(world.calls).toEqual([]);
    // Its own lock on the platform Worker was released as it stopped.
    acquireLock(workerLockPath(plan.accountId, plan.platformWorker), 0, "test")();
  });

  it("refuses a staging installation's state file away from its default path", async () => {
    const plan = await stagingPlan();
    const { world, ports } = await finished(plan, join(dir, "elsewhere.json"));
    await expect(
      updateCommand(join(dir, "elsewhere.json"), { root: ROOT, verify: true }, ports()),
    ).rejects.toThrow(/lives at .*leave out --state/);
    expect(world.calls).toEqual([]);
  });

  it("refuses without a state file", async () => {
    await expect(
      updateCommand(join(dir, "missing.json"), { root: ROOT, verify: true }, realPorts(ROOT)),
    ).rejects.toThrow(/no state file at/);
  });

  it("wires the real adapters for both kinds of installation, without calling them", async () => {
    const ports = realPorts(ROOT);
    const account = await accountPlan();
    const staging = await stagingPlan();
    const base = baseConfigs();
    expect(typeof ports.cloud(account, base).deployPlatform).toBe("function");
    expect(typeof ports.cloud(staging, base).deployPlatform).toBe("function");
    expect(typeof ports.accessApi(account)?.apps).toBe("function");
    expect(ports.accessApi(staging)).toBeUndefined();
    expect(ports.random(4)).toHaveLength(4);
    expect(Math.abs(ports.now() - Date.now())).toBeLessThan(60_000);
    await ports.sleep(0);
  });
});

describe("codeVersion: the commit of a clean checkout", () => {
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=cfo-test",
        "-c",
        "user.email=cfo-test@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "init.defaultBranch=main",
        ...args,
      ],
      { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };

  it("names the commit only while nothing in the checkout has changed", () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "worker"), { recursive: true });
    writeFileSync(join(repo, "worker", "index.ts"), "export {};\n");
    writeFileSync(join(repo, ".gitignore"), "ignored/\n");
    git(repo, "init", "-q");
    // No commit yet: no version.
    expect(codeVersion(repo)).toBeUndefined();
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "first");
    const head = git(repo, "rev-parse", "HEAD");
    expect(codeVersion(repo)).toBe(head);
    expect(realPorts(repo).codeVersion()).toBe(head);
    // What git ignores does not matter.
    mkdirSync(join(repo, "ignored"));
    writeFileSync(join(repo, "ignored", "x"), "x\n");
    expect(codeVersion(repo)).toBe(head);
    // A change, tracked or new, anywhere else makes the code's version unknown.
    writeFileSync(join(repo, "worker", "index.ts"), "export const x = 1;\n");
    expect(codeVersion(repo)).toBeUndefined();
    git(repo, "checkout", "--", "worker/index.ts");
    expect(codeVersion(repo)).toBe(head);
    writeFileSync(join(repo, "notes.txt"), "x\n");
    expect(codeVersion(repo)).toBeUndefined();
  });

  it("has no version outside a git checkout", () => {
    expect(codeVersion(join(dir, "nowhere"))).toBeUndefined();
  });
});
