// The deterministic simulation (WP3.1): whole controllers under crashes between every transition
// and effect, and under random event orders with lost replies, platform stops, refused starts,
// dropped connections and evictions. Invariants after every step: one live container per
// computer, no leaked reservation, every published manifest complete in R2, no container where
// the lifecycle wants none, no launch token stored outside its key, and work arriving during a
// stop resolved once.
import type { LauncherRequest, LauncherResult } from "@cfo/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ComputerSim, HOST } from "../support/computer-sim.ts";

/** Sends a request as Omnigent's launcher does: a failed or lost call is repeated unchanged. */
async function send(sim: ComputerSim, request: LauncherRequest): Promise<LauncherResult | string> {
  for (let i = 0; i < 6; i += 1) {
    try {
      const result = await sim.client.send(request);
      if (sim.dead) await sim.restart();
      await sim.settle();
      return result;
    } catch (error) {
      if (sim.dead) {
        await sim.restart();
        await sim.settle();
        continue;
      }
      const code = /^\[([a-z_]+)\]/.exec((error as Error).message)?.[1];
      if ((code === "unavailable" || code === "internal") && i < 5) continue;
      return code ?? String(error);
    }
  }
  throw new Error(`no answer to ${request.operation}`);
}

/** Wake, start, sign in, save, sleep, wake again: the scenario every crash point must survive. */
async function scenario(sim: ComputerSim): Promise<void> {
  await send(sim, sim.client.provisionRequest("managed-7f3c2a9e", `${"0".repeat(31)}1`));
  for (let round = 0; round < 2; round += 1) {
    await send(sim, sim.client.resumeRequest());
    await sim.advance(2_000);
    const token = sim.token(round + 1);
    for (let i = 0; i < 5; i += 1) {
      const status = await send(sim, sim.client.statusRequest());
      if (typeof status === "string" || status.operation !== "status")
        throw new Error(String(status));
      if (status.status === "host_running") break;
      if (status.status === "stopped") {
        await send(sim, sim.client.resumeRequest());
        await sim.advance(2_000);
        continue;
      }
      const claim = await send(sim, sim.client.claimRequest());
      if (typeof claim !== "string" && claim.operation === "claim_start" && claim.granted) {
        await send(
          sim,
          sim.client.startRequest({ attempt: claim.startAttempt, token, hostId: HOST }),
        );
      }
      await sim.advance(5_000);
    }
    if (round === 0) {
      sim.sup?.signIn("claude", "claude-login-canary-scenario");
      sim.sup?.write("work/a.txt", "saved");
      await sim.settle();
      await send(sim, sim.client.checkpointRequest());
      await sim.advance(10_000);
      if (sim.sup !== null) sim.sup.runnerProcesses = 0;
      const sleep = sim.client.suspendRequest();
      for (let i = 0; i < 10; i += 1) {
        const outcome = await send(sim, sleep);
        if (
          typeof outcome !== "string" &&
          outcome.operation === "suspend" &&
          outcome.outcome === "stopped"
        )
          break;
        if (
          typeof outcome !== "string" &&
          outcome.operation === "suspend" &&
          outcome.outcome === "refused"
        ) {
          // A refused sleep is retried by Omnigent later, with a new operation.
          await sim.advance(60_000);
          if (sim.sup !== null) sim.sup.runnerProcesses = 0;
          await send(sim, sim.client.suspendRequest());
        }
        await sim.advance(30_000);
      }
    }
  }
  await sim.advance(60_000);
}

describe("the simulation, crashing between every transition and effect", () => {
  it("survives a crash at any step of a wake, a save, a sleep and a second wake", async () => {
    const dry = new ComputerSim();
    await scenario(dry);
    expect(dry.check()).toEqual([]);
    expect(dry.record().lifecycle.context.state).toBe("host_running");
    const steps = dry.steps;
    expect(steps).toBeGreaterThan(100);
    const failures: string[] = [];
    for (let at = 1; at <= steps; at += 1) {
      const sim = new ComputerSim();
      sim.crashAt = at;
      try {
        await scenario(sim);
      } catch (error) {
        failures.push(`step ${at} (${dry.stepLog[at - 1]}): ${String(error)}`);
        continue;
      }
      const r = sim.record();
      const problems = sim.check();
      if (r.lifecycle.context.state !== "host_running")
        problems.push(`ended ${r.lifecycle.context.state}`);
      if (sim.sup?.tree.get("work/a.txt") !== "saved")
        problems.push("the saved file was not restored");
      if (
        sim.sup?.credentials.get(".claude/.credentials.json") !== "claude-login-canary-scenario"
      ) {
        problems.push("the login was not restored");
      }
      // One container start per generation that ran, never two at once.
      const started = sim.computer.starts
        .filter((s) => !s.refused)
        .map((s) => s.env.CFO_GENERATION);
      if (new Set(started).size !== started.length)
        problems.push(`a generation started twice: ${started}`);
      if (problems.length > 0)
        failures.push(`step ${at} (${dry.stepLog[at - 1]}): ${problems.join("; ")}`);
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

type Action =
  | { readonly kind: "wake" }
  | { readonly kind: "claim_start" }
  | { readonly kind: "late_start" }
  | { readonly kind: "checkpoint"; readonly lost: boolean }
  | { readonly kind: "write"; readonly n: number }
  | { readonly kind: "sign_in" }
  | { readonly kind: "suspend"; readonly lost: boolean }
  | { readonly kind: "resume_during_stop" }
  | { readonly kind: "runners"; readonly n: number }
  | { readonly kind: "platform_stop" }
  | { readonly kind: "refuse_starts"; readonly n: number }
  | { readonly kind: "drop"; readonly when: "before" | "after" }
  | { readonly kind: "advance"; readonly ms: number }
  | { readonly kind: "evict" }
  | { readonly kind: "crash_soon"; readonly in: number }
  | { readonly kind: "control_down"; readonly down: boolean }
  | { readonly kind: "terminate" };

const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 4, arbitrary: fc.constant({ kind: "wake" as const }) },
  { weight: 3, arbitrary: fc.constant({ kind: "claim_start" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "late_start" as const }) },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant("checkpoint" as const), lost: fc.boolean() }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("write" as const), n: fc.nat(5) }) },
  { weight: 1, arbitrary: fc.constant({ kind: "sign_in" as const }) },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant("suspend" as const), lost: fc.boolean() }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "resume_during_stop" as const }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("runners" as const), n: fc.nat(2) }) },
  { weight: 1, arbitrary: fc.constant({ kind: "platform_stop" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("refuse_starts" as const), n: fc.nat(6) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("drop" as const),
      when: fc.constantFrom("before" as const, "after" as const),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("advance" as const),
      ms: fc.constantFrom(1_000, 10_000, 60_000, 6 * 60_000, 20 * 60_000),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "evict" as const }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("crash_soon" as const),
      in: fc.integer({ min: 1, max: 40 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("control_down" as const), down: fc.boolean() }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "terminate" as const }) },
);

async function apply(sim: ComputerSim, a: Action, tokens: { n: number }): Promise<void> {
  const sup = sim.sup;
  switch (a.kind) {
    case "wake": {
      // Omnigent's wake: resume, then a claim and a start once the status says parked.
      await send(sim, sim.client.resumeRequest());
      await sim.advance(2_000);
      const status = await send(sim, sim.client.statusRequest());
      if (typeof status === "string" || status.operation !== "status") break;
      if (!["started_no_host", "start_claimed", "host_refused"].includes(status.status)) break;
      const claim = await send(sim, sim.client.claimRequest());
      if (typeof claim !== "string" && claim.operation === "claim_start" && claim.granted) {
        tokens.n += 1;
        await send(
          sim,
          sim.client.startRequest({
            attempt: claim.startAttempt,
            token: sim.token(tokens.n),
            hostId: HOST,
          }),
        );
      }
      break;
    }
    case "claim_start": {
      const claim = await send(sim, sim.client.claimRequest());
      if (typeof claim !== "string" && claim.operation === "claim_start" && claim.granted) {
        tokens.n += 1;
        await send(
          sim,
          sim.client.startRequest({
            attempt: claim.startAttempt,
            token: sim.token(tokens.n),
            hostId: HOST,
          }),
        );
      }
      break;
    }
    case "late_start":
      // A delayed start for an attempt that is no longer current.
      await send(
        sim,
        sim.client.startRequest({
          attempt: Math.max(1, sim.record().lifecycle.attempt - 1),
          token: sim.token(900),
          hostId: HOST,
        }),
      );
      break;
    case "checkpoint":
      if (a.lost) await sim.client.lose(sim.client.checkpointRequest());
      else await send(sim, sim.client.checkpointRequest());
      break;
    case "write":
      sup?.write(`work/f${a.n}.txt`, `${sim.now}`);
      break;
    case "sign_in":
      sup?.signIn("codex", `codex-login-canary-${sim.now}`);
      break;
    case "suspend":
      if (a.lost) await sim.client.lose(sim.client.suspendRequest());
      else await send(sim, sim.client.suspendRequest());
      break;
    case "resume_during_stop":
      if (sim.record().lifecycle.context.state === "stopping")
        await send(sim, sim.client.resumeRequest());
      break;
    case "runners":
      if (sup !== null) {
        sup.runnerProcesses = a.n;
        sup.report();
      }
      break;
    case "platform_stop":
      if (sim.computer.running) sim.computer.stopByPlatform();
      break;
    case "refuse_starts":
      sim.computer.refuseStarts = a.n;
      break;
    case "drop":
      sim.computer.dropRequests = { count: 1, when: a.when };
      break;
    case "advance":
      await sim.advance(a.ms);
      break;
    case "evict":
      await sim.restart();
      break;
    case "crash_soon":
      sim.crashAt = sim.steps + a.in;
      break;
    case "control_down":
      sim.control.unavailable = a.down;
      break;
    case "terminate":
      await send(sim, sim.client.terminateRequest());
      break;
  }
  await sim.settle();
}

const stats = {
  runs: 0,
  instances: 0,
  hosts: 0,
  published: 0,
  stops: 0,
  unexpected: 0,
  states: new Set<string>(),
};

describe("the simulation under random event orders (property)", () => {
  it("keeps its invariants whatever happens, and recovers once the faults stop", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 5, maxLength: 60 }), async (actions) => {
        const sim = new ComputerSim();
        const tokens = { n: 0 };
        await send(sim, sim.client.provisionRequest("managed-7f3c2a9e"));
        for (const a of actions) {
          await apply(sim, a, tokens);
          const problems = sim.check();
          if (problems.length > 0) throw new Error(`${JSON.stringify(a)}: ${problems.join("; ")}`);
          const started = sim.computer.starts
            .filter((s) => !s.refused)
            .map((s) => Number(s.env.CFO_GENERATION));
          for (let i = 1; i < started.length; i += 1) {
            if ((started[i] as number) <= (started[i - 1] as number))
              throw new Error(`generations out of order: ${started}`);
          }
        }
        // Faults stop: ControlDO back, no crashes, time passes. Every slot ends released or held by
        // the live generation, and no work is left half done.
        sim.crashAt = null;
        sim.control.unavailable = false;
        sim.computer.dropRequests = { count: 0, when: "before" };
        await sim.advance(30 * 60_000);
        const problems = sim.check();
        const r = sim.record();
        if (r.releases.length > 0) problems.push("releases left pending");
        if (r.lifecycle.context.state === "stopping" || r.lifecycle.context.state === "waking") {
          problems.push(`stuck in ${r.lifecycle.context.state}`);
        }
        if (problems.length > 0) throw new Error(problems.join("; "));
        stats.runs += 1;
        stats.instances += sim.instances - 1;
        stats.hosts += sim.computer.supervisors.filter((s) => s.host.state === "running").length;
        stats.published += sim.logs.filter((l) => l.event === "workspace_published").length;
        stats.stops += sim.computer.stops.length;
        stats.unexpected += sim.logs.filter((l) => l.event === "unexpected_stop").length;
        stats.states.add(r.lifecycle.context.state);
      }),
      { numRuns: 150, seed: 31_2026 },
    );
    // The runs exercised the controller, not only refusals.
    expect(stats.runs).toBe(150);
    expect(stats.instances).toBeGreaterThan(50);
    expect(stats.hosts).toBeGreaterThan(50);
    expect(stats.published).toBeGreaterThan(20);
    expect(stats.unexpected).toBeGreaterThan(5);
    process.stderr.write(
      `\nsimulation: ${JSON.stringify({ ...stats, states: [...stats.states] })}\n`,
    );
  }, 300_000);
});
