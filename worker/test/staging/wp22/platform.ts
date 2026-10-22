// WP2.2 staging harness: the platform Worker as WP2.2's staging cases deploy it. Test code only,
// never shipped. It runs the production OmnigentServer (with the stand-in server container of
// server/), and adds:
//   - three staging-only calls on OmnigentServer: a forced reset, a container stop for the
//     watchdog case, and a read of the stand-in's event log;
//   - ComputerRoute, a stand-in for WP3.3's omnigent.internal handler: the stand-in computer's
//     WebSocket goes intercept → ComputerRoute → OmnigentServer.fetch → the server container,
//     the path a host's tunnel takes on A′;
//   - StagingComputer, the stand-in computer's Durable Object;
//   - StagingRun, the run's schedule and results, started by the owner's one click on this
//     Worker's own page (behind owner-only Access) and recorded in the results bucket.
//
// The laptop's run.sh deploys the web Worker again and this Worker again at fixed times after
// the click, and collects the results. Schedule, from the click (T0):
//   T0         server and computer started
//   T0+8 min   forced reset of OmnigentServer
//   T0+16 min  web Worker deploy (run.sh)              → no drop expected
//   T0+24 min  platform Worker deploy (run.sh)         → version switch about 300 s later
//   T0+36 min  the server container stopped            → the watchdog restarts it
//   T0+46 min  end: final log pull, computer stopped

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { stripTrustHeaders } from "../../../src/server/headers.ts";
import { OmnigentServer as PlatformOmnigentServer } from "../../../src/server/OmnigentServer.ts";
import {
  FORWARD_VERSION_HEADER,
  OMNIGENT_SERVER_INTERFACE_VERSION,
  OMNIGENT_SERVER_OBJECT_NAME,
} from "../../../src/shared/rpc.ts";
import { BUILD } from "./build.ts";

export { PlatformInternal } from "../../../src/server/platform-internal.ts";

interface StagingEnv {
  readonly OMNIGENT: DurableObjectNamespace<OmnigentServer>;
  readonly COMPUTER: DurableObjectNamespace<StagingComputer>;
  readonly RUN: DurableObjectNamespace<StagingRun>;
  readonly RESULTS: R2Bucket;
}

const MIN = 60_000;
const SCHEDULE = {
  reset: 8 * MIN,
  webDeploy: 16 * MIN,
  platformDeploy: 24 * MIN,
  stop: 36 * MIN,
  end: 46 * MIN,
};
const TICK_MS = 30_000;
const INTENT_TTL_MS = 10 * MIN;
const LOG_PORT = 8002;
const call = { interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION };

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ cfo: "wp22_staging", event, build: BUILD.id, ...fields }));
}

const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// ---------------------------------------------------------------------------------------------

/** The production class, with the harness's three calls. */
export class OmnigentServer extends PlatformOmnigentServer {
  /** A forced reset of this object, as X1 forced ServerDO's. The call itself cannot answer. */
  async stagingReset(reason: string): Promise<void> {
    log("forced_reset", { reason });
    this.ctx.abort(reason);
  }

  /** Stops the server container, as platform maintenance or a rollout would. */
  async stagingStopContainer(): Promise<{ wasRunning: boolean; at: number }> {
    const container = this.ctx.container;
    const wasRunning = container?.running ?? false;
    if (container && wasRunning) await container.destroy("wp22 staging: the watchdog case");
    log("container_stopped_by_harness", { wasRunning });
    return { wasRunning, at: Date.now() };
  }

  /** The stand-in server's event log from byte `offset`, at most 1 MiB. */
  async stagingLog(offset: number): Promise<{ boot: string | null; text: string }> {
    const container = this.ctx.container;
    if (!container?.running) return { boot: null, text: "" };
    const response = await container
      .getTcpPort(LOG_PORT)
      .fetch(`http://omnigent/log?offset=${Math.max(0, Math.floor(offset))}`, {
        signal: AbortSignal.timeout(5_000),
      });
    return { boot: response.headers.get("x-wp22-boot"), text: await response.text() };
  }
}

/** The stand-in for WP3.3's omnigent.internal handler: forwards to OmnigentServer as it will. */
export class ComputerRoute extends WorkerEntrypoint<StagingEnv> {
  override async fetch(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    stripTrustHeaders(headers);
    headers.set(FORWARD_VERSION_HEADER, String(OMNIGENT_SERVER_INTERFACE_VERSION));
    headers.set("x-wp22-hop", "computer-route"); // reaches the stand-in's log: not a trust header
    return this.env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME).fetch(
      new Request(request, { headers, redirect: "manual" }),
    );
  }
}

/** The stand-in computer: one container, kept running while the run is active. */
export class StagingComputer extends DurableObject<StagingEnv> {
  constructor(ctx: DurableObjectState, env: StagingEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      if (ctx.container?.running) {
        await ctx.container.setInactivityTimeout(30 * MIN);
        await this.intercept();
      }
    });
  }

  async intercept(): Promise<void> {
    // ctx.exports is typed from the production entry, which has no ComputerRoute.
    const exports = this.ctx.exports as unknown as {
      ComputerRoute: (options: { props: object }) => Fetcher;
    };
    await this.ctx.container?.interceptOutboundHttp(
      "omnigent.internal",
      exports.ComputerRoute({ props: {} }),
    );
  }

  async ensure(): Promise<{ running: boolean }> {
    const container = this.ctx.container;
    if (!container) throw new Error("no container configured for StagingComputer");
    await this.ctx.storage.put("wanted", true);
    if (!container.running) {
      await this.intercept();
      container.start({ enableInternet: false, env: {} });
      log("computer_started");
    }
    await container.setInactivityTimeout(30 * MIN);
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    return { running: container.running };
  }

  override async alarm(): Promise<void> {
    if (!(await this.ctx.storage.get("wanted"))) return;
    try {
      await this.ensure();
    } catch (error) {
      log("computer_error", { error: String(error).slice(0, 200) });
    }
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async stop(): Promise<void> {
    await this.ctx.storage.put("wanted", false);
    await this.ctx.storage.deleteAlarm();
    if (this.ctx.container?.running) await this.ctx.container.destroy("wp22 staging: run ended");
    log("computer_stopped");
  }
}

interface RunRecord {
  runId: string;
  t0: number;
  status: "active" | "ended";
  events: { kind: "reset" | "stop" | "end"; at: number; doneAt: number | null }[];
  planned: typeof SCHEDULE;
  logOffset: number;
  logBoot: string | null;
  build: string;
}

/** The run: one per deployment, started by the owner's click. */
export class StagingRun extends DurableObject<StagingEnv> {
  #intent: { value: string; issuedAt: number } | null = null;

  intentToken(): string {
    if (!this.#intent || Date.now() - this.#intent.issuedAt > INTENT_TTL_MS) {
      this.#intent = { value: randomHex(32), issuedAt: Date.now() };
    }
    return this.#intent.value;
  }

  async start(presented: string): Promise<{ started: boolean; reason?: string; runId?: string }> {
    const held = this.#intent;
    if (!held || Date.now() - held.issuedAt > INTENT_TTL_MS || presented !== held.value) {
      return { started: false, reason: "bad_intent" };
    }
    this.#intent = null;
    const current = await this.ctx.storage.get<RunRecord>("run");
    if (current?.status === "active")
      return { started: false, reason: "a run is active", runId: current.runId };
    const t0 = Date.now();
    const run: RunRecord = {
      runId: `run-${new Date(t0).toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z`,
      t0,
      status: "active",
      events: [
        { kind: "reset", at: t0 + SCHEDULE.reset, doneAt: null },
        { kind: "stop", at: t0 + SCHEDULE.stop, doneAt: null },
        { kind: "end", at: t0 + SCHEDULE.end, doneAt: null },
      ],
      planned: SCHEDULE,
      logOffset: 0,
      logBoot: null,
      build: BUILD.id,
    };
    // Persist before effect: the run exists before any container starts.
    await this.ctx.storage.put("run", run);
    await this.env.RESULTS.put(`runs/${run.runId}/run.json`, JSON.stringify(run));
    await this.env.RESULTS.put("runs/current.json", JSON.stringify(run));
    await this.record(run, "run_started", {});
    await this.env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME).bootstrapStatus(call);
    await this.env.COMPUTER.getByName("computer").ensure();
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    return { started: true, runId: run.runId };
  }

  async status(): Promise<unknown> {
    return { build: BUILD.id, run: (await this.ctx.storage.get<RunRecord>("run")) ?? null };
  }

  async record(run: RunRecord, event: string, fields: Record<string, unknown>): Promise<void> {
    const at = Date.now();
    log(event, { runId: run.runId, ...fields });
    await this.env.RESULTS.put(
      `runs/${run.runId}/events/${at}-${event}-${randomHex(3)}.json`,
      JSON.stringify({ event, at, ...fields }),
    );
  }

  override async alarm(): Promise<void> {
    const run = await this.ctx.storage.get<RunRecord>("run");
    if (run?.status !== "active") return;
    const server = this.env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME);
    for (const event of run.events) {
      if (event.doneAt !== null || event.at > Date.now()) continue;
      event.doneAt = Date.now(); // persist before effect: each event acts at most once
      await this.ctx.storage.put("run", run);
      if (event.kind === "reset") {
        await this.record(run, "reset_requested", {});
        await server.stagingReset("wp22 staging: forced reset").catch(() => undefined);
      } else if (event.kind === "stop") {
        const result = await server
          .stagingStopContainer()
          .catch((e: unknown) => ({ error: String(e) }));
        await this.record(run, "container_stop_requested", { result });
      }
    }
    await this.snapshot(run, server);
    if (run.events.every((e) => e.doneAt !== null)) {
      run.status = "ended";
      await this.env.COMPUTER.getByName("computer")
        .stop()
        .catch(() => undefined);
      await this.ctx.storage.put("run", run);
      await this.env.RESULTS.put("runs/current.json", JSON.stringify(run));
      await this.env.RESULTS.put(`runs/${run.runId}/end.json`, JSON.stringify(run));
      await this.record(run, "run_ended", {});
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  /** Pulls the stand-in server's log and records the outage records and bootstrap status. */
  async snapshot(run: RunRecord, server: DurableObjectStub<OmnigentServer>): Promise<void> {
    try {
      const outages = await server.outages({
        ...call,
        from: new Date(run.t0 - 60 * MIN).toISOString(),
        to: new Date(Date.now() + MIN).toISOString(),
      });
      const bootstrap = await server.bootstrapStatus(call);
      await this.env.RESULTS.put(
        `runs/${run.runId}/state/${Date.now()}.json`,
        JSON.stringify({ outages, bootstrap }),
      );
      for (let i = 0; i < 8; i += 1) {
        const offset = run.logBoot === null ? 0 : run.logOffset;
        const chunk = await server.stagingLog(offset);
        if (chunk.boot === null) break;
        if (chunk.boot !== run.logBoot) {
          // A new container: its log starts at 0. Read it from there on the next pass.
          if (run.logBoot !== null) {
            run.logBoot = chunk.boot;
            run.logOffset = 0;
            continue;
          }
          run.logBoot = chunk.boot;
        }
        if (chunk.text.length === 0) break;
        await this.env.RESULTS.put(
          `runs/${run.runId}/server-log/${chunk.boot}-${String(run.logOffset).padStart(10, "0")}.jsonl`,
          chunk.text,
        );
        run.logOffset += new TextEncoder().encode(chunk.text).byteLength;
        await this.ctx.storage.put("run", run);
        if (chunk.text.length < 1 << 20) break;
      }
    } catch (error) {
      log("snapshot_error", { runId: run.runId, error: String(error).slice(0, 200) });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The owner's page. A GET only shows the status and a confirmation form; starting is a
// same-origin POST that carries the form's single-use request-intent token (IR-017).

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "same-origin",
};

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const run = env.RUN.getByName("run");
    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      const token = await run.intentToken();
      const status = JSON.stringify(await run.status(), null, 2);
      return new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>WP2.2 staging</title></head><body>
<h1>WP2.2 staging run</h1>
<p>Starts the server and a stand-in computer, then runs the schedule for about 46 minutes: a forced reset of the server's Durable Object, a web Worker deploy, a platform Worker deploy, and a stopped server container for the watchdog. Click once.</p>
<form method="post" action="/start"><input type="hidden" name="intent" value="${escapeHtml(token)}"><button type="submit">Start the run</button></form>
<pre>${escapeHtml(status)}</pre></body></html>`,
        { headers: PAGE_HEADERS },
      );
    }
    if (url.pathname === "/start" && request.method === "POST") {
      const origin = request.headers.get("origin");
      const site = request.headers.get("sec-fetch-site");
      if (origin !== url.origin || (site !== null && site !== "same-origin")) {
        log("start_refused", { reason: "origin" });
        return Response.json({ error: "refused" }, { status: 403 });
      }
      const form = (request.headers.get("content-type") ?? "").startsWith(
        "application/x-www-form-urlencoded",
      )
        ? new URLSearchParams((await request.text()).slice(0, 4096))
        : new URLSearchParams();
      const result = await run.start(form.get("intent") ?? "");
      return Response.json(result, { status: result.started ? 200 : 409 });
    }
    return new Response("not found\n", { status: 404 });
  },
} satisfies ExportedHandler<StagingEnv>;
