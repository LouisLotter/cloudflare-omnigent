/**
 * The deterministic simulation harness for WorkspaceDO's controller (WP3.1): a simulated clock,
 * a simulated computer (container port, supervisor, R2 layers), a fake ControlDO, a credential
 * bucket and Omnigent's launcher client, around one `WorkspaceController` at a time.
 *
 * `crash()` ends the controller instance as a Durable Object's reset or eviction does: its
 * in-memory state and in-flight work are lost, every later call it makes fails, and a new instance
 * is built from the same storage and booted. `crashAt` crashes at the N-th step of the run, a step
 * being a storage commit (before or after it is written) or a call into the port, ControlDO or the
 * bucket (before or after its effect), so a test can crash between every transition and effect.
 *
 * `check()` asserts the simulation's invariants: one live container per computer, no leaked
 * reservation, every manifest complete in R2, no container where the lifecycle wants none, and no
 * launch token in storage, logs or journals.
 */
import {
  type ComputerId,
  type ComputerPageState,
  containerMayRun,
  type LauncherResult,
  type SupervisorMessage,
  type SupervisorReply,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import {
  CONTROLLER_TIMING,
  type ControllerTiming,
  WorkspaceController,
} from "../../src/computer/controller.ts";
import { ComputerRecord, RECORD_KEY, TOKEN_KEY } from "../../src/computer/record.ts";
import type { ComputerContainerPort } from "../../src/shared/computer-port.ts";
import type { ControlRpc } from "../../src/shared/rpc.ts";
import { FakeBucket } from "./fake-bucket.ts";
import { FakeControl } from "./fake-control.ts";
import { FakeLauncherClient } from "./fake-launcher-client.ts";
import { type FakeSupervisor, SimulatedComputer } from "./fake-supervisor.ts";
import { MemoryStore } from "./memory-store.ts";

export const CMP = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3" as ComputerId;
export const HOST = "7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f";
export const TOKEN_PREFIX = "synthetic-launch-token-canary-";

/** A crash injected by the simulation. */
export class Crash extends Error {
  constructor() {
    super("simulated crash");
    this.name = "Crash";
  }
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export interface SimOptions {
  readonly timing?: Partial<ControllerTiming>;
  /** No checkpoint bucket is bound. */
  readonly noBucket?: boolean;
  readonly start?: number;
}

/** The running computer's supervisor; fails the test if no container runs. */
export function live(sim: { readonly sup: FakeSupervisor | null }): FakeSupervisor {
  if (sim.sup === null) throw new Error("no container runs");
  return sim.sup;
}

/** The trusted props an intercept was registered with. */
export function propsOf(intercept: { readonly target: Fetcher } | undefined): unknown {
  return (intercept?.target as unknown as { props?: unknown } | undefined)?.props;
}

export class ComputerSim {
  now: number;
  readonly store = new MemoryStore();
  readonly computer = new SimulatedComputer(CMP);
  readonly control = new FakeControl();
  readonly bucket = new FakeBucket();
  readonly client: FakeLauncherClient;
  readonly timing: ControllerTiming;
  readonly logs: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  readonly violations: string[] = [];
  readonly tokens: string[] = [];
  /** The Durable Object's alarm: durable, so it survives a crash. */
  alarmAt: number | null = null;
  controller!: WorkspaceController;
  instances = 0;
  /** Steps counted for `crashAt`; a crash fires when `steps` reaches it. */
  steps = 0;
  crashAt: number | null = null;
  /** Runs at the injected crash, before the new instance boots (the world moving on meanwhile). */
  onCrash: (() => void) | null = null;
  #dead = { dead: false };
  #ids = 0;

  readonly #noBucket: boolean;

  constructor(options: SimOptions = {}) {
    this.#noBucket = options.noBucket ?? false;
    this.now = options.start ?? Date.UTC(2026, 9, 25, 9, 0, 0);
    this.timing = { ...CONTROLLER_TIMING, ...options.timing };
    this.client = new FakeLauncherClient(CMP, async (request) => {
      await this.#live();
      return this.controller.launcher({ interfaceVersion: WORKSPACE_INTERFACE_VERSION, request });
    });
    this.store.beforeCommit = () => this.#step(this.#dead, "commit:before");
    this.store.afterCommit = () => this.#step(this.#dead, "commit:after");
    this.#build();
  }

  /** Deadlines handed out (uploads, commands); `expire` fires them. */
  readonly deadlines: { readonly ms: number; readonly controller: AbortController }[] = [];

  /** Fires every deadline of at least `ms` handed out so far. */
  expire(ms: number): void {
    for (const d of this.deadlines) {
      if (d.ms >= ms) d.controller.abort(new DOMException("deadline", "TimeoutError"));
    }
  }

  /** Each step's label, in order: a dry run tells a test where to crash. */
  readonly stepLog: string[] = [];

  /** Counts one step, and crashes there if asked. */
  #step(life = this.#dead, label = "commit"): void {
    if (life.dead) throw new Crash();
    this.steps += 1;
    this.stepLog.push(label);
    if (this.crashAt !== null && this.steps === this.crashAt) {
      this.crashAt = null;
      life.dead = true;
      this.onCrash?.();
      throw new Crash();
    }
  }

  #guard<T extends object>(target: T, life: { dead: boolean }): T {
    return new Proxy(target, {
      get: (object, property, receiver) => {
        const value = Reflect.get(object, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        const name = `${String(property)}`;
        return (...args: unknown[]) => {
          this.#step(life, `${name}:before`);
          if (property === "start" && (object as unknown as SimulatedComputer).running) {
            this.violations.push("start() while a container runs");
          }
          const result = (value as (...a: unknown[]) => unknown).apply(object, args);
          if (result instanceof Promise) {
            return result.then((v) => {
              this.#step(life, `${name}:after`);
              return v;
            });
          }
          this.#step(life, `${name}:after`);
          return result;
        };
      },
    });
  }

  #build(): void {
    const life = { dead: false };
    this.#dead = life;
    const store = this.store;
    const guardedStore = {
      get: (key: string) => store.get(key),
      put: (key: string, value: unknown) => {
        if (life.dead) throw new Crash();
        store.put(key, value);
      },
      delete: (key: string) => {
        if (life.dead) throw new Crash();
        store.delete(key);
      },
      keys: (prefix: string, limit?: number) => store.keys(prefix, limit),
      transaction: <T>(fn: () => T): T => {
        if (life.dead) throw new Crash();
        return store.transaction(fn);
      },
    };
    this.instances += 1;
    this.controller = new WorkspaceController({
      computerId: CMP,
      store: guardedStore,
      port: this.#guard(this.computer as ComputerContainerPort, life),
      control: this.#guard(this.control as ControlRpc, life),
      bucket: this.#noBucket ? null : this.#guard(this.bucket, life),
      clock: () => this.now,
      alarm: {
        set: (at) => {
          if (life.dead) throw new Crash();
          this.alarmAt = at;
        },
        clear: () => {
          if (life.dead) throw new Crash();
          this.alarmAt = null;
        },
      },
      newId: (prefix) => {
        this.#ids += 1;
        let n = this.#ids;
        let id = "";
        for (let i = 0; i < 26; i += 1) {
          id = (ALPHABET[n % 32] as string) + id;
          n = Math.floor(n / 32);
        }
        return `${prefix}_${id}`;
      },
      deadline: (ms) => {
        const controller = new AbortController();
        this.deadlines.push({ ms, controller });
        return { signal: controller.signal, clear: () => undefined };
      },
      intercepts: (props) => [
        { host: "computer.internal", target: { props } as unknown as Fetcher },
        { host: "omnigent.internal", target: { props } as unknown as Fetcher },
      ],
      timing: this.timing,
      log: (event, fields) => {
        if (life.dead) return;
        const text = JSON.stringify(fields);
        for (const token of this.tokens) {
          if (text.includes(token)) this.violations.push(`token logged in ${event}`);
        }
        this.logs.push({ event, fields });
      },
    });
  }

  /**
   * After a crash, the runtime builds a new instance only when an event arrives: a call, a
   * computer message or the alarm. So nothing recovers unless an alarm was left in place.
   */
  async #live(): Promise<void> {
    if (this.#dead.dead) await this.restart();
  }

  /** A new instance from the same storage (a reset, a deploy's switch, an eviction). */
  async restart(): Promise<void> {
    this.#dead.dead = true;
    this.#build();
    await this.controller.boot().catch((error: unknown) => {
      if (!(error instanceof Crash)) throw error;
    });
  }

  /** Runs `fn`; if a crash fires during it or the runner it starts, restarts the controller. */
  async guarded<T>(fn: () => Promise<T>): Promise<T | Crash> {
    try {
      const result = await fn();
      await this.controller.idle();
      return this.#dead.dead ? new Crash() : result;
    } catch (error) {
      if (error instanceof Crash || this.#dead.dead) return new Crash();
      throw error;
    }
  }

  /** Whether the current instance has crashed and not yet been replaced. */
  get dead(): boolean {
    return this.#dead.dead;
  }

  get sup(): FakeSupervisor | null {
    return this.computer.sup;
  }

  /** What the cloud-computers page shows. */
  async page(): Promise<ComputerPageState> {
    const result = await this.controller.pages({
      interfaceVersion: WORKSPACE_INTERFACE_VERSION,
      action: "state",
    });
    if (result.action !== "state") throw new Error("not a page state");
    return result.computer as ComputerPageState;
  }

  record(): ComputerRecord {
    return ComputerRecord.parse(this.store.get(RECORD_KEY));
  }

  /** The supervisor's queued messages, through the computer API, until none is acknowledged. */
  deliver = async (message: SupervisorMessage): Promise<SupervisorReply> => {
    await this.#live();
    const raw = this.store.get(RECORD_KEY);
    const hostId = raw === undefined ? null : ComputerRecord.parse(raw).hostId;
    return this.controller.computer({
      interfaceVersion: WORKSPACE_INTERFACE_VERSION,
      props: { propsVersion: 1, computerId: CMP, generation: message.generation, hostId },
      message,
    });
  };

  /**
   * Lets everything settle: the runner, and the supervisor's messages, until neither moves. A
   * crashed instance stays down until an event arrives (a supervisor message counts).
   */
  async settle(): Promise<void> {
    let last = "";
    for (let i = 0; i < 50; i += 1) {
      await this.controller.idle();
      const sup = this.sup;
      if (sup !== null && sup.outbox.length > 0) {
        await sup.flush(this.deliver).catch(() => undefined);
        await this.controller.idle();
      }
      const now = `${this.sup?.outbox.length ?? 0}/${this.store.commits}/${this.instances}/${this.#dead.dead}`;
      if ((this.sup?.outbox.length ?? 0) === 0 || now === last) break;
      last = now;
    }
  }

  /**
   * Lets work run without waiting for the runner to finish (for a test that holds an effect
   * open): delivers the supervisor's messages and yields, until `condition` holds.
   */
  async until(condition: () => boolean, rounds = 500): Promise<void> {
    for (let i = 0; i < rounds && !condition(); i += 1) {
      const sup = this.sup;
      if (sup !== null && sup.outbox.length > 0)
        await sup.flush(this.deliver).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!condition()) throw new Error("condition never held");
  }

  /** Advances the clock, running every alarm that falls due, and settles after each. */
  async advance(ms: number): Promise<void> {
    await this.settle();
    const until = this.now + ms;
    for (let i = 0; i < 10_000; i += 1) {
      const at = this.alarmAt;
      if (at === null || at > until) break;
      this.now = Math.max(this.now, at);
      this.alarmAt = null;
      await this.#live();
      await this.guarded(() => this.controller.alarm());
      await this.settle();
    }
    this.now = until;
  }

  /** A launcher call through the client, settling afterwards. */
  async call(request: Parameters<FakeLauncherClient["send"]>[0]): Promise<LauncherResult> {
    const result = await this.client.send(request);
    await this.settle();
    return result;
  }

  token(n: number): string {
    const token = `${TOKEN_PREFIX}${String(n).padStart(4, "0")}`;
    this.tokens.push(token);
    return token;
  }

  /**
   * A provisioned computer, woken and with a host taken by the supervisor: the usual starting
   * point. Returns the attempt.
   */
  async running(): Promise<number> {
    await this.call(this.client.provisionRequest("managed-7f3c2a9e"));
    const token = this.token(this.tokens.length + 1);
    await this.call(this.client.resumeRequest());
    await this.advance(1);
    const claim = await this.call(this.client.claimRequest());
    if (claim.operation !== "claim_start" || !claim.granted) throw new Error("claim refused");
    await this.call(this.client.startRequest({ attempt: claim.startAttempt, token, hostId: HOST }));
    await this.advance(this.timing.pollMs);
    return claim.startAttempt;
  }

  /** The invariants every simulated run must keep. */
  check(): string[] {
    const problems = [...this.violations];
    const raw = this.store.get(RECORD_KEY);
    if (raw === undefined) return problems;
    const r = ComputerRecord.parse(raw);
    const state = r.lifecycle.context.state;
    if (!containerMayRun(state) && this.computer.running) {
      problems.push(`a container runs while ${state}`);
    }
    // No leaked reservation: once releases are drained, only the live generation holds a slot.
    if (!this.control.unavailable && r.releases.length === 0) {
      for (const slot of this.control.slots) {
        const [computer, generation] = slot.split("/");
        if (computer !== CMP) continue;
        const held =
          r.reservation !== null &&
          String(r.reservation.generation) === generation &&
          containerMayRun(state);
        if (!held) problems.push(`slot ${slot} leaked in ${state}`);
      }
    }
    // A manifest is always complete: every layer it names is in R2.
    for (const layer of r.workspace?.layers ?? []) {
      if (!this.computer.layers.has(layer.backup.id)) {
        problems.push(`manifest ${r.workspace?.checkpointId} names missing layer ${layer.layerId}`);
      }
    }
    // No untracked credential object: each is the pointer's, or queued for deletion, or an upload
    // whose key is recorded (Codex WP3.1 r1-1).
    const tracked = new Set([
      ...(r.credential === null ? [] : [r.credential.object.key]),
      ...r.credentialDeletes,
      ...r.credentialUploads.map((u) => `credentials/${CMP}/${u.checkpointId}.json`),
    ]);
    for (const key of this.bucket.objects.keys()) {
      if (!tracked.has(key)) problems.push(`untracked credential object ${key}`);
    }
    // Token custody: never in the record, the journal or the bucket.
    const stored = [...this.store.data]
      .filter(([key]) => key !== TOKEN_KEY)
      .map(([, v]) => v)
      .join("\n");
    for (const token of this.tokens) {
      if (stored.includes(token)) problems.push("a launch token is stored outside its key");
      if (this.bucket.dump().includes(token)) problems.push("a launch token is in the bucket");
    }
    return problems;
  }
}
