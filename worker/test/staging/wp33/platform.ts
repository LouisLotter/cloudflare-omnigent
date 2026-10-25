// WP3.3 staging harness: the platform Worker as WP3.3's staging checks deploy it. Test code only,
// never shipped. Started by its own cron trigger, so no owner step is needed: the first tick of a
// deployment whose `WP33_RUN_TAG` has no run yet starts one.
//
// Mode "full" (wrangler.platform.jsonc): the production OmnigentServer with a stand-in server
// container, and four stand-in computers, one per container configuration:
//   def-off  default scheduling policy, internet off (WP2.2's stand-in)
//   def-on   default scheduling policy, internet on
//   do-on    `durable_object` policy, internet on (the design's computers; X1's)
//   do-off   `durable_object` policy, internet off
// Each computer's probe holds one WebSocket per route, through the computer's intercepts:
//   native.internal → NativeRoute → OmnigentServer → server port 8000 (WP2.2's ComputerRoute:
//                     the socket is never accepted in JavaScript)
//   bridge.internal → BridgeRoute → OmnigentServer → server port 8000 (the route accepts both
//                     ends and relays, closing each side with a close frame when the other ends)
//   route.internal  → OmnigentRoute, the production handler (internal/omnigent-route.ts), once
//                     it exists (WP33_PRODUCTION_ROUTE)
// The run forces resets of OmnigentServer and a server container stop; run.sh deploys this
// Worker again mid-run for a version switch. The probe records when each connection's end
// reached the computer, and how (WP2.2's design change 7).
//
// Both modes also run StartBench: starts of a `durable_object`-policy container, with and
// without `monitor()`, right after a stop and after gaps, for 3.C's open question 3 and VD-16.
// Mode "bench" (wrangler.bench.jsonc) runs only the bench, on a second fresh deployment.
//
// Results go to the RESULTS bucket under runs/<run>/, read with run.sh collect.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { bareUpgradeHeaders, stripTrustHeaders } from "../../../src/server/headers.ts";
import { OmnigentServer as PlatformOmnigentServer } from "../../../src/server/OmnigentServer.ts";
import {
  FORWARD_VERSION_HEADER,
  OMNIGENT_SERVER_INTERFACE_VERSION,
  OMNIGENT_SERVER_OBJECT_NAME,
} from "../../../src/shared/rpc.ts";
import { BUILD } from "./build.ts";

export { PlatformInternal } from "../../../src/internal/entrypoints.ts";

interface StagingEnv {
  readonly OMNIGENT?: DurableObjectNamespace<OmnigentServer>;
  readonly COMPUTER_DEF_OFF?: DurableObjectNamespace<ComputerDefOff>;
  readonly COMPUTER_DEF_ON?: DurableObjectNamespace<ComputerDefOn>;
  readonly COMPUTER_DO_ON?: DurableObjectNamespace<ComputerDoOn>;
  readonly COMPUTER_DO_OFF?: DurableObjectNamespace<ComputerDoOff>;
  readonly BENCH: DurableObjectNamespace<StartBench>;
  readonly RUN: DurableObjectNamespace<StagingRun>;
  readonly RESULTS: R2Bucket;
  readonly WP33_MODE: "full" | "bench";
  readonly WP33_RUN_TAG: string;
}

const SEC = 1000;
const MIN = 60 * SEC;
const TICK_MS = 15 * SEC;
const LOG_PORT = 8002;
const call = { interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The full run's schedule, from T0. run.sh uploads the platform Worker again at T0+16 min. */
const SCHEDULE: readonly { readonly kind: EventKind; readonly at: number }[] = [
  { kind: "reset", at: 4 * MIN },
  { kind: "reset", at: 7 * MIN },
  { kind: "stop", at: 10 * MIN },
  { kind: "reset", at: 14 * MIN },
  { kind: "reset", at: 29 * MIN },
  { kind: "end", at: 32 * MIN },
];
type EventKind = "reset" | "stop" | "end";

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ cfo: "wp33_staging", event, build: BUILD.id, ...fields }));
}

function text(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300);
}

function runStub(env: StagingEnv) {
  return env.RUN.getByName("run");
}

// ---------------------------------------------------------------------------------------------
// The server

/** The production class, with the harness's three calls (as WP2.2's harness). */
export class OmnigentServer extends PlatformOmnigentServer {
  async stagingReset(reason: string): Promise<void> {
    log("forced_reset", { reason });
    this.ctx.abort(reason);
  }

  async stagingStopContainer(): Promise<{ wasRunning: boolean; at: number }> {
    const container = this.ctx.container;
    const wasRunning = container?.running ?? false;
    if (container && wasRunning) await container.destroy("wp33 staging: container stop");
    log("container_stopped_by_harness", { wasRunning });
    return { wasRunning, at: Date.now() };
  }

  async stagingLog(offset: number): Promise<{ boot: string | null; text: string }> {
    const container = this.ctx.container;
    if (!container?.running) return { boot: null, text: "" };
    const response = await container
      .getTcpPort(LOG_PORT)
      .fetch(`http://omnigent/log?offset=${Math.max(0, Math.floor(offset))}`, {
        signal: AbortSignal.timeout(5_000),
      });
    return { boot: response.headers.get("x-wp33-boot"), text: await response.text() };
  }
}

// ---------------------------------------------------------------------------------------------
// The routes under test

interface RouteProps {
  readonly variant: string;
  readonly runId: string;
}

function forwardedRequest(request: Request, hop: string): Request {
  const headers = new Headers(request.headers);
  stripTrustHeaders(headers);
  headers.set(FORWARD_VERSION_HEADER, String(OMNIGENT_SERVER_INTERFACE_VERSION));
  headers.set("x-wp33-hop", hop); // reaches the stand-in's log: not a trust header
  return new Request(request, { headers, redirect: "manual" });
}

function serverStub(env: StagingEnv) {
  if (!env.OMNIGENT) throw new Error("no OMNIGENT binding in this mode");
  return env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME);
}

/** WP2.2's ComputerRoute: the server's 101 goes back as it came. */
export class NativeRoute extends WorkerEntrypoint<StagingEnv, RouteProps> {
  override async fetch(request: Request): Promise<Response> {
    return serverStub(this.env).fetch(forwardedRequest(request, "native"));
  }
}

/** The close codes a WebSocket may send; anything else becomes 1011. */
function sendable(code: number): number {
  return code === 1000 ||
    (code >= 1001 && code <= 1003) ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
    ? code
    : 1011;
}

/**
 * Accepts both ends and relays frames unchanged (binaryType arraybuffer). When one side ends,
 * the other is closed with a close frame: a normal code is passed on, an abnormal end (1006) of
 * the server's side becomes 1012 ("service restart").
 */
export class BridgeRoute extends WorkerEntrypoint<StagingEnv, RouteProps> {
  override async fetch(request: Request): Promise<Response> {
    const response = await serverStub(this.env).fetch(forwardedRequest(request, "bridge"));
    const upstream = response.webSocket;
    if (!upstream) return response;
    const props = this.ctx.props;
    const opened = Date.now();
    const pair = new WebSocketPair();
    const client = pair[0];
    const computer = pair[1];
    upstream.binaryType = "arraybuffer";
    computer.binaryType = "arraybuffer";
    upstream.accept();
    computer.accept();
    let ended = false;
    const end = (from: "server" | "computer", other: WebSocket, code: number, reason: string) => {
      if (!ended) {
        ended = true;
        const row = {
          ev: "bridge_end",
          wall: Date.now(),
          from,
          code,
          openMs: Date.now() - opened,
          variant: props.variant,
        };
        log("bridge_end", row);
        this.ctx.waitUntil(
          runStub(this.env)
            .rows("note", [JSON.stringify(row)])
            .catch(() => undefined),
        );
      }
      const passed = from === "server" && code === 1006 ? 1012 : sendable(code);
      try {
        other.close(passed, reason.slice(0, 100) || "the other side ended");
      } catch {
        // already closed
      }
    };
    computer.addEventListener("message", (event) => {
      try {
        upstream.send(event.data as ArrayBuffer | string);
      } catch {
        end("server", computer, 1011, "server side gone");
      }
    });
    upstream.addEventListener("message", (event) => {
      try {
        computer.send(event.data as ArrayBuffer | string);
      } catch {
        end("computer", upstream, 1011, "computer side gone");
      }
    });
    upstream.addEventListener("close", (event) =>
      end("server", computer, event.code, event.reason),
    );
    computer.addEventListener("close", (event) =>
      end("computer", upstream, event.code, event.reason),
    );
    upstream.addEventListener("error", () => end("server", computer, 1011, "server side error"));
    computer.addEventListener("error", () =>
      end("computer", upstream, 1011, "computer side error"),
    );
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: bareUpgradeHeaders(response.headers),
    });
  }
}

/** rec.internal: the probe's records, kept by the run. */
export class Recorder extends WorkerEntrypoint<StagingEnv, RouteProps> {
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = await request.text();
    const lines = body
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(0, 5000);
    await runStub(this.env).rows(
      "probe",
      lines.map((line) => line.slice(0, 2000)),
    );
    return new Response(null, { status: 204 });
  }
}

// ---------------------------------------------------------------------------------------------
// Stand-in computers

interface Variant {
  readonly name: string;
  readonly policy: "default" | "durable_object";
  readonly internet: boolean;
  readonly ladder: boolean;
  readonly flood: readonly string[];
}

const ROUTE_HOSTS: readonly (readonly [string, "NativeRoute" | "BridgeRoute"])[] = [
  ["native.internal", "NativeRoute"],
  ["bridge.internal", "BridgeRoute"],
];

abstract class ComputerBase extends DurableObject<StagingEnv> {
  protected abstract variant(): Variant;

  constructor(ctx: DurableObjectState, env: StagingEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      if (ctx.container?.running) {
        await ctx.container.setInactivityTimeout(40 * MIN);
        const runId = await ctx.storage.get<string>("runId");
        if (runId) await this.intercept(runId);
      }
    });
  }

  async intercept(runId: string): Promise<void> {
    const exports = this.ctx.exports as unknown as Record<
      string,
      (options: { props: RouteProps }) => Fetcher
    >;
    const props: RouteProps = { variant: this.variant().name, runId };
    const container = this.ctx.container;
    if (!container) return;
    for (const [host, entrypoint] of ROUTE_HOSTS) {
      const factory = exports[entrypoint];
      if (factory) await container.interceptOutboundHttp(host, factory({ props }));
    }
    const recorder = exports.Recorder;
    if (recorder) await container.interceptOutboundHttp("rec.internal", recorder({ props }));
  }

  async ensure(runId: string): Promise<{ running: boolean }> {
    const container = this.ctx.container;
    if (!container) throw new Error("no container configured");
    await this.ctx.storage.put("runId", runId);
    await this.ctx.storage.put("wanted", true);
    const v = this.variant();
    if (!container.running) {
      await this.intercept(runId);
      const env = {
        WP33_HOSTS: ROUTE_HOSTS.map(([host]) => host).join(","),
        WP33_VARIANT: v.name,
        WP33_LADDER: v.ladder ? "1" : "",
        WP33_FLOOD: v.flood.join(","),
      };
      if (v.policy === "durable_object") {
        const image = container.images.probe;
        if (!image) throw new Error("no probe image");
        container.start({ image, instance: "standard-1", enableInternet: v.internet, env });
      } else {
        container.start({ enableInternet: v.internet, env } as ContainerStartupOptions);
      }
      log("computer_started", { variant: v.name });
    }
    await container.setInactivityTimeout(40 * MIN);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 30 * SEC);
    }
    return { running: container.running };
  }

  override async alarm(): Promise<void> {
    if (!(await this.ctx.storage.get("wanted"))) return;
    const runId = await this.ctx.storage.get<string>("runId");
    try {
      if (runId) await this.ensure(runId);
    } catch (error) {
      log("computer_error", { variant: this.variant().name, error: text(error) });
    }
    await this.ctx.storage.setAlarm(Date.now() + 30 * SEC);
  }

  async stop(): Promise<void> {
    await this.ctx.storage.put("wanted", false);
    await this.ctx.storage.deleteAlarm();
    if (this.ctx.container?.running) await this.ctx.container.destroy("wp33 staging: run ended");
  }
}

export class ComputerDefOff extends ComputerBase {
  protected variant(): Variant {
    return { name: "def-off", policy: "default", internet: false, ladder: true, flood: [] };
  }
}
export class ComputerDefOn extends ComputerBase {
  protected variant(): Variant {
    return { name: "def-on", policy: "default", internet: true, ladder: false, flood: [] };
  }
}
export class ComputerDoOn extends ComputerBase {
  protected variant(): Variant {
    // No ladder here: a 31–33 MiB message ran this probe out of memory on `lite` (diag-1).
    return {
      name: "do-on",
      policy: "durable_object",
      internet: true,
      ladder: false,
      flood: ["bridge.internal", "native.internal"],
    };
  }
}
export class ComputerDoOff extends ComputerBase {
  protected variant(): Variant {
    return { name: "do-off", policy: "durable_object", internet: false, ladder: false, flood: [] };
  }
}

// ---------------------------------------------------------------------------------------------
// The start bench (3.C's open question 3; VD-16)

interface CycleSpec {
  readonly label: string;
  /** Pause between the confirmed stop and the first start; null for the deployment's first. */
  readonly gapMs: number | null;
  readonly monitor: boolean;
  readonly instance: string;
  /** "image": the image's own command (bench_server.py on 8090); "inline": INLINE_SERVER. */
  readonly command?: "image" | "inline";
}

/**
 * bench-1 found the image's own command exiting with code 1 about a second after every start
 * (it runs locally). This server, passed as the entrypoint, tries the binds the supervisor will
 * need, reports what each did to rec.internal (the bench's recorder intercept), and serves
 * /health on the first that worked: 8090 on IPv4, then IPv6, then 8091.
 */
const INLINE_SERVER = `
import http.server as h, json, os, socket, sys, threading, time, traceback, urllib.request
class H(h.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"upMs": round((time.time() - START) * 1000), "port": PORT}).encode()
        self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
class H6(h.ThreadingHTTPServer):
    address_family = socket.AF_INET6
START = time.time(); res = []; srv = None; PORT = None
for host, port in (("0.0.0.0", 8090), ("::", 8090), ("0.0.0.0", 8091)):
    try:
        s = (H6 if host == "::" else h.ThreadingHTTPServer)((host, port), H)
        res.append([host, port, "ok"])
        if srv is None: srv, PORT = s, port
        else: s.server_close()
    except Exception as e:
        res.append([host, port, repr(e)[:300]])
def post():
    body = json.dumps({"ev": "bench_bind", "wall": time.time() * 1000, "variant": "bench", "res": res, "label": os.environ.get("WP33_BENCH"), "uid": os.getuid(), "py": sys.version[:30]}).encode()
    for _ in range(10):
        try:
            urllib.request.urlopen(urllib.request.Request("http://rec.internal/batch", data=body, method="POST"), timeout=5); return
        except Exception:
            time.sleep(1)
threading.Thread(target=post, daemon=True).start()
if srv is None:
    time.sleep(60); sys.exit(3)
srv.serve_forever()
`;

const BENCH_PLAN: readonly CycleSpec[] = [
  // bench-2: why the image's command exits, then the start measurements on what runs.
  {
    label: "diag-image-std1",
    gapMs: null,
    monitor: true,
    instance: "standard-1",
    command: "image",
  },
  { label: "diag-inline-std1", gapMs: 0, monitor: true, instance: "standard-1", command: "inline" },
  { label: "diag-image-lite", gapMs: 0, monitor: true, instance: "lite", command: "image" },
  { label: "diag-inline-lite", gapMs: 0, monitor: true, instance: "lite", command: "inline" },
  { label: "gap0-a", gapMs: 0, monitor: false, instance: "standard-1", command: "inline" },
  { label: "gap0-monitor-a", gapMs: 0, monitor: true, instance: "standard-1", command: "inline" },
  { label: "gap0-b", gapMs: 0, monitor: false, instance: "standard-1", command: "inline" },
  { label: "gap0-monitor-b", gapMs: 0, monitor: true, instance: "standard-1", command: "inline" },
  { label: "gap2s", gapMs: 2_000, monitor: false, instance: "standard-1", command: "inline" },
  { label: "gap5s", gapMs: 5_000, monitor: false, instance: "standard-1", command: "inline" },
  { label: "gap10s", gapMs: 10_000, monitor: false, instance: "standard-1", command: "inline" },
  { label: "gap20s", gapMs: 20_000, monitor: false, instance: "standard-1", command: "inline" },
  { label: "gap0-standard-2", gapMs: 0, monitor: false, instance: "standard-2", command: "inline" },
  { label: "gap0-basic", gapMs: 0, monitor: true, instance: "basic", command: "inline" },
];
/** bench-1's plan (25 Oct): every cycle hit the image command's exit 1. Kept for the record. */
export const BENCH_1_PLAN: readonly CycleSpec[] = [
  { label: "fresh", gapMs: null, monitor: false, instance: "standard-1" },
  { label: "gap0-a", gapMs: 0, monitor: false, instance: "standard-1" },
  { label: "gap0-monitor-a", gapMs: 0, monitor: true, instance: "standard-1" },
  { label: "gap0-b", gapMs: 0, monitor: false, instance: "standard-1" },
  { label: "gap0-monitor-b", gapMs: 0, monitor: true, instance: "standard-1" },
  { label: "gap2s-monitor", gapMs: 2_000, monitor: true, instance: "standard-1" },
  { label: "gap5s", gapMs: 5_000, monitor: false, instance: "standard-1" },
  { label: "gap10s", gapMs: 10_000, monitor: false, instance: "standard-1" },
  { label: "gap20s", gapMs: 20_000, monitor: false, instance: "standard-1" },
  { label: "gap0-standard-2", gapMs: 0, monitor: false, instance: "standard-2" },
  { label: "gap0-basic", gapMs: 0, monitor: false, instance: "basic" },
  { label: "gap0-c", gapMs: 0, monitor: true, instance: "standard-1" },
];
const RETRY_AFTER_MS = [5_000, 10_000, 20_000, 20_000];
const NO_INSTANCE = "there is no container instance that can be provided to this durable object";

interface Attempt {
  n: number;
  sinceStopMs: number | null;
  threw: string | null;
  runningAfterStart: boolean;
  runningTrueMs: number | null;
  runningFalseMs: number | null;
  runningAt10s: boolean | null;
  readyMs: number | null;
  upMs: number | null;
  errors: { ms: number; text: string }[];
  monitorMs: number | null;
  monitorError: string | null;
  outcome: "ready" | "refused" | "timeout" | "threw";
}

export class StartBench extends DurableObject<StagingEnv> {
  async begin(runId: string): Promise<void> {
    if ((await this.ctx.storage.get("runId")) === runId) return;
    await this.ctx.storage.put({ runId, next: 0, lastStopAt: null });
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  override async alarm(): Promise<void> {
    const runId = await this.ctx.storage.get<string>("runId");
    const next = (await this.ctx.storage.get<number>("next")) ?? 0;
    if (!runId || next >= BENCH_PLAN.length) return;
    const spec = BENCH_PLAN[next] as CycleSpec;
    await this.ctx.storage.put("next", next + 1); // persist before effect: a cycle runs once
    let result: unknown;
    try {
      result = await this.cycle(spec);
    } catch (error) {
      result = { error: text(error) };
    }
    await runStub(this.env).rows("bench", [
      JSON.stringify({ ev: "cycle", wall: Date.now(), runId, spec, result, build: BUILD.id }),
    ]);
    if (next + 1 < BENCH_PLAN.length) await this.ctx.storage.setAlarm(Date.now() + 2000);
    else {
      if (this.ctx.container?.running) await this.ctx.container.destroy("wp33 bench done");
      await runStub(this.env).rows("bench", [JSON.stringify({ ev: "done", wall: Date.now() })]);
    }
  }

  async cycle(spec: CycleSpec): Promise<unknown> {
    const container = this.ctx.container;
    if (!container) throw new Error("no container configured");
    let lastStopAt = (await this.ctx.storage.get<number | null>("lastStopAt")) ?? null;
    let destroyMs: number | null = null;
    if (container.running) {
      const t = Date.now();
      await container.destroy("wp33 bench: next cycle");
      destroyMs = Date.now() - t;
      lastStopAt = Date.now();
      await this.ctx.storage.put("lastStopAt", lastStopAt);
    }
    if (spec.gapMs) await sleep(spec.gapMs);
    const attempts: Attempt[] = [];
    for (let i = 0; i <= RETRY_AFTER_MS.length; i += 1) {
      if (i > 0) await sleep(RETRY_AFTER_MS[i - 1] as number);
      const attempt = await this.attempt(container, spec, i + 1, lastStopAt);
      attempts.push(attempt);
      if (attempt.outcome !== "refused") break;
    }
    // Hold the container a little, then stop it for the next cycle.
    await sleep(3000);
    const runningBeforeStop = container.running;
    if (container.running) {
      await container.destroy("wp33 bench: cycle end");
      await this.ctx.storage.put("lastStopAt", Date.now());
    }
    return { destroyMs, attempts, runningBeforeStop };
  }

  async attempt(
    container: Container,
    spec: CycleSpec,
    n: number,
    lastStopAt: number | null,
  ): Promise<Attempt> {
    const t0 = Date.now();
    const a: Attempt = {
      n,
      sinceStopMs: lastStopAt === null ? null : t0 - lastStopAt,
      threw: null,
      runningAfterStart: false,
      runningTrueMs: null,
      runningFalseMs: null,
      runningAt10s: null,
      readyMs: null,
      upMs: null,
      errors: [],
      monitorMs: null,
      monitorError: null,
      outcome: "timeout",
    };
    // The recorder for the inline server's report, registered before every start.
    const runId = (await this.ctx.storage.get<string>("runId")) ?? "none";
    const recorder = (
      this.ctx.exports as unknown as Record<string, (o: { props: RouteProps }) => Fetcher>
    ).Recorder;
    if (recorder) {
      await container.interceptOutboundHttp(
        "rec.internal",
        recorder({ props: { variant: "bench", runId } }),
      );
    }
    try {
      const image = container.images.bench;
      container.start({
        image,
        instance: spec.instance,
        enableInternet: true,
        env: { WP33_BENCH: spec.label },
        ...(spec.command === "inline" ? { entrypoint: ["python", "-c", INLINE_SERVER] } : {}),
      } as ContainerStartupOptions);
    } catch (error) {
      a.threw = text(error);
      a.outcome = a.threw.toLowerCase().includes(NO_INSTANCE) ? "refused" : "threw";
      return a;
    }
    a.runningAfterStart = container.running;
    let monitorDone = false;
    if (spec.monitor) {
      container.monitor().then(
        () => {
          a.monitorMs = Date.now() - t0;
          monitorDone = true;
        },
        (error: unknown) => {
          a.monitorMs = Date.now() - t0;
          a.monitorError = text(error);
          monitorDone = true;
        },
      );
    }
    let wasRunning = a.runningAfterStart;
    let lastProbe = 0;
    while (Date.now() - t0 < 20_000) {
      const ms = Date.now() - t0;
      const running = container.running;
      if (running && a.runningTrueMs === null) a.runningTrueMs = ms;
      if (!running && wasRunning && a.runningFalseMs === null) a.runningFalseMs = ms;
      wasRunning = running;
      if (a.runningAt10s === null && ms >= 10_000) a.runningAt10s = running;
      if (ms - lastProbe >= 250) {
        lastProbe = ms;
        try {
          const response = await container
            .getTcpPort(8090)
            .fetch("http://bench/health", { signal: AbortSignal.timeout(1000) });
          if (response.ok) {
            const body = (await response.json()) as { upMs?: number };
            a.readyMs = Date.now() - t0;
            a.upMs = typeof body.upMs === "number" ? body.upMs : null;
            a.outcome = "ready";
            break;
          }
          await response.body?.cancel();
        } catch (error) {
          const t = text(error);
          if (a.errors.length < 6 && !a.errors.some((e) => e.text === t)) {
            a.errors.push({ ms: Date.now() - t0, text: t });
          }
          if (t.toLowerCase().includes(NO_INSTANCE)) {
            a.outcome = "refused";
            break;
          }
        }
      }
      if (monitorDone && a.monitorError?.toLowerCase().includes(NO_INSTANCE)) {
        a.outcome = "refused";
        break;
      }
      await sleep(50);
    }
    if (a.runningAt10s === null && Date.now() - t0 >= 10_000) a.runningAt10s = container.running;
    // A monitor() still pending is left: the container's stop settles it.
    return a;
  }
}

// ---------------------------------------------------------------------------------------------
// The run

interface RunRecord {
  runId: string;
  tag: string;
  mode: "full" | "bench";
  t0: number;
  status: "active" | "ended";
  events: { kind: EventKind; at: number; doneAt: number | null; result?: unknown }[];
  logOffset: number;
  logBoot: string | null;
  lastDump: number;
}

export class StagingRun extends DurableObject<StagingEnv> {
  constructor(ctx: DurableObjectState, env: StagingEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, line TEXT)",
    );
  }

  /** The cron trigger, every minute. */
  async tick(): Promise<void> {
    const run = await this.ctx.storage.get<RunRecord>("run");
    if (!run || run.tag !== this.env.WP33_RUN_TAG) {
      await this.begin();
      return;
    }
    if (run.status === "active" && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
  }

  async begin(): Promise<void> {
    const t0 = Date.now();
    const mode = this.env.WP33_MODE;
    const run: RunRecord = {
      runId: `run-${new Date(t0).toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z`,
      tag: this.env.WP33_RUN_TAG,
      mode,
      t0,
      status: "active",
      events: (mode === "full" ? SCHEDULE : [{ kind: "end" as const, at: 14 * MIN }]).map((e) => ({
        kind: e.kind,
        at: t0 + e.at,
        doneAt: null,
      })),
      logOffset: 0,
      logBoot: null,
      lastDump: 0,
    };
    this.ctx.storage.sql.exec("DELETE FROM rows");
    await this.ctx.storage.put("run", run);
    await this.env.RESULTS.put("runs/current.json", JSON.stringify(run));
    await this.env.RESULTS.put(`runs/${run.runId}/run.json`, JSON.stringify(run));
    this.#event(run, "run_started", { mode, build: BUILD.id });
    if (mode === "full") {
      await serverStub(this.env).ensureStarted(call);
      for (const ns of this.#computers()) {
        await ns
          .getByName("computer")
          .ensure(run.runId)
          .catch((error: unknown) => this.#event(run, "computer_error", { error: text(error) }));
      }
    }
    await this.env.BENCH.getByName("bench").begin(run.runId);
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  #computers() {
    return [
      this.env.COMPUTER_DEF_OFF,
      this.env.COMPUTER_DEF_ON,
      this.env.COMPUTER_DO_ON,
      this.env.COMPUTER_DO_OFF,
    ].filter((ns) => ns !== undefined) as DurableObjectNamespace<ComputerBase>[];
  }

  async rows(kind: string, lines: string[]): Promise<void> {
    for (const line of lines) {
      this.ctx.storage.sql.exec("INSERT INTO rows (kind, line) VALUES (?, ?)", kind, line);
    }
  }

  #event(run: RunRecord, event: string, fields: Record<string, unknown>): void {
    const row = { ev: event, wall: Date.now(), runId: run.runId, build: BUILD.id, ...fields };
    log(event, row);
    this.ctx.storage.sql.exec(
      "INSERT INTO rows (kind, line) VALUES (?, ?)",
      "event",
      JSON.stringify(row),
    );
  }

  override async alarm(): Promise<void> {
    const run = await this.ctx.storage.get<RunRecord>("run");
    if (run?.status !== "active") return;
    for (const event of run.events) {
      if (event.doneAt !== null || event.at > Date.now()) continue;
      event.doneAt = Date.now(); // persist before effect: each event acts at most once
      await this.ctx.storage.put("run", run);
      this.#event(run, `${event.kind}_requested`, { plannedAt: event.at });
      const server = this.env.OMNIGENT ? serverStub(this.env) : null;
      if (event.kind === "reset" && server) {
        await server.stagingReset("wp33 staging: forced reset").catch(() => undefined);
        this.#event(run, "reset_called", {});
      } else if (event.kind === "stop" && server) {
        const result = await server.stagingStopContainer().catch((e: unknown) => text(e));
        this.#event(run, "stop_done", { result });
      }
    }
    if (this.env.OMNIGENT) await this.#pullServerLog(run);
    const ending = run.events.every((e) => e.doneAt !== null);
    if (ending || Date.now() - run.lastDump > 2 * MIN) {
      run.lastDump = Date.now();
      await this.ctx.storage.put("run", run);
      await this.#dump(run);
    }
    if (ending) {
      for (const ns of this.#computers()) {
        await ns
          .getByName("computer")
          .stop()
          .catch(() => undefined);
      }
      run.status = "ended";
      await this.ctx.storage.put("run", run);
      this.#event(run, "run_ended", {});
      await this.#dump(run);
      await this.env.RESULTS.put("runs/current.json", JSON.stringify(run));
      await this.env.RESULTS.put(`runs/${run.runId}/end.json`, JSON.stringify(run));
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async #pullServerLog(run: RunRecord): Promise<void> {
    try {
      for (let i = 0; i < 4; i += 1) {
        const offset = run.logBoot === null ? 0 : run.logOffset;
        const chunk = await serverStub(this.env).stagingLog(offset);
        if (chunk.boot === null) return;
        if (chunk.boot !== run.logBoot) {
          if (run.logBoot !== null) {
            run.logBoot = chunk.boot;
            run.logOffset = 0;
            continue;
          }
          run.logBoot = chunk.boot;
        }
        if (chunk.text.length === 0) return;
        const lines = chunk.text.split("\n").filter((l) => l.length > 0);
        await this.rows("server", lines);
        run.logOffset += new TextEncoder().encode(chunk.text).byteLength;
        await this.ctx.storage.put("run", run);
        if (chunk.text.length < 1 << 20) return;
      }
    } catch (error) {
      log("server_log_error", { error: text(error) });
    }
  }

  async #dump(run: RunRecord): Promise<void> {
    const kinds = this.ctx.storage.sql
      .exec<{ kind: string }>("SELECT DISTINCT kind FROM rows")
      .toArray()
      .map((r) => r.kind);
    for (const kind of kinds) {
      const lines = this.ctx.storage.sql
        .exec<{ line: string }>("SELECT line FROM rows WHERE kind = ? ORDER BY id", kind)
        .toArray()
        .map((r) => r.line);
      await this.env.RESULTS.put(`runs/${run.runId}/rows-${kind}.jsonl`, `${lines.join("\n")}\n`);
    }
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("not found\n", { status: 404 });
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(runStub(env).tick());
  },
} satisfies ExportedHandler<StagingEnv>;
