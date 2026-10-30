// The bootstrap's state file (WP2.4): the plan and the journal, on the installer's laptop.
//
// It holds no secret, but it identifies the installation (account, hostname, the owner's pin),
// so it lives outside the repository, readable by its owner only:
//   $CFO_INSTALL_DIR, or $XDG_CONFIG_HOME/cloudflare-omnigent/installations (~/.config/…),
//   one file per platform Worker, <platform worker>.json, mode 0600, in a 0700 directory.
// Writes are atomic (a temporary file in the same directory, then a rename), so a crash leaves
// either the old journal or the new one. A lock file beside it keeps two runs apart.
//
// The plan is written once and never changed: every later run reads the installation's names,
// its buckets' included, from it. A plan made since D33 records its bucket tag and is written
// as version 2; one from before records none, stays version 1, and keeps its untagged bucket
// names (stateVersionFor). A journal that records what WP3.34 added (whose password was
// uploaded, the code each Worker was deployed from) is written as version 3, tagged or not, so a
// bootstrap from before WP3.34 refuses it ("unknown version") rather than drop those fields
// (Codex WP3.34 r2-1). One that records the MCP services (WP5.10) is version 5, for the same
// reason, and one that records an update's read-only window or restore points (WP3.41) version 6.

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
import { dirname, join, resolve } from "node:path";
import { BootstrapStatus } from "../../contracts/src/index.ts";
import type { BootstrapState, Journal, McpServicesRecord, StateStore } from "./machine.ts";
import { type Installation, installationProblems, type Target } from "./settings.ts";
import type { UpdateRecord } from "./update.ts";
import type {
  PreviousRelease,
  RestorePointRecord,
  RollbackRecord,
  WindowRecord,
} from "./window.ts";

export function installationsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CFO_INSTALL_DIR) return env.CFO_INSTALL_DIR;
  const config = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(config, "cloudflare-omnigent", "installations");
}

export function statePathFor(platformWorker: string, dir: string = installationsDir()): string {
  return join(dir, `${platformWorker}.json`);
}

/**
 * Why a state file may not be used at this path, or undefined. A staging installation's lives
 * only at its default path, where the staging tool's teardown and sweep look for its R2 tokens:
 * a login that may not list tokens leaves no other way to find them (Codex WP3.25 r3-5).
 */
export function stagingStateProblem(
  plan: Pick<Installation, "platformWorker" | "target">,
  path: string,
  dir: string = installationsDir(),
): string | undefined {
  if (plan.target.kind !== "staging") return undefined;
  const expected = statePathFor(plan.platformWorker, dir);
  return resolve(path) === resolve(expected)
    ? undefined
    : `a staging installation's state file lives at ${expected}, where the staging tool finds its R2 tokens; leave out --state`;
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
    ...(i.bucketTag === undefined ? {} : { bucketTag: str(i, "bucketTag", "installation") }),
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
    "ownerPasswordGivenAt",
    "updatedAt",
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
  // WP3.34: whose password the first deploy uploaded, and the code each Worker was deployed from.
  if (j.ownerPassword !== undefined) {
    if (j.ownerPassword !== "page" && j.ownerPassword !== "installer") {
      throw new Error("the state file's journal.ownerPassword is neither page nor installer");
    }
    journal.ownerPassword = j.ownerPassword;
  }
  for (const key of ["platformCode", "webCode"] as const) {
    const code = j[key];
    if (code === undefined) continue;
    if (typeof code !== "string" || !/^[0-9a-f]{40}$/.test(code)) {
      throw new Error(`the state file's journal.${key} is not a commit ID`);
    }
    journal[key] = code;
  }
  if (j.releasedVersionId !== undefined) {
    if (typeof j.releasedVersionId !== "string") {
      throw new Error("the state file's released version is not text");
    }
    journal.releasedVersionId = j.releasedVersionId;
  }
  if (j.update !== undefined) journal.update = parseUpdate(j.update);
  if (j.mcpServices !== undefined) journal.mcpServices = parseMcpServices(j.mcpServices);
  if (j.window !== undefined) journal.window = parseWindow(j.window);
  if (j.restorePoints !== undefined) journal.restorePoints = parseRestorePoints(j.restorePoints);
  if (j.r2Token !== undefined) {
    const t = object(j.r2Token, "journal.r2Token");
    const token: Record<string, string> = { name: str(t, "name", "journal.r2Token") };
    if (t.id !== undefined) token.id = str(t, "id", "journal.r2Token");
    for (const key of ["createStartedAt", "createdAt", "expiresOn"] as const) {
      const time = optionalTime(t, key, "journal.r2Token");
      if (time !== undefined) token[key] = time;
    }
    journal.r2Token = token;
  }
  if (j.r2TokensToDelete !== undefined) {
    if (!Array.isArray(j.r2TokensToDelete)) {
      throw new Error("the state file's journal.r2TokensToDelete is not a list");
    }
    journal.r2TokensToDelete = j.r2TokensToDelete.map((entry: unknown) => {
      const t = object(entry, "journal.r2TokensToDelete entry");
      const token: Record<string, string> = { name: str(t, "name", "journal.r2TokensToDelete") };
      if (t.id !== undefined) token.id = str(t, "id", "journal.r2TokensToDelete");
      for (const key of ["expiresOn", "createStartedAt"] as const) {
        const time = optionalTime(t, key, "journal.r2TokensToDelete");
        if (time !== undefined) token[key] = time;
      }
      return token;
    });
  }
  if (j.accessApp !== undefined) {
    const a = object(j.accessApp, "journal.accessApp");
    const app: Record<string, string> = { name: str(a, "name", "journal.accessApp") };
    if (a.id !== undefined) app.id = str(a, "id", "journal.accessApp");
    for (const key of ["createStartedAt", "createdAt"] as const) {
      const time = optionalTime(a, key, "journal.accessApp");
      if (time !== undefined) app[key] = time;
    }
    journal.accessApp = app;
  }
  if (j.accessLoginMethod !== undefined) {
    const m = object(j.accessLoginMethod, "journal.accessLoginMethod");
    const method: Record<string, string> = {};
    if (m.id !== undefined) method.id = str(m, "id", "journal.accessLoginMethod");
    for (const key of ["createStartedAt", "createdAt"] as const) {
      const time = optionalTime(m, key, "journal.accessLoginMethod");
      if (time !== undefined) method[key] = time;
    }
    journal.accessLoginMethod = method;
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

/** The journal fields WP3.34 added, which a bootstrap from before it would drop. */
const WP334_JOURNAL_FIELDS = ["ownerPassword", "platformCode", "webCode", "updatedAt"] as const;

/**
 * The last update's record (WP3.35, update.ts). Names, times and IDs only, never a secret.
 */
function parseUpdate(value: unknown): UpdateRecord {
  const u = object(value, "journal.update");
  const where = "journal.update";
  const startedAt = optionalTime(u, "startedAt", where);
  if (startedAt === undefined)
    throw new Error("the state file's journal.update.startedAt is missing");
  const code = str(u, "code", where);
  if (!/^[0-9a-f]{40}$/.test(code))
    throw new Error("the state file's journal.update.code is not a commit ID");
  const update: Record<string, unknown> = { code, startedAt };
  for (const key of [
    "platformDeployStartedAt",
    "platformDeployedAt",
    "webDeployStartedAt",
    "webDeployedAt",
    "verifiedAt",
  ] as const) {
    const time = optionalTime(u, key, where);
    if (time !== undefined) update[key] = time;
  }
  for (const key of ["deployId", "platformVersionId", "webVersionId"] as const) {
    if (u[key] !== undefined) update[key] = str(u, key, where);
  }
  if (u.addedSecrets !== undefined) {
    if (!Array.isArray(u.addedSecrets) || !u.addedSecrets.every((n) => typeof n === "string")) {
      throw new Error("the state file's journal.update.addedSecrets is not a list of names");
    }
    update.addedSecrets = [...u.addedSecrets];
  }
  return update as unknown as UpdateRecord;
}

/** A window's and restore point's ID (worker/src/server/maintenance.ts). */
const WINDOW_ID = /^rp-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
const COMMIT = /^[0-9a-f]{40}$/;

function windowIdOf(o: Record<string, unknown>, key: string, where: string): string {
  const id = str(o, key, where);
  if (!WINDOW_ID.test(id)) throw new Error(`the state file's ${where}.${key} is not a window's ID`);
  return id;
}

function optionalCommit(o: Record<string, unknown>, key: string, where: string) {
  if (o[key] === undefined) return {};
  const value = str(o, key, where);
  if (!COMMIT.test(value)) throw new Error(`the state file's ${where}.${key} is not a commit ID`);
  return { [key]: value };
}

function requiredTime(o: Record<string, unknown>, key: string, where: string): string {
  const time = optionalTime(o, key, where);
  if (time === undefined) throw new Error(`the state file's ${where}.${key} is missing`);
  return time;
}

function optionalTimes(o: Record<string, unknown>, keys: readonly string[], where: string) {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const time = optionalTime(o, key, where);
    if (time !== undefined) out[key] = time;
  }
  return out;
}

/** An update's open window (WP3.41, window.ts). Names, times and IDs only. */
function parseWindow(value: unknown): WindowRecord {
  const where = "journal.window";
  const w = object(value, where);
  const p = object(w.previous, `${where}.previous`);
  const previous: PreviousRelease = {
    platformVersionId: str(p, "platformVersionId", `${where}.previous`),
    webVersionId: str(p, "webVersionId", `${where}.previous`),
    ...optionalCommit(p, "platformCode", `${where}.previous`),
    ...optionalCommit(p, "webCode", `${where}.previous`),
  };
  let rollback: RollbackRecord | undefined;
  if (w.rollback !== undefined) {
    const rw = `${where}.rollback`;
    const r = object(w.rollback, rw);
    rollback = {
      startedAt: requiredTime(r, "startedAt", rw),
      ...optionalTimes(r, ["restoredAt", "webRolledBackAt", "platformRolledBackAt"], rw),
      ...(r.platformVersionId === undefined
        ? {}
        : { platformVersionId: str(r, "platformVersionId", rw) }),
    };
  }
  return {
    id: windowIdOf(w, "id", where),
    openedAt: requiredTime(w, "openedAt", where),
    previous,
    ...optionalTimes(w, ["restorePointTakenAt", "acceptStartedAt"], where),
    ...(w.acceptVersionId === undefined
      ? {}
      : { acceptVersionId: str(w, "acceptVersionId", where) }),
    ...(rollback === undefined ? {} : { rollback }),
  };
}

const OUTCOMES = ["accepted", "rolled back", "ended outside the installer"] as const;

/** The last few restore points (WP3.41). */
function parseRestorePoints(value: unknown): RestorePointRecord[] {
  const where = "journal.restorePoints";
  if (!Array.isArray(value)) throw new Error(`the state file's ${where} is not a list`);
  return value.map((entry: unknown) => {
    const r = object(entry, `${where} entry`);
    const outcome = r.outcome;
    if (!OUTCOMES.includes(outcome as (typeof OUTCOMES)[number])) {
      throw new Error(`the state file's ${where} entry has an unknown outcome`);
    }
    return {
      id: windowIdOf(r, "id", where),
      where: str(r, "where", where),
      ...optionalTimes(r, ["takenAt"], where),
      ...optionalCommit(r, "before", where),
      ...optionalCommit(r, "updatedTo", where),
      outcome: outcome as RestorePointRecord["outcome"],
      closedAt: requiredTime(r, "closedAt", where),
    };
  });
}

const SERVICE_ID = /^[a-z][a-z0-9-]{0,39}$/;
const REVISION = /^[0-9a-f]{16,64}$/;

function serviceList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && SERVICE_ID.test(v))) {
    throw new Error(`the state file's ${where} is not a list of service IDs`);
  }
  return [...value];
}

/** The MCP services' record (WP5.10, services.ts). IDs, a revision and times; never a secret. */
function parseMcpServices(value: unknown): McpServicesRecord {
  const where = "journal.mcpServices";
  const m = object(value, where);
  const record: Record<string, unknown> = { on: serviceList(m.on, `${where}.on`) };
  for (const key of ["changedAt", "confirmedAt"] as const) {
    const time = optionalTime(m, key, where);
    if (time !== undefined) record[key] = time;
  }
  if (m.revision !== undefined) {
    const revision = str(m, "revision", where);
    if (!REVISION.test(revision))
      throw new Error(`the state file's ${where}.revision is malformed`);
    record.revision = revision;
  }
  if (m.registry !== undefined) {
    if (typeof m.registry !== "boolean") {
      throw new Error(`the state file's ${where}.registry is not true or false`);
    }
    record.registry = m.registry;
  }
  if (m.pending !== undefined) {
    const pendingWhere = `${where}.pending`;
    const pending = object(m.pending, pendingWhere);
    const revision = str(pending, "revision", pendingWhere);
    const startedAt = optionalTime(pending, "startedAt", pendingWhere);
    if (!REVISION.test(revision) || startedAt === undefined) {
      throw new Error(`the state file's ${pendingWhere} is malformed`);
    }
    record.pending = { on: serviceList(pending.on, `${pendingWhere}.on`), revision, startedAt };
  }
  return record as unknown as McpServicesRecord;
}

/**
 * The state file's format for a plan and its journal. Version 2 records the plan's bucket tag
 * (D33); version 1, from before it, records none, so its buckets keep their untagged names. A
 * plan without a tag is still written as version 1, which earlier bootstraps read as before; a
 * tagged one as version 2, which they refuse ("unknown version") rather than drop the tag and
 * rename its buckets. Version 3 is either, with a journal that records WP3.34's fields: every
 * bootstrap from before WP3.34 refuses it rather than drop them (Codex WP3.34 r2-1). Version 4
 * is either, with a journal that records an update (WP3.35, `bootstrap.ts update`), for the same
 * reason: a bootstrap from before it would drop the record of an unfinished update and take the
 * installation for up to date. Version 5 is either, with a journal that records the MCP services
 * (WP5.10, `bootstrap.ts services`): a bootstrap from before it would drop which services are on.
 * Version 6 is either, with a journal that records an update's read-only window or restore
 * points (WP3.41): a bootstrap from before it would drop an open window and deploy over it.
 */
export function stateVersionFor(
  plan: Pick<Installation, "bucketTag">,
  journal: Readonly<Record<string, unknown>> = {},
): 1 | 2 | 3 | 4 | 5 | 6 {
  const j = journal as Partial<Journal>;
  if (j.window !== undefined || j.restorePoints !== undefined) return 6;
  if ((journal as Partial<Journal>).mcpServices !== undefined) return 5;
  // The last update's record (WP3.35), which a bootstrap from before it would drop.
  if ((journal as Partial<Journal>).update !== undefined) return 4;
  if (WP334_JOURNAL_FIELDS.some((key) => journal[key] !== undefined)) return 3;
  return plan.bucketTag === undefined ? 1 : 2;
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
  if (![1, 2, 3, 4, 5, 6].includes(o.stateVersion as number)) {
    throw new Error("the state file has an unknown version");
  }
  const installation = parseInstallation(o.installation);
  // Versions 3 to 6 hold a plan with or without a tag; 1 and 2 as their plans say.
  if (
    ![3, 4, 5, 6].includes(o.stateVersion as number) &&
    stateVersionFor(installation) !== o.stateVersion
  ) {
    throw new Error(
      o.stateVersion === 1
        ? "the state file's plan has a bucket tag, which only version 2 records"
        : "the state file's version 2 plan records no bucket tag",
    );
  }
  return {
    stateVersion: o.stateVersion as BootstrapState["stateVersion"],
    installation,
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
    // The version follows the plan and the journal, whatever the caller's state says
    // (stateVersionFor).
    save: (state) =>
      writeAtomic(
        path,
        `${JSON.stringify(
          {
            ...state,
            stateVersion: stateVersionFor(
              state.installation,
              state.journal as unknown as Record<string, unknown>,
            ),
          },
          null,
          2,
        )}\n`,
      ),
  };
}
