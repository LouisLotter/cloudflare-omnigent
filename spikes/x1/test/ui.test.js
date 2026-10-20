// IR-017: the UI Worker's controls, tested on the real UI module with the real RunDO from the
// transport Worker behind its cross-script binding. Only the platform is faked: storage, the
// containers and the bucket record every call as an effect, so a refusal can be shown to have none.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRouteInfoCache } from "../transport/src/index.js";
import ui, { originRefusal } from "../ui/src/index.js";
import { harness } from "./harness.js";

const ORIGIN = "https://cfo-stg-x1-ui.example.test";
const EVIL = "https://evil.example";
const ACTIONS = ["preflight", "start", "stop"];

let h;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  resetRouteInfoCache();
  h = harness({
    secrets: { X1_TUNNEL_TOKEN: "t", X1_ACCESS_CLIENT_ID: "i", X1_ACCESS_CLIENT_SECRET: "s" },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function request(method, path, { origin, site, mode, form, headers, base = ORIGIN } = {}) {
  const h2 = new Headers(headers);
  if (origin !== undefined) h2.set("origin", origin);
  if (site !== undefined) h2.set("sec-fetch-site", site);
  if (mode !== undefined) h2.set("sec-fetch-mode", mode);
  let body;
  if (form !== undefined) {
    h2.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(form).toString();
  }
  return new Request(`${base}${path}`, { method, headers: h2, body });
}

/** The request-intent token, read from the confirmation page as the owner's browser would. */
async function tokenFrom(path) {
  const page = await ui.fetch(request("GET", path), h.env);
  const match = (await page.text()).match(/name="intent" value="([0-9a-f]{64})"/);
  return match?.[1];
}

async function validControl(action) {
  const intent = await tokenFrom(`/x1/${action}`);
  return ui.fetch(
    request("POST", `/x1/${action}`, {
      origin: ORIGIN,
      site: "same-origin",
      mode: "navigate",
      form: { intent: intent ?? "" },
    }),
    h.env,
  );
}

describe("a GET never changes state", () => {
  for (const action of ACTIONS) {
    it(`cross-site top-level GET /x1/${action} shows a confirmation page and does nothing`, async () => {
      const res = await ui.fetch(
        request("GET", `/x1/${action}`, { site: "cross-site", mode: "navigate" }),
        h.env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
      expect(await res.text()).toContain(`<form method="post" action="/x1/${action}">`);
      expect(h.effects).toEqual([]);
    });

    it(`HEAD /x1/${action} does nothing`, async () => {
      await ui.fetch(request("HEAD", `/x1/${action}`), h.env);
      expect(h.effects).toEqual([]);
    });
  }

  it("the status page and /x1/status read only, even during a run", async () => {
    expect((await validControl("start")).status).toBe(200);
    h.env.RUN.evict("run");
    h.effects.length = 0;
    const page = await ui.fetch(request("GET", "/"), h.env);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await page.text()).toContain("&quot;status&quot;: &quot;active&quot;");
    const json = await (await ui.fetch(request("GET", "/x1/status"), h.env)).json();
    expect(json.run.status).toBe("active");
    expect(json.run.zone).toBeUndefined();
    expect(h.effects).toEqual([]);
    expect((await ui.fetch(request("POST", "/x1/status"), h.env)).status).toBe(404);
  });
});

describe("a refused POST has zero effect", () => {
  const hostile = [
    ["a foreign origin", { origin: EVIL, site: "cross-site" }],
    ["a null origin", { origin: "null", site: "cross-site" }],
    ["a missing origin", {}],
    ["a same-origin header with a cross-site fetch", { origin: ORIGIN, site: "cross-site" }],
    ["a same-site sibling origin", { origin: "https://other.example.test", site: "same-site" }],
  ];

  for (const action of ACTIONS) {
    describe(`/x1/${action}`, () => {
      beforeEach(async () => {
        if (action === "stop") expect((await validControl("start")).status).toBe(200);
        h.effects.length = 0;
      });

      for (const [name, headers] of hostile) {
        it(`refuses ${name}, even with a valid token`, async () => {
          const intent = await tokenFrom(`/x1/${action}`);
          expect(intent).toMatch(/^[0-9a-f]{64}$/);
          const res = await ui.fetch(
            request("POST", `/x1/${action}`, { ...headers, form: { intent } }),
            h.env,
          );
          expect(res.status).toBe(403);
          expect(h.effects).toEqual([]);
        });
      }

      it("refuses a simple cross-site form (no token, urlencoded)", async () => {
        const res = await ui.fetch(
          request("POST", `/x1/${action}`, {
            origin: EVIL,
            site: "cross-site",
            mode: "navigate",
            form: { go: "1" },
          }),
          h.env,
        );
        expect(res.status).toBe(403);
        expect(h.effects).toEqual([]);
      });

      it("refuses a same-origin POST without a token, with a wrong one or an oversized form", async () => {
        for (const form of [
          {},
          { intent: "0".repeat(64) },
          { intent: "short" },
          { intent: "x".repeat(5000) },
        ]) {
          const res = await ui.fetch(
            request("POST", `/x1/${action}`, { origin: ORIGIN, site: "same-origin", form }),
            h.env,
          );
          expect(res.status).toBe(403);
        }
        const json = await ui.fetch(
          request("POST", `/x1/${action}`, {
            origin: ORIGIN,
            headers: { "content-type": "application/json", "content-length": "10" },
          }),
          h.env,
        );
        expect(json.status).toBe(403);
        expect(h.effects).toEqual([]);
      });

      it("refuses other methods", async () => {
        for (const method of ["PUT", "DELETE", "PATCH"]) {
          const res = await ui.fetch(
            request(method, `/x1/${action}`, { origin: ORIGIN, site: "same-origin" }),
            h.env,
          );
          expect(res.status).toBe(405);
        }
        expect(h.effects).toEqual([]);
      });
    });
  }
});

describe("a valid same-origin control works", () => {
  it("preflight, then stop, each with the token from its own page", async () => {
    const started = await validControl("preflight");
    expect(started.status).toBe(200);
    const body = await started.json();
    expect(body).toMatchObject({ action: "preflight", started: true, mode: "preflight" });
    expect(h.effects).toContain("computer:start");
    expect(h.effects).toContain("server:start");
    // The zone comes from the UI's own hostname: P4's and P5's hostnames for the probe.
    expect(h.starts.computer.env.X1_P5_URL).toBe(
      "wss://cfo-stg-x1-transport-tunnel.example.test/x1/echo",
    );
    h.effects.length = 0;
    const stopped = await validControl("stop");
    expect(stopped.status).toBe(200);
    expect(h.effects).toContain("computer:destroy");
    expect(h.effects).toContain("server:destroy");
  });

  it("a second start while a run is active answers 409 and starts nothing", async () => {
    expect((await validControl("start")).status).toBe(200);
    h.effects.length = 0;
    const again = await validControl("preflight");
    expect(again.status).toBe(409);
    expect(h.effects.filter((e) => e.endsWith(":start"))).toEqual([]);
  });

  it("a token works once: a replay is refused with zero effect", async () => {
    const intent = await tokenFrom("/x1/start");
    const post = () =>
      ui.fetch(
        request("POST", "/x1/start", { origin: ORIGIN, site: "same-origin", form: { intent } }),
        h.env,
      );
    expect((await post()).status).toBe(200);
    h.effects.length = 0;
    expect((await post()).status).toBe(403);
    expect(h.effects).toEqual([]);
  });

  it("a token for one action does not work for another", async () => {
    const intent = await tokenFrom("/x1/preflight");
    const res = await ui.fetch(
      request("POST", "/x1/start", { origin: ORIGIN, site: "same-origin", form: { intent } }),
      h.env,
    );
    expect(res.status).toBe(403);
    expect(h.effects).toEqual([]);
  });

  it("a token older than 10 minutes is refused with zero effect", async () => {
    const intent = await tokenFrom("/x1/start");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000 + 1);
    const res = await ui.fetch(
      request("POST", "/x1/start", { origin: ORIGIN, site: "same-origin", form: { intent } }),
      h.env,
    );
    vi.mocked(Date.now).mockRestore();
    expect(res.status).toBe(403);
    expect(h.effects).toEqual([]);
  });

  it("accepts the token in a header, without Sec-Fetch-Site (older browsers)", async () => {
    const intent = await tokenFrom("/x1/start");
    const res = await ui.fetch(
      request("POST", "/x1/start", { origin: ORIGIN, headers: { "x-x1-intent": intent } }),
      h.env,
    );
    expect(res.status).toBe(200);
    expect(h.effects).toContain("computer:start");
  });

  it("served under another hostname, a start gets no zone and starts nothing", async () => {
    const base = "https://elsewhere.example.test";
    const page = await ui.fetch(request("GET", "/x1/start", { base }), h.env);
    const intent = (await page.text()).match(/value="([0-9a-f]{64})"/)[1];
    const res = await ui.fetch(
      request("POST", "/x1/start", { base, origin: base, site: "same-origin", form: { intent } }),
      h.env,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no valid zone");
    expect(h.effects.filter((e) => e.endsWith(":start"))).toEqual([]);
  });

  it("unknown paths are 404", async () => {
    expect((await ui.fetch(request("GET", "/x1/reset"), h.env)).status).toBe(404);
  });
});

describe("originRefusal", () => {
  it("names each refusal", () => {
    const url = new URL(ORIGIN);
    const r = (headers) => originRefusal(new Request(ORIGIN, { method: "POST", headers }), url);
    expect(r({})).toBe("missing_origin");
    expect(r({ origin: "null" })).toBe("bad_origin");
    expect(r({ origin: ORIGIN, "sec-fetch-site": "same-site" })).toBe("cross_site");
    expect(r({ origin: ORIGIN, "sec-fetch-site": "same-origin" })).toBeNull();
  });
});
