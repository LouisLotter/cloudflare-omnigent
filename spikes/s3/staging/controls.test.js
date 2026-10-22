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
let campaignStatus;
let lastBody;

function ports() {
  return {
    now: () => clock,
    saveArm: async (armedUntil) => {
      calls.push(`saveArm ${armedUntil}`);
    },
    campaign: {
      view: async () =>
        campaignStatus ? { campaign: { id: "c1", status: campaignStatus } } : null,
      start: async (plan) => {
        calls.push(`campaign start ${plan}`);
        if (campaignStatus === "running") return { ok: false, reason: "a campaign is running" };
        campaignStatus = "running";
        return { ok: true };
      },
      stop: async (reason) => {
        calls.push(`campaign stop ${reason}`);
      },
    },
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
        lastBody = init.body;
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
  campaignStatus = null;
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

  it("a simple cross-site form posting to /probe, /bench and /campaign", async () => {
    for (const path of ["/probe", "/bench", "/campaign"]) {
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
    for (const path of ["/", "/arm", "/disarm", "/probe", "/bench", "/campaign"]) {
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

  it("GET /results only reads the stored campaign", async () => {
    campaignStatus = "running";
    const res = await handle(get("/results", { "Sec-Fetch-Site": "cross-site" }), state, ports());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Campaign c1");
    noEffects();
  });

  it("a cross-site POST /campaign with a valid-looking body starts nothing", async () => {
    const res = await handle(
      post("/campaign", { site: "cross-site", body: { plan: "full" } }),
      state,
      ports(),
    );
    expect(res.status).toBe(403);
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
  it("arm, probe, bench, then the manual arming expires", async () => {
    let res = await handle(post("/arm"), state, ports());
    expect(res.status).toBe(303);
    expect(state.armedUntil).toBe(clock + ARM_MS);
    expect(calls).toEqual([`saveArm ${clock + ARM_MS}`]);
    calls = [];

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
    expect(JSON.parse(lastBody)).toEqual({
      profile: "realistic",
      plan: [
        { method: "rsync", runs: 5 },
        { method: "rsync-2phase", runs: 5 },
      ],
    });

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

  it("disarm disarms and stops the campaign", async () => {
    await handle(post("/arm"), state, ports());
    const res = await handle(post("/disarm"), state, ports());
    expect(res.status).toBe(303);
    expect(state.armedUntil).toBe(0);
    expect(calls).toContain("campaign stop disarmed by the owner");
  });

  it("starts a campaign, refuses a second, and refuses the manual controls meanwhile", async () => {
    let res = await handle(post("/campaign", { body: { plan: "full" } }), state, ports());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/results");
    expect(calls).toEqual(["campaign start full"]);
    res = await handle(post("/campaign", { body: { plan: "quick" } }), state, ports());
    expect(res.status).toBe(409);
    await handle(post("/arm"), state, ports());
    calls = [];
    res = await handle(post("/probe"), state, ports());
    expect(res.status).toBe(409);
    expect(calls).toEqual([]);
  });

  it("refuses an unknown campaign plan", async () => {
    const res = await handle(post("/campaign", { body: { plan: "forever" } }), state, ports());
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
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
