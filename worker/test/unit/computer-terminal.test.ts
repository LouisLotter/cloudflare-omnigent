// WorkspaceDO's controller and the setup terminal's shells on the computer (WP3.28, FH-38): the
// runner sends the bridge's pending `terminal_end` first, drops one it can no longer deliver,
// keeps one the supervisor could not take yet; a stop's final capture asks the supervisor to end
// every session; a page sign-in closes the terminal as a sign-out does. Against the fake
// supervisor, which models the computer's sessions per window, with crashes between steps.
import { describe, expect, it } from "vitest";
import { ComputerSim, live } from "../support/computer-sim.ts";

function generation(sim: ComputerSim): number {
  return sim.record().lifecycle.generation;
}

function sent(sim: ComputerSim, type: string) {
  return sim.computer.supervisors.flatMap((s) => s.commands).filter((c) => c.type === type);
}

const OP = (n: number) => `op_${String(n).padStart(26, "0")}`;

/** A computer running, with window 2's shell kept on it and its end owed. */
async function owing(
  options: Parameters<ComputerSim["computer"]["terminalSessions"]["open"]>[0] = 2,
) {
  const sim = new ComputerSim();
  await sim.running();
  sim.computer.terminalSessions.open(options);
  sim.terminal.pending = { window: options, generation: generation(sim), op: OP(7) };
  return sim;
}

describe("the shell's end, sent by the runner (WP3.28)", () => {
  it("is delivered to the supervisor until answered, then settled", async () => {
    const sim = await owing();
    await sim.advance(sim.timing.heartbeatMs);
    expect(sent(sim, "terminal_end")).toEqual([
      expect.objectContaining({ window: 2, operationId: OP(7), generation: generation(sim) }),
    ]);
    expect(sim.computer.terminalSessions.sessions.size).toBe(0);
    expect(sim.terminal.pending).toBeNull();
    expect(sim.logs).toContainEqual({
      event: "terminal_end_delivered",
      fields: expect.objectContaining({ window: 2, generation: generation(sim), remaining: 0 }),
    });
    await sim.advance(sim.timing.heartbeatMs);
    expect(sent(sim, "terminal_end")).toHaveLength(1);
  });

  it("is kept while the supervisor cannot answer, and sent again with the same operation ID", async () => {
    const sim = await owing();
    const handler = sim.computer.supervisor;
    sim.computer.supervisor = (request) =>
      request
        .clone()
        .text()
        .then((body) =>
          body.includes('"terminal_end"')
            ? Response.json(
                { error: { code: "unavailable", message: "a capture runs", retryable: true } },
                { status: 503 },
              )
            : (handler as NonNullable<typeof handler>)(request),
        );
    await sim.advance(sim.timing.heartbeatMs);
    expect(sim.terminal.pending).not.toBeNull();
    expect(sim.logs.some((l) => l.event === "terminal_end_failed")).toBe(false);
    sim.computer.supervisor = handler;
    await sim.restart(); // a reset meanwhile: the end is in storage
    await sim.advance(sim.timing.heartbeatMs);
    expect(sim.terminal.pending).toBeNull();
    expect(sent(sim, "terminal_end").map((c) => c.operationId)).toEqual([OP(7)]);
  });

  it("logs a failure other than a busy supervisor, and keeps the end", async () => {
    const sim = await owing();
    const handler = sim.computer.supervisor;
    sim.computer.supervisor = () =>
      Response.json(
        { error: { code: "internal", message: "broken", retryable: true } },
        { status: 500 },
      );
    await sim.advance(sim.timing.heartbeatMs);
    sim.computer.supervisor = handler;
    expect(sim.terminal.pending).not.toBeNull();
    expect(sim.logs.some((l) => l.event === "terminal_end_failed")).toBe(true);
  });

  it("is dropped for another generation: that container went with its sessions", async () => {
    const sim = await owing();
    sim.terminal.pending = { window: 2, generation: generation(sim) - 1, op: OP(8) };
    await sim.advance(sim.timing.heartbeatMs);
    expect(sent(sim, "terminal_end")).toEqual([]);
    expect(sim.terminal.pending).toBeNull();
    expect(sim.logs).toContainEqual({
      event: "terminal_end_dropped",
      fields: expect.objectContaining({
        window: 2,
        generation: generation(sim) - 1,
        reason: "another_generation",
      }),
    });
  });

  it("is dropped, unsent, for a supervisor without terminal sessions (its ttyd ended the shell)", async () => {
    const sim = new ComputerSim();
    sim.computer.supervisorOptions = { terminalSessions: false };
    await sim.running();
    sim.terminal.pending = { window: 1, generation: generation(sim), op: OP(9) };
    await sim.advance(sim.timing.heartbeatMs);
    expect(sent(sim, "terminal_end")).toEqual([]);
    expect(sim.terminal.pending).toBeNull();
    expect(sim.logs.some((l) => l.event === "terminal_end_dropped")).toBe(true);
  });

  it("is dropped when the supervisor refuses the command as unknown", async () => {
    const sim = await owing();
    const handler = sim.computer.supervisor;
    sim.computer.supervisor = (request) =>
      request
        .clone()
        .text()
        .then((body) =>
          body.includes('"terminal_end"')
            ? Response.json(
                { error: { code: "bad_request", message: "unknown", retryable: false } },
                { status: 400 },
              )
            : (handler as NonNullable<typeof handler>)(request),
        );
    await sim.advance(sim.timing.heartbeatMs);
    sim.computer.supervisor = handler;
    expect(sim.terminal.pending).toBeNull();
    expect(sim.logs.some((l) => l.event === "terminal_end_dropped")).toBe(true);
  });

  it("goes before a sign-out's commands", async () => {
    const sim = await owing();
    sim.terminal.pending = { window: 2, generation: generation(sim), op: OP(10) };
    await sim.controller.pages({ interfaceVersion: 1, action: "sign_out", operationId: OP(11) });
    await sim.advance(sim.timing.heartbeatMs);
    const types = live(sim).commands.map((c) => c.type);
    const end = types.indexOf("terminal_end");
    expect(end).toBeGreaterThanOrEqual(0);
    expect(end).toBeLessThan(types.indexOf("sign_out"));
    // The sign-out closed the terminal through the bridge's hook first.
    expect(sim.terminal.closes).toContain("a sign-out started");
  });
});

describe("a stop's final capture (WP3.28)", () => {
  it("asks the supervisor to end every terminal session; an ordinary save does not", async () => {
    const sim = new ComputerSim();
    await sim.running();
    await sim.call(sim.client.checkpointRequest());
    await sim.advance(sim.timing.pollMs);
    sim.computer.terminalSessions.open(3);
    live(sim).runnerProcesses = 0;
    await sim.call(sim.client.suspendRequest());
    await sim.advance(60_000);
    const captures = sent(sim, "capture") as { endTerminals?: boolean }[];
    expect(captures.length).toBeGreaterThanOrEqual(2);
    expect(captures[0]?.endTerminals).toBeUndefined();
    expect(captures.at(-1)?.endTerminals).toBe(true);
    expect(sim.computer.terminalSessions.ended).toContain("all");
    expect(sim.terminal.closes).toContain("the computer is stopping");
  });

  it("carries no flag to a supervisor without terminal sessions", async () => {
    const sim = new ComputerSim();
    sim.computer.supervisorOptions = { terminalSessions: false };
    await sim.running();
    live(sim).runnerProcesses = 0;
    await sim.call(sim.client.suspendRequest());
    await sim.advance(60_000);
    const captures = sent(sim, "capture") as { endTerminals?: boolean }[];
    expect(captures.length).toBeGreaterThanOrEqual(1);
    expect(captures.every((c) => c.endTerminals === undefined)).toBe(true);
    expect(sim.computer.running).toBe(false);
  });
});

describe("a sign-in from the page (WP3.28)", () => {
  it("closes the setup terminal first, as a sign-out does; a refused start closes nothing", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).signIn("claude");
    await sim.settle();
    const refused = await sim.controller.signInStart({
      service: "claude",
      session: "ab".repeat(32),
      operationId: OP(20),
      generation: generation(sim) + 1,
    });
    expect(refused).toEqual({ outcome: "refused", reason: "stale" });
    expect(sim.terminal.closes).toEqual([]);
    const started = await sim.controller.signInStart({
      service: "codex",
      session: "ab".repeat(32),
      operationId: OP(21),
      generation: generation(sim),
    });
    expect(started.outcome).toBe("accepted");
    expect(sim.terminal.closes).toEqual(["a sign-in from the page started"]);
    expect(sim.record().terminalOpenUntil).toBeNull();
    // The supervisor ended every session before the CLI's spawn as well.
    expect(sim.computer.terminalSessions.ended).toContain("all");
  });

  it("reports the computer's session count in its status", async () => {
    const sim = new ComputerSim();
    await sim.running();
    sim.computer.terminalSessions.open(4);
    await sim.advance(5 * 60_000); // past the cached metrics
    const status = await sim.controller.computerStatus();
    expect(status.metrics).toMatchObject({ terminals: 1 });
  });
});
