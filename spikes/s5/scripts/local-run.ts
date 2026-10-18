// Spike S5 local run: the Worker under `wrangler dev`, in front of the published Omnigent server
// image in Docker, with Access stood in by locally generated keys.
//
//   node spikes/s5/scripts/local-run.ts
//
// What it does, writing spikes/s5/results/local-run.json:
//   1. Ingress: every negative assertion case through the real Worker (workerd), the hostname
//      check, header stripping, and proof that no rejected request reaches Omnigent.
//   2. Omnigent behind the Worker: health, setup closed, its own login still required.
//   3. Bootstrap of the platform's login, then removal of the bootstrap secret: the Worker is
//      restarted without it and keeps reading /v1/scheduled-tasks with the stored grant.
//   4. The repair card over HTTP: origin and form-token checks, wrong and right password.
//   5. Transient outage (Omnigent stopped) and absolute expiry after Omnigent's purge.
//   6. The platform-login scenarios (src/scenarios.ts) via the Worker's scenario runner.
// Every secret is generated here, synthetic, and kept in spikes/s5/.work/ (gitignored). The
// results hold no token or password; the run ends by scanning its own outputs for them.

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  base64UrlEncode,
  MAX_ASSERTION_BYTES,
  STRIPPED_HEADERS,
  sha256Hex,
} from "../src/access.ts";
import { makeKey, sign, type TestKey } from "../test/keys.ts";

const SPIKE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(SPIKE, "..", "..");
const WORK = join(SPIKE, ".work", "local");
const GENERATED = join(SPIKE, "generated");
const RESULTS = join(SPIKE, "results");
export const IMAGE =
  "ghcr.io/omnigent-ai/omnigent-server@sha256:dba491573ba16b42da7447a7ab6e978bfeb6f49876093cc925f8340abd010df6";
const CONTAINER = "cfo-s5-local-omnigent";
const PORT = { omnigent: 25080, recorder: 25081, helper: 25090, worker: 25787, inspector: 25229 };
const TEAM = "s5-local.cloudflareaccess.com";
const ISSUER = `https://${TEAM}`;
const AUD = randomBytes(32).toString("hex");
const OTHER_AUD = randomBytes(32).toString("hex");
const OWNER_EMAIL = "owner@s5.example.invalid";
const USERNAME = "owner";

const secret = {
  password: base64UrlEncode(randomBytes(18)),
  cookie: randomBytes(32).toString("hex"),
  platformKey: base64UrlEncode(randomBytes(32)),
};

const steps: { section: string; step: string; expect: string; got: string; pass: boolean }[] = [];
let section = "setup";
function check(step: string, expect: string, got: string): void {
  steps.push({ section, step, expect, got, pass: expect === got });
  console.log(`${expect === got ? "PASS" : "FAIL"} [${section}] ${step}: ${got}`);
}
function note(step: string, got: string): void {
  steps.push({ section, step, expect: "(measurement)", got, pass: true });
  console.log(`NOTE [${section}] ${step}: ${got}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- HTTP client with full header control (Host included) ----

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function call(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string; port?: number } = {},
): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: options.port ?? PORT.worker,
        method,
        path,
        headers: { host: `127.0.0.1:${options.port ?? PORT.worker}`, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolveReply({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const reasonOf = (r: Reply) => {
  try {
    const body = JSON.parse(r.body) as { error?: { reason?: string; code?: string } };
    return body.error?.reason ?? body.error?.code ?? "none";
  } catch {
    return "none";
  }
};

// ---- Local stand-ins: Access certs, fault helper, and a recording proxy in front of Omnigent ----

let keys: { current: TestKey; previous: TestKey; rogue: TestKey; stranger: TestKey };
let certsFetches = 0;
const upstream: {
  method: string;
  path: string;
  strippedPresent: string[];
  cookies: string[];
  authorization: boolean;
}[] = [];

function startHelpers(): http.Server[] {
  const helper = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/cdn-cgi/access/certs") {
      certsFetches++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [keys.current.jwk, keys.previous.jwk] }));
      return;
    }
    if (req.method === "POST" && req.url === "/sql") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          res.end(dockerSql(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          res.statusCode = 500;
          res.end(error instanceof Error ? error.message.slice(0, 300) : "error");
        }
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  helper.listen(PORT.helper, "127.0.0.1");

  const recorder = http.createServer((req, res) => {
    const names = Object.keys(req.headers);
    upstream.push({
      method: req.method ?? "",
      path: (req.url ?? "").split("?")[0] ?? "",
      strippedPresent: STRIPPED_HEADERS.filter((h) => names.includes(h)),
      cookies: (req.headers.cookie ?? "")
        .split(";")
        .map((c) => c.trim().split("=")[0] ?? "")
        .filter((c) => c !== ""),
      authorization: req.headers.authorization !== undefined,
    });
    const out = http.request(
      {
        host: "127.0.0.1",
        port: PORT.omnigent,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    out.on("error", () => {
      res.statusCode = 502;
      res.end("omnigent unreachable");
    });
    req.pipe(out);
  });
  recorder.listen(PORT.recorder, "127.0.0.1");
  return [helper, recorder];
}

function dockerSql(sql: string): string {
  const code =
    "import sqlite3, sys\nc = sqlite3.connect('/data/omnigent.db')\nc.executescript(sys.argv[1])\nc.commit()\nprint(c.total_changes)";
  return execFileSync("docker", ["exec", CONTAINER, "python", "-c", code, sql], {
    encoding: "utf8",
  });
}

// ---- Omnigent container ----

function startOmnigent(): void {
  execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  mkdirSync(join(WORK, "data"), { recursive: true });
  const envFile = join(WORK, "omnigent.env");
  writeFileSync(
    envFile,
    [
      "DATABASE_URL=sqlite:////data/omnigent.db",
      "OMNIGENT_AUTH_PROVIDER=accounts",
      `OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME=${USERNAME}`,
      `OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD=${secret.password}`,
      `OMNIGENT_ACCOUNTS_COOKIE_SECRET=${secret.cookie}`,
      `OMNIGENT_ACCOUNTS_BASE_URL=http://127.0.0.1:${PORT.worker}`,
      `OMNIGENT_WS_ALLOWED_ORIGINS=http://127.0.0.1:${PORT.worker}`,
      "OMNIGENT_GRANT_MAX_LIFETIME_DAYS=1",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      CONTAINER,
      "--env-file",
      envFile,
      "-p",
      `127.0.0.1:${PORT.omnigent}:8000`,
      "-v",
      `${join(WORK, "data")}:/data`,
      IMAGE,
    ],
    { stdio: "ignore" },
  );
}

async function waitHealthy(port: number, path: string, ok: (r: Reply) => boolean): Promise<number> {
  const started = Date.now();
  for (let i = 0; i < 120; i++) {
    try {
      if (ok(await call("GET", path, { port }))) return Date.now() - started;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`port ${port} did not become ready`);
}

// ---- Worker under wrangler dev ----

function writeWorkerConfig(): string {
  mkdirSync(GENERATED, { recursive: true });
  const file = join(GENERATED, "wrangler.local.jsonc");
  const config = {
    name: "cfo-s5-local",
    main: "../src/worker.ts",
    compatibility_date: "2026-10-01",
    workers_dev: false,
    preview_urls: false,
    durable_objects: {
      bindings: [
        { name: "PLATFORM_LOGIN", class_name: "PlatformLoginDO" },
        { name: "OMNIGENT_SERVER", class_name: "OmnigentServerDO" },
      ],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["PlatformLoginDO", "OmnigentServerDO"] }],
    vars: {
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      ALLOWED_HOSTNAMES: "127.0.0.1",
      OTHER_APP_AUD: OTHER_AUD,
      ACCESS_CERTS_URL_LOCAL_ONLY: `http://127.0.0.1:${PORT.helper}`,
      OMNIGENT_ORIGIN_LOCAL_ONLY: `http://127.0.0.1:${PORT.recorder}`,
      FAULT_HELPER_LOCAL_ONLY: `http://127.0.0.1:${PORT.helper}`,
      OMNIGENT_USERNAME: USERNAME,
      GRANT_LIFETIME_DAYS: "1",
      S5_FAULTS: "1",
    },
  };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

async function writeWorkerSecrets(withBootstrap: boolean): Promise<string> {
  const file = join(WORK, "worker.env");
  const lines = [
    `PLATFORM_LOGIN_KEY=${secret.platformKey}`,
    `OWNER_EMAIL_SHA256=${await sha256Hex(OWNER_EMAIL)}`,
  ];
  if (withBootstrap) lines.push(`OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD=${secret.password}`);
  writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  return file;
}

let wrangler: ChildProcess | undefined;
let wranglerRuns = 0;

async function startWorker(withBootstrap: boolean): Promise<number> {
  const config = writeWorkerConfig();
  const envFile = await writeWorkerSecrets(withBootstrap);
  wranglerRuns++;
  const log = createWriteStream(join(WORK, `wrangler-${wranglerRuns}.log`));
  wrangler = spawn(
    process.execPath,
    [
      join(ROOT, "worker", "node_modules", "wrangler", "bin", "wrangler.js"),
      "dev",
      "--config",
      config,
      "--ip",
      "127.0.0.1",
      "--port",
      String(PORT.worker),
      "--inspector-port",
      String(PORT.inspector),
      "--persist-to",
      join(WORK, "state"),
      "--env-file",
      envFile,
      "--show-interactive-dev-session=false",
      "--log-level",
      "log",
    ],
    {
      cwd: join(ROOT, "worker"),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1" },
    },
  );
  wrangler.stdout?.pipe(log);
  wrangler.stderr?.pipe(log);
  return waitHealthy(PORT.worker, "/__s5/whoami", (r) => r.status === 403);
}

async function stopWorker(): Promise<void> {
  const child = wrangler;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(10_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  wrangler = undefined;
  await sleep(500);
}

// ---- Access tokens, signed with the local stand-in for the team key ----

const NOW = () => Math.floor(Date.now() / 1000);
function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = NOW();
  return {
    aud: [AUD],
    email: OWNER_EMAIL,
    exp: now + 600,
    iat: now - 5,
    nbf: now - 5,
    iss: ISSUER,
    type: "app",
    identity_nonce: "synthetic",
    sub: "00000000-0000-4000-8000-0000000000aa",
    country: "XX",
    ...extra,
  };
}
const access = (token: string) => ({ "cf-access-jwt-assertion": token });

// ---- The run ----

async function ingress(): Promise<void> {
  section = "ingress";
  const good = await sign(keys.current, claims());
  const enc = (v: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(v)));
  const [gh, gp, gs] = good.split(".") as [string, string, string];
  const before = upstream.length;

  const negatives: [string, Record<string, string>, number, string][] = [
    ["no assertion", {}, 403, "missing_assertion"],
    [
      "assertion only in the CF_Authorization cookie",
      { cookie: `CF_Authorization=${good}` },
      403,
      "missing_assertion",
    ],
    ["empty assertion", access(""), 403, "missing_assertion"],
    ["oversized", access("a".repeat(MAX_ASSERTION_BYTES + 1)), 403, "oversized"],
    ["malformed", access(`${gh}.${gp}`), 403, "malformed"],
    [
      "forged signature under the genuine kid",
      access(await sign(keys.rogue, claims())),
      403,
      "bad_signature",
    ],
    [
      "payload edited after signing",
      access(`${gh}.${enc(claims({ aud: [OTHER_AUD] }))}.${gs}`),
      403,
      "bad_signature",
    ],
    [
      "alg none",
      access(`${enc({ alg: "none", kid: keys.current.kid })}.${gp}.AA`),
      403,
      "unsupported_alg",
    ],
    [
      "alg HS256",
      access(`${enc({ alg: "HS256", kid: keys.current.kid })}.${gp}.${gs}`),
      403,
      "unsupported_alg",
    ],
    ["unknown kid", access(await sign(keys.stranger, claims())), 403, "unknown_kid"],
    [
      "wrong issuer",
      access(
        await sign(keys.current, claims({ iss: "https://another-team.cloudflareaccess.com" })),
      ),
      403,
      "wrong_issuer",
    ],
    [
      "another application (other AUD)",
      access(await sign(keys.current, claims({ aud: [OTHER_AUD] }))),
      403,
      "wrong_audience",
    ],
    [
      "expired",
      access(
        await sign(keys.current, claims({ exp: NOW() - 60, iat: NOW() - 700, nbf: NOW() - 700 })),
      ),
      403,
      "expired",
    ],
    [
      "not yet valid",
      access(await sign(keys.current, claims({ nbf: NOW() + 600 }))),
      403,
      "not_yet_valid",
    ],
    [
      "org session token",
      access(await sign(keys.current, claims({ type: "org" }))),
      403,
      "wrong_token_type",
    ],
    [
      "another identity",
      access(await sign(keys.current, claims({ email: "intruder@s5.example.invalid" }))),
      403,
      "not_owner",
    ],
  ];
  for (const path of ["/", "/v1/scheduled-tasks", "/platform/login", "/__s5/whoami"]) {
    for (const [name, headers, status, reason] of negatives) {
      const r = await call("GET", path, { headers });
      check(`${name} on ${path}`, `${status} ${reason}`, `${r.status} ${reasonOf(r)}`);
    }
  }
  const post = await call("POST", "/auth/login", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: secret.password }),
  });
  check(
    "POST /auth/login without an assertion",
    "403 missing_assertion",
    `${post.status} ${reasonOf(post)}`,
  );

  const wrongHost = await call("GET", "/__s5/whoami", {
    headers: { ...access(good), host: "attacker.example" },
  });
  check(
    "valid assertion, unknown Host header",
    "404 unknown_host",
    `${wrongHost.status} ${reasonOf(wrongHost)}`,
  );
  const previous = await call("GET", "/__s5/whoami", {
    headers: access(await sign(keys.previous, claims())),
  });
  check("token from the previous key (rotation)", "200", String(previous.status));
  const ok = await call("GET", "/__s5/whoami", { headers: access(good) });
  check("genuine assertion", "200", String(ok.status));

  check("rejected requests that reached Omnigent", "0", String(upstream.length - before));

  // A flood of unknown key ids triggers at most one certs fetch per 30 seconds.
  const fetchesBefore = certsFetches;
  for (let i = 0; i < 40; i++) {
    const k = await makeKey(`flood-${i}`);
    await call("GET", "/__s5/whoami", { headers: access(await sign(k, claims())) });
    if (i === 0) keys.stranger = k;
  }
  check(
    "certs fetches caused by 40 unknown-kid tokens",
    "at most 1",
    certsFetches - fetchesBefore <= 1 ? "at most 1" : String(certsFetches - fetchesBefore),
  );

  const selftest = JSON.parse(
    (await call("GET", "/__s5/selftest", { headers: access(good) })).body,
  ) as {
    passed: number;
    failed: number;
  };
  check("derived negative cases in workerd (self-test)", "0 failed", `${selftest.failed} failed`);
  note("derived cases passed", String(selftest.passed));
}

async function behindAccess(): Promise<void> {
  section = "omnigent behind the Worker";
  const good = access(await sign(keys.current, claims()));
  const health = await call("GET", "/health", { headers: good });
  check(
    "GET /health through the Worker",
    "200 1",
    `${health.status} ${health.headers["x-s5-worker"]}`,
  );
  const tasks = await call("GET", "/v1/scheduled-tasks", { headers: good });
  check("Access alone does not sign in to Omnigent", "401", String(tasks.status));
  const setup = await call("POST", "/auth/setup", {
    headers: { ...good, "content-type": "application/json" },
    body: JSON.stringify({ username: "intruder", password: "intruder-password" }),
  });
  check("first-visitor setup is closed (owner pre-provisioned)", "409", String(setup.status));
  const before = upstream.length;
  const login = await call("POST", "/auth/login", {
    headers: {
      ...good,
      "content-type": "application/json",
      "x-forwarded-email": "intruder@s5.example.invalid",
      "cf-access-authenticated-user-email": "intruder@s5.example.invalid",
      cookie: `CF_Authorization=${good["cf-access-jwt-assertion"]}; theme=dark`,
    },
    body: JSON.stringify({ username: USERNAME, password: secret.password }),
  });
  check("owner signs in to Omnigent through the Worker", "200", String(login.status));
  const seen = upstream.slice(before).find((u) => u.path === "/auth/login");
  check(
    "identity and Access headers stripped before Omnigent",
    "none",
    seen?.strippedPresent.join(",") || "none",
  );
  check("only the Access cookie removed", "theme", seen?.cookies.join(",") ?? "missing");
  const cookie = String(login.headers["set-cookie"] ?? "").split(";")[0] ?? "";
  const me = await call("GET", "/auth/me", { headers: { ...good, cookie } });
  check("Omnigent session works through the Worker", "200", String(me.status));
}

async function bootstrapAndSecretRemoval(): Promise<void> {
  section = "bootstrap and secret removal";
  const good = access(await sign(keys.current, claims()));
  const status0 = JSON.parse((await call("GET", "/platform/status", { headers: good })).body) as {
    state: string;
    bootstrapSecretRemovable: boolean;
  };
  check(
    "before bootstrap",
    "bootstrap_pending false",
    `${status0.state} ${status0.bootstrapSecretRemovable}`,
  );
  const boot = JSON.parse((await call("POST", "/platform/bootstrap", { headers: good })).body) as {
    outcome: string;
    secretRemovable: boolean;
  };
  check("bootstrap", "stored true", `${boot.outcome} ${boot.secretRemovable}`);
  const read = JSON.parse((await call("GET", "/platform/schedules", { headers: good })).body) as {
    kind: string;
  };
  check("platform reads /v1/scheduled-tasks with its own grant", "ok", read.kind);
  const platformCalls = upstream.filter((u) => u.path === "/v1/scheduled-tasks" && u.authorization);
  check(
    "platform reads carry a bearer token (its own grant)",
    "true",
    String(platformCalls.length > 0),
  );

  await stopWorker();
  note(
    "Worker restarted without the bootstrap secret, ms to ready",
    String(await startWorker(false)),
  );
  const good2 = access(await sign(keys.current, claims()));
  const read2 = JSON.parse((await call("GET", "/platform/schedules", { headers: good2 })).body) as {
    kind: string;
  };
  check("reads after the secret is gone", "ok", read2.kind);
  const loginsBefore = upstream.filter((u) => u.path === "/auth/login").length;
  const boot2 = JSON.parse(
    (await call("POST", "/platform/bootstrap", { headers: good2 })).body,
  ) as {
    outcome: string;
  };
  check("bootstrap without the secret, after a stored grant", "already_stored", boot2.outcome);
  check(
    "no login attempted",
    "0",
    String(upstream.filter((u) => u.path === "/auth/login").length - loginsBefore),
  );
}

function formTokenOf(html: string): string {
  return /name="form_token" value="([^"]+)"/.exec(html)?.[1] ?? "";
}

async function repairOverHttp(): Promise<void> {
  section = "repair card over HTTP";
  const good = access(await sign(keys.current, claims()));
  await call("POST", "/__s5/fault/revoke-grant", { headers: good });
  const read = JSON.parse((await call("GET", "/platform/schedules", { headers: good })).body) as {
    kind: string;
    reason?: string;
  };
  check(
    "read after revocation",
    "needs_reauthentication grant_rejected",
    `${read.kind} ${read.reason}`,
  );
  const page = await call("GET", "/platform/login", { headers: good });
  check("card asks for the password", "true", String(page.body.includes('type="password"')));
  check("card framing protection", "DENY", String(page.headers["x-frame-options"]));
  check(
    "card CSP frame-ancestors",
    "true",
    String(String(page.headers["content-security-policy"]).includes("frame-ancestors 'none'")),
  );
  const token = formTokenOf(page.body);
  const origin = `http://127.0.0.1:${PORT.worker}`;
  const form = (password: string, t = token) =>
    new URLSearchParams({ form_token: t, password }).toString();
  const formHeaders = { ...good, "content-type": "application/x-www-form-urlencoded" };

  let r = await call("POST", "/platform/login/repair", {
    headers: formHeaders,
    body: form(secret.password),
  });
  check("no Origin header", "403 bad_origin", `${r.status} ${reasonOf(r)}`);
  r = await call("POST", "/platform/login/repair", {
    headers: { ...formHeaders, origin: "https://attacker.example" },
    body: form(secret.password),
  });
  check("foreign Origin", "403 bad_origin", `${r.status} ${reasonOf(r)}`);
  r = await call("POST", "/platform/login/repair", {
    headers: { ...formHeaders, origin },
    body: form(secret.password, "1.AAAA"),
  });
  check("bad form token", "403 bad_form_token", `${r.status} ${reasonOf(r)}`);
  const otherSub = access(
    await sign(keys.current, claims({ sub: "00000000-0000-4000-8000-0000000000bb" })),
  );
  r = await call("POST", "/platform/login/repair", {
    headers: { ...otherSub, "content-type": "application/x-www-form-urlencoded", origin },
    body: form(secret.password),
  });
  check(
    "form token from another Access identity",
    "403 bad_form_token",
    `${r.status} ${reasonOf(r)}`,
  );
  r = await call("POST", "/platform/login/repair", {
    headers: { ...formHeaders, origin },
    body: form("wrong-password-123"),
  });
  check(
    "wrong password",
    "400 wrong_password",
    `${r.status} ${/data-message="([^"]+)"/.exec(r.body)?.[1]}`,
  );
  r = await call("POST", "/platform/login/repair", {
    headers: { ...formHeaders, origin },
    body: form(secret.password, formTokenOf(r.body)),
  });
  check(
    "right password",
    "200 repaired",
    `${r.status} ${/data-message="([^"]+)"/.exec(r.body)?.[1]}`,
  );
  const after = JSON.parse((await call("GET", "/platform/schedules", { headers: good })).body) as {
    kind: string;
  };
  check("read after repair", "ok", after.kind);
}

async function transientAndPurge(): Promise<void> {
  section = "transient outage";
  const good = access(await sign(keys.current, claims()));
  execFileSync("docker", ["stop", "-t", "5", CONTAINER], { stdio: "ignore" });
  await call("POST", "/__s5/fault/drop-access", { headers: good });
  const down = JSON.parse((await call("GET", "/platform/schedules", { headers: good })).body) as {
    kind: string;
  };
  check("read while Omnigent is down", "transient", down.kind);
  const s = JSON.parse((await call("GET", "/platform/status", { headers: good })).body) as {
    state: string;
  };
  check("state while Omnigent is down", "ok", s.state);
  execFileSync("docker", ["start", CONTAINER], { stdio: "ignore" });
  note(
    "Omnigent restart, ms to healthy",
    String(await waitHealthy(PORT.omnigent, "/health", (x) => x.status === 200)),
  );
  const up = JSON.parse((await call("GET", "/platform/schedules", { headers: good })).body) as {
    kind: string;
  };
  check("read after Omnigent is back", "ok", up.kind);

  section = "absolute expiry after the purge";
  dockerSql(
    "UPDATE device_grants SET approved_at = approved_at - 86401, created_at = created_at - 86401 WHERE client_id = 'omnigent-cli' AND status = 4;",
  );
  // A fresh server process purges on its first refresh: the aged row is deleted before lookup.
  execFileSync("docker", ["restart", "-t", "5", CONTAINER], { stdio: "ignore" });
  await waitHealthy(PORT.omnigent, "/health", (x) => x.status === 200);
  await call("POST", "/__s5/fault/drop-access", { headers: good });
  const expired = JSON.parse(
    (await call("GET", "/platform/schedules", { headers: good })).body,
  ) as {
    kind: string;
    reason?: string;
  };
  check("read after expiry and purge", "needs_reauthentication", expired.kind);
  const st = JSON.parse((await call("GET", "/platform/status", { headers: good })).body) as {
    reason: string;
    serverError: string;
  };
  note(
    "reason and server answer (platform clock is not past the lifetime here)",
    `${st.reason} ${st.serverError}`,
  );
  const page = await call("GET", "/platform/login", { headers: good });
  const origin = `http://127.0.0.1:${PORT.worker}`;
  const r = await call("POST", "/platform/login/repair", {
    headers: { ...good, "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({
      form_token: formTokenOf(page.body),
      password: secret.password,
    }).toString(),
  });
  check("repair after expiry", "200", String(r.status));
}

async function scenarios(): Promise<void> {
  section = "scenarios";
  await stopWorker();
  await startWorker(true);
  const good = () => sign(keys.current, claims()).then(access);
  // The same entry point the owner opens in staging.
  const run = JSON.parse(
    (
      await call("GET", "/__s5/run", {
        headers: { ...(await good()), cookie: "CF_Authorization=synthetic; theme=dark" },
      })
    ).body,
  ) as {
    access: { failed: number };
    behindAccess: Record<string, string | number>;
    scenarios: string;
  };
  check("/__s5/run: derived assertion cases", "0 failed", `${run.access.failed} failed`);
  check("/__s5/run: health via proxy", "200 via worker", String(run.behindAccess.health));
  check(
    "/__s5/run: /v1/scheduled-tasks without an Omnigent login",
    "401 via worker",
    String(run.behindAccess.scheduledTasksWithoutOmnigentLogin),
  );
  check(
    "/__s5/run: first-visitor setup",
    "409 via worker",
    String(run.behindAccess.firstVisitorSetup),
  );
  check("/__s5/run: Omnigent web page", "200 via worker", String(run.behindAccess.loginPage));
  let report: {
    state: string;
    steps: { scenario: string; step: string; expect: string; got: string; pass: boolean }[];
  } = {
    state: "running",
    steps: [],
  };
  for (let i = 0; i < 600 && report.state === "running"; i++) {
    await sleep(1000);
    report = JSON.parse((await call("GET", "/__s5/report", { headers: await good() })).body);
  }
  check("scenario runner finished", "done", report.state);
  for (const s of report.steps) {
    steps.push({
      section: `scenario: ${s.scenario}`,
      step: s.step,
      expect: s.expect,
      got: s.got,
      pass: s.pass,
    });
    console.log(`${s.pass ? "PASS" : "FAIL"} [scenario: ${s.scenario}] ${s.step}: ${s.got}`);
  }
}

function scanOutputs(): void {
  section = "secrets scan";
  const needles = [secret.password, secret.cookie, secret.platformKey];
  const files = [
    ...readdirSync(WORK)
      .filter((f) => f.endsWith(".log"))
      .map((f) => join(WORK, f)),
    join(RESULTS, "local-run.json"),
    join(WORK, "omnigent.log"),
  ];
  let hits = 0;
  for (const file of files) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const n of needles) if (text.includes(n)) hits++;
    if (/eyJ[A-Za-z0-9_-]{10,}\.eyJ/.test(text)) hits++;
  }
  check(`synthetic secrets or JWTs in ${files.length} output files`, "0", String(hits));
}

async function main(): Promise<void> {
  rmSync(join(WORK, "state"), { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(RESULTS, { recursive: true });
  keys = {
    current: await makeKey("s5-local-current"),
    previous: await makeKey("s5-local-previous"),
    rogue: await makeKey("s5-local-current"),
    stranger: await makeKey("s5-local-stranger"),
  };
  const servers = startHelpers();
  const started = new Date().toISOString();
  try {
    startOmnigent();
    note(
      "Omnigent container, ms to healthy",
      String(await waitHealthy(PORT.omnigent, "/health", (r) => r.status === 200)),
    );
    note("wrangler dev, ms to ready", String(await startWorker(true)));
    await ingress();
    await behindAccess();
    await bootstrapAndSecretRemoval();
    await repairOverHttp();
    await transientAndPurge();
    await scenarios();
  } catch (error) {
    check("run completed", "no error", error instanceof Error ? error.message : String(error));
  } finally {
    await stopWorker();
    const dockerLogs = spawnSync("docker", ["logs", CONTAINER], { encoding: "utf8" });
    const logs = `${dockerLogs.stdout ?? ""}${dockerLogs.stderr ?? ""}`;
    writeFileSync(join(WORK, "omnigent.log"), logs);
    const issuanceFailures = (logs.match(/refresh grant issuance failed/g) ?? []).length;
    section = "server log";
    note("login handler logged 'refresh grant issuance failed'", `${issuanceFailures} time(s)`);
    execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
    // The container wrote its database as root; remove it with the same image.
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${WORK}:/w`,
        "--entrypoint",
        "python",
        IMAGE,
        "-c",
        "import shutil; shutil.rmtree('/w/data', ignore_errors=True)",
      ],
      { stdio: "ignore" },
    );
    for (const s of servers) s.close();
    const summary = {
      started,
      finished: new Date().toISOString(),
      image: IMAGE,
      node: process.version,
      passed: steps.filter((s) => s.pass).length,
      failed: steps.filter((s) => !s.pass).length,
      steps,
    };
    writeFileSync(join(RESULTS, "local-run.json"), `${JSON.stringify(summary, null, 2)}\n`);
    scanOutputs();
    summary.passed = steps.filter((s) => s.pass).length;
    summary.failed = steps.filter((s) => !s.pass).length;
    writeFileSync(
      join(RESULTS, "local-run.json"),
      `${JSON.stringify({ ...summary, steps }, null, 2)}\n`,
    );
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exitCode = summary.failed === 0 ? 0 : 1;
  }
}

await main();
