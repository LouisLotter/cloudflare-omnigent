// The WP2.5 harness Worker: one Durable Object with one `basic` container running the server
// image plus the drill (cfo_drill.harness), and the owner's page that starts a run.
//
//   GET  /            the page (status, the R2 token form, Run and Stop); changes nothing
//   GET  /api/status  the run as the Durable Object records it; never a credential
//   POST /api/run     the owner's R2 token; same origin and an intent token (IR-017)
//   POST /api/stop    stops the run, the container, and forgets the token
//
// After Run, the Durable Object's alarm drives everything: it polls the harness on the
// container's port 8002, copies each finished result to R2 under results/<run id>/, kills
// the container and starts a new one when the harness asks for the replacement measurement,
// times that replacement until Omnigent answers /health, and at the end stops the container
// and deletes the token. Deploy with the guarded staging tool only (see wrangler.jsonc).

import { DurableObject } from "cloudflare:workers";
import { type ContainerPort, containerPort } from "./container-port.ts";
import {
  checkOrigin,
  INTENT_HEADER,
  INTENT_TTL_MS,
  intentMatches,
  pruneIntents,
  randomHex,
  type StoredIntent,
  sha256Hex,
} from "./controls.ts";
import { page } from "./page.ts";
import {
  ALARM_MS,
  type Awaiting,
  decide,
  type HarnessStatus,
  harnessEnv,
  newRunId,
  type Outcome,
  parseCredentials,
  parseHarnessStatus,
  type R2Credentials,
  RUN_WINDOW_MS,
  type RunRecord,
  type RunSettings,
  replacedEnv,
  replacementTimings,
  resultKey,
} from "./plan.ts";

export interface Env {
  readonly DRILL: DurableObjectNamespace<DrillRun>;
  readonly RESULTS: R2Bucket;
  readonly REPLICA_BUCKET: string;
  readonly DRILL_PLAN: string;
  readonly DRILL_BARRIER_WRITES: string;
  readonly DRILL_BARRIER_ITEMS: string;
  readonly DRILL_IDLE_S: string;
}

const MAX_BODY_BYTES = 4096;
const HEALTH_POLL_MS = 1000;
/** How long one alarm keeps polling the replaced server before it yields. */
const HEALTH_SLICE_MS = 60_000;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  // Run ids, phases and outcomes only.
  console.log(JSON.stringify({ event: `drill.${event}`, ...fields }));
}

export class DrillRun extends DurableObject<Env> {
  private port(): ContainerPort {
    return containerPort(this.ctx);
  }

  async issueIntent(): Promise<string> {
    const now = Date.now();
    const token = randomHex(32);
    const kept = pruneIntents((await this.ctx.storage.get<StoredIntent[]>("intents")) ?? [], now);
    kept.push({ hash: await sha256Hex(token), expiresAt: now + INTENT_TTL_MS });
    await this.ctx.storage.put("intents", kept);
    return token;
  }

  async checkIntent(token: string | null): Promise<boolean> {
    const intents = (await this.ctx.storage.get<StoredIntent[]>("intents")) ?? [];
    return intentMatches(token, intents, Date.now());
  }

  async status(): Promise<Record<string, unknown>> {
    const run = await this.ctx.storage.get<RunRecord>("run");
    return {
      run: run ?? null,
      replacement: run?.replacement ? replacementTimings(run.replacement) : null,
      containerRunning: this.port().running,
      holdsToken: (await this.ctx.storage.get("creds")) !== undefined,
    };
  }

  async run(input: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const parsed = parseCredentials(input);
    if (!parsed.ok) return { status: 400, body: { error: parsed.reason } };
    const current = await this.ctx.storage.get<RunRecord>("run");
    if (current !== undefined && current.outcome === undefined) {
      return { status: 409, body: { error: "a run is in progress", runId: current.runId } };
    }
    const port = this.port();
    if (port.running) return { status: 409, body: { error: "the container is still running" } };
    const now = Date.now();
    const settings: RunSettings = {
      runId: newRunId(new Date(now), randomHex(3)),
      ownerPassword: randomHex(16),
      cookieSecret: randomHex(32),
      bucket: this.env.REPLICA_BUCKET,
      plan: this.env.DRILL_PLAN,
      barrierWrites: this.env.DRILL_BARRIER_WRITES,
      barrierItems: this.env.DRILL_BARRIER_ITEMS,
      idleSeconds: this.env.DRILL_IDLE_S,
    };
    const run: RunRecord = {
      runId: settings.runId,
      startedAt: now,
      armedUntil: now + RUN_WINDOW_MS,
      mode: "measure",
      phase: null,
      stored: [],
      errors: {},
      missedPolls: 0,
    };
    await this.ctx.storage.put("creds", parsed.value);
    await this.ctx.storage.put("settings", settings);
    await this.ctx.storage.put("run", run);
    port.start(harnessEnv(settings, parsed.value));
    await this.ctx.storage.setAlarm(now + ALARM_MS);
    log("run.started", { runId: run.runId });
    return { status: 202, body: { runId: run.runId, armedUntil: run.armedUntil } };
  }

  async stop(): Promise<void> {
    const run = await this.ctx.storage.get<RunRecord>("run");
    if (run !== undefined && run.outcome === undefined) {
      await this.finish(run, "stopped");
      return;
    }
    await this.port().kill();
    await this.forgetSecrets();
  }

  async alarm(): Promise<void> {
    let run = await this.ctx.storage.get<RunRecord>("run");
    if (run === undefined || run.outcome !== undefined) return;
    const port = this.port();
    const status = port.running ? await this.harnessStatus(port) : null;
    run = {
      ...run,
      missedPolls: status === null ? run.missedPolls + 1 : 0,
      phase: status?.phase ?? run.phase,
      errors: status ? { ...run.errors, ...status.errors } : run.errors,
    };
    let next = ALARM_MS;
    for (const action of decide(run, status, Date.now())) {
      if (action.kind === "store") {
        run = await this.store(run, port, action.names);
      } else if (action.kind === "replace") {
        run = await this.replace(run, port, action.awaiting);
        next = HEALTH_POLL_MS;
      } else if (action.kind === "await-health") {
        run = await this.awaitHealth(run, port);
        if (run.replacement?.healthyAt === undefined) next = HEALTH_POLL_MS;
      } else {
        await this.finish(run, action.outcome);
        return;
      }
    }
    await this.ctx.storage.put("run", run);
    await this.ctx.storage.setAlarm(Date.now() + next);
  }

  private async harnessStatus(port: ContainerPort): Promise<HarnessStatus | null> {
    try {
      const response = await port.harness("/status");
      if (!response.ok) return null;
      const parsed = parseHarnessStatus(await response.json());
      return parsed.ok ? parsed.value : null;
    } catch {
      return null;
    }
  }

  private async store(
    run: RunRecord,
    port: ContainerPort,
    names: readonly string[],
  ): Promise<RunRecord> {
    const stored = [...run.stored];
    for (const name of names) {
      try {
        const response = await port.harness(`/results/${name}`);
        if (!response.ok) continue;
        const text = await response.text();
        JSON.parse(text);
        await this.env.RESULTS.put(resultKey(run.runId, name), text, {
          httpMetadata: { contentType: "application/json" },
        });
        stored.push(name);
        log("result.stored", { runId: run.runId, name });
      } catch {
        // Tried again at the next alarm.
      }
    }
    return { ...run, stored };
  }

  /** The loss of the server on Cloudflare: kill the container, start a new one on the replica. */
  private async replace(
    run: RunRecord,
    port: ContainerPort,
    awaiting: Awaiting,
  ): Promise<RunRecord> {
    const settings = await this.ctx.storage.get<RunSettings>("settings");
    const creds = await this.ctx.storage.get<R2Credentials>("creds");
    const requestedAt = Date.now();
    if (settings === undefined || creds === undefined) {
      return {
        ...run,
        replacement: { prefix: awaiting.prefix, requestedAt, error: "no settings" },
      };
    }
    log("replacement.kill", { runId: run.runId });
    await port.kill();
    const stoppedAt = Date.now();
    try {
      port.start(replacedEnv(settings, creds, awaiting));
    } catch (error) {
      return {
        ...run,
        mode: "replaced",
        replacement: {
          prefix: awaiting.prefix,
          requestedAt,
          stoppedAt,
          error: String(error).slice(0, 200),
        },
      };
    }
    const startCalledAt = Date.now();
    log("replacement.started", { runId: run.runId });
    return {
      ...run,
      mode: "replaced",
      stored: run.stored,
      missedPolls: 0,
      replacement: { prefix: awaiting.prefix, requestedAt, stoppedAt, startCalledAt },
    };
  }

  private async awaitHealth(run: RunRecord, port: ContainerPort): Promise<RunRecord> {
    const replacement = run.replacement;
    if (replacement === undefined) return run;
    const until = Date.now() + HEALTH_SLICE_MS;
    while (Date.now() < until) {
      if (await port.serverHealthy()) {
        const done = { ...replacement, healthyAt: Date.now() };
        await this.env.RESULTS.put(
          resultKey(run.runId, "cf-replacement-do"),
          JSON.stringify({ ...done, timings: replacementTimings(done) }, null, 2),
          { httpMetadata: { contentType: "application/json" } },
        );
        log("replacement.healthy", { runId: run.runId, ...replacementTimings(done) });
        return { ...run, replacement: done };
      }
      await sleep(HEALTH_POLL_MS);
    }
    return run;
  }

  private async finish(run: RunRecord, outcome: Outcome): Promise<void> {
    try {
      await this.port().kill();
    } catch {
      // Recorded below either way; teardown removes the container application.
    }
    await this.forgetSecrets();
    const finished: RunRecord = { ...run, outcome, finishedAt: Date.now() };
    await this.ctx.storage.put("run", finished);
    await this.ctx.storage.deleteAlarm();
    try {
      await this.env.RESULTS.put(
        resultKey(run.runId, "summary"),
        JSON.stringify(
          {
            ...finished,
            replacementTimings: finished.replacement
              ? replacementTimings(finished.replacement)
              : null,
          },
          null,
          2,
        ),
        { httpMetadata: { contentType: "application/json" } },
      );
    } catch {
      // The run record keeps the same facts.
    }
    log("run.finished", { runId: run.runId, outcome });
  }

  private async forgetSecrets(): Promise<void> {
    await this.ctx.storage.delete("creds");
    await this.ctx.storage.delete("settings");
  }
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("body too large");
  return JSON.parse(text);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const drill = env.DRILL.get(env.DRILL.idFromName("drill"));
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
      return new Response(page(await drill.issueIntent()), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
        },
      });
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      return json(await drill.status());
    }
    if (
      request.method === "POST" &&
      (url.pathname === "/api/run" || url.pathname === "/api/stop")
    ) {
      const origin = checkOrigin(request);
      if (!origin.ok) return json({ error: origin.reason }, 403);
      if (!(await drill.checkIntent(request.headers.get(INTENT_HEADER)))) {
        return json({ error: "missing or expired intent token; reload the page" }, 403);
      }
      if (url.pathname === "/api/stop") {
        await drill.stop();
        return json({ stopped: true });
      }
      let body: unknown;
      try {
        body = await readJson(request);
      } catch {
        return json({ error: "the body must be a small JSON object" }, 400);
      }
      const result = await drill.run(body);
      return json(result.body, result.status);
    }
    return json({ error: "not found" }, 404);
  },
};
