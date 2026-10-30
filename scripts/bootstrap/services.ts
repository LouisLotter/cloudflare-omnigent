// The installer's MCP services step (WP5.10): `bootstrap.ts services [add|remove <id>]`.
// Written against the bootstrap's ports, so tests drive it with a fake Cloudflare. No I/O of its
// own.
//
// Omnigent's own MCP registry runs on the server (owner decision D43): its Settings → MCP page
// connects and disconnects accounts, its gateway calls the services, and every login stays on the
// server, sealed by the platform's key service. The services it may offer ship in the server
// image as manifests (`images/server/services/<id>.json`); an installation only chooses which are
// on, and gives what a manifest asks for. This step:
//   1. checks the plan's platform Worker exists, is this installation's, runs a release with the
//      MCP manifests and the server's MCP report (`mcp-services`; else: `bootstrap.ts update`
//      first), and holds the credential store's keys (made at install and by `update`);
//   2. asks for what the manifest asks: the service's origin (`--origin`, or typed), an OAuth
//      client's ID and secret (typed, never shown, never on an argument);
//   3. stores the choices in one change of the Worker's secrets (`updateSecrets`, the bootstrap's
//      descriptor transport): the list of services that are on (`CFO_MCP_SERVICES`), the asked
//      values (`CFO_MCP_ORIGIN_<KEY>`, `CFO_MCP_CLIENT_ID_<KEY>`, `CFO_MCP_CLIENT_SECRET_<KEY>`,
//      all `SERVER_ENV_`), and a new revision (`CFO_MCP_REVISION`). Removing a service deletes
//      the values it was given. The journal records the list it writes, intent first;
//   4. waits until a server started with that revision answers (the watchdog's status line, the
//      reader the GitHub step uses: `checkMcpServices`), and says whether Omnigent lists MCP:
//      "Ready. Connect it in Omnigent: Settings → MCP", or what is wrong (off, held, not yet).
//
// What it never does: print, log, keep or put in an argument an asked secret; talk to the
// installation itself (Access is in front of it); turn on a service the image does not ship.
// Approvals are not its concern: writes go through Omnigent's own policies as they are.

import { MCP_REVISION_ENV } from "../../worker/src/server/mcp-services.ts";
import { checkMcpServices, parseLogs } from "./events.ts";
import {
  type BootstrapCloud,
  type McpServicesRecord,
  type StateStore,
  slicedLogs,
} from "./machine.ts";
import {
  CREDENTIAL_STORE_SECRETS,
  type Installation,
  offersPlatformFeature,
  SERVER_ENV,
} from "./settings.ts";
import { pollServer } from "./update.ts";
import { windowRefusal } from "./window.ts";

/** The settings the server image reads (images/server/cfo_server/mcp.py), as the Worker holds them. */
export const MCP_SERVICES_SECRET = `${SERVER_ENV}CFO_MCP_SERVICES`;
export const MCP_REVISION_SECRET = MCP_REVISION_ENV;
const ORIGIN_SECRET = `${SERVER_ENV}CFO_MCP_ORIGIN_`;
const CLIENT_ID_SECRET = `${SERVER_ENV}CFO_MCP_CLIENT_ID_`;
const CLIENT_SECRET_SECRET = `${SERVER_ENV}CFO_MCP_CLIENT_SECRET_`;
/** The Worker secrets that hold asked values, whichever service they belong to. */
const ASKED_PREFIXES = [ORIGIN_SECRET, CLIENT_ID_SECRET, CLIENT_SECRET_SECRET] as const;
/** The GitHub App's client ID, as github-app.ts stores it: GitHub linking is set up. */
const GITHUB_APP_CLIENT_ID = `${SERVER_ENV}OMNIGENT_GITHUB_APP_CLIENT_ID`;
/** Omnigent's Settings → MCP, on the installation's hostname. */
export const SETTINGS_MCP_PATH = "/settings/mcp";
const SETTINGS_INTEGRATIONS_PATH = "/settings/integrations";

export const DEFAULT_SERVICES_WAIT_MS = 20 * 60_000;
export const DEFAULT_SERVICES_POLL_MS = 20_000;

/** A service ID as the image accepts it (cfo_server/mcp.py, SERVICE_ID). */
const SERVICE_ID = /^[a-z][a-z0-9-]{0,39}$/;
const ASKS = ["origin", "client_id", "client_secret"] as const;
export type Ask = (typeof ASKS)[number];

/** A refusal the installer can act on: the message says what to do. Never carries a secret. */
export class ServicesRefusal extends Error {}

/** What the step needs to know of a shipped manifest. The image checks the rest. */
export interface ServiceManifest {
  readonly id: string;
  readonly title: string;
  readonly auth: string;
  readonly asks: readonly Ask[];
}

/** A shipped manifest's content, read for what the step needs; throws naming the file. */
export function readManifest(name: string, data: unknown): ServiceManifest {
  const where = `the manifest ${name}`;
  const o = data as {
    manifest?: unknown;
    asks?: unknown;
    service?: { id?: unknown; title?: unknown; auth?: unknown };
  } | null;
  if (o === null || typeof o !== "object" || o.manifest !== 1) {
    throw new Error(`${where} is not a version 1 manifest`);
  }
  const service = o.service;
  if (
    service === undefined ||
    typeof service.id !== "string" ||
    service.id !== name ||
    !SERVICE_ID.test(service.id) ||
    typeof service.title !== "string" ||
    typeof service.auth !== "string"
  ) {
    throw new Error(`${where} does not name its service as the file does`);
  }
  if (!Array.isArray(o.asks) || !o.asks.every((a) => (ASKS as readonly unknown[]).includes(a))) {
    throw new Error(`${where}'s asks are not ${ASKS.join(", ")}`);
  }
  return { id: service.id, title: service.title, auth: service.auth, asks: o.asks as Ask[] };
}

/** `<KEY>` of a service's settings: its ID in capitals, `-` as `_` (cfo_server/mcp.py). */
export function envKey(id: string): string {
  return id.toUpperCase().replaceAll("-", "_");
}

/** The Worker secrets that hold what a service asks for. */
export function askedSecrets(manifest: ServiceManifest): Record<Ask, string> {
  const key = envKey(manifest.id);
  return {
    origin: `${ORIGIN_SECRET}${key}`,
    client_id: `${CLIENT_ID_SECRET}${key}`,
    client_secret: `${CLIENT_SECRET_SECRET}${key}`,
  };
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const REFUSED_SUFFIXES = new Set(["localhost", "internal", "local"]);

/**
 * Why a URL breaks the image's destination rules (cfo_server/mcp.py, `destination_problem`), in
 * words that never repeat it; undefined if it does not. The image enforces them at every start;
 * the step checks first, so that a mistake never stops the server. Both test suites read the same
 * vectors (images/server/tests/destination_vectors.json).
 */
export function destinationProblem(url: string): string | undefined {
  if (/[\s\\]/u.test(url) || /\p{Cc}/u.test(url)) return "it must be a plain URL";
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (scheme === null) return "it must be a well-formed URL";
  const rest = url.slice(scheme[0].length);
  const authority = rest.split(/[/?#]/, 1)[0] ?? "";
  const after = rest.slice(authority.length);
  if (authority.includes("@")) return "it must not carry credentials";
  if (after.includes("?") || after.includes("#")) return "it must not carry a query or a fragment";
  let host = authority;
  let port: string | undefined;
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close < 0) return "it must be a well-formed URL";
    return "it must name a host, not an IP address";
  }
  const colon = host.lastIndexOf(":");
  if (colon >= 0) {
    port = host.slice(colon + 1);
    host = host.slice(0, colon);
    // At most five digits, as the image reads them (Codex WP5.10 r1-3).
    if (!/^[0-9]{0,5}$/.test(port) || (port !== "" && Number(port) > 65535)) {
      return "it must be a well-formed URL";
    }
    if (port !== "" && Number(port) === 0) return "it must not use port 0";
  }
  if (scheme[1]?.toLowerCase() !== "https") return "it must be https";
  host = host.toLowerCase().replace(/\.$/, "");
  if (host === "") return "it must name a host";
  if (/^[0-9.]+$/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return "it must name a host, not an IP address";
  }
  const labels = host.split(".");
  if (host.length > 253 || !labels.every((label) => LABEL.test(label))) {
    return "it must name a host in lower case letters, digits and hyphens";
  }
  const top = labels.at(-1) ?? "";
  if (labels.length < 2 || !TLD.test(top)) {
    return "it must name a public host (a name with a real top-level domain)";
  }
  if (REFUSED_SUFFIXES.has(top)) return `it must not be a ${top} host`;
  return undefined;
}

/** An origin a manifest asks for, checked: `https://host[:port]`, nothing after. */
export function originProblem(origin: string): string | undefined {
  const problem = destinationProblem(origin);
  if (problem !== undefined) return problem;
  const rest = origin.slice(origin.indexOf("://") + 3);
  const path = rest.slice(rest.split("/", 1)[0]?.length ?? 0);
  return path === "" || path === "/" ? undefined : "it must be an origin, with no path";
}

function normalOrigin(origin: string): string {
  return origin.replace(/\/$/, "").replace(/^https:\/\/[^/]+/i, (head) => head.toLowerCase());
}

/** An OAuth client's ID or secret: printable ASCII, no spaces (cfo_server/mcp.py). */
function valueProblem(value: string, limit: number): string | undefined {
  if (value === "") return "it is empty";
  if (value.length > limit) return `it is longer than ${limit} characters`;
  if (!/^[!-~]+$/.test(value)) return "it must be printable characters without spaces";
  return undefined;
}

export interface ServicesPorts {
  readonly cloud: Pick<
    BootstrapCloud,
    "secretNames" | "workerInstallation" | "updateSecrets" | "logs"
  >;
  readonly store: StateStore;
  /** The manifests this checkout ships, by ID: the ones the release's image holds. */
  readonly manifests: ReadonlyMap<string, ServiceManifest>;
  /**
   * Asks the person for a value, typed in the terminal: shown as typed when it is not a secret,
   * never shown when it is. Never called for a value given on the command line.
   */
  ask(question: string, options: { readonly secret: boolean }): Promise<string>;
  random(bytes: number): Uint8Array;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

export type ServicesChange =
  | { readonly kind: "add"; readonly id: string; readonly origin?: string }
  | { readonly kind: "remove"; readonly id: string };

export interface ServicesOptions {
  /** Replace a list of services this state file does not know (set from elsewhere). */
  readonly replace?: boolean;
  readonly waitMs?: number;
  readonly pollMs?: number;
}

/**
 * How a change ended once it was stored. `ready`: a server started with it answers, and Omnigent
 * lists MCP exactly when a service is on. Otherwise: `off` (it answers, but Omnigent lists no MCP:
 * a prerequisite is missing, `config.warning` names it), `held` (the server refused a setting and
 * is stopped, exit 78), or `waiting` (not confirmed in time; `why` says what was seen last).
 */
export type ServicesOutcome =
  | { readonly kind: "ready" | "off" | "held"; readonly on: readonly string[] }
  | { readonly kind: "waiting"; readonly on: readonly string[]; readonly why: string }
  | { readonly kind: "unchanged"; readonly on: readonly string[] };

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The services on, as the journal records them, and whether a change may be under way. */
export function servicesOn(record: McpServicesRecord | undefined): readonly string[] {
  return record?.on ?? [];
}

/**
 * The checks before anything is asked: this installation's platform Worker, on a release with the
 * MCP manifests and report, holding the credential store's keys. Returns its secret names.
 */
async function preflight(
  plan: Installation,
  ports: ServicesPorts,
  record: McpServicesRecord | undefined,
  replace: boolean,
): Promise<Set<string>> {
  const nothing = "; nothing was changed";
  const names = await ports.cloud.secretNames(plan.platformWorker);
  if (names === null) {
    throw new ServicesRefusal(
      `${plan.platformWorker} does not exist yet: finish the installation with bootstrap.ts install first`,
    );
  }
  const identity = await ports.cloud.workerInstallation(plan.platformWorker);
  if (!identity.exists || identity.installationId !== plan.installationId) {
    throw new ServicesRefusal(
      `${plan.platformWorker} is not serving installation ${plan.installationId}${nothing}`,
    );
  }
  if (!offersPlatformFeature(identity.vars, "mcp-services")) {
    throw new ServicesRefusal(
      `${plan.platformWorker} runs a release from before MCP services: update the installation first with bootstrap.ts update, then run this step again${nothing}`,
    );
  }
  const present = new Set(names);
  const lacking = CREDENTIAL_STORE_SECRETS.filter((name) => !present.has(name));
  if (lacking.length > 0) {
    throw new ServicesRefusal(
      `${plan.platformWorker} lacks ${lacking.join(", ")}, which logins need: run bootstrap.ts update, which adds ${lacking.length === 1 ? "it" : "them"}${nothing}`,
    );
  }
  if (record === undefined && present.has(MCP_SERVICES_SECRET) && !replace) {
    throw new ServicesRefusal(
      `${plan.platformWorker} holds a list of MCP services this state file does not record (set from another laptop?). Run this step where it was set, or run again with --replace to write the list from this state file${nothing}`,
    );
  }
  return present;
}

/** Asks for what the manifest asks, checking each answer; never logs one. */
async function askFor(
  manifest: ServiceManifest,
  ports: ServicesPorts,
  given: { readonly origin?: string },
): Promise<Record<string, string>> {
  const secrets = askedSecrets(manifest);
  const values: Record<string, string> = {};
  for (const ask of manifest.asks) {
    if (ask === "origin") {
      const origin = (
        given.origin ??
        (await ports.ask(`${manifest.title}: the service's address (https://host, no path): `, {
          secret: false,
        }))
      ).trim();
      const problem = originProblem(origin);
      if (problem !== undefined) {
        throw new ServicesRefusal(
          `the service's address breaks a rule: ${problem}; nothing was changed`,
        );
      }
      values[secrets.origin] = normalOrigin(origin);
    } else {
      const secret = ask === "client_secret";
      const what = secret ? "OAuth client secret" : "OAuth client ID";
      const value = (
        await ports.ask(`${manifest.title}: its ${what} (not shown): `, { secret: true })
      ).trim();
      const problem = valueProblem(value, secret ? 1024 : 256);
      if (problem !== undefined) {
        throw new ServicesRefusal(`the ${what} is not usable: ${problem}; nothing was changed`);
      }
      values[secrets[ask]] = value;
    }
  }
  return values;
}

/**
 * Turns one shipped service on or off, and waits until a server started with the change
 * answers. Refuses (ServicesRefusal) before any change when a check fails.
 */
export async function changeServices(
  plan: Installation,
  ports: ServicesPorts,
  change: ServicesChange,
  options: ServicesOptions = {},
): Promise<ServicesOutcome> {
  let state = ports.store.load();
  // Not inside an update's read-only window (WP3.41): a rollback would undo this change unseen.
  const inWindow = windowRefusal(state.journal);
  if (inWindow !== undefined) throw new ServicesRefusal(`${inWindow}; nothing was changed`);
  const record = state.journal.mcpServices;
  const manifest = ports.manifests.get(change.id);
  if (manifest === undefined) {
    const shipped = [...ports.manifests.keys()].sort().join(", ") || "none";
    throw new ServicesRefusal(
      `no MCP service ${JSON.stringify(change.id)} ships with this release (it has: ${shipped}); nothing was changed`,
    );
  }
  const present = await preflight(plan, ports, record, options.replace === true);
  // Whether the Worker's list is known: not after a change whose outcome is unknown (an
  // interrupted upload, a lost answer), nor when --replace overrides a list set elsewhere. Then no
  // shortcut is taken: the whole list is written again (Codex WP5.10 r1-1).
  const uncertain =
    record?.pending !== undefined || (record === undefined && present.has(MCP_SERVICES_SECRET));
  if (record?.pending !== undefined) {
    ports.log(
      "an earlier change of the MCP services may not have reached the installation; this one writes the whole list again",
    );
  }
  // The list this change starts from: the last intent, keeping only services this release ships
  // whose asked values the Worker holds (an earlier change that never arrived, or a removal that
  // did, may have left a service without them, which the server would refuse).
  const intended = record?.pending?.on ?? servicesOn(record);
  const before = intended.filter((id) => {
    if (id === manifest.id) return true;
    const other = ports.manifests.get(id);
    const why =
      other === undefined
        ? "this release does not ship it"
        : other.asks.every((ask) => present.has(askedSecrets(other)[ask]))
          ? undefined
          : "the installation does not hold the values it was given";
    if (why !== undefined) ports.log(`${id} is left off: ${why}; add it again to turn it on`);
    return why === undefined;
  });
  // A service left off is a change the Worker's list needs, whatever else this one asks
  // (Codex WP5.10 r2-1): no shortcut then either.
  const rewrite = uncertain || before.length !== intended.length;
  const changes: Record<string, string | null> = {};
  let on: string[];
  if (change.kind === "add") {
    if (manifest.auth === "github" && !present.has(GITHUB_APP_CLIENT_ID)) {
      throw new ServicesRefusal(
        `${manifest.title} uses Omnigent's GitHub linking, which this installation has not set up: run bootstrap.ts github-app first; nothing was changed`,
      );
    }
    if (!rewrite && before.includes(manifest.id) && manifest.asks.length === 0) {
      ports.log(`${manifest.title} (${manifest.id}) is on already; nothing was changed`);
      return { kind: "unchanged", on: before };
    }
    Object.assign(changes, await askFor(manifest, ports, change));
    on = [...new Set([...before, manifest.id])].sort();
  } else {
    if (!rewrite && !before.includes(manifest.id)) {
      ports.log(`${manifest.title} (${manifest.id}) is not on; nothing was changed`);
      return { kind: "unchanged", on: before };
    }
    on = before.filter((id) => id !== manifest.id);
  }
  // The values a service was given go with it: every asked value the Worker holds for a service
  // that is not on, shipped or not, also any an interrupted change left behind.
  const keep = new Set(
    on.flatMap((id) => Object.values(askedSecrets({ id, title: "", auth: "", asks: [] }))),
  );
  for (const name of present) {
    if (ASKED_PREFIXES.some((prefix) => name.startsWith(prefix)) && !keep.has(name)) {
      changes[name] = null;
    }
  }
  if (on.length > 0) changes[MCP_SERVICES_SECRET] = on.join(",");
  else if (present.has(MCP_SERVICES_SECRET)) changes[MCP_SERVICES_SECRET] = null;
  const revision = hex(ports.random(16));
  changes[MCP_REVISION_SECRET] = revision;

  const save = (next: McpServicesRecord) => {
    state = { ...state, journal: { ...state.journal, mcpServices: next } };
    ports.store.save(state);
  };
  // Intent before effect: the list and revision this change writes.
  const base: McpServicesRecord = record ?? { on: [] };
  const { pending: _earlier, ...settled } = base;
  save({ ...settled, pending: { on, revision, startedAt: iso(ports.now()) } });
  const since = ports.now();
  await ports.cloud.updateSecrets(plan.platformWorker, changes);
  save({ on, revision, changedAt: iso(ports.now()) });
  ports.log(
    `stored: MCP services on: ${on.join(", ") || "none"} (${Object.keys(changes).length} settings). Waiting for the server to restart with them (a few minutes)`,
  );

  const logsSince = slicedLogs({ cloud: ports.cloud, now: () => ports.now() }, plan.platformWorker);
  const result = await pollServer<{ held: true } | { registry: boolean }>(
    ports,
    {
      pollMs: options.pollMs ?? DEFAULT_SERVICES_POLL_MS,
      deadline: ports.now() + (options.waitMs ?? DEFAULT_SERVICES_WAIT_MS),
    },
    async () => {
      let events: unknown[];
      try {
        events = await logsSince(since, ports.now());
      } catch {
        return { why: "Cloudflare did not answer the query for the platform Worker's logs" };
      }
      const check = checkMcpServices(parseLogs(events, plan.platformWorker), {
        installationId: plan.installationId,
        revision,
        since,
      });
      if (check.state === "waiting") return { why: check.why };
      return { decided: check.state === "held" ? { held: true } : { registry: check.registry } };
    },
  );
  if (!("decided" in result)) return { kind: "waiting", on, why: result.why };
  if ("held" in result.decided) return { kind: "held", on };
  save({
    on,
    revision,
    changedAt: state.journal.mcpServices?.changedAt ?? iso(since),
    confirmedAt: iso(ports.now()),
    registry: result.decided.registry,
  });
  return { kind: result.decided.registry === on.length > 0 ? "ready" : "off", on };
}

/**
 * The installer's last words and exit status for a change: 0 ready (or nothing to change), 3 not
 * confirmed yet, 1 off or held.
 */
export function servicesMessage(
  plan: Installation,
  change: ServicesChange,
  manifests: ReadonlyMap<string, ServiceManifest>,
  outcome: ServicesOutcome,
): { readonly lines: readonly string[]; readonly exitCode: number } {
  const site = `https://${plan.hostname}`;
  const manifest = manifests.get(change.id);
  const name = manifest === undefined ? change.id : `${manifest.title} (${change.id})`;
  const on = `MCP services on: ${outcome.on.join(", ") || "none"}.`;
  switch (outcome.kind) {
    case "unchanged":
      return { lines: [on], exitCode: 0 };
    case "ready":
      if (change.kind === "remove") {
        return { lines: [`${name} is off.`, on], exitCode: 0 };
      }
      return {
        lines: [
          `Ready. ${name} is on.`,
          manifest?.auth === "github"
            ? `It uses your GitHub link (${site}${SETTINGS_INTEGRATIONS_PATH}); in a new conversation, turn it on in the MCPs picker.`
            : `Connect it in Omnigent: Settings → MCP, ${site}${SETTINGS_MCP_PATH}; then turn it on in a new conversation's MCPs picker.`,
          on,
        ],
        exitCode: 0,
      };
    case "off":
      return {
        lines: [
          outcome.on.length > 0
            ? "The server restarted with the change, but Omnigent does not list its MCP services: a setting it needs is missing."
            : "The server restarted with the change, but Omnigent still lists MCP services.",
          "The server's config.warning line in the platform Worker's Workers Logs names what is missing (bootstrap.ts status --logs shows the status lines).",
          on,
        ],
        exitCode: 1,
      };
    case "held":
      return {
        lines: [
          "Omnigent's server does not start with the change: it refused one of the settings (exit code 78) and stays stopped, so Omnigent is down. The server's config.error line in the platform Worker's Workers Logs names the setting.",
          change.kind === "add"
            ? `To undo it: node scripts/bootstrap/bootstrap.ts services remove ${change.id}`
            : "See docs/operations/troubleshooting.md.",
          on,
        ],
        exitCode: 1,
      };
    case "waiting":
      return {
        lines: [
          `Stored, but not confirmed yet (last seen: ${outcome.why}).`,
          "Run bootstrap.ts services in a few minutes to see the list, or bootstrap.ts status --logs to see the server's status lines.",
          on,
        ],
        exitCode: 3,
      };
  }
}

/** The list for `bootstrap.ts services` and `status`: each shipped service, on or off. */
export function servicesListing(
  manifests: ReadonlyMap<string, ServiceManifest>,
  record: McpServicesRecord | undefined,
): string[] {
  const on = new Set(servicesOn(record));
  const lines = [...manifests.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (m) =>
        `${on.has(m.id) ? "on " : "off"}  ${m.id}: ${m.title}${m.asks.length > 0 ? ` (asks for: ${m.asks.join(", ")})` : ""}`,
    );
  if (record?.pending !== undefined) {
    lines.push(
      `a change begun at ${record.pending.startedAt} (services: ${record.pending.on.join(", ") || "none"}) may not have reached the installation`,
    );
  } else if (record?.changedAt !== undefined) {
    lines.push(
      record.confirmedAt === undefined
        ? `last changed at ${record.changedAt}; not confirmed by the server yet`
        : `last changed at ${record.changedAt}; confirmed at ${record.confirmedAt}${record.registry === false && record.on.length > 0 ? " (but Omnigent listed no MCP services)" : ""}`,
    );
  }
  return lines;
}
