// WP2.6 staging: the run's driver (test code, never shipped). One tick at a time per object,
// whoever calls it (the cron's RPC or the object's alarm), so a decision is never taken twice
// on the same stored state (Codex WP2.6 r1-3). Each step is persisted before its effects; a
// destroy counts only once it returned, timed from when it was sent (Codex WP2.6 r1-4, r2-2).
import { type Action, decide, INITIAL_RUN, type Observed, type RunState } from "./plan.ts";

export interface RunPorts {
  load(): Promise<RunState | undefined>;
  save(state: RunState): Promise<void>;
  /** Everything `decide` needs but the time, for this state. */
  observe(state: RunState): Promise<Omit<Observed, "now">>;
  now(): number;
  startSeeder(): Promise<void>;
  stopSeeder(): Promise<void>;
  ensureServer(): Promise<void>;
  destroyServer(): Promise<{ wasRunning: boolean }>;
  writeSummary(state: RunState): Promise<void>;
  log(event: string, fields: Record<string, unknown>): void;
  /** Asks for the next tick at this time (the object's alarm). */
  scheduleNext(at: number): Promise<void>;
}

export const TICK_MS = 15_000;

export class RunDriver {
  readonly #ports: RunPorts;
  #queue: Promise<void> = Promise.resolve();

  constructor(ports: RunPorts) {
    this.#ports = ports;
  }

  tick(): Promise<void> {
    const run = this.#queue.then(() => this.#tick());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #tick(): Promise<void> {
    const ports = this.#ports;
    let state = (await ports.load()) ?? INITIAL_RUN;
    if (state.stage === "done" && state.summaryWritten) return;
    try {
      const observed = await ports.observe(state);
      const step = decide(state, { ...observed, now: ports.now() });
      state = step.state;
      await ports.save(state); // persist before effect
      for (const action of step.actions) {
        const next = await this.#apply(action, state);
        if (next !== state) {
          state = next;
          await ports.save(state);
        }
      }
    } catch (error) {
      ports.log("tick_error", {
        error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
      });
    } finally {
      if (!(state.stage === "done" && state.summaryWritten) && state.stage !== "waiting_token") {
        await ports.scheduleNext(ports.now() + TICK_MS);
      }
    }
  }

  async #apply(action: Action, state: RunState): Promise<RunState> {
    const ports = this.#ports;
    switch (action.type) {
      case "log":
        ports.log(action.event, { runId: state.runId, ...action.fields });
        return state;
      case "start_seeder":
        await ports.startSeeder();
        return state;
      case "stop_seeder":
        await ports.stopSeeder();
        return state;
      case "ensure_server":
        await ports.ensureServer();
        return state;
      case "destroy_server": {
        // Sent at `killSentAt`, the measurement's origin; it counts once it returned.
        const killSentAt = ports.now();
        const result = await ports.destroyServer();
        const killedAt = ports.now();
        ports.log("server_destroyed", {
          runId: state.runId,
          ...result,
          destroyMs: killedAt - killSentAt,
        });
        return { ...state, killSentAt, killedAt };
      }
      case "write_summary":
        await ports.writeSummary(state);
        ports.log("summary_written", { runId: state.runId });
        return { ...state, summaryWritten: true };
    }
  }
}
