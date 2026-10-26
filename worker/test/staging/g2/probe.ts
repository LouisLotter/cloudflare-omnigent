// G2 sitting, RC-01 (test tooling, laptop only, read-only): every way to a Worker but the
// owner's hostname must stop before the Worker, or not exist.
//
//   node worker/test/staging/g2/probe.ts [<account's workers.dev subdomain>]
//
//   1. Anonymous requests to both hostnames: each must be sent to the Access login.
//   2. Each Worker's settings, as Cloudflare reports them (cf workers get): workers.dev and
//      preview URLs.
//   3. With the account's workers.dev subdomain (the dashboard shows it; $CFO_WORKERS_DEV_SUBDOMAIN
//      or the argument): each Worker's workers.dev URL, and the preview URL of every version it
//      has, `<first 8 of the version ID>-<worker>.<subdomain>.workers.dev`. Each must be refused
//      by Cloudflare or not exist; an answer from the Worker itself fails the probe.
//
// Output: one line per request, then a verdict. Redact before it leaves the laptop (run.sh does).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cfJson } from "../../../../scripts/bootstrap/cloud.ts";
import { spawnRunner } from "../../../../scripts/staging/cloud.ts";

const BASE = "g2-sitting";
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKERS = [`cfo-stg-${BASE}-web`, `cfo-stg-${BASE}-platform`];
const stateDir =
  process.env.CFO_STAGING_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cloudflare-omnigent", "staging");
const { accountId, zone } = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as {
  accountId: string;
  zone: string;
};
const run = spawnRunner(accountId);
const subdomain = process.argv[2] ?? process.env.CFO_WORKERS_DEV_SUBDOMAIN ?? "";
let failures = 0;

interface Outcome {
  /** "absent": the name does not resolve; "no answer": anything else that failed. */
  readonly status: number | "absent" | "no answer";
  readonly location?: string;
  readonly contentType?: string;
  readonly head?: string;
}

async function request(url: string, method = "GET"): Promise<Outcome> {
  try {
    const response = await fetch(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "cfo-g2-sitting-probe/1" },
      ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}),
    });
    const text = (await response.text()).replace(/\s+/g, " ").slice(0, 100);
    return {
      status: response.status,
      ...(response.headers.get("location")
        ? { location: response.headers.get("location") ?? "" }
        : {}),
      contentType: response.headers.get("content-type") ?? "",
      head: text,
    };
  } catch (error) {
    // Only a name that does not resolve proves absence; a timeout or a reset proves nothing
    // (Codex G2 review, 8).
    const code = String((error as { cause?: { code?: unknown } }).cause?.code ?? "");
    return {
      status: code === "ENOTFOUND" ? "absent" : "no answer",
      head: `${code} ${String(error)}`.slice(0, 100),
    };
  }
}

function toAccess(o: Outcome): boolean {
  return (
    (o.status === 302 || o.status === 303) &&
    /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\//.test(o.location ?? "")
  );
}

/** The Worker answered: JSON (both Workers answer in JSON), a 2xx, or a redirect elsewhere. */
function workerAnswered(o: Outcome): boolean {
  if (typeof o.status !== "number") return false;
  if (o.status >= 200 && o.status < 300) return true;
  if (o.status >= 300 && o.status < 400) return !toAccess(o);
  return (o.contentType ?? "").includes("application/json");
}

function show(label: string, o: Outcome, verdict: string): void {
  const where = o.location ? ` -> ${o.location.replace(/\?.*$/, "?…")}` : "";
  console.log(
    `${verdict.padEnd(9)} ${label} ${o.status}${where} [${o.contentType ?? ""}] ${o.head ?? ""}`,
  );
}

console.log("1. Anonymous requests to the hostnames (each must go to the Access login)");
for (const worker of WORKERS) {
  for (const [method, path] of [
    ["GET", "/"],
    ["GET", "/v1/info"],
    ["GET", "/health"],
    ["GET", "/__health"],
    ["POST", "/auth/setup"],
    ["POST", "/auth/login"],
  ] as const) {
    const o = await request(`https://${worker}.${zone}${path}`, method);
    // A POST may be refused outright by Access (403) instead of redirected.
    const ok = toAccess(o) || (method === "POST" && o.status === 403 && !workerAnswered(o));
    if (!ok) failures += 1;
    show(`${method} ${worker}${path}`, o, ok ? "ok" : "FAIL");
  }
}

console.log("2. Each Worker's alternate URLs, as Cloudflare reports them");
const versions = new Map<string, string[]>();
for (const worker of WORKERS) {
  try {
    const got = cfJson(run, ["workers", "get", worker]) as Record<string, unknown> | null;
    const settings = got?.subdomain ?? got?.workers_dev ?? null;
    console.log(
      `info      ${worker}: subdomain settings ${JSON.stringify(settings)} (fields: ${Object.keys(got ?? {}).join(", ")})`,
    );
    const flags = settings as { enabled?: unknown; previews_enabled?: unknown } | null;
    if (flags?.enabled === true || flags?.previews_enabled === true) {
      failures += 1;
      console.log(`FAIL      ${worker}: workers.dev or preview URLs enabled`);
    }
  } catch (error) {
    failures += 1;
    console.log(`FAIL      ${worker}: cf workers get failed: ${String(error).slice(0, 120)}`);
  }
  try {
    const listed = cfJson(run, ["workers", "versions", "list", "--worker-id", worker]);
    const items = Array.isArray(listed)
      ? listed
      : ((listed as { items?: unknown[] } | null)?.items ?? []);
    // Every entry must carry a version ID of Cloudflare's shape (a UUID), whose first eight
    // characters name its preview URL; a malformed one is failed discovery (Codex run 2, 8).
    const listedIds = items.map((v) => (v as { id?: unknown } | null)?.id);
    const ids = listedIds.filter(
      (id): id is string => typeof id === "string" && VERSION_ID.test(id),
    );
    versions.set(worker, ids);
    if (ids.length !== listedIds.length) {
      failures += 1;
      console.log(
        `FAIL      ${worker}: ${listedIds.length - ids.length} of ${listedIds.length} listed versions have no valid ID`,
      );
    }
    if (ids.length === 0) {
      // Every deployed Worker has a version: an empty list means the discovery failed.
      failures += 1;
      console.log(`FAIL      ${worker}: no version listed, so no version URL can be probed`);
    } else {
      console.log(`info      ${worker}: ${ids.length} versions`);
    }
  } catch (error) {
    failures += 1;
    console.log(
      `FAIL      ${worker}: cf workers versions list failed: ${String(error).slice(0, 120)}`,
    );
  }
}

console.log("3. workers.dev and preview URLs (each must be refused by Cloudflare or not exist)");
if (subdomain === "") {
  console.log(
    "SKIPPED   no workers.dev subdomain given: pass the account's subdomain (dashboard, Workers & Pages) to probe the URLs",
  );
  failures += 1;
} else {
  for (const worker of WORKERS) {
    const hosts = [
      `${worker}.${subdomain}.workers.dev`,
      ...(versions.get(worker) ?? []).map(
        (id) => `${id.slice(0, 8)}-${worker}.${subdomain}.workers.dev`,
      ),
    ];
    for (const host of hosts) {
      for (const path of ["/", "/__health"]) {
        const o = await request(`https://${host}${path}`);
        const answered = workerAnswered(o);
        const unsure = o.status === "no answer";
        if (answered || unsure) failures += 1;
        const verdict = answered
          ? "FAIL"
          : unsure
            ? "UNSURE"
            : o.status === "absent"
              ? "absent"
              : "refused";
        show(`GET ${host}${path}`, o, verdict);
      }
    }
  }
}

console.log(failures === 0 ? "RC-01 probe: PASS" : `RC-01 probe: ${failures} problem(s)`);
process.exitCode = failures === 0 ? 0 : 1;
