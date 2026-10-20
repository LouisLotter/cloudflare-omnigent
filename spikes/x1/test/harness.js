// A fake platform for the transport Worker's Durable Objects: storage, alarms, containers,
// intercepts, ctx.abort and an R2 bucket. Every call that changes state is pushed to `effects`,
// so a test can show that a refused request had none.
import { ComputerDO, RunDO, ServerDO } from "../transport/src/index.js";
import { FakeSocket } from "./setup.js";

export const COMPUTER_IMAGE_REF = `registry.example/cfo-stg-x1-transport-computerdo-computer@sha256:${"a".repeat(64)}`;

export class FakeBucket {
  constructor(effects) {
    this.effects = effects;
    this.objects = new Map();
    this.failConditional = false;
  }

  async head(key) {
    return this.objects.has(key) ? { key, size: this.objects.get(key).body.length } : null;
  }

  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { key, text: async () => object.body, json: async () => JSON.parse(object.body) };
  }

  async put(key, value, options = {}) {
    const conditional = options.onlyIf;
    if (conditional) {
      if (this.failConditional) throw new Error("conditional headers are not supported here");
      if (conditional.get("if-none-match") === "*" && this.objects.has(key)) return null;
    }
    const body =
      typeof value === "string" ? value : new TextDecoder().decode(new Uint8Array(value));
    this.effects.push(`r2:put:${key}`);
    this.objects.set(key, { body, options });
    return { key };
  }

  async list({ prefix = "", cursor } = {}) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const page = keys.slice(start, start + 2);
    const next = start + page.length;
    return {
      objects: page.map((key) => ({ key })),
      truncated: next < keys.length,
      cursor: next < keys.length ? String(next) : undefined,
    };
  }

  json(key) {
    const object = this.objects.get(key);
    return object ? JSON.parse(object.body) : undefined;
  }

  keys(prefix = "") {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

/** The 101 the container's echo server answers an upgrade with, as a fetch would return it. */
export function upstreamUpgrade() {
  const socket = new FakeSocket("upstream");
  const response = new Response(null, {
    status: 101,
    webSocket: socket,
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Accept": "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
      "Sec-WebSocket-Extensions": "permessage-deflate",
    },
  });
  return { socket, response };
}

export function harness({ secrets = {} } = {}) {
  const effects = [];
  const starts = {};
  const intercepts = [];
  const requests = { server: [], log: [] };
  const bucket = new FakeBucket(effects);
  const env = { RESULTS: bucket, ...secrets };
  const ports = {
    // The echo server: /health answers, an upgrade gets the container's 101.
    8081: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/health") return new Response("ok\n");
      requests.server.push(request);
      const { socket, response } = upstreamUpgrade();
      ports.lastUpstream = socket;
      return response;
    },
    // The log server: the next chunk for an offset, and the log's ID.
    8082: async (request) => {
      const offset = Number(new URL(request.url).searchParams.get("offset"));
      requests.log.push(offset);
      const text = ports.logText.slice(offset);
      return new Response(text, { headers: { "x-x1-log-id": ports.logId } });
    },
    logText: "",
    logId: "b0b0b0b0-1",
    lastUpstream: null,
  };

  function containerFor(role) {
    return {
      running: false,
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
      async interceptOutboundHttp(host, entry) {
        effects.push(`${role}:intercept:${host}`);
        intercepts.push({ host, ...entry });
      },
      getTcpPort(port) {
        return {
          fetch: (input) => ports[port](input instanceof Request ? input : new Request(input)),
        };
      },
    };
  }

  function namespace(Class, role) {
    const durable = new Map(); // id -> { store, alarm, container }: survives a reset
    const live = new Map(); // id -> { stub, ctx, object }
    function construct(id) {
      if (!durable.has(id)) {
        durable.set(id, {
          store: new Map(),
          alarm: null,
          container: role === "run" ? undefined : containerFor(role),
        });
      }
      const state = durable.get(id);
      const ctx = {
        id,
        ready: Promise.resolve(),
        container: state.container,
        aborted: null,
        storage: {
          async get(key) {
            return structuredClone(state.store.get(key));
          },
          async put(key, value) {
            effects.push(`${role}:put:${key}`);
            state.store.set(key, structuredClone(value));
          },
          async getAlarm() {
            return state.alarm;
          },
          async setAlarm(when) {
            effects.push(`${role}:setAlarm`);
            state.alarm = when;
          },
          async deleteAlarm() {
            effects.push(`${role}:deleteAlarm`);
            state.alarm = null;
          },
        },
        blockConcurrencyWhile(fn) {
          ctx.ready = fn();
          return ctx.ready;
        },
        waitUntil(promise) {
          ctx.pending = promise;
        },
        abort(reason) {
          effects.push(`${role}:abort`);
          live.delete(id);
          throw new Error(`Durable Object reset: ${reason}`);
        },
        exports: Object.fromEntries(
          ["P1Route", "P2Route", "P3Echo", "P6Policy", "Recorder"].map((name) => [
            name,
            (options) => ({ entrypoint: name, ...options }),
          ]),
        ),
      };
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
      live.set(id, { stub, ctx, object });
      return live.get(id);
    }
    return {
      idFromName: (name) => name,
      get(id) {
        return (live.get(id) ?? construct(id)).stub;
      },
      ctx: (id) => (live.get(id) ?? construct(id)).ctx,
      object: (id) => (live.get(id) ?? construct(id)).object,
      state: (id) => durable.get(id),
      /** Drops the live instance, as a code update or eviction would: storage stays. */
      evict(id) {
        live.delete(id);
      },
    };
  }

  env.SERVER = namespace(ServerDO, "server");
  env.COMPUTER = namespace(ComputerDO, "computer");
  env.RUN = namespace(RunDO, "run");
  return { env, effects, starts, intercepts, bucket, ports, requests };
}
