// The transport Worker's real module, with the platform faked: each route's hops, the policy
// points, the recorder, the run's schedule and the forced resets.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, {
  ComputerDO,
  P1Route,
  P2Route,
  P3Echo,
  P6Policy,
  Recorder,
  resetRouteInfoCache,
} from "../transport/src/index.js";
import {
  batchKey,
  computerEnv,
  echoReply,
  failureKey,
  issueCredential,
  manifestKey,
  nextEventAt,
  parseCredential,
  parseRecorderPath,
  runIdFor,
  schedule,
  stripTrust,
  verifyCredential,
  zoneOf,
} from "../transport/src/lib.js";
import { COMPUTER_IMAGE_REF, harness, upstreamUpgrade } from "./harness.js";
import { FakeSocket } from "./setup.js";

const SECRETS = {
  X1_TUNNEL_TOKEN: "tunnel-token-canary",
  X1_ACCESS_CLIENT_ID: "client-id-canary",
  X1_ACCESS_CLIENT_SECRET: "client-secret-canary",
};
const ZONE = "example.test";
const TUNNEL = `https://cfo-stg-x1-transport-tunnel.${ZONE}`;
const WORKER = `https://cfo-stg-x1-transport.${ZONE}`;
const MIN = 60_000;

let h;
let logs;

beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line) => logs.push(String(line)));
  resetRouteInfoCache();
  h = harness({ secrets: SECRETS });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function entry(Class, props = { computerId: "c1", generation: 1, registeredBy: "test" }) {
  return new Class({ props }, h.env);
}

function upgrade(url, headers = {}) {
  return new Request(url, { headers: { upgrade: "websocket", ...headers } });
}

async function begin(mode = "run") {
  const run = h.env.RUN.get("run");
  return run.begin(mode, { zone: ZONE });
}

describe("the schedule (section 5)", () => {
  it("run: 5 minutes of warm-up, resets at S+30, 60, 90 and the end at S+120", () => {
    const plan = schedule("run", 1000);
    expect(plan.soakStart).toBe(1000 + 5 * MIN);
    expect(plan.soakEnd).toBe(plan.soakStart + 120 * MIN);
    // Amendment 1, item 7: RunDO and the probe run 60 s past the soak's end.
    expect(plan.tailEnd).toBe(plan.soakEnd + 60_000);
    expect(plan.events.map((e) => [e.kind, (e.at - plan.soakStart) / MIN])).toEqual([
      ["reset", 30],
      ["reset", 60],
      ["reset", 90],
      ["end", 121],
    ]);
    expect(plan.deploysPlanned).toEqual({
      ui: plan.soakStart + 45 * MIN,
      transport: plan.soakStart + 75 * MIN,
    });
  });

  it("preflight: one reset at 5 minutes, the end at 10", () => {
    const plan = schedule("preflight", 0);
    expect(plan.events.map((e) => [e.kind, e.at / MIN])).toEqual([
      ["reset", 5],
      ["end", 11],
    ]);
    expect(() => schedule("other", 0)).toThrow();
    expect(() => schedule("run", Number.NaN)).toThrow();
  });

  it("names runs by mode and time, and finds the next event", () => {
    expect(runIdFor("run", Date.UTC(2027, 0, 15, 8, 0, 0, 123))).toBe("run-20270115T080000Z");
    expect(nextEventAt([{ at: 5 }, { at: 3, doneAt: 1 }])).toBe(5);
    expect(nextEventAt([{ at: 3, doneAt: 1 }])).toBeNull();
  });
});

describe("starting a run", () => {
  it("persists the run, writes run.json and current.json, then starts both containers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2027, 0, 15, 8, 0, 0));
    const result = await begin("run");
    expect(result).toMatchObject({ started: true, runId: "run-20270115T080000Z", mode: "run" });
    const order = h.effects.filter((e) => /run:put:run|run.json|current.json|:start$/.test(e));
    expect(order).toEqual([
      "run:put:run",
      "r2:put:runs/run-20270115T080000Z/run.json",
      "r2:put:runs/current.json",
      "server:start",
      "computer:start",
    ]);
    const runJson = h.bucket.json("runs/run-20270115T080000Z/run.json");
    expect(runJson.zone).toBeUndefined();
    expect(runJson.worker).toBe("cfo-stg-x1-transport");
    expect(runJson.routes).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
    expect(runJson.publicRoutes).toBe(true);
    expect(h.bucket.json("runs/current.json")).toMatchObject({ status: "active", mode: "run" });
    expect(h.env.RUN.state("run").alarm).toBe(runJson.events[0].at);
    // A second start while the run is active is refused.
    expect(await begin("preflight")).toMatchObject({ started: false, error: "a run is active" });
  });

  it("without the service token secrets, P4 and P5 are not built", async () => {
    h = harness({ secrets: { X1_TUNNEL_TOKEN: "t" } });
    await begin("preflight");
    const env = h.starts.computer.env;
    expect(env.X1_ROUTES).toBe("p1,p2,p3,p6");
    expect(Object.keys(env).filter((k) => /P4|P5|ACCESS|CREDENTIAL/.test(k))).toEqual([]);
  });

  it("refuses a missing or malformed zone", async () => {
    const run = h.env.RUN.get("run");
    expect(await run.begin("run", { zone: null })).toMatchObject({ started: false });
    expect(await run.begin("run", { zone: "not a zone" })).toMatchObject({ started: false });
    expect(h.effects.filter((e) => e.endsWith(":start"))).toEqual([]);
  });
});

describe("ComputerDO", () => {
  it("registers every intercept before the container starts, with trusted props", async () => {
    await begin("run");
    const hosts = h.effects.filter((e) => e.startsWith("computer:intercept:"));
    expect(hosts).toEqual([
      "computer:intercept:p1.x1.internal",
      "computer:intercept:p2.x1.internal",
      "computer:intercept:p3.x1.internal",
      "computer:intercept:p6.x1.internal",
      "computer:intercept:rec.x1.internal",
    ]);
    expect(h.effects.indexOf("computer:intercept:rec.x1.internal")).toBeLessThan(
      h.effects.indexOf("computer:start"),
    );
    expect(h.intercepts.map((i) => i.entrypoint)).toEqual([
      "P1Route",
      "P2Route",
      "P3Echo",
      "P6Policy",
      "Recorder",
    ]);
    expect(h.intercepts[0].props).toEqual({
      computerId: "c1",
      generation: 1,
      registeredBy: "local",
    });
  });

  it("starts the computer as standard-1 from the image map, with the run and the credential", async () => {
    await begin("run");
    const start = h.starts.computer;
    expect(start).toMatchObject({
      image: COMPUTER_IMAGE_REF,
      instance: "standard-1",
      enableInternet: true,
    });
    const run = h.env.RUN.state("run").store.get("run");
    expect(start.env.X1_SOAK_END).toBe(String(run.soakEnd));
    expect(start.env.X1_END).toBe(String(run.soakEnd + 60_000));
    expect(run.events.at(-1)).toMatchObject({ kind: "end", at: run.soakEnd + 60_000 });
    expect(start.env).toMatchObject({
      X1_MODE: "run",
      X1_GENERATION: "1",
      X1_ROUTES: "p1,p2,p3,p4,p5,p6",
      X1_P4_URL: `wss://cfo-stg-x1-transport.${ZONE}/x1/echo`,
      X1_P5_URL: `wss://cfo-stg-x1-transport-tunnel.${ZONE}/x1/echo`,
      X1_ACCESS_CLIENT_ID: "client-id-canary",
      X1_ACCESS_CLIENT_SECRET: "client-secret-canary",
    });
    const computer = h.env.COMPUTER.get("c1");
    const info = {
      computerId: "c1",
      key: await computer.routeKey(),
      generation: await computer.generation(),
    };
    expect(await verifyCredential(start.env.X1_ROUTE_CREDENTIAL, info)).toMatchObject({ ok: true });
    // The server gets the Tunnel token, and only the server.
    expect(h.starts.server).toEqual({
      enableInternet: true,
      env: { X1_TUNNEL_TOKEN: "tunnel-token-canary" },
    });
    expect(JSON.stringify(start.env)).not.toContain("tunnel-token-canary");
  });

  it("never writes a secret to the bucket or the logs", async () => {
    await begin("run");
    await h.env.COMPUTER.get("c1").routeKey();
    const written = [...h.bucket.objects.values()].map((o) => o.body).join("\n") + logs.join("\n");
    for (const secret of [...Object.values(SECRETS), h.starts.computer.env.X1_ROUTE_CREDENTIAL]) {
      expect(written).not.toContain(secret);
    }
    const key = h.env.COMPUTER.state("c1").store.get("routeKey");
    expect(written).not.toContain(key);
  });

  it("replaces a container left from another run, with a new generation", async () => {
    await begin("preflight");
    h.effects.length = 0;
    const computer = h.env.COMPUTER.get("c1");
    await computer.ensure({
      ...h.env.COMPUTER.state("c1").store.get("run"),
      runId: "run-20990101T000000Z",
    });
    expect(h.effects.indexOf("computer:destroy")).toBeLessThan(h.effects.indexOf("computer:start"));
    expect(h.starts.computer.env.X1_GENERATION).toBe("2");
    expect(h.starts.computer.env.X1_RUN_ID).toBe("run-20990101T000000Z");
  });

  it("re-registers intercepts when it wakes to a running container (S2 as built)", async () => {
    await begin("run");
    h.env.COMPUTER.evict("c1");
    h.effects.length = 0;
    await h.env.COMPUTER.get("c1").generation();
    expect(h.effects.filter((e) => e.includes("intercept"))).toHaveLength(5);
    expect(h.effects).toContain("computer:inactivity");
    expect(h.effects).not.toContain("computer:start");
  });

  it("refuses to start without a run", async () => {
    await expect(h.env.COMPUTER.get("c1").ensure()).rejects.toThrow("no run");
  });

  it("the keep-alive alarm restarts a stopped container while wanted (S2's Keeper)", async () => {
    await begin("run");
    h.env.COMPUTER.state("c1").container.running = false;
    h.effects.length = 0;
    await h.env.COMPUTER.get("c1").alarm();
    expect(h.effects).toContain("computer:start");
    expect(h.starts.computer.env.X1_GENERATION).toBe("2");
    await h.env.COMPUTER.get("c1").stop();
    h.effects.length = 0;
    await h.env.COMPUTER.get("c1").alarm();
    expect(h.effects).toEqual(["computer:setAlarm"]);
  });
});

describe("P1 and P2: the private route to ServerDO", () => {
  const hostile = {
    "cf-access-jwt-assertion": "forged",
    "x-cfo-computer-id": "someone-else",
    "x-x1-serverdo": "forged",
    "x-forwarded-email": "forged",
  };

  it("P1 strips trust headers, sets the identity from props and bridges with a bare 101", async () => {
    await begin("run");
    const res = await entry(P1Route).fetch(upgrade("http://p1.x1.internal/x1/echo", hostile));
    expect(res.status).toBe(101);
    const forwarded = h.requests.server.at(-1).headers;
    expect(forwarded.get("x-cfo-computer-id")).toBe("c1");
    expect(forwarded.get("x-cfo-generation")).toBe("1");
    expect(forwarded.get("x-x1-route")).toBe("p1");
    expect(forwarded.get("cf-access-jwt-assertion")).toBeNull();
    expect(forwarded.get("x-forwarded-email")).toBeNull();
    expect(forwarded.get("x-x1-serverdo")).toMatch(/^[0-9a-f]{16}$/);
    // Bridged: the upstream socket is accepted and a new pair's end is returned.
    const upstream = h.ports.lastUpstream;
    expect(upstream.accepted).toBe(true);
    expect(res.webSocket).not.toBe(upstream);
    expect([...res.headers.keys()]).toEqual([]);
    // Messages and closes cross the bridge both ways.
    res.webSocket.send("to-server");
    expect(upstream.sent).toEqual(["to-server"]);
    upstream.dispatch("message", { data: "to-host" });
    expect(res.webSocket.peer.sent).toEqual(["to-host"]);
    upstream.dispatch("close", { code: 1006, reason: "" });
    expect(res.webSocket.peer.closed).toEqual({ code: 1000, reason: "" });
  });

  it("P2 hands the container port's socket back without accepting either socket", async () => {
    await begin("run");
    const res = await entry(P2Route).fetch(upgrade("http://p2.x1.internal/x1/echo", hostile));
    const upstream = h.ports.lastUpstream;
    expect(res.status).toBe(101);
    expect(res.webSocket).toBe(upstream);
    expect(upstream.accepted).toBe(false);
    expect([...res.headers.keys()]).toEqual([]);
    expect(h.requests.server.at(-1).headers.get("x-x1-route")).toBe("p2");
  });

  it("both refuse /x1/blocked with 403 naming the hop, before ServerDO", async () => {
    for (const [Class, hop] of [
      [P1Route, "p1-handler"],
      [P2Route, "p2-handler"],
    ]) {
      const res = await entry(Class).fetch(new Request("http://p2.x1.internal/x1/blocked"));
      expect(res.status).toBe(403);
      expect(res.headers.get("x-x1-refused-by")).toBe(hop);
    }
    expect(h.effects).toEqual([]);
  });

  it("ServerDO answers 502 when the container port fails, and retries readiness next time", async () => {
    await begin("run");
    const original = h.ports[8081];
    h.ports[8081] = async () => {
      throw new Error("connection refused");
    };
    h.env.SERVER.object("server").ready = false;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn) => {
      fn();
      return 0;
    });
    const now = Date.now();
    let calls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now + (calls++ > 4 ? 200_000 : 0));
    const res = await entry(P1Route).fetch(upgrade("http://p1.x1.internal/x1/echo"));
    expect(res.status).toBe(502);
    vi.mocked(Date.now).mockRestore();
    h.ports[8081] = original;
    const plain = await h.env.SERVER.get("server").fetch(
      new Request("http://p1.x1.internal/health"),
    );
    expect(plain.status).toBe(200);
  });
});

describe("P3 and P4: stateless echoes", () => {
  it("P3 answers itself with a WebSocketPair and echoes only the probe's fields", async () => {
    const res = await entry(P3Echo).fetch(upgrade("http://p3.x1.internal/x1/echo"));
    expect(res.status).toBe(101);
    const client = res.webSocket;
    client.send(JSON.stringify({ t: "echo", route: "p3", conn: 1, seq: 5, sent: 1.5, x: "no" }));
    client.send("junk");
    const replies = client.peer.sent.map((s) => JSON.parse(s));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ t: "echo", route: "p3", conn: 1, seq: 5, sent: 1.5 });
    expect(replies[0].id).toMatchObject({ by: "p3-handler", build: "local" });
    expect(replies[0].id.isolate).toMatch(/^[0-9a-f]{16}$/);
    expect(replies[0].x).toBeUndefined();
    client.peer.dispatch("close", { code: 4000, reason: "silence" });
    expect(client.peer.closed).toEqual({ code: 4000, reason: "closing" });
    client.peer.dispatch("close", { code: 1006, reason: "" }); // a second close is ignored
  });

  it("P3 refuses a plain request; P4 serves only /x1/echo on the Worker's hostname", async () => {
    expect((await entry(P3Echo).fetch(new Request("http://p3.x1.internal/x1/echo"))).status).toBe(
      426,
    );
    const res = await worker.fetch(upgrade(`${WORKER}/x1/echo`), h.env);
    expect(res.status).toBe(101);
    res.webSocket.send(JSON.stringify({ t: "echo", route: "p4", conn: 1, seq: 1, sent: 0 }));
    expect(JSON.parse(res.webSocket.peer.sent[0]).id.by).toBe("p4-worker");
    expect((await worker.fetch(new Request(`${WORKER}/x1/start`), h.env)).status).toBe(404);
  });

  it("a send on a closed pair is ignored", async () => {
    const res = await entry(P3Echo).fetch(upgrade("http://p3.x1.internal/x1/echo"));
    res.webSocket.peer.closed = { code: 1000 };
    res.webSocket.send(JSON.stringify({ t: "echo", route: "p3", conn: 1, seq: 1, sent: 0 }));
    expect(res.webSocket.peer.sent).toEqual([]);
  });
});

describe("P5: the public Tunnel's policy route", () => {
  async function credential(generation = 1) {
    const key = await h.env.COMPUTER.get("c1").routeKey();
    return issueCredential(key, "c1", generation);
  }

  function tunnelRequest(path, extra = {}) {
    return upgrade(`${TUNNEL}${path}`, {
      "cf-access-client-id": "client-id-canary",
      "cf-access-client-secret": "client-secret-canary",
      "cf-access-jwt-assertion": "a.b.c",
      ...extra,
    });
  }

  it("refuses /x1/blocked first, naming the hop", async () => {
    const res = await worker.fetch(new Request(`${TUNNEL}/x1/blocked`), h.env);
    expect(res.status).toBe(403);
    expect(res.headers.get("x-x1-refused-by")).toBe("p5-route");
  });

  it("refuses a missing, wrong or old route credential", async () => {
    await begin("run");
    const good = await credential(1);
    const wrongMac = good.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    const fetchSpy = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);
    const cases = [
      [{}, "credential missing or malformed"],
      [{ "x-x1-route-credential": wrongMac }, "bad credential"],
      [{ "x-x1-route-credential": good.replace(/^c1/, "c2") }, "another computer"],
    ];
    for (const [headers, reason] of cases) {
      const res = await worker.fetch(tunnelRequest("/x1/echo", headers), h.env);
      expect(res.status).toBe(403);
      expect(res.headers.get("x-x1-refused-by")).toBe("p5-route");
      expect(await res.text()).toContain(reason);
    }
    // A new container: generation 2. Generation 1's credential is now older.
    h.env.COMPUTER.state("c1").container.running = false;
    await h.env.COMPUTER.get("c1").ensure();
    const newer = await credential(2);
    expect(
      (await worker.fetch(tunnelRequest("/x1/echo", { "x-x1-route-credential": newer }), h.env))
        .status,
    ).toBe(200);
    const old = await worker.fetch(
      tunnelRequest("/x1/echo", { "x-x1-route-credential": good }),
      h.env,
    );
    expect(await old.text()).toContain("older generation");
    const future = await worker.fetch(
      tunnelRequest("/x1/echo", { "x-x1-route-credential": newer.replace(".2.", ".3.") }),
      h.env,
    );
    expect(await future.text()).toContain("unknown generation");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards a verified upgrade to the origin and returns its response unaccepted", async () => {
    await begin("run");
    const { socket, response } = upstreamUpgrade();
    const fetchSpy = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchSpy);
    const presented = await credential(1);
    const res = await worker.fetch(
      tunnelRequest("/x1/echo", {
        "x-x1-route-credential": presented,
        "x-cfo-computer-id": "forged",
      }),
      h.env,
    );
    expect(res).toBe(response);
    expect(socket.accepted).toBe(false);
    const sent = fetchSpy.mock.calls[0][0];
    expect(sent.url).toBe(`${TUNNEL}/x1/echo`);
    expect(sent.headers.get("x-x1-route-credential")).toBeNull();
    expect(sent.headers.get("cf-access-client-secret")).toBeNull();
    expect(sent.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(sent.headers.get("x-cfo-computer-id")).toBe("c1");
    expect(sent.headers.get("x-cfo-generation")).toBe("1");
    expect(sent.headers.get("x-x1-route")).toBe("p5");
    expect(sent.headers.get("x-x1-policy")).toMatch(/^[0-9a-f]{16}$/);
    expect(sent.headers.get("upgrade")).toBe("websocket");
  });

  it("caches only the key per isolate and reads the generation on every handshake", async () => {
    await begin("run");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok")),
    );
    const computer = h.env.COMPUTER.object("c1");
    const keys = vi.spyOn(computer, "routeKey");
    const generations = vi.spyOn(computer, "generation");
    const presented = await credential(1);
    keys.mockClear();
    for (let i = 0; i < 3; i++) {
      await worker.fetch(tunnelRequest("/x1/echo", { "x-x1-route-credential": presented }), h.env);
    }
    expect(keys).toHaveBeenCalledTimes(1);
    expect(generations).toHaveBeenCalledTimes(3);
  });

  it("refuses a replaced generation's credential once the cache is warm (review r1, finding 5)", async () => {
    await begin("run");
    const fetchSpy = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);
    const first = await credential(1);
    const warm = await worker.fetch(
      tunnelRequest("/x1/echo", { "x-x1-route-credential": first }),
      h.env,
    );
    expect(warm.status).toBe(200);
    // The computer restarts: ComputerDO advances to generation 2. Nobody presents it yet.
    h.env.COMPUTER.state("c1").container.running = false;
    await h.env.COMPUTER.get("c1").ensure();
    const stale = await worker.fetch(
      tunnelRequest("/x1/echo", { "x-x1-route-credential": first }),
      h.env,
    );
    expect(stale.status).toBe(403);
    expect(stale.headers.get("x-x1-refused-by")).toBe("p5-route");
    expect(await stale.text()).toContain("older generation");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("answers 503 if the credential check fails and 502 if the origin fetch fails", async () => {
    await begin("run");
    const presented = await credential(1);
    vi.spyOn(h.env.COMPUTER.object("c1"), "generation").mockRejectedValueOnce(new Error("reset"));
    const failed = await worker.fetch(
      tunnelRequest("/x1/echo", { "x-x1-route-credential": presented }),
      h.env,
    );
    expect(failed.status).toBe(503);
    expect(failed.headers.get("x-x1-hop")).toBe("p5-route");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("tunnel down"))),
    );
    const down = await worker.fetch(
      tunnelRequest("/x1/echo", { "x-x1-route-credential": presented }),
      h.env,
    );
    expect(down.status).toBe(502);
  });
});

describe("P6: the private Tunnel's policy handler", () => {
  it("refuses /x1/blocked naming the hop, before the VPC service", async () => {
    const vpc = { fetch: vi.fn() };
    h.env.X1_VPC = vpc;
    const res = await entry(P6Policy).fetch(new Request("http://p6.x1.internal/x1/blocked"));
    expect(res.status).toBe(403);
    expect(res.headers.get("x-x1-refused-by")).toBe("p6-handler");
    expect(vpc.fetch).not.toHaveBeenCalled();
  });

  it("forwards through the VPC service and returns the socket unaccepted under a bare 101", async () => {
    const { socket, response } = upstreamUpgrade();
    h.env.X1_VPC = { fetch: vi.fn(async () => response) };
    const res = await entry(P6Policy).fetch(
      upgrade("http://p6.x1.internal/x1/echo?x=1", {
        "x-cfo-generation": "99",
        "x-x1-policy": "forged",
      }),
    );
    expect(res.status).toBe(101);
    expect(res.webSocket).toBe(socket);
    expect(socket.accepted).toBe(false);
    expect([...res.headers.keys()]).toEqual([]);
    const sent = h.env.X1_VPC.fetch.mock.calls[0][0];
    expect(sent.url).toBe("http://127.0.0.1:8081/x1/echo?x=1");
    expect(sent.headers.get("x-cfo-generation")).toBe("1");
    expect(sent.headers.get("x-x1-route")).toBe("p6");
    expect(sent.headers.get("x-x1-policy")).not.toBe("forged");
  });

  it("passes a plain response through, and answers 502 without the binding or on failure", async () => {
    h.env.X1_VPC = { fetch: vi.fn(async () => new Response("plain")) };
    expect(await (await entry(P6Policy).fetch(new Request("http://p6.x1.internal/x"))).text()).toBe(
      "plain",
    );
    h.env.X1_VPC = { fetch: vi.fn(async () => Promise.reject(new Error("no route"))) };
    expect((await entry(P6Policy).fetch(upgrade("http://p6.x1.internal/x1/echo"))).status).toBe(
      502,
    );
    delete h.env.X1_VPC;
    const missing = await entry(P6Policy).fetch(upgrade("http://p6.x1.internal/x1/echo"));
    expect(missing.status).toBe(502);
    expect(missing.headers.get("x-x1-hop")).toBe("p6-handler");
  });
});

describe("the recorder (rec.x1.internal)", () => {
  const run = "run-20270115T080000Z";
  const instance = "g1-0a1b2c3d-00a1b2";

  function post(path, body = "line\n", headers = {}) {
    return entry(Recorder).fetch(
      new Request(`http://rec.x1.internal${path}`, { method: "POST", body, headers }),
    );
  }

  it("stores a batch once: a retry finds it and changes nothing", async () => {
    const first = await (await post(`/x1/batch/${run}/${instance}/1`, "first\n")).json();
    const again = await (await post(`/x1/batch/${run}/${instance}/1`, "first\n")).json();
    expect(first).toEqual({ stored: true, existed: false });
    expect(again).toEqual({ stored: false, existed: true });
    expect(h.bucket.objects.get(batchKey(run, instance, 1)).body).toBe("first\n");
    expect(h.bucket.objects.get(batchKey(run, instance, 1)).options.customMetadata).toMatchObject({
      generation: "1",
    });
    await post(`/x1/manifest/${run}/${instance}`, '{"batches":1}');
    expect(h.bucket.json(manifestKey(run, instance))).toEqual({ batches: 1 });
  });

  it("stores the probe's failure record create-only, like a manifest (review r2, finding 3)", async () => {
    const body = '{"failure":"manifest conflict","conflicts":[]}';
    expect(await (await post(`/x1/failure/${run}/${instance}`, body)).json()).toEqual({
      stored: true,
      existed: false,
    });
    expect(h.bucket.objects.get(failureKey(run, instance)).body).toBe(body);
    expect((await post(`/x1/failure/${run}/${instance}`, "{}")).status).toBe(409);
  });

  it("refuses other paths, methods and oversized bodies", async () => {
    for (const path of [
      "/x1/batch/bad/g1-0a1b2c3d-00a1b2/1",
      `/x1/batch/${run}/bad/1`,
      `/x1/batch/${run}/${instance}/0`,
      "/other",
    ]) {
      expect((await post(path)).status).toBe(404);
    }
    const get = await entry(Recorder).fetch(
      new Request(`http://rec.x1.internal/x1/batch/${run}/${instance}/1`),
    );
    expect(get.status).toBe(404);
    expect(
      (
        await post(`/x1/batch/${run}/${instance}/2`, "x", {
          "content-length": String(5 * 1024 * 1024),
        })
      ).status,
    ).toBe(413);
    expect(
      (await post(`/x1/batch/${run}/${instance}/2`, "x".repeat(4 * 1024 * 1024 + 1))).status,
    ).toBe(413);
    expect(h.bucket.objects.size).toBe(0);
  });

  it("stores the body's sha256 and acknowledges a retry only when the bodies match", async () => {
    const key = batchKey(run, instance, 5);
    expect(await (await post(`/x1/batch/${run}/${instance}/5`, "same\n")).json()).toEqual({
      stored: true,
      existed: false,
    });
    const hash = h.bucket.objects.get(key).options.customMetadata.sha256;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await (await post(`/x1/batch/${run}/${instance}/5`, "same\n")).json()).toEqual({
      stored: false,
      existed: true,
    });
    const other = await post(`/x1/batch/${run}/${instance}/5`, "different\n");
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ stored: false, conflict: true });
    expect(h.bucket.objects.get(key).body).toBe("same\n");
  });

  it("a racing write that lands first is checked by its hash", async () => {
    const key = batchKey(run, instance, 3);
    const realHead = h.bucket.head.bind(h.bucket);
    // Another write of the same body lands between the head and the conditional put.
    const racer = async (body) => {
      vi.spyOn(h.bucket, "head").mockImplementationOnce(async () => {
        await new Recorder({ props: { generation: 1 } }, h.env).fetch(
          new Request(`http://rec.x1.internal/x1/batch/${run}/${instance}/3`, {
            method: "POST",
            body,
          }),
        );
        return null;
      });
    };
    await racer("late\n");
    expect(await (await post(`/x1/batch/${run}/${instance}/3`, "late\n")).json()).toEqual({
      stored: false,
      existed: true,
    });
    h.bucket.head = realHead;
    h.bucket.objects.delete(key);
    await racer("racer\n");
    const conflict = await post(`/x1/batch/${run}/${instance}/3`, "late\n");
    expect(conflict.status).toBe(409);
    expect(h.bucket.objects.get(key).body).toBe("racer\n");
  });

  it("never falls back to an unconditional put: an error is retryable (review r1, finding 6)", async () => {
    h.bucket.failConditional = true;
    const res = await post(`/x1/batch/${run}/${instance}/4`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ stored: false, retry: true });
    expect(h.bucket.objects.size).toBe(0);
    expect(h.effects.filter((e) => e.startsWith("r2:put"))).toEqual([]);
  });
});

describe("RunDO: forced resets and the end", () => {
  it("records R, then has ServerDO record and abort itself; each reset acts once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2027, 0, 15, 8, 0, 0));
    await begin("run");
    const run = h.env.RUN.state("run").store.get("run");
    vi.setSystemTime(run.events[0].at + 1500);
    h.effects.length = 0;
    await h.env.RUN.get("run").alarm();
    const lifecycle = h.bucket.keys(`runs/${run.runId}/lifecycle/`).map((k) => h.bucket.json(k));
    const requested = lifecycle.find((r) => r.x1 === "reset-requested");
    expect(requested).toMatchObject({
      event: "reset-s30",
      planned: run.events[0].at,
      R: run.events[0].at + 1500,
    });
    const abort = lifecycle.find((r) => r.x1 === "abort");
    expect(abort.role).toBe("server");
    const ended = lifecycle.find((r) => r.x1 === "reset-call-ended");
    expect(ended.error).toContain("Durable Object reset");
    // Persist before effect: the event is marked done before the reset is requested.
    expect(h.effects.indexOf("run:put:run")).toBeLessThan(h.effects.indexOf("server:abort"));
    expect(h.env.RUN.state("run").store.get("run").events[0].doneAt).toBeDefined();
    expect(h.env.RUN.state("run").alarm).toBe(run.events[1].at);
    // The server object was reset: a new instance, the container still running.
    expect(h.env.SERVER.state("server").container.running).toBe(true);
    h.effects.length = 0;
    await h.env.RUN.get("run").alarm();
    expect(h.effects).not.toContain("server:abort");
  });

  it("a reset whose call returns is recorded too", async () => {
    await begin("preflight");
    vi.spyOn(h.env.SERVER.object("server"), "reset").mockResolvedValueOnce(undefined);
    const run = h.env.RUN.state("run").store.get("run");
    vi.spyOn(Date, "now").mockReturnValue(run.events[0].at);
    await h.env.RUN.get("run").alarm();
    const ended = h.bucket
      .keys(`runs/${run.runId}/lifecycle/`)
      .map((k) => h.bucket.json(k))
      .find((r) => r.x1 === "reset-call-ended");
    expect(ended.error).toBeUndefined();
  });

  it("at the end waits for the probe's manifest, then stops both containers and writes end.json", async () => {
    await begin("preflight");
    const run = h.env.RUN.state("run").store.get("run");
    const now = vi.spyOn(Date, "now").mockReturnValue(run.tailEnd + 1);
    await h.env.RUN.get("run").alarm();
    let stored = h.env.RUN.state("run").store.get("run");
    expect(stored.status).toBe("ending");
    expect(h.env.RUN.state("run").alarm).toBe(run.tailEnd + 1 + 10_000);
    expect(h.bucket.objects.has(`runs/${run.runId}/end.json`)).toBe(false);
    // Batches arrive (several pages of keys), then the manifest.
    for (let n = 1; n <= 3; n++)
      await h.bucket.put(batchKey(run.runId, "g1-0a1b2c3d-00a1b2", n), "x");
    await h.env.RUN.get("run").alarm();
    expect(h.bucket.objects.has(`runs/${run.runId}/end.json`)).toBe(false);
    await h.bucket.put(manifestKey(run.runId, "g1-0a1b2c3d-00a1b2"), "{}");
    now.mockReturnValue(run.tailEnd + 20_000);
    h.effects.length = 0;
    await h.env.RUN.get("run").alarm();
    stored = h.env.RUN.state("run").store.get("run");
    expect(stored.status).toBe("ended");
    expect(h.effects).toContain("computer:destroy");
    expect(h.effects).toContain("server:destroy");
    const end = h.bucket.json(`runs/${run.runId}/end.json`);
    expect(end).toMatchObject({
      reason: "end",
      manifests: [manifestKey(run.runId, "g1-0a1b2c3d-00a1b2")],
    });
    expect(end.stops).toEqual({ computer: { stopped: true }, server: { stopped: true } });
    expect(h.bucket.json("runs/current.json").status).toBe("ended");
    // An ended run does nothing on a stray alarm.
    h.effects.length = 0;
    await h.env.RUN.get("run").alarm();
    expect(h.effects).toEqual([]);
  });

  it("ends on the failure record that replaces a conflicting manifest", async () => {
    await begin("preflight");
    const run = h.env.RUN.state("run").store.get("run");
    vi.spyOn(Date, "now").mockReturnValue(run.tailEnd + 1);
    await h.bucket.put(failureKey(run.runId, "g1-0a1b2c3d-00a1b2"), "{}");
    await h.env.RUN.get("run").alarm();
    const end = h.bucket.json(`runs/${run.runId}/end.json`);
    expect(end).toMatchObject({
      reason: "end",
      manifests: [failureKey(run.runId, "g1-0a1b2c3d-00a1b2")],
    });
  });

  it("finishes without a manifest after the grace period", async () => {
    await begin("preflight");
    const run = h.env.RUN.state("run").store.get("run");
    const now = vi.spyOn(Date, "now").mockReturnValue(run.tailEnd + 1);
    await h.env.RUN.get("run").alarm();
    now.mockReturnValue(run.tailEnd + 6 * MIN);
    vi.spyOn(h.env.SERVER.object("server"), "stop").mockRejectedValueOnce(new Error("gone"));
    await h.env.RUN.get("run").alarm();
    const end = h.bucket.json(`runs/${run.runId}/end.json`);
    expect(end).toMatchObject({
      reason: "end",
      manifests: [],
      stops: { server: { error: "Error: gone" } },
    });
  });

  it("stop: ends an active run, or makes sure both containers are down", async () => {
    await h.env.RUN.get("run").halt("stopped by the owner");
    expect(h.effects).toContain("run:deleteAlarm");
    await begin("run");
    const result = await h.env.RUN.get("run").halt("stopped by the owner");
    expect(result).toMatchObject({ stopped: true, reason: "stopped by the owner" });
    expect(h.env.RUN.state("run").store.get("run").status).toBe("stopped");
    expect(h.env.COMPUTER.state("c1").container.running).toBe(false);
  });

  it("status reads only, and records a construction only on an alarm or control", async () => {
    await begin("run");
    h.env.RUN.evict("run");
    h.effects.length = 0;
    const status = await h.env.RUN.get("run").status();
    expect(status.run.zone).toBeUndefined();
    expect(status.run.status).toBe("active");
    expect(h.effects).toEqual([]);
    await h.env.RUN.get("run").alarm();
    const constructed = h.bucket
      .keys("runs/")
      .map((k) => h.bucket.json(k))
      .filter((r) => r?.x1 === "constructed" && r.role === "run");
    expect(constructed).toHaveLength(1);
  });
});

describe("ServerDO's log pull", () => {
  it("copies the container's log by offset every 30 s, starting again at 0 for a new log", async () => {
    await begin("run");
    const server = h.env.SERVER.get("server");
    const runId = h.env.SERVER.state("server").store.get("run").runId;
    h.ports.logText = "a\nb\n";
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000_000);
    await server.alarm();
    expect(h.bucket.objects.get(`runs/${runId}/server-log/b0b0b0b0-1/000000000000.log`).body).toBe(
      "a\nb\n",
    );
    h.ports.logText = "a\nb\nc\n";
    now.mockReturnValue(10_010_000);
    await server.alarm(); // within 30 s: no pull
    expect(h.requests.log).toEqual([0]);
    now.mockReturnValue(10_040_000);
    await server.alarm();
    expect(h.requests.log).toEqual([0, 4]);
    expect(h.bucket.objects.get(`runs/${runId}/server-log/b0b0b0b0-1/000000000004.log`).body).toBe(
      "c\n",
    );
    // A new container: a new log ID, read from 0.
    h.ports.logId = "c0c0c0c0-2";
    h.ports.logText = "new\n";
    now.mockReturnValue(10_080_000);
    await server.alarm();
    expect(h.bucket.objects.get(`runs/${runId}/server-log/c0c0c0c0-2/000000000000.log`).body).toBe(
      "new\n",
    );
  });

  it("survives a failing log server and pulls a last time on stop", async () => {
    await begin("run");
    const server = h.env.SERVER.get("server");
    h.ports[8082] = async () => new Response("no", { status: 500 });
    await server.pullLog();
    h.ports[8082] = async () => {
      throw new Error("refused");
    };
    await server.pullLog();
    expect(logs.some((l) => l.includes("log-pull-error"))).toBe(true);
    h.ports[8082] = async () => new Response("last\n", { headers: { "x-x1-log-id": "d-1" } });
    await server.stop();
    expect(h.bucket.keys().some((k) => k.endsWith("/server-log/d-1/000000000000.log"))).toBe(true);
  });
});

describe("pure helpers", () => {
  it("echoReply refuses anything but a probe echo", () => {
    for (const bad of [
      new ArrayBuffer(1),
      "x".repeat(5000),
      "{",
      "null",
      JSON.stringify({ t: "echo", route: "p7", conn: 1, seq: 1, sent: 1 }),
      JSON.stringify({ t: "echo", route: "p1", conn: 1.5, seq: 1, sent: 1 }),
      JSON.stringify({ t: "echo", route: "p1", conn: 1, seq: "1", sent: 1 }),
      JSON.stringify({ t: "echo", route: "p1", conn: 1, seq: 1, sent: "1" }),
    ]) {
      expect(echoReply(bad, {}, 0)).toBeNull();
    }
  });

  it("parses recorder paths and credentials strictly", () => {
    expect(parseRecorderPath("/x1/batch/run-20270115T080000Z/g1-0a1b2c3d-00a1b2/12")).toMatchObject(
      {
        kind: "batch",
        n: 12,
        key: "runs/run-20270115T080000Z/probe/g1-0a1b2c3d-00a1b2/batch-000012.jsonl",
      },
    );
    expect(parseRecorderPath("/x1/manifest/run-20270115T080000Z/nope")).toBeNull();
    expect(
      parseRecorderPath("/x1/batch/run-20270115T080000Z/g1-0a1b2c3d-00a1b2/1000000"),
    ).toBeNull();
    expect(parseCredential(`c1.2.${"f".repeat(64)}`)).toEqual({
      computerId: "c1",
      generation: 2,
      mac: "f".repeat(64),
    });
    expect(parseCredential("c1.2.short")).toBeNull();
    expect(parseCredential(undefined)).toBeNull();
  });

  it("zoneOf, stripTrust and computerEnv", () => {
    expect(zoneOf("cfo-stg-x1-ui.example.test", "cfo-stg-x1-ui")).toBe("example.test");
    expect(zoneOf("other.example.test", "cfo-stg-x1-ui")).toBeNull();
    expect(zoneOf("cfo-stg-x1-ui.bad_zone", "cfo-stg-x1-ui")).toBeNull();
    const headers = new Headers({
      "cf-access-x": "1",
      "x-x1-a": "1",
      "x-cfo-b": "1",
      "x-forwarded-user": "u",
      keep: "1",
    });
    stripTrust(headers);
    expect([...headers.keys()]).toEqual(["keep"]);
    const run = {
      runId: "r",
      mode: "run",
      t0: 1,
      soakStart: 2,
      soakEnd: 3,
      tailEnd: 4,
      routes: ["p1"],
      publicRoutes: false,
      zone: "z.test",
    };
    expect(computerEnv(run, 1, "cred", { clientId: "a", clientSecret: "b" })).toEqual({
      X1_RUN_ID: "r",
      X1_MODE: "run",
      X1_T0: "1",
      X1_SOAK_START: "2",
      X1_SOAK_END: "3",
      X1_END: "4",
      X1_GENERATION: "1",
      X1_ROUTES: "p1",
    });
  });

  it("FakeSocket refuses a double close", () => {
    const socket = new FakeSocket();
    socket.close(1000, "x");
    expect(() => socket.close(1000, "x")).toThrow();
  });

  it("an unknown control action is refused", async () => {
    const run = h.env.RUN.get("run");
    await expect(run.intentToken("reset")).rejects.toThrow();
    expect(await run.control("reset", "x")).toEqual({ ok: false });
  });

  it("ComputerDO's class is the one bound to the computer container", () => {
    expect(h.env.COMPUTER.object("c1")).toBeInstanceOf(ComputerDO);
  });
});
