// Pure helpers for experiment X1's transport Worker. Nothing here imports `cloudflare:workers`,
// so the tests load it directly. The schedule, the route names and the record keys follow the
// X1 pre-registration (project notes, verification/x1-preregistration.md), sections 3 to 6.

export const WORKER_NAME = "cfo-stg-x1-transport";
export const UI_NAME = "cfo-stg-x1-ui";
/** The Tunnel's public hostname is `<this>.<zone>`; the staging tool routes it to this Worker. */
export const TUNNEL_LABEL = `${WORKER_NAME}-tunnel`;
export const ECHO_PATH = "/x1/echo";
export const BLOCKED_PATH = "/x1/blocked";
/** The header every policy hop sets when it refuses a request, naming itself. */
export const REFUSED_BY = "x-x1-refused-by";
/** The per-computer route credential P5's policy route verifies. */
export const CREDENTIAL_HEADER = "x-x1-route-credential";

/** Virtual hosts the computer reaches through interception, registered by ComputerDO. */
export const HOSTS = Object.freeze({
  p1: "p1.x1.internal",
  p2: "p2.x1.internal",
  p3: "p3.x1.internal",
  p6: "p6.x1.internal",
  rec: "rec.x1.internal",
});
/** Which entrypoint (a key of ctx.exports) serves each intercepted host. */
export const INTERCEPTS = Object.freeze([
  [HOSTS.p1, "P1Route"],
  [HOSTS.p2, "P2Route"],
  [HOSTS.p3, "P3Echo"],
  [HOSTS.p6, "P6Policy"],
  [HOSTS.rec, "Recorder"],
]);

export const ALL_ROUTES = Object.freeze(["p1", "p2", "p3", "p4", "p5", "p6"]);
/** P4 and P5 need the F7-staging service token; without it they are not built (section 10). */
export const PRIVATE_ROUTES = Object.freeze(["p1", "p2", "p3", "p6"]);

export function routesFor(publicRoutes) {
  return publicRoutes ? [...ALL_ROUTES] : [...PRIVATE_ROUTES];
}

const MINUTE = 60_000;
/** Amendment 1, item 7: the probe and RunDO run this long past the soak's end. */
export const TAIL_MS = 60_000;

/**
 * The run's schedule from T0, section 5. Times are Worker milliseconds.
 *   run:       5 min warm-up, soak S..S+120 min, resets at S+30, S+60, S+90, then the 60 s
 *              recovery tail; the end at S+120 min + 60 s. The laptop deploys the UI at S+45
 *              and the transport at S+75 (recorded as planned).
 *   preflight: about 10 minutes from T0, one reset at T0+5 min, then the same tail.
 */
export function schedule(mode, t0) {
  if (!Number.isFinite(t0)) throw new Error("t0 must be a number");
  if (mode === "run") {
    const soakStart = t0 + 5 * MINUTE;
    const soakEnd = soakStart + 120 * MINUTE;
    return {
      mode,
      t0,
      soakStart,
      soakEnd,
      tailEnd: soakEnd + TAIL_MS,
      events: [
        ...[30, 60, 90].map((m) => ({
          id: `reset-s${m}`,
          kind: "reset",
          at: soakStart + m * MINUTE,
        })),
        { id: "end", kind: "end", at: soakEnd + TAIL_MS },
      ],
      deploysPlanned: { ui: soakStart + 45 * MINUTE, transport: soakStart + 75 * MINUTE },
    };
  }
  if (mode === "preflight") {
    const soakEnd = t0 + 10 * MINUTE;
    return {
      mode,
      t0,
      soakStart: t0,
      soakEnd,
      tailEnd: soakEnd + TAIL_MS,
      events: [
        { id: "reset-t5", kind: "reset", at: t0 + 5 * MINUTE },
        { id: "end", kind: "end", at: soakEnd + TAIL_MS },
      ],
      deploysPlanned: {},
    };
  }
  throw new Error(`unknown mode "${mode}"`);
}

/** Scheduled events that are due and not yet done, in time order. */
export function dueEvents(events, now) {
  return events.filter((e) => e.doneAt === undefined && e.at <= now).sort((a, b) => a.at - b.at);
}

/** When the next not-done event is due, or null when none is left. */
export function nextEventAt(events) {
  const pending = events.filter((e) => e.doneAt === undefined).map((e) => e.at);
  return pending.length === 0 ? null : Math.min(...pending);
}

/** `run-20261020T120000Z` or `preflight-…`: names the run's objects in the results bucket. */
export function runIdFor(mode, t0) {
  const stamp = new Date(t0)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return `${mode}-${stamp}`;
}

export const RUN_ID = /^(run|preflight)-\d{8}T\d{6}Z$/;
/** A probe instance: g<generation>-<boot id prefix>-<random>, chosen by the probe at start. */
export const INSTANCE_ID = /^g\d{1,6}-[0-9a-f]{8}-[0-9a-f]{6}$/;
const MAX_BATCH = 999_999;

export function batchKey(runId, instance, n) {
  return `runs/${runId}/probe/${instance}/batch-${String(n).padStart(6, "0")}.jsonl`;
}

export function manifestKey(runId, instance) {
  return `runs/${runId}/probe/${instance}/manifest.json`;
}

/** Where the probe records that its manifest could not be stored (a conflict). */
export function failureKey(runId, instance) {
  return `runs/${runId}/probe/${instance}/failure.json`;
}

export function lifecycleKey(runId, t, role, nonce) {
  return `runs/${runId}/lifecycle/${String(t).padStart(13, "0")}-${role}-${nonce}.json`;
}

export function logChunkKey(runId, logId, offset) {
  return `runs/${runId}/server-log/${logId}/${String(offset).padStart(12, "0")}.log`;
}

/**
 * The recorder's two paths, or null for anything else:
 *   POST /x1/batch/<run>/<instance>/<n>   one numbered batch of the probe's log
 *   POST /x1/manifest/<run>/<instance>    the probe's final manifest (its completion marker)
 *   POST /x1/failure/<run>/<instance>     its failure record, if the manifest conflicted
 */
export function parseRecorderPath(pathname) {
  const parts = pathname.split("/");
  if (parts.length === 6 && parts[1] === "x1" && parts[2] === "batch") {
    const [, , , runId, instance, n] = parts;
    if (!RUN_ID.test(runId) || !INSTANCE_ID.test(instance) || !/^[1-9]\d{0,5}$/.test(n)) {
      return null;
    }
    const number = Number(n);
    if (number > MAX_BATCH) return null;
    return { kind: "batch", runId, instance, n: number, key: batchKey(runId, instance, number) };
  }
  if (parts.length === 5 && parts[1] === "x1" && ["manifest", "failure"].includes(parts[2])) {
    const [, , kind, runId, instance] = parts;
    if (!RUN_ID.test(runId) || !INSTANCE_ID.test(instance)) return null;
    const key = kind === "manifest" ? manifestKey(runId, instance) : failureKey(runId, instance);
    return { kind, runId, instance, key };
  }
  return null;
}

/**
 * The 101 headers for a WebSocket answered through the container egress: none of the
 * handshake's own (no Upgrade, Connection, Accept or extension), which the egress adds; only a
 * subprotocol the server chose. S2's rule, unchanged.
 */
export function bareHeaders(upstreamHeaders) {
  const headers = new Headers();
  const protocol = upstreamHeaders?.get("Sec-WebSocket-Protocol");
  if (protocol) headers.set("Sec-WebSocket-Protocol", protocol);
  return headers;
}

/**
 * Headers a computer must never be able to set: Access identity, the route's own identity
 * headers and every x1 header (hop identities, the route credential once it has been read).
 */
export function stripTrust(headers) {
  for (const name of [...headers.keys()]) {
    if (
      name.startsWith("cf-access-") ||
      name.startsWith("x-cfo-") ||
      name.startsWith("x-x1-") ||
      name === "x-forwarded-email" ||
      name === "x-forwarded-user"
    ) {
      headers.delete(name);
    }
  }
}

/** A policy hop's refusal: 403 with a header naming the hop. */
export function refusal(hop, reason = "blocked", status = 403) {
  return new Response(`refused by ${hop}: ${reason}\n`, {
    status,
    headers: { [REFUSED_BY]: hop, "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * The echo reply to one probe message, or null when the message is not a valid echo. Only the
 * probe's own fields are echoed (route, connection, sequence number, send time), with the
 * answering instance's identity and the echo's clock.
 */
export function echoReply(data, identity, now) {
  if (typeof data !== "string" || data.length > 4096) return null;
  let message;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    message === null ||
    typeof message !== "object" ||
    message.t !== "echo" ||
    typeof message.route !== "string" ||
    !/^p[1-6]$/.test(message.route) ||
    !Number.isSafeInteger(message.conn) ||
    !Number.isSafeInteger(message.seq) ||
    typeof message.sent !== "number"
  ) {
    return null;
  }
  return JSON.stringify({
    t: "echo",
    route: message.route,
    conn: message.conn,
    seq: message.seq,
    sent: message.sent,
    id: identity,
    at: now,
  });
}

export function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two token strings. */
export function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hexBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** HMAC-SHA-256 of `message` under a hex key, as hex. */
export async function hmacHex(keyHex, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    hexBytes(keyHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The route credential's signed text: computer ID and generation. */
export function credentialMessage(computerId, generation) {
  return `x1-route:${computerId}:${generation}`;
}

/** `<computer>.<generation>.<hmac>`, issued by ComputerDO at each container start. */
export async function issueCredential(keyHex, computerId, generation) {
  return `${computerId}.${generation}.${await hmacHex(keyHex, credentialMessage(computerId, generation))}`;
}

export function parseCredential(text) {
  const match = /^([a-z0-9-]{1,32})\.(\d{1,9})\.([0-9a-f]{64})$/.exec(text ?? "");
  if (!match) return null;
  return { computerId: match[1], generation: Number(match[2]), mac: match[3] };
}

/**
 * Verifies a presented route credential against the key and current generation that ComputerDO
 * holds (`info`). The policy point refuses a malformed credential, another computer, an older
 * or unknown generation, and a wrong MAC.
 */
export async function verifyCredential(presented, info) {
  const parsed = parseCredential(presented);
  if (!parsed) return { ok: false, reason: "credential missing or malformed" };
  if (parsed.computerId !== info.computerId) return { ok: false, reason: "another computer" };
  if (parsed.generation < info.generation) return { ok: false, reason: "older generation" };
  if (parsed.generation > info.generation) return { ok: false, reason: "unknown generation" };
  const expected = await hmacHex(info.key, credentialMessage(parsed.computerId, parsed.generation));
  if (!sameToken(parsed.mac, expected)) return { ok: false, reason: "bad credential" };
  return { ok: true, computerId: parsed.computerId, generation: parsed.generation };
}

/** The zone of a staging hostname `<label>.<zone>`, or null if the host is not that label's. */
export function zoneOf(hostname, label) {
  const prefix = `${label}.`;
  if (!hostname.startsWith(prefix)) return null;
  const zone = hostname.slice(prefix.length);
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(zone) ? zone : null;
}

/**
 * The computer container's environment for one start. The probe reads it; nothing in it is ever
 * logged. The service token is included only when P4 and P5 are built.
 */
export function computerEnv(run, generation, credential, secrets) {
  const env = {
    X1_RUN_ID: run.runId,
    X1_MODE: run.mode,
    X1_T0: String(run.t0),
    X1_SOAK_START: String(run.soakStart),
    X1_SOAK_END: String(run.soakEnd),
    // The probe stops at the end of the recovery tail (Amendment 1, item 7).
    X1_END: String(run.tailEnd),
    X1_GENERATION: String(generation),
    X1_ROUTES: run.routes.join(","),
  };
  if (run.publicRoutes) {
    env.X1_P4_URL = `wss://${WORKER_NAME}.${run.zone}${ECHO_PATH}`;
    env.X1_P5_URL = `wss://${TUNNEL_LABEL}.${run.zone}${ECHO_PATH}`;
    env.X1_ROUTE_CREDENTIAL = credential;
    env.X1_ACCESS_CLIENT_ID = secrets.clientId;
    env.X1_ACCESS_CLIENT_SECRET = secrets.clientSecret;
  }
  return env;
}

/** The run record as written to the results bucket: no zone, nothing secret. */
export function publicRun(run) {
  const { zone: _zone, ...rest } = run;
  return rest;
}
