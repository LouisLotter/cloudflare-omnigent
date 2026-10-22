// A simulated Cloudflare for the bootstrap's tests (WP2.4): Worker versions with their secrets,
// the platform objects' switch to a new version about 300 s after it is deployed, and the
// watchdog's bootstrap status lines in Workers Logs, once a minute while the running version
// holds the bootstrap password (WP2.2's OmnigentServer), as Workers Logs delivers them.
// Test code only: it has no I/O, and it can make any call fail before or after its effect.

import type { BootstrapCloud, BootstrapState, StateStore } from "../machine.ts";
import {
  type AccessSettings,
  INITIALIZED_SECRET,
  type Installation,
  PASSWORD_SECRET,
} from "../settings.ts";

export const SWITCH_MS = 300_000;
/** From the platform's first deploy to the server's first answer (the cron starts it). */
export const START_MS = 90_000;
export const CHECK_MS = 60_000;

export interface Version {
  readonly id: string;
  readonly at: number;
  readonly secrets: ReadonlyMap<string, string>;
}

/** What the watchdog would find at a time: Omnigent's owner and the replicated position. */
export type ServerTruth = (t: number) => { initialized: boolean; reason: string };

export class Crash extends Error {}

export interface CrashPoint {
  /** The call: deployPlatform, deployWeb, updateSecrets, access, secretNames, logs, save. */
  readonly call: string;
  /** Which occurrence of it (1 is the first). */
  readonly nth: number;
  /** Before its effect, or after it (the answer is lost). */
  readonly when: "before" | "after";
}

export class FakeWorld {
  now = Date.UTC(2026, 9, 22, 12, 0, 0);
  readonly versions = new Map<string, Version[]>();
  readonly calls: string[] = [];
  readonly configs = new Map<string, Readonly<Record<string, unknown>>[]>();
  /** Every secret change, with the time it took effect. */
  readonly secretChanges: {
    at: number;
    worker: string;
    changes: Readonly<Record<string, string | null>>;
  }[] = [];
  /** Statuses from other installations or Workers, mixed into the logs. */
  readonly foreign: unknown[] = [];
  truth: ServerTruth = () => ({ initialized: true, reason: "durable" });
  access: () => AccessSettings = () => ({
    teamDomain: "team.cloudflareaccess.com",
    aud: "a".repeat(64),
  });
  crash: CrashPoint | undefined;
  /** Time a call takes, once: the clock moves on while it runs (a slow query, a suspended laptop). */
  slow: { call: string; nth: number; ms: number } | undefined;
  /** Something that happens just before a call, once: another hand acting meanwhile. */
  before: { call: string; nth: number; run: () => void } | undefined;
  /** Secrets a deploy loses (a broken upload). */
  dropOnDeploy: string[] = [];
  /** A secret change that reports success and changes nothing. */
  bulkKeeps = false;
  /** Workers Logs without versions, and no version listed by Cloudflare. */
  noVersions = false;
  /** Workers Logs loses this share of lines (0..1), deterministically by time. */
  lossEvery = 0;
  readonly counts = new Map<string, number>();
  #nextVersion = 1;

  readonly plan: Installation;

  constructor(plan: Installation) {
    this.plan = plan;
  }

  #enter(call: string): number {
    this.calls.push(call);
    const n = (this.counts.get(call) ?? 0) + 1;
    this.counts.set(call, n);
    if (this.before?.call === call && this.before.nth === n) {
      const run = this.before.run;
      this.before = undefined;
      run();
    }
    if (this.slow?.call === call && this.slow.nth === n) {
      this.now += this.slow.ms;
      this.slow = undefined;
    }
    if (this.crash?.call === call && this.crash.nth === n && this.crash.when === "before") {
      this.crash = undefined;
      throw new Crash(`crash before ${call}`);
    }
    return n;
  }

  #leave(call: string, n: number): void {
    if (this.crash?.call === call && this.crash.nth === n && this.crash.when === "after") {
      this.crash = undefined;
      throw new Crash(`crash after ${call}`);
    }
  }

  latest(worker: string): Version | undefined {
    return this.versions.get(worker)?.at(-1);
  }

  secretsOf(worker: string): ReadonlyMap<string, string> | undefined {
    return this.latest(worker)?.secrets;
  }

  #newVersion(worker: string, secrets: ReadonlyMap<string, string>): void {
    const list = this.versions.get(worker) ?? [];
    list.push({ id: `v${this.#nextVersion++}`, at: this.now, secrets });
    this.versions.set(worker, list);
  }

  /** The version the platform objects run at `t`: a new one about 300 s after its deploy. */
  activeAt(worker: string, t: number): Version | undefined {
    const list = this.versions.get(worker) ?? [];
    let active: Version | undefined;
    for (const [i, v] of list.entries()) {
      if (i === 0 ? v.at <= t : v.at + SWITCH_MS <= t) active = v;
    }
    return active;
  }

  cloud(): BootstrapCloud {
    const world = this;
    return {
      async secretNames(worker) {
        const n = world.#enter("secretNames");
        const secrets = world.secretsOf(worker);
        world.#leave("secretNames", n);
        return secrets === undefined ? null : [...secrets.keys()].sort();
      },
      async access() {
        const n = world.#enter("access");
        const found = world.access();
        world.#leave("access", n);
        return found;
      },
      async deployPlatform(plan, config, secrets) {
        const n = world.#enter("deployPlatform");
        const kept = new Map(world.secretsOf(plan.platformWorker) ?? []);
        for (const [key, value] of Object.entries(secrets)) kept.set(key, value);
        for (const key of world.dropOnDeploy) kept.delete(key);
        world.#newVersion(plan.platformWorker, kept);
        world.configs.set(plan.platformWorker, [
          ...(world.configs.get(plan.platformWorker) ?? []),
          config,
        ]);
        world.#leave("deployPlatform", n);
      },
      async deployWeb(plan, config) {
        const n = world.#enter("deployWeb");
        world.#newVersion(plan.webWorker, new Map());
        world.configs.set(plan.webWorker, [...(world.configs.get(plan.webWorker) ?? []), config]);
        world.#leave("deployWeb", n);
      },
      async updateSecrets(worker, changes) {
        const n = world.#enter("updateSecrets");
        const current = world.secretsOf(worker);
        // Like cf workers secrets bulk: a missing Worker is an error, never created.
        if (current === undefined) throw new Error("cf workers secrets bulk failed: [10007]");
        const next = new Map(current);
        for (const [key, value] of Object.entries(world.bulkKeeps ? {} : changes)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        world.#newVersion(worker, next);
        world.secretChanges.push({ at: world.now, worker, changes });
        world.#leave("updateSecrets", n);
      },
      async activeVersion(worker) {
        const n = world.#enter("activeVersion");
        const id = world.noVersions ? undefined : world.latest(worker)?.id;
        world.#leave("activeVersion", n);
        return id;
      },
      async logs(worker, fromMs, toMs) {
        const n = world.#enter("logs");
        const events = world.logEvents(worker, fromMs, toMs);
        world.#leave("logs", n);
        return events;
      },
    };
  }

  /** What Workers Logs answers: the watchdog's alarms and, while it holds the password, its status. */
  logEvents(worker: string, fromMs: number, toMs: number): unknown[] {
    const first = this.versions.get(worker)?.[0];
    if (first === undefined || worker !== this.plan.platformWorker) return [...this.foreign];
    const events: unknown[] = [];
    const startAt = first.at + START_MS;
    for (let t = startAt; t <= Math.min(toMs, this.now); t += CHECK_MS) {
      if (t < fromMs) continue;
      if (this.lossEvery > 0 && Math.floor(t / CHECK_MS) % Math.round(1 / this.lossEvery) === 0) {
        continue;
      }
      const version = this.activeAt(worker, t);
      if (version === undefined) continue;
      const $workers = {
        scriptName: worker,
        scriptVersion: { id: this.noVersions ? "" : version.id },
        eventType: "alarm",
        entrypoint: "OmnigentServer",
      };
      events.push({ timestamp: t, $workers, source: { level: "info", message: "" } });
      if (!version.secrets.has(PASSWORD_SECRET)) continue;
      const truth = this.truth(t);
      events.push({
        timestamp: t,
        $workers,
        $metadata: { id: `e${t}` },
        source: {
          cfo: "bootstrap",
          event: "status",
          reason: truth.reason,
          bootstrapStatus: {
            protocolVersion: 1,
            installationId: this.plan.installationId,
            initialized: truth.initialized,
            checkedAt: new Date(t).toISOString(),
          },
          secretPresent: true,
        },
      });
    }
    return [...events.reverse(), ...this.foreign];
  }

  /** Whether the installation is released: initialized set and the password gone. */
  released(): boolean {
    const secrets = this.secretsOf(this.plan.platformWorker);
    return secrets?.get(INITIALIZED_SECRET) === "true" && !secrets.has(PASSWORD_SECRET);
  }
}

export class MemoryStore implements StateStore {
  state: BootstrapState;
  saves = 0;
  crash: { nth: number } | undefined;

  constructor(state: BootstrapState) {
    this.state = state;
  }

  load(): BootstrapState {
    return structuredClone(this.state);
  }

  save(state: BootstrapState): void {
    this.saves++;
    if (this.crash?.nth === this.saves) {
      this.crash = undefined;
      throw new Crash("crash before a journal write");
    }
    this.state = structuredClone(state);
  }
}
