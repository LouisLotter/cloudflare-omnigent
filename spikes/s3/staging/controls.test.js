// Campaign-control tests for the S3 staging page (IR-017). Each refusal must
// have zero effect: no container start, no forward, no arming.
//   pnpm exec vitest run --config spikes/s3/staging/vitest.config.mjs
import { beforeEach, describe, expect, it } from "vitest";
import { ARM_MS, handle, sameToken } from "./controls.js";

const ORIGIN = "https://cfo-stg-s3-capture.example.test";
const TOKEN = "a".repeat(64);

let state;
let calls;
let clock;
let running;

function ports() {
  return {
    now: () => clock,
    container: {
      running: () => running,
      start: () => {
        calls.push("start");
        running = true;
      },
      keepAlive: async () => {
        calls.push("keepAlive");
      },
      fetch: async (path, init) => {
        calls.push(`fetch ${init.method} ${path}`);
        return new Response(JSON.stringify({ ok: true, path }), { status: 200 });
      },
    },
  };
}

function post(path, opts = {}) {
  // An explicitly undefined origin or token means "leave it out".
  const origin = "origin" in opts ? opts.origin : ORIGIN;
  const token = "token" in opts ? opts.token : TOKEN;
  const { site, body } = opts;
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (origin !== undefined) headers.Origin = origin;
  if (site !== undefined) headers["Sec-Fetch-Site"] = site;
  const form = new URLSearchParams(body ?? {});
  if (token !== undefined) form.set("intent", token);
  return new Request(ORIGIN + path, { method: "POST", headers, body: form.toString() });
}

function get(path, headers = {}) {
  return new Request(ORIGIN + path, { method: "GET", headers });
}

function noEffects() {
  expect(calls).toEqual([]);
  expect(state.armedUntil).toBe(0);
}

beforeEach(() => {
  state = { token: TOKEN, armedUntil: 0 };
  calls = [];
  clock = 1_000_000;
  running = false;
});

describe("refusals have zero effect", () => {
  it.each([
    ["a foreign origin", { origin: "https://attacker.example" }],
    ["a null origin", { origin: "null" }],
    ["a missing origin", { origin: undefined }],
    ["same-site but not same-origin", { site: "same-site" }],
    ["cross-site fetch metadata", { site: "cross-site" }],
    ["a missing token", { token: undefined }],
    ["a wrong token", { token: "b".repeat(64) }],
    ["a short token", { token: "a" }],
  ])("POST /arm with %s", async (_name, opts) => {
    const res = await handle(post("/arm", opts), state, ports());
    expect(res.status).toBe(403);
    noEffects();
  });

  it("a simple cross-site form posting to /probe and /bench", async () => {
    for (const path of ["/probe", "/bench"]) {
      const res = await handle(
        post(path, { origin: "https://attacker.example", body: { profile: "large" } }),
        state,
        ports(),
      );
      expect(res.status).toBe(403);
    }
    noEffects();
  });

  it("a cross-site top-level GET of every control URL only shows the page", async () => {
    for (const path of ["/", "/arm", "/disarm", "/probe", "/bench"]) {
      const res = await handle(
        get(path, { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" }),
        state,
        ports(),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<form method="post"');
    }
    noEffects();
  });

  it("HEAD never acts", async () => {
    const res = await handle(new Request(ORIGIN + "/probe", { method: "HEAD" }), state, ports());
    expect(res.status).toBe(200);
    noEffects();
  });

  it("GET /jobs/<id> does not start a stopped container", async () => {
    const res = await handle(get("/jobs/0123abcd"), state, ports());
    expect(res.status).toBe(409);
    noEffects();
  });

  it("a valid POST to /probe while disarmed", async () => {
    const res = await handle(post("/probe"), state, ports());
    expect(res.status).toBe(409);
    noEffects();
  });

  it("other methods", async () => {
    const res = await handle(
      new Request(ORIGIN + "/arm", { method: "PUT", headers: { Origin: ORIGIN } }),
      state,
      ports(),
    );
    expect(res.status).toBe(405);
    noEffects();
  });
});

describe("valid same-origin controls", () => {
  it("arm, probe, bench, then the campaign disarms itself", async () => {
    let res = await handle(post("/arm"), state, ports());
    expect(res.status).toBe(303);
    expect(state.armedUntil).toBe(clock + ARM_MS);

    res = await handle(post("/probe"), state, ports());
    expect(res.status).toBe(200);
    expect(calls).toEqual(["start", "keepAlive", "fetch GET /probe"]);

    res = await handle(
      post("/bench", { body: { profile: "realistic", runs: "5", methods: "rsync,rsync-2phase" } }),
      state,
      ports(),
    );
    expect(res.status).toBe(200);
    expect(calls.at(-1)).toBe("fetch POST /bench");

    clock += ARM_MS + 1;
    calls = [];
    res = await handle(post("/probe"), state, ports());
    expect(res.status).toBe(409);
    expect(calls).toEqual([]);
  });

  it("the token may also come in X-Intent", async () => {
    const req = new Request(ORIGIN + "/arm", {
      method: "POST",
      headers: { Origin: ORIGIN, "X-Intent": TOKEN },
    });
    const res = await handle(req, state, ports());
    expect(res.status).toBe(303);
  });

  it("rejects bench parameters outside the allowed set", async () => {
    await handle(post("/arm"), state, ports());
    calls = [];
    for (const body of [{ profile: "huge" }, { runs: "0" }, { runs: "11" }, { methods: "tar" }]) {
      const res = await handle(post("/bench", { body }), state, ports());
      expect(res.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("disarm stops the campaign", async () => {
    await handle(post("/arm"), state, ports());
    const res = await handle(post("/disarm"), state, ports());
    expect(res.status).toBe(303);
    expect(state.armedUntil).toBe(0);
  });
});

describe("sameToken", () => {
  it("compares exactly", () => {
    expect(sameToken(TOKEN, TOKEN)).toBe(true);
    expect(sameToken(TOKEN, `${TOKEN.slice(0, -1)}b`)).toBe(false);
    expect(sameToken(null, TOKEN)).toBe(false);
    expect(sameToken("", "")).toBe(false);
  });
});
