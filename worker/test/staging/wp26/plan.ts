// WP2.6 staging: the restore run's decisions, as a pure function (test code, never shipped). The
// RestoreRun Durable Object (harness.ts) observes, calls `decide`, stores the new state, then
// carries out the actions. The run, from the moment the owner's R2 token arrives:
//   1. seed: a seeder container (the server image, a fresh installation) grows the database to
//      the target size, waits until the R2 replica covers every commit, stops its server with a
//      confirmed final sync, and reports; then it is removed, so one writer at a time;
//   2. the first start: the production OmnigentServer is asked to start (ensureStarted, as the
//      cron does) and its watchdog restores the replica and follows the start until it answers;
//   3. the replacement: once it has answered for a while, its container is destroyed and the
//      watchdog starts a new one, which restores the same replica, until it answers;
//   4. the end: the summary is written to R2; teardown removes the rest.
// Every stage is bounded, so a run that goes wrong ends as `failed` with the reason.

export type Stage = "waiting_token" | "seeding" | "starting" | "healthy" | "replacing" | "done";

export interface SeedResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly fields: Readonly<Record<string, number | string | boolean | null>>;
}

export interface RunState {
  readonly stage: Stage;
  readonly runId: string;
  /** When the token was first seen: the run's start. */
  readonly t0: number | null;
  readonly seedStartedAt: number | null;
  readonly seedStarts: number;
  readonly seed: SeedResult | null;
  readonly firstStartAt: number | null;
  readonly firstAnsweredAt: number | null;
  readonly killedAt: number | null;
  readonly replacedAnsweredAt: number | null;
  readonly failure: string | null;
  readonly endedAt: number | null;
  readonly summaryWritten: boolean;
}

export const INITIAL_RUN: RunState = {
  stage: "waiting_token",
  runId: "",
  t0: null,
  seedStartedAt: null,
  seedStarts: 0,
  seed: null,
  firstStartAt: null,
  firstAnsweredAt: null,
  killedAt: null,
  replacedAnsweredAt: null,
  failure: null,
  endedAt: null,
  summaryWritten: false,
};

export interface Observed {
  readonly now: number;
  /** Whether the replica's credentials (the owner's R2 token) are set on the Worker. */
  readonly tokenPresent: boolean;
  readonly seederRunning: boolean;
  /** What the seeder reported; null while it has not finished or cannot be read. */
  readonly seedResult: SeedResult | null;
  /** The server watchdog's last answer, from its stored state; null before it ever answered. */
  readonly serverLastAnsweredAt: number | null;
  /** The server's outage records (OmnigentServer.outages), as times in milliseconds. */
  readonly outages: readonly { readonly detectedAt: number; readonly endedAt: number | null }[];
}

export type Action =
  | { readonly type: "start_seeder" }
  | { readonly type: "stop_seeder" }
  | { readonly type: "ensure_server" }
  | { readonly type: "destroy_server" }
  | { readonly type: "write_summary" }
  | {
      readonly type: "log";
      readonly event: string;
      readonly fields: Readonly<Record<string, number | string | boolean | null>>;
    };

export interface Limits {
  readonly seedMs: number;
  readonly seedRestartAfterMs: number;
  readonly maxSeedStarts: number;
  readonly startMs: number;
  readonly healthyHoldMs: number;
}

export const LIMITS: Limits = {
  seedMs: 90 * 60_000,
  // A seeder container that is not running a minute after its start was refused or crashed.
  seedRestartAfterMs: 60_000,
  maxSeedStarts: 4,
  // Longer than the watchdog's own budgets (restore 540 s, app 300 s, readiness 120 s) and its
  // retries: a start the watchdog cannot bring up ends the run as failed.
  startMs: 45 * 60_000,
  healthyHoldMs: 3 * 60_000,
};

const ended = (
  state: RunState,
  now: number,
  failure: string | null,
): { state: RunState; actions: Action[] } => ({
  state: { ...state, stage: "done", failure, endedAt: now },
  actions: [
    { type: "log", event: failure === null ? "run_done" : "run_failed", fields: { failure } },
    { type: "write_summary" },
  ],
});

/** One step of the run. Pure: the same state and observation give the same step. */
export function decide(
  state: RunState,
  seen: Observed,
  limits: Limits = LIMITS,
): { state: RunState; actions: Action[] } {
  const now = seen.now;
  switch (state.stage) {
    case "waiting_token": {
      if (!seen.tokenPresent) return { state, actions: [] };
      const runId = `run-${new Date(now).toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z`;
      return {
        state: { ...state, stage: "seeding", runId, t0: now, seedStartedAt: now, seedStarts: 1 },
        actions: [
          { type: "log", event: "run_started", fields: { runId } },
          { type: "start_seeder" },
        ],
      };
    }
    case "seeding": {
      const since = state.seedStartedAt ?? now;
      if (seen.seedResult !== null) {
        if (!seen.seedResult.ok) {
          const failedSeed = { ...state, seed: seen.seedResult };
          const end = ended(failedSeed, now, `seeding failed: ${seen.seedResult.detail}`);
          return { state: end.state, actions: [{ type: "stop_seeder" }, ...end.actions] };
        }
        // The seeder's server stopped with a confirmed final sync; remove it before the
        // production server starts, so the replica has one writer at a time.
        return {
          state: { ...state, stage: "starting", seed: seen.seedResult, firstStartAt: now },
          actions: [
            { type: "stop_seeder" },
            { type: "log", event: "seeded", fields: seen.seedResult.fields },
            { type: "ensure_server" },
          ],
        };
      }
      if (now - since > limits.seedMs) {
        const end = ended(state, now, "seeding did not finish in time");
        return { state: end.state, actions: [{ type: "stop_seeder" }, ...end.actions] };
      }
      if (!seen.seederRunning && now - since > limits.seedRestartAfterMs) {
        if (state.seedStarts >= limits.maxSeedStarts) {
          return ended(state, now, "the seeder container would not run");
        }
        return {
          state: { ...state, seedStartedAt: now, seedStarts: state.seedStarts + 1 },
          actions: [
            { type: "log", event: "seeder_restarted", fields: { starts: state.seedStarts + 1 } },
            { type: "start_seeder" },
          ],
        };
      }
      return { state, actions: [] };
    }
    case "starting": {
      const since = state.firstStartAt ?? now;
      const answered = seen.serverLastAnsweredAt;
      if (answered !== null && answered >= since) {
        return {
          state: { ...state, stage: "healthy", firstAnsweredAt: answered },
          actions: [
            {
              type: "log",
              event: "first_start_answered",
              fields: { afterMs: answered - since },
            },
          ],
        };
      }
      if (now - since > limits.startMs) return ended(state, now, "the first start never answered");
      // As the platform's cron does every minute: a stopped server is started at once.
      return { state, actions: [{ type: "ensure_server" }] };
    }
    case "healthy": {
      if (now - (state.firstAnsweredAt ?? now) < limits.healthyHoldMs) {
        return { state, actions: [{ type: "ensure_server" }] };
      }
      return {
        state: { ...state, stage: "replacing", killedAt: now },
        actions: [
          { type: "log", event: "server_destroyed", fields: {} },
          { type: "destroy_server" },
        ],
      };
    }
    case "replacing": {
      const killedAt = state.killedAt ?? now;
      // The outage the watchdog opened when it found the destroyed container stopped, ended by
      // the replacement's first answer.
      const answered =
        seen.outages
          .filter((o) => o.detectedAt >= killedAt && o.endedAt !== null)
          .map((o) => o.endedAt as number)
          .sort((a, b) => a - b)[0] ?? null;
      if (answered !== null) {
        const replaced = { ...state, replacedAnsweredAt: answered };
        const end = ended(replaced, now, null);
        return {
          state: end.state,
          actions: [
            {
              type: "log",
              event: "replacement_answered",
              fields: { afterKillMs: answered - killedAt },
            },
            ...end.actions,
          ],
        };
      }
      if (now - killedAt > limits.startMs)
        return ended(state, now, "the replacement never answered");
      return { state, actions: [{ type: "ensure_server" }] };
    }
    case "done":
      return state.summaryWritten
        ? { state, actions: [] }
        : { state, actions: [{ type: "write_summary" }] };
  }
}
