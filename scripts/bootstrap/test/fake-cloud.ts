// A simulated Cloudflare for the bootstrap's tests (WP2.4): Worker versions with their secrets,
// the platform objects' switch to a new version about 300 s after it is deployed, and the
// watchdog's bootstrap status lines in Workers Logs, once a minute while the running version
// holds the bootstrap password (WP2.2's OmnigentServer), as Workers Logs delivers them.
// The server container keeps the configuration it was started with (the version's secrets and its
// `SERVER_ENV_` variables): a new version adopts it, and its watchdog replaces it once (a restart
// of `REPLACE_MS`) when its configuration differs.
// The server then logs its status without the password until it shows a durable owner, and for
// `NOTICE_MS` after (G2-SEC-001).
// The installer's user API tokens (WP3.25) live here too, with the same crash points, and so does
// Access in the installer's account (WP3.31): the organization, the applications and the login
// methods, as cf answers for them.
// Test code only: it has no I/O, and it can make any call fail before or after its effect.

import { type AccessApi, AccessUnavailable, type IdentityProvider } from "../access-app.ts";
import type { BootstrapCloud, BootstrapState, StateStore } from "../machine.ts";
import {
  type ApiToken,
  R2_WRITE_GROUP,
  s3Credentials,
  type TokenApi,
  TokensUnavailable,
} from "../r2-token.ts";
import {
  type AccessSettings,
  INITIALIZED_SECRET,
  type Installation,
  PASSWORD_SECRET,
} from "../settings.ts";
import { parseState } from "../state.ts";

export const SWITCH_MS = 300_000;
/** From the platform's first deploy to the server's first answer (the cron starts it). */
export const START_MS = 90_000;
export const CHECK_MS = 60_000;
/** A replacement after a release: the stop, its final sync, a start and the restore. */
export const REPLACE_MS = 90_000;
/** How long a server started with a new configuration logs its status (APPLIED_NOTICE_MS). */
export const NOTICE_MS = 15 * 60_000;

export interface Version {
  readonly id: string;
  readonly at: number;
  readonly secrets: ReadonlyMap<string, string>;
  /** The `SERVER_ENV_` variables the version's configuration gives the server, as one text. */
  readonly serverVars: string;
}

/** What the watchdog would find at a time: Omnigent's owner and the replicated position. */
export type ServerTruth = (t: number) => { initialized: boolean; reason: string };

export class Crash extends Error {}

/** The synthetic ID of "Workers R2 Storage Bucket Item Write". */
export const R2_GROUP_ID = `${"0".repeat(31)}9`;

export interface CrashPoint {
  /**
   * The call: deployPlatform, deployWeb, updateSecrets, access, secretNames, logs, save, the
   * token calls tokenGroup, tokenList, tokenCreate and tokenRemove, and the Access calls
   * accessOrg, accessList, accessGet, accessCreate, accessRemove, loginList and loginCreate.
   */
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
  /**
   * A call that takes effect and then fails with this message, as `wrangler deploy` does when the
   * new version is live but its `durable_object` container application could not be applied.
   */
  failAfter: { call: string; nth: number; message: string } | undefined;
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
  /** Unrelated lines the platform Worker logs each minute (computers, other objects). */
  noisePerMinute = 0;
  /** At most this many events per query, newest first, as `cf o11y telemetry query` pages. */
  logCap: number | undefined;
  /**
   * Whether the platform's watchdog replaces a server whose configuration changed. False models
   * a build without G2-SEC-001: a release never reaches the running server.
   */
  appliesReleases = true;
  readonly counts = new Map<string, number>();
  /** The installer's user API tokens, with the value each has now. */
  readonly tokens = new Map<string, { token: ApiToken; value: string }>();
  /** Cloudflare answers 403 to every token call: a login that may not make tokens. */
  tokensForbidden = false;
  /**
   * Cloudflare answers 403 to listing and deleting tokens, but lets the login make them: cf's
   * OAuth login, as found on 28 Oct (WP3.25). The default, as for the owner.
   */
  oauthLogin = true;
  /**
   * A token request whose client gives up (cf fails with a timeout) while the request itself
   * takes effect `afterMs` later, as a request left in flight by a stopped run may.
   */
  late: { call: "tokenCreate" | "accessCreate"; nth: number; afterMs: number } | undefined;
  /** The Zero Trust organization's team domain; undefined: the account has none. */
  teamDomain: string | undefined = "team.cloudflareaccess.com";
  /** Access applications in the account, by ID, as Cloudflare answers for them. */
  readonly accessApps = new Map<string, Record<string, unknown>>();
  /** The account's login methods. */
  loginMethods: IdentityProvider[] = [{ id: "idp-onetimepin", type: "onetimepin" }];
  /** Cloudflare answers 403 to creating and deleting Access applications. */
  accessForbidden = false;
  /** Cloudflare answers 403 to reading and adding login methods. */
  loginsForbidden = false;
  #nextApp = 1;
  #landing: { due: number; apply: () => void }[] = [];
  #nextVersion = 1;
  #nextToken = 1;

  readonly plan: Installation;

  constructor(plan: Installation) {
    this.plan = plan;
  }

  /** Lands every late request now, however long it would still take. */
  landLate(): void {
    for (const { apply } of this.#landing.splice(0)) apply();
  }

  #enter(call: string): number {
    // Late requests whose time has come land before anything else is seen.
    const due = this.#landing.filter((l) => l.due <= this.now);
    this.#landing = this.#landing.filter((l) => l.due > this.now);
    for (const { apply } of due) apply();
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
    if (this.failAfter?.call === call && this.failAfter.nth === n) {
      const { message } = this.failAfter;
      this.failAfter = undefined;
      throw new Error(message);
    }
  }

  latest(worker: string): Version | undefined {
    return this.versions.get(worker)?.at(-1);
  }

  secretsOf(worker: string): ReadonlyMap<string, string> | undefined {
    return this.latest(worker)?.secrets;
  }

  #newVersion(worker: string, secrets: ReadonlyMap<string, string>, serverVars = ""): void {
    const list = this.versions.get(worker) ?? [];
    list.push({ id: `v${this.#nextVersion++}`, at: this.now, secrets, serverVars });
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
        world.#newVersion(plan.platformWorker, kept, serverVarsOf(config));
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
      async workerInstallation(worker) {
        const n = world.#enter("workerInstallation");
        const exists = world.versions.has(worker);
        const vars = (world.configs.get(worker)?.at(-1)?.vars ?? {}) as Record<string, string>;
        world.#leave("workerInstallation", n);
        if (!exists) return { exists: false };
        const id = vars.CFO_INSTALLATION_ID;
        const versionId = world.noVersions ? undefined : world.latest(worker)?.id;
        return {
          exists: true,
          installationId: typeof id === "string" ? id : undefined,
          ...(versionId === undefined ? {} : { versionId }),
          vars: { ...vars },
        };
      },
      async updateSecrets(worker, changes, notAfter) {
        const n = world.#enter("updateSecrets");
        // Like the adapters: the window is checked after every read, just before the request.
        if (notAfter !== undefined && world.now > notAfter) {
          world.#leave("updateSecrets", n);
          return "expired";
        }
        const current = world.secretsOf(worker);
        // Like cf workers secrets bulk: a missing Worker is an error, never created.
        if (current === undefined) throw new Error("cf workers secrets bulk failed: [10007]");
        const next = new Map(current);
        for (const [key, value] of Object.entries(world.bulkKeeps ? {} : changes)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        world.#newVersion(worker, next, world.latest(worker)?.serverVars);
        world.secretChanges.push({ at: world.now, worker, changes });
        world.#leave("updateSecrets", n);
        return "sent";
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
        return world.logCap === undefined ? events : events.slice(0, world.logCap);
      },
    };
  }

  /** An Access application as Cloudflare answers for it: AUD and defaults filled in. */
  addAccessApp(app: Record<string, unknown>): string {
    const id = typeof app.id === "string" ? app.id : `app-${this.#nextApp++}`;
    this.accessApps.set(id, {
      aud: `${"a".repeat(60)}${String(this.#nextApp).padStart(4, "0")}`,
      options_preflight_bypass: false,
      http_only_cookie_attribute: true,
      ...structuredClone(app),
      id,
    });
    return id;
  }

  accessApi(): AccessApi {
    const call = <T>(name: string, forbidden: boolean, effect: () => T): T => {
      const n = this.#enter(name);
      if (forbidden) throw new AccessUnavailable("Cloudflare refused (403)");
      if (this.late?.call === name && this.late.nth === n) {
        this.#landing.push({ due: this.now + this.late.afterMs, apply: () => void effect() });
        this.late = undefined;
        throw new Error("cf zero-trust access applications create failed: timeout");
      }
      const result = effect();
      this.#leave(name, n);
      return result;
    };
    return {
      teamDomain: () => call("accessOrg", false, () => this.teamDomain),
      apps: () =>
        call("accessList", false, () =>
          [...this.accessApps.values()].map((a) => structuredClone(a)),
        ),
      app: (id) => call("accessGet", false, () => structuredClone(this.accessApps.get(id))),
      create: (body) =>
        call("accessCreate", this.accessForbidden, () =>
          this.addAccessApp({ ...body, id: `app-${this.#nextApp++}` }),
        ),
      identityProviders: () =>
        call("loginList", this.loginsForbidden, () => this.loginMethods.map((m) => ({ ...m }))),
      createOneTimePin: () =>
        call("loginCreate", this.loginsForbidden, () => {
          if (this.loginMethods.some((m) => m.type === "onetimepin")) {
            throw new Error("cf zero-trust identity-providers create failed: [12130] exists");
          }
          const method = { id: "idp-added-onetimepin", type: "onetimepin" };
          this.loginMethods = [...this.loginMethods, method];
          return method.id;
        }),
      remove: (id) =>
        call("accessRemove", this.accessForbidden, () =>
          this.accessApps.delete(id) ? "deleted" : "absent",
        ),
    };
  }

  /** A token as another hand (or an earlier run) left it. */
  addToken(token: Omit<ApiToken, "id" | "ipLimited"> & Partial<ApiToken>): string {
    const id = token.id ?? this.#tokenId();
    this.tokens.set(id, {
      token: { ipLimited: false, ...token, id },
      value: `cfo-canary-r2-token-value-${id}`,
    });
    return id;
  }

  #tokenId(): string {
    return `cfocanary${String(this.#nextToken++).padStart(23, "0")}`;
  }

  /** The S3 key pair the token's current value gives. */
  pairOf(id: string): { accessKeyId: string; secretAccessKey: string } {
    const entry = this.tokens.get(id);
    if (entry === undefined) throw new Error(`no token ${id}`);
    return s3Credentials(id, entry.value);
  }

  tokenApi(): TokenApi {
    const call = <T>(name: string, effect: () => T): T => {
      const n = this.#enter(name);
      const managing = name === "tokenList" || name === "tokenRemove";
      if (this.tokensForbidden || (this.oauthLogin && managing)) {
        throw new TokensUnavailable("Cloudflare refused (403)");
      }
      if (this.late?.call === name && this.late.nth === n) {
        this.#landing.push({ due: this.now + this.late.afterMs, apply: () => void effect() });
        this.late = undefined;
        throw new Error("cf user tokens create failed: timeout");
      }
      const result = effect();
      this.#leave(name, n);
      return result;
    };
    return {
      permissionGroup: (name) =>
        call("tokenGroup", () => {
          if (name !== R2_WRITE_GROUP) throw new Error(`no permission group ${name}`);
          return R2_GROUP_ID;
        }),
      list: () => call("tokenList", () => [...this.tokens.values()].map((t) => t.token)),
      // An OAuth login may read a token by its ID (28 Oct): 404 once it is gone.
      get: (id) => call("tokenGet", () => this.tokens.get(id)?.token),
      create: (request) =>
        call("tokenCreate", () => {
          const id = this.#tokenId();
          const value = `cfo-canary-r2-token-value-${id}-1`;
          this.tokens.set(id, {
            token: {
              id,
              name: request.name,
              status: "active",
              ...(request.expiresOn === undefined ? {} : { expiresOn: request.expiresOn }),
              ipLimited: false,
              policies: request.policies.map((p) => ({
                effect: p.effect,
                permissionGroups: p.permission_groups.map((g) => g.id),
                resources: p.resources,
              })),
            },
            value,
          });
          return { id, value };
        }),
      remove: (id) => call("tokenRemove", () => (this.tokens.delete(id) ? "deleted" : "absent")),
    };
  }

  /**
   * The server container at `t`: the version whose configuration it was started with, and since
   * when it answers with it. Undefined before the first start.
   */
  containerAt(worker: string, t: number): { version: Version; since: number } | undefined {
    const list = this.versions.get(worker) ?? [];
    const first = list[0];
    if (first === undefined || t < first.at + START_MS) return undefined;
    let running = { version: first, since: first.at + START_MS };
    for (const v of list.slice(1)) {
      const switchAt = v.at + SWITCH_MS;
      if (switchAt > t) break;
      if (this.appliesReleases && !sameConfig(v, running.version)) {
        running = { version: v, since: Math.max(switchAt, running.since) + REPLACE_MS };
      }
    }
    return running;
  }

  /**
   * What Workers Logs answers: the watchdog's alarms and its status while the running version
   * holds the password, or for a while after a server started with a new configuration answers.
   */
  logEvents(worker: string, fromMs: number, toMs: number): unknown[] {
    const first = this.versions.get(worker)?.[0];
    if (first === undefined || worker !== this.plan.platformWorker) return [...this.foreign];
    const events: unknown[] = [];
    const startAt = first.at + START_MS;
    // When each container started with a new configuration last became durable: its notice
    // runs until then and for NOTICE_MS after, and again from each return to durable
    // (OmnigentServer's, Codex r1-2 and r2-2).
    const durableSince = new Map<number, number>();
    let wasDurable = false;
    for (let t = startAt; t <= Math.min(toMs, this.now); t += CHECK_MS) {
      const running = this.containerAt(worker, t);
      const truth = this.truth(t);
      if (running !== undefined && t >= running.since && truth.initialized) {
        if (!durableSince.has(running.since) || !wasDurable) durableSince.set(running.since, t);
      }
      wasDurable = truth.initialized;
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
      for (let i = 1; i <= this.noisePerMinute; i++) {
        events.push({
          timestamp: t + i,
          $workers: { ...$workers, eventType: "fetch", entrypoint: "ControlDO" },
          source: { cfo: "control", event: "noise" },
        });
      }
      // The status comes only from a server that answers with this version's configuration:
      // one being replaced, or one an older build never replaced, logs none.
      const container = this.containerAt(worker, t);
      const applied =
        container !== undefined && t >= container.since && sameConfig(container.version, version);
      const secretPresent = version.secrets.has(PASSWORD_SECRET);
      const durableAt = container === undefined ? undefined : durableSince.get(container.since);
      const announcing = !truth.initialized || durableAt === undefined || t - durableAt < NOTICE_MS;
      if (!applied || !(secretPresent || (announcing && this.appliesReleases))) continue;
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
          secretPresent,
          ...(this.appliesReleases ? { configApplied: true } : {}),
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

function sameSecrets(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  return a.size === b.size && [...a].every(([name, value]) => b.get(name) === value);
}

/**
 * Whether a server started with one version's configuration runs another's (the fingerprint):
 * the secrets and variables that reach the server, `SERVER_ENV_` ones only, as in production.
 */
function sameConfig(a: Version, b: Version): boolean {
  return sameSecrets(serverSecrets(a), serverSecrets(b)) && a.serverVars === b.serverVars;
}

function serverSecrets(v: Version): Map<string, string> {
  return new Map([...v.secrets].filter(([name]) => name.startsWith("SERVER_ENV_")));
}

/** The `SERVER_ENV_` variables of a deployed configuration, as one text. */
function serverVarsOf(config: Readonly<Record<string, unknown>>): string {
  const vars = (config.vars ?? {}) as Record<string, unknown>;
  return JSON.stringify(
    Object.entries(vars)
      .filter(([name]) => name.startsWith("SERVER_ENV_"))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export class MemoryStore implements StateStore {
  state: BootstrapState;
  saves = 0;
  crash: { nth: number } | undefined;

  constructor(state: BootstrapState) {
    this.state = state;
  }

  /** Through the production parser, as the state file is read: a field it drops is lost here too. */
  load(): BootstrapState {
    return parseState(JSON.stringify(this.state));
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
