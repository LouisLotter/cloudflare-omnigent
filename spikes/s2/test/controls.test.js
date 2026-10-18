// IR-017: the spike's public controls, tested on the real Worker module (src/index.js) with
// its real ServerDO and ComputerDO classes. Only the platform is faked: Durable Object storage
// and the container record every call as an effect, so a refusal can be shown to have none.
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { ComputerDO, ServerDO } from "../src/index.js";

const ORIGIN = "https://cfo-stg-s2-route.example.test";
const EVIL = "https://evil.example";

const COMPUTER_IMAGE_REF = `registry.example/cfo-stg-s2-route-computerdo-computer@sha256:${"a".repeat(64)}`;

function harness() {
  const effects = [];
  const starts = {};
  const env = {};

  function ctxFor(role) {
    const store = new Map();
    let alarm = null;
    const ctx = {
      ready: Promise.resolve(),
      container: {
        running: false,
        // Only a durable_object-policy application has an image map: the computer's.
        images: role === "computer" ? { computer: COMPUTER_IMAGE_REF } : undefined,
        start(options) {
          effects.push(`${role}:start`);
          starts[role] = options;
          this.running = true;
        },
        async destroy() {
          effects.push(`${role}:destroy`);
          this.running = false;
        },
        async setInactivityTimeout() {
          effects.push(`${role}:inactivity`);
        },
        async interceptOutboundHttp(host) {
          effects.push(`${role}:intercept:${host}`);
        },
        getTcpPort() {
          throw new Error("no container port in these tests");
        },
      },
      storage: {
        async get(key) {
          return store.get(key);
        },
        async put(key, value) {
          effects.push(`${role}:put:${key}`);
          store.set(key, value);
        },
        async getAlarm() {
          return alarm;
        },
        async setAlarm(when) {
          effects.push(`${role}:setAlarm`);
          alarm = when;
        },
        async deleteAlarm() {
          effects.push(`${role}:deleteAlarm`);
          alarm = null;
        },
      },
      blockConcurrencyWhile(fn) {
        ctx.ready = fn();
        return ctx.ready;
      },
      exports: { PrivateRoute: (options) => ({ options }) },
      waitUntil() {},
      getWebSockets: () => [],
    };
    return ctx;
  }

  function namespace(Class, role) {
    const objects = new Map();
    return {
      idFromName: (name) => name,
      get(id) {
        if (!objects.has(id)) {
          const ctx = ctxFor(role);
          const object = new Class(ctx, env);
          // As in the runtime, every call waits for the constructor's blockConcurrencyWhile.
          const stub = new Proxy(object, {
            get(target, prop) {
              const value = target[prop];
              if (typeof value !== "function") return value;
              return async (...args) => {
                await ctx.ready;
                return value.apply(target, args);
              };
            },
          });
          objects.set(id, { stub, ctx });
        }
        return objects.get(id).stub;
      },
      ctx: (id) => objects.get(id)?.ctx,
    };
  }

  env.SERVER = namespace(ServerDO, "server");
  env.COMPUTER = namespace(ComputerDO, "computer");
  return { env, effects, starts };
}

function request(method, path, { origin, site, mode, form, headers } = {}) {
  const h = new Headers(headers);
  if (origin !== undefined) h.set("origin", origin);
  if (site !== undefined) h.set("sec-fetch-site", site);
  if (mode !== undefined) h.set("sec-fetch-mode", mode);
  let body;
  if (form !== undefined) {
    h.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(form).toString();
  }
  return new Request(`${ORIGIN}${path}`, { method, headers: h, body });
}

/** The request-intent token, read from the confirmation page as the owner's browser would. */
async function tokenFrom(env, path) {
  const page = await worker.fetch(request("GET", path), env);
  const match = (await page.text()).match(/name="intent" value="([0-9a-f]{64})"/);
  return match?.[1];
}

async function validControl(env, action) {
  const intent = await tokenFrom(env, `/s2/${action}`);
  return worker.fetch(
    request("POST", `/s2/${action}`, {
      origin: ORIGIN,
      site: "same-origin",
      mode: "navigate",
      form: { intent: intent ?? "" },
    }),
    env,
  );
}

let h;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  h = harness();
});

describe("a GET never changes state", () => {
  for (const action of ["start", "stop"]) {
    it(`cross-site top-level GET /s2/${action} shows a confirmation page and does nothing`, async () => {
      const res = await worker.fetch(
        request("GET", `/s2/${action}`, { site: "cross-site", mode: "navigate" }),
        h.env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      const html = await res.text();
      expect(html).toContain(`<form method="post" action="/s2/${action}">`);
      expect(h.effects).toEqual([]);
    });

    it(`HEAD /s2/${action} does nothing`, async () => {
      await worker.fetch(request("HEAD", `/s2/${action}`), h.env);
      expect(h.effects).toEqual([]);
    });
  }

  it("GET /s2/status reads only", async () => {
    const res = await worker.fetch(request("GET", "/s2/status"), h.env);
    expect(res.status).toBe(200);
    expect(h.effects).toEqual([]);
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

  for (const action of ["start", "stop"]) {
    describe(`/s2/${action}`, () => {
      beforeEach(async () => {
        if (action === "stop") {
          // Stop is only meaningful on a running campaign: start it the valid way first.
          expect((await validControl(h.env, "start")).status).toBe(200);
        }
        h.effects.length = 0;
      });

      for (const [name, headers] of hostile) {
        it(`refuses ${name}, even with a valid token`, async () => {
          const intent = await tokenFrom(h.env, `/s2/${action}`);
          expect(intent).toMatch(/^[0-9a-f]{64}$/);
          const res = await worker.fetch(
            request("POST", `/s2/${action}`, { ...headers, form: { intent } }),
            h.env,
          );
          expect(res.status).toBe(403);
          expect(h.effects).toEqual([]);
        });
      }

      it("refuses a simple cross-site form (no token, urlencoded)", async () => {
        const res = await worker.fetch(
          request("POST", `/s2/${action}`, {
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

      it("refuses a same-origin POST without a token, or with a wrong one", async () => {
        for (const form of [{}, { intent: "0".repeat(64) }, { intent: "short" }]) {
          const res = await worker.fetch(
            request("POST", `/s2/${action}`, { origin: ORIGIN, site: "same-origin", form }),
            h.env,
          );
          expect(res.status).toBe(403);
        }
        expect(h.effects).toEqual([]);
      });

      it("refuses other methods", async () => {
        for (const method of ["PUT", "DELETE", "PATCH"]) {
          const res = await worker.fetch(
            request(method, `/s2/${action}`, { origin: ORIGIN, site: "same-origin" }),
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
  it("start, then stop, each with the token from its own page", async () => {
    const started = await validControl(h.env, "start");
    expect(started.status).toBe(200);
    expect(h.effects).toContain("computer:start");
    expect(h.effects).toContain("server:start");
    expect(h.effects).toContain("computer:intercept:omnigent.internal");
    // The intercept is registered before the container starts.
    expect(h.effects.indexOf("computer:intercept:omnigent.internal")).toBeLessThan(
      h.effects.indexOf("computer:start"),
    );
    expect(h.env.COMPUTER.ctx("c1").container.running).toBe(true);
    // The computer: durable_object policy, image from the version's map, standard-1.
    expect(h.starts.computer).toMatchObject({
      image: COMPUTER_IMAGE_REF,
      instance: "standard-1",
      enableInternet: true,
    });
    // The server: default policy, so no image or size at start.
    expect(h.starts.server).not.toHaveProperty("image");
    expect(h.starts.server).not.toHaveProperty("instance");

    h.effects.length = 0;
    const stopped = await validControl(h.env, "stop");
    expect(stopped.status).toBe(200);
    expect(h.effects).toContain("computer:destroy");
    expect(h.effects).toContain("server:destroy");
    expect(h.env.COMPUTER.ctx("c1").container.running).toBe(false);
  });

  it("a token works once: a replay is refused with zero effect", async () => {
    const intent = await tokenFrom(h.env, "/s2/start");
    const post = () =>
      worker.fetch(
        request("POST", "/s2/start", { origin: ORIGIN, site: "same-origin", form: { intent } }),
        h.env,
      );
    expect((await post()).status).toBe(200);
    h.effects.length = 0;
    expect((await post()).status).toBe(403);
    expect(h.effects).toEqual([]);
  });

  it("a token is bound to its action: the start page's token cannot stop", async () => {
    expect((await validControl(h.env, "start")).status).toBe(200);
    const startToken = await tokenFrom(h.env, "/s2/start");
    h.effects.length = 0;
    const res = await worker.fetch(
      request("POST", "/s2/stop", {
        origin: ORIGIN,
        site: "same-origin",
        form: { intent: startToken },
      }),
      h.env,
    );
    expect(res.status).toBe(403);
    expect(h.effects).toEqual([]);
  });

  it("a token older than 10 minutes is refused with zero effect", async () => {
    const intent = await tokenFrom(h.env, "/s2/start");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000 + 1);
    const res = await worker.fetch(
      request("POST", "/s2/start", { origin: ORIGIN, site: "same-origin", form: { intent } }),
      h.env,
    );
    vi.mocked(Date.now).mockRestore();
    expect(res.status).toBe(403);
    expect(h.effects).toEqual([]);
  });

  it("accepts the token in a header, without Sec-Fetch-Site (older browsers)", async () => {
    const intent = await tokenFrom(h.env, "/s2/start");
    const res = await worker.fetch(
      request("POST", "/s2/start", { origin: ORIGIN, headers: { "x-s2-intent": intent } }),
      h.env,
    );
    expect(res.status).toBe(200);
    expect(h.effects).toContain("computer:start");
  });
});
