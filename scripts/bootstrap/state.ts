// The bootstrap's state file (WP2.4): the plan and the journal, on the installer's laptop.
//
// It holds no secret, but it identifies the installation (account, hostname, the owner's pin),
// so it lives outside the repository, readable by its owner only:
//   $CFO_INSTALL_DIR, or $XDG_CONFIG_HOME/cloudflare-omnigent/installations (~/.config/…),
//   one file per platform Worker, <platform worker>.json, mode 0600, in a 0700 directory.
// Writes are atomic (a temporary file in the same directory, then a rename), so a crash leaves
// either the old journal or the new one. A lock file beside it keeps two runs apart.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BootstrapStatus } from "../../contracts/src/index.ts";
import type { BootstrapState, Journal, StateStore } from "./machine.ts";
import { type Installation, installationProblems, type Target } from "./settings.ts";

export function installationsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CFO_INSTALL_DIR) return env.CFO_INSTALL_DIR;
  const config = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(config, "cloudflare-omnigent", "installations");
}

export function statePathFor(platformWorker: string, dir: string = installationsDir()): string {
  return join(dir, `${platformWorker}.json`);
}

/**
 * Where the bootstrap's locks live: one place per laptop user, whatever state file or
 * $CFO_INSTALL_DIR a run uses, so that two runs against the same Workers always meet.
 */
export function locksDir(env: NodeJS.ProcessEnv = process.env): string {
  const config = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(config, "cloudflare-omnigent", "bootstrap-locks");
}

/** The bootstrap's lock for one Worker, keyed by account and Worker name. */
export function workerLockPath(
  accountId: string,
  worker: string,
  dir: string = locksDir(),
): string {
  return join(dir, `${accountId}.${worker}.lock`);
}

/**
 * The locks a run holds for its whole length: one per Worker it may change, keyed by account
 * and Worker name, in a fixed order (Codex WP2.4 r1, finding 1).
 */
export function resourceLockPaths(
  plan: Pick<Installation, "accountId" | "platformWorker" | "webWorker">,
  dir: string = locksDir(),
): string[] {
  return [plan.platformWorker, plan.webWorker]
    .map((worker) => workerLockPath(plan.accountId, worker, dir))
    .sort();
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`the state file's ${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string, what: string): string {
  const value = o[key];
  if (typeof value !== "string") throw new Error(`the state file's ${what}.${key} is not text`);
  return value;
}

function optionalTime(
  o: Record<string, unknown>,
  key: string,
  where = "journal",
): string | undefined {
  const value = o[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`the state file's ${where}.${key} is not a time`);
  }
  return value;
}

function parseTarget(value: unknown): Target {
  const t = object(value, "installation.target");
  if (t.kind === "account") return { kind: "account" };
  if (t.kind === "staging") {
    const days = t.days;
    if (typeof days !== "number") throw new Error("the state file's staging days is not a number");
    return {
      kind: "staging",
      owner: str(t, "owner", "target"),
      platformSuffix: str(t, "platformSuffix", "target"),
      webSuffix: str(t, "webSuffix", "target"),
      days,
    };
  }
  throw new Error("the state file's target is neither an account nor staging");
}

function parseInstallation(value: unknown): Installation {
  const i = object(value, "installation");
  const replica = object(i.replica, "installation.replica");
  const endpoint = replica.endpoint;
  if (endpoint !== undefined && typeof endpoint !== "string") {
    throw new Error("the state file's replica endpoint is not text");
  }
  let artifacts: Installation["artifacts"];
  if (i.artifacts !== undefined) {
    const a = object(i.artifacts, "installation.artifacts");
    if (a.endpoint !== undefined && typeof a.endpoint !== "string") {
      throw new Error("the state file's artifacts endpoint is not text");
    }
    artifacts = {
      url: str(a, "url", "installation.artifacts"),
      ...(a.endpoint === undefined ? {} : { endpoint: a.endpoint }),
    };
  }
  const installation: Installation = {
    installationId: str(i, "installationId", "installation"),
    accountId: str(i, "accountId", "installation"),
    platformWorker: str(i, "platformWorker", "installation"),
    webWorker: str(i, "webWorker", "installation"),
    hostname: str(i, "hostname", "installation"),
    ownerPin: str(i, "ownerPin", "installation"),
    ownerUsername: str(i, "ownerUsername", "installation"),
    replica: {
      url: str(replica, "url", "installation.replica"),
      ...(endpoint === undefined ? {} : { endpoint }),
    },
    ...(artifacts === undefined ? {} : { artifacts }),
    target: parseTarget(i.target),
    plannedAt: str(i, "plannedAt", "installation"),
  };
  const problems = installationProblems(installation);
  if (problems.length > 0)
    throw new Error(`the state file's plan is not usable: ${problems.join("; ")}`);
  return installation;
}

function parseJournal(value: unknown): Journal {
  const j = object(value ?? {}, "journal");
  const times = [
    "platformDeployStartedAt",
    "platformDeployedAt",
    "webDeployStartedAt",
    "webDeployedAt",
    "releaseStartedAt",
    "releasedAt",
    "verifiedAt",
  ] as const;
  const journal: Record<string, unknown> = {};
  for (const key of times) {
    const time = optionalTime(j, key);
    if (time !== undefined) journal[key] = time;
  }
  if (j.access !== undefined) {
    const a = object(j.access, "journal.access");
    journal.access = {
      teamDomain: str(a, "teamDomain", "journal.access"),
      aud: str(a, "aud", "journal.access"),
      checkedAt: str(a, "checkedAt", "journal.access"),
    };
  }
  if (j.newestStatus !== undefined) {
    const n = object(j.newestStatus, "journal.newestStatus");
    const status = BootstrapStatus.safeParse(n.status);
    if (!status.success || typeof n.loggedAt !== "number") {
      throw new Error("the state file's newest status is malformed");
    }
    for (const key of ["versionId", "reason"] as const) {
      if (n[key] !== undefined && typeof n[key] !== "string") {
        throw new Error(`the state file's newest status ${key} is not text`);
      }
    }
    journal.newestStatus = {
      loggedAt: n.loggedAt,
      status: status.data,
      ...(n.versionId === undefined ? {} : { versionId: n.versionId }),
      ...(n.reason === undefined ? {} : { reason: n.reason }),
    };
  }
  if (j.releasedVersionId !== undefined) {
    if (typeof j.releasedVersionId !== "string") {
      throw new Error("the state file's released version is not text");
    }
    journal.releasedVersionId = j.releasedVersionId;
  }
  if (j.r2Token !== undefined) {
    const t = object(j.r2Token, "journal.r2Token");
    const token: Record<string, string> = { name: str(t, "name", "journal.r2Token") };
    if (t.id !== undefined) token.id = str(t, "id", "journal.r2Token");
    for (const key of ["createStartedAt", "createdAt", "expiresOn", "rollStartedAt"] as const) {
      const time = optionalTime(t, key, "journal.r2Token");
      if (time !== undefined) token[key] = time;
    }
    journal.r2Token = token;
  }
  if (j.accepted !== undefined) {
    const a = object(j.accepted, "journal.accepted");
    const status = BootstrapStatus.safeParse(a.status);
    if (!status.success) throw new Error("the state file's accepted status is malformed");
    const versionId = a.versionId;
    if (versionId !== undefined && typeof versionId !== "string") {
      throw new Error("the state file's accepted version is not text");
    }
    journal.accepted = {
      at: str(a, "at", "journal.accepted"),
      status: status.data,
      ...(versionId === undefined ? {} : { versionId }),
    };
  }
  return journal as Journal;
}

/** The state file's content, checked; throws naming the field, never echoing the file. */
export function parseState(text: string): BootstrapState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("the state file is not JSON");
  }
  const o = object(raw, "top level");
  if (o.stateVersion !== 1) throw new Error("the state file has an unknown version");
  return {
    stateVersion: 1,
    installation: parseInstallation(o.installation),
    journal: parseJournal(o.journal),
  };
}

/** Writes `text` to `path` atomically, mode 0600, in a 0700 directory. */
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

export function fileStateStore(path: string): StateStore {
  return {
    load: () => {
      if (!existsSync(path)) throw new Error(`no state file at ${path}; run plan first`);
      return parseState(readFileSync(path, "utf8"));
    },
    save: (state) => writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`),
  };
}
