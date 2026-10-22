// Spike S3 staging Worker: one Durable Object, Bench, that owns the spike computer container
// (all-in-one: the supervisor, Omnigent's host and runners, the CLIs, and beside them the
// Omnigent server and the mock LLM, so nothing needs the internet), uploads its layers to R2
// with the Sandbox SDK's DirectoryBackup, and runs the staging campaign from its alarm.
//
// Reached only through the owner-only Access application. Every change follows the
// campaign-control rule (IR-017): see controls.js. The campaign itself is campaign.js.

import { DurableObject } from "cloudflare:workers";
import { DirectoryBackup } from "@cloudflare/sandbox";
import { PLANS, startCampaign, stopCampaign, tick } from "./campaign.js";
import { handle } from "./controls.js";
import { gatewayFor } from "./gateway.js";

// The SDK's gateway for control calls, and the holding gateway for the container's transfers;
// reached only through ctx.exports by DirectoryBackup. No route leads to either.
export { DirectoryBackupGateway } from "@cloudflare/sandbox";
export { HoldingGateway } from "./gateway.js";

const KEEP_ALIVE_MS = 30 * 60 * 1000;
const SUPERVISOR_PORT = 7070;
// The first start pulls the image (about 3 GB); later starts are quick.
const READY_MS = 600_000;
// DC-37: a start right after a stop can be refused; wait and retry.
const START_RETRY_MS = [5_000, 10_000, 20_000, 20_000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(event, data = {}) {
  console.log(JSON.stringify({ s3: event, wt: Date.now(), ...data }));
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class Bench extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // The token is in memory only: a new instance gets a new one. The manual arming is stored.
    this.state = { token: randomToken(), armedUntil: 0 };
    ctx.blockConcurrencyWhile(async () => {
      this.state.armedUntil = (await ctx.storage.get("armedUntil")) ?? 0;
    });
  }

  /** One request to the supervisor's API inside the container. Never retried. */
  supFetch(path, init = { method: "GET" }) {
    return this.ctx.container.getTcpPort(SUPERVISOR_PORT).fetch(`http://container${path}`, init);
  }

  async supJson(method, path, body) {
    const init =
      body === undefined
        ? { method }
        : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } };
    const res = await this.supFetch(path, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`supervisor ${path}: ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }

  /** Starts the container if needed and waits for the supervisor; returns its boot record. */
  async ensure() {
    const container = this.ctx.container;
    if (!container.running) {
      for (let attempt = 0; ; attempt++) {
        try {
          container.start({ env: { S3_ALL_IN_ONE: "1" }, enableInternet: false });
          log("container_start", { attempt });
          break;
        } catch (error) {
          log("container_start_refused", { attempt, error: String(error).slice(0, 300) });
          if (attempt >= START_RETRY_MS.length) throw error;
          await sleep(START_RETRY_MS[attempt]);
        }
      }
    }
    const deadline = Date.now() + READY_MS;
    for (;;) {
      try {
        const res = await this.supFetch("/boot");
        if (res.ok) return await res.json();
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline)
        throw new Error(`the supervisor did not answer within ${READY_MS} ms`);
      await sleep(1_000);
    }
  }

  async view() {
    const c = await this.ctx.storage.get("campaign");
    if (!c) return null;
    const steps = PLANS[c.plan].steps;
    return {
      campaign: {
        id: c.id,
        plan: c.plan,
        status: c.status,
        index: c.index,
        stepCount: steps.length,
        step: steps[c.index] ?? null,
        startedAt: new Date(c.startedAt).toISOString(),
        armedUntil: new Date(c.armedUntil).toISOString(),
        endedAt: c.endedAt ? new Date(c.endedAt).toISOString() : null,
        containerReplaced: c.replaced ?? 0,
      },
      steps: c.steps,
    };
  }

  ports() {
    const { ctx, env } = this;
    const storage = ctx.storage;
    return {
      now: () => Date.now(),
      sleep,
      log,
      deadline: (ms) => AbortSignal.timeout(ms),
      storage: {
        get: (key) => storage.get(key),
        put: (key, value) => storage.put(key, value),
        delete: (key) => storage.delete(key),
        setAlarm: (time) => storage.setAlarm(time),
      },
      sup: {
        get: (path) => this.supJson("GET", path),
        post: (path, body) => this.supJson("POST", path, body ?? {}),
      },
      container: {
        running: () => ctx.container.running,
        ensure: () => this.ensure(),
        start: () => this.ensure(),
        keepAlive: () => ctx.container.setInactivityTimeout(KEEP_ALIVE_MS),
        stop: () => ctx.container.destroy(),
        fetch: (path, init) => this.supFetch(path, init),
      },
      backups: (prefix, hold) =>
        new DirectoryBackup(ctx.container, gatewayFor(ctx.exports, hold), {
          binding: "CKPT",
          prefix,
        }),
      results: {
        put: (key, value) =>
          env.CKPT.put(key, JSON.stringify(value, null, 1), {
            httpMetadata: { contentType: "application/json" },
          }),
        count: async (prefix) => {
          let n = 0;
          let cursor;
          do {
            const listed = await env.CKPT.list({ prefix, cursor });
            n += listed.objects.length;
            cursor = listed.truncated ? listed.cursor : undefined;
          } while (cursor);
          return n;
        },
      },
      campaign: {
        view: () => this.view(),
        start: (plan) => startCampaign(this.ports(), plan),
        stop: (reason) => stopCampaign(this.ports(), reason),
      },
      saveArm: (armedUntil) => storage.put("armedUntil", armedUntil),
    };
  }

  fetch(request) {
    return handle(request, this.state, this.ports());
  }

  alarm() {
    return tick(this.ports());
  }
}

export default {
  fetch(request, env) {
    return env.BENCH.get(env.BENCH.idFromName("s3")).fetch(request);
  },
};
