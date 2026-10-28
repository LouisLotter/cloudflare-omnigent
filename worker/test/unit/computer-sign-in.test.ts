// WorkspaceDO's controller (WP3.23): sign-in from the page, the sign-in lease, the computer's
// status and its logs, the history of final saves and the staging-only RC-53 switch, against the
// fake supervisor, with crashes (new instances from the same storage) between persisted steps.
// The link's state, the expected code and Codex's device code must never reach the logs or the
// stored record (the sim records a violation if a log holds one; `noSecrets` scans storage).
import { describe, expect, it } from "vitest";
import { STATUS_LOG_KEY } from "../../src/computer/record.ts";
import { ComputerSim, live } from "../support/computer-sim.ts";

const SESSION = "ab".repeat(32);
const OTHER = "cd".repeat(32);
let ops = 0;
const op = () => {
  ops += 1;
  return `op_${String(ops).padStart(26, "0")}`;
};

function generation(sim: ComputerSim): number {
  const raw = sim.store.get("computer") as { lifecycle?: { generation?: number } } | undefined;
  return raw?.lifecycle?.generation ?? 0;
}

function start(sim: ComputerSim, service: "claude" | "codex" = "claude", session = SESSION) {
  return sim.controller.signInStart({
    service,
    session,
    operationId: op(),
    generation: generation(sim),
  });
}

function accepted<T extends { outcome: string }>(answer: T) {
  if (answer.outcome !== "accepted") throw new Error(`refused: ${JSON.stringify(answer)}`);
  return answer as Extract<T, { outcome: "accepted" }>;
}

function noSecrets(sim: ComputerSim): void {
  const dump = sim.store.dump();
  for (const value of sim.computer.supervisors.flatMap((s) => s.issuedValues)) {
    expect(dump.includes(value), "a sign-in value in storage").toBe(false);
  }
  expect(sim.violations).toEqual([]);
}

/** The supervisor answers every command with "unavailable" while `fn` runs. */
async function offline<T>(sim: ComputerSim, fn: () => Promise<T>): Promise<T> {
  const handler = sim.computer.supervisor;
  sim.computer.supervisor = () =>
    Response.json(
      { error: { code: "unavailable", message: "down", retryable: true } },
      { status: 503 },
    );
  try {
    return await fn();
  } finally {
    sim.computer.supervisor = handler;
  }
}

function sent(sim: ComputerSim, type: string) {
  return sim.computer.supervisors.flatMap((s) => s.commands).filter((c) => c.type === type);
}

describe("signing in from the page", () => {
  it("signs in to Claude: link, the pasted code, the card; nothing stored or logged", async () => {
    const sim = new ComputerSim();
    await sim.running();
    expect((await sim.page()).signIn).toMatchObject({ available: "yes", cancelPending: false });
    const started = accepted(await start(sim));
    expect(started.view.state).toBe("awaiting_user");
    expect(started.view.url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    expect(started.view.deadline).toBe(new Date(sim.now + 10 * 60_000).toISOString());
    const attempt = started.view.attempt;
    await sim.restart();
    const status = accepted(
      await sim.controller.signInStatus({ service: "claude", attempt, session: SESSION }),
    );
    expect(status.view.url).toBe(started.view.url);
    expect(sim.controller.sessionAttempts(SESSION)).toEqual([{ service: "claude", attempt }]);
    expect(sim.controller.sessionAttempts(OTHER)).toEqual([]);
    const code = live(sim).issued.claude?.code ?? "";
    const done = accepted(
      await sim.controller.signInInput({
        service: "claude",
        attempt,
        code,
        session: SESSION,
        operationId: op(),
      }),
    );
    expect(done.view.state).toBe("done");
    expect(done.view.url).toBeUndefined();
    await sim.settle();
    expect((await sim.page()).setupCards[0]?.state).toBe("signed_in");
    await sim.advance(20_000);
    expect(sim.record().signIn.attempts.find((a) => a.attempt === attempt)?.ended).toBe("finished");
    expect(sim.controller.sessionAttempts(SESSION)).toEqual([]);
    noSecrets(sim);
  });

  it("signs in to Codex once the code is entered at OpenAI; the lease then ends", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const started = accepted(await start(sim, "codex"));
    expect(started.view.url).toBe("https://auth.openai.com/codex/device");
    expect(started.view.userCode).toBe(live(sim).issued.codex?.userCode);
    live(sim).runnerProcesses = 0;
    expect(await sim.call(sim.client.suspendRequest())).toEqual({
      operation: "suspend",
      outcome: "refused",
      reason: "terminal_open",
    });
    live(sim).approve("codex");
    await sim.advance(20_000);
    expect((await sim.page()).setupCards[1]?.state).toBe("signed_in");
    expect(sim.logs.some((l) => l.event === "sign_in_ended")).toBe(true);
    expect(await sim.call(sim.client.suspendRequest())).toEqual({
      operation: "suspend",
      outcome: "in_progress",
    });
    noSecrets(sim);
  });

  it("answers a repeated start with the same attempt, after a crash too", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const id = op();
    const first = accepted(
      await sim.controller.signInStart({
        service: "claude",
        session: SESSION,
        operationId: id,
        generation: generation(sim),
      }),
    );
    await sim.restart();
    const again = accepted(
      await sim.controller.signInStart({
        service: "claude",
        session: SESSION,
        operationId: id,
        generation: generation(sim),
      }),
    );
    expect(again.view.attempt).toBe(first.view.attempt);
    expect(again.view.state).toBe("starting");
    expect(sim.record().signIn.next).toBe(first.view.attempt);
    // Another session repeating the same operation does not get the attempt.
    expect(
      await sim.controller.signInStart({
        service: "claude",
        session: OTHER,
        operationId: id,
        generation: generation(sim),
      }),
    ).toEqual({ outcome: "refused", reason: "not_yours" });
  });

  it("refuses a start while asleep, stopping, signing out or being removed", async () => {
    const asleep = new ComputerSim();
    await asleep.call(asleep.client.provisionRequest("managed-7f3c2a9e"));
    expect(await start(asleep)).toEqual({ outcome: "refused", reason: "not_running" });

    const stopping = new ComputerSim();
    await stopping.running();
    live(stopping).options.capturePolls = 50;
    live(stopping).runnerProcesses = 0;
    await stopping.call(stopping.client.suspendRequest());
    expect(await start(stopping)).toEqual({ outcome: "refused", reason: "busy" });

    const removed = new ComputerSim();
    await removed.running();
    await removed.call(removed.client.terminateRequest());
    expect(await start(removed)).toEqual({ outcome: "refused", reason: "not_offered" });
  });

  it("offers the terminal for an older supervisor, known from its hello or from a refusal", async () => {
    const sim = new ComputerSim();
    sim.computer.supervisorOptions = { legacy: true };
    await sim.running();
    expect((await sim.page()).signIn).toMatchObject({ available: "no" });
    expect(await start(sim)).toEqual({ outcome: "refused", reason: "unsupported" });
    // A record that never heard its hello: the start is tried, refused as unknown, and recorded.
    const r = sim.record();
    sim.store.put("computer", { ...r, supervisorInfo: null });
    expect((await sim.page()).signIn).toMatchObject({ available: "unknown" });
    expect(await start(sim)).toEqual({ outcome: "refused", reason: "unsupported" });
    expect((await sim.page()).signIn).toMatchObject({ available: "no" });
    expect(sim.record().signIn.attempts.at(-1)?.ended).toBe("finished");
  });

  it("binds an attempt to its session and service, and refuses stale ones", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const { attempt } = accepted(await start(sim)).view;
    const read = (input: { service?: "claude" | "codex"; attempt?: number; session?: string }) =>
      sim.controller.signInStatus({
        service: input.service ?? "claude",
        attempt: input.attempt ?? attempt,
        session: input.session ?? SESSION,
      });
    expect(await read({ session: OTHER })).toEqual({ outcome: "refused", reason: "not_yours" });
    expect(await read({ service: "codex" })).toEqual({ outcome: "refused", reason: "stale" });
    expect(await read({ attempt: attempt + 5 })).toEqual({ outcome: "refused", reason: "stale" });
    const input = (session: string, service: "claude" | "codex" = "claude", n = attempt) =>
      sim.controller.signInInput({
        service,
        attempt: n,
        code: "x#y",
        session,
        operationId: op(),
      });
    expect(await input(OTHER)).toEqual({ outcome: "refused", reason: "not_yours" });
    expect(await input(SESSION, "codex")).toEqual({ outcome: "refused", reason: "stale" });
    expect(
      await sim.controller.signInCancel({ service: "claude", attempt, session: OTHER }),
    ).toEqual({ outcome: "refused", reason: "not_yours" });
    expect(
      await sim.controller.signInCancel({ service: "codex", attempt, session: SESSION }),
    ).toEqual({ outcome: "refused", reason: "stale" });
    // Codex has no code to relay.
    const codex = accepted(await start(sim, "codex")).view.attempt;
    expect(await input(SESSION, "codex", codex)).toEqual({ outcome: "refused", reason: "stale" });
  });

  it("fails a wrong code plainly, and refuses input once the attempt ended", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const { attempt } = accepted(await start(sim)).view;
    const input = (code: string) =>
      sim.controller.signInInput({
        service: "claude",
        attempt,
        code,
        session: SESSION,
        operationId: op(),
      });
    expect(accepted(await input("no-separator")).view).toMatchObject({
      state: "awaiting_user",
      notice: "incomplete_code",
    });
    expect(accepted(await input("WRONG#code")).view).toMatchObject({
      state: "failed",
      reason: "code_rejected",
    });
    // The supervisor answers "conflict": the attempt is not waiting any more.
    expect(await input("again#x")).toEqual({ outcome: "refused", reason: "stale" });
    await sim.settle();
    noSecrets(sim);
  });

  it("says the computer is unreachable, and the runner delivers a start that got no answer", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const started = await offline(sim, () => start(sim));
    expect(accepted(started).view.state).toBe("starting");
    const attempt = accepted(started).view.attempt;
    expect(sent(sim, "sign_in_start")).toHaveLength(0);
    expect(
      await offline(sim, () =>
        sim.controller.signInStatus({ service: "claude", attempt, session: SESSION }),
      ),
    ).toEqual(
      expect.objectContaining({
        outcome: "accepted",
        view: expect.objectContaining({ state: "starting" }),
      }),
    );
    await sim.restart();
    await sim.advance(2_000);
    expect(sent(sim, "sign_in_start")).toHaveLength(1);
    const now = accepted(
      await sim.controller.signInStatus({ service: "claude", attempt, session: SESSION }),
    );
    expect(now.view.state).toBe("awaiting_user");
    expect(
      await offline(sim, () =>
        sim.controller.signInStatus({ service: "claude", attempt, session: SESSION }),
      ),
    ).toEqual({ outcome: "refused", reason: "unreachable" });
    expect(
      await offline(sim, () =>
        sim.controller.signInInput({
          service: "claude",
          attempt,
          code: "x#y",
          session: SESSION,
          operationId: op(),
        }),
      ),
    ).toEqual({ outcome: "refused", reason: "unreachable" });
  });

  it("cancels a start that has not reached the computer: it never does", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const { attempt } = accepted(await offline(sim, () => start(sim))).view;
    const cancelled = await offline(sim, () =>
      sim.controller.signInCancel({ service: "claude", attempt, session: SESSION }),
    );
    expect(accepted(cancelled).view.state).toBe("cancelled");
    expect(sim.record().signIn.attempts.at(-1)).toMatchObject({
      ended: "cancelled",
      cancel: "pending",
    });
    await sim.restart();
    await sim.advance(5_000);
    expect(sent(sim, "sign_in_start")).toHaveLength(0);
    expect(sent(sim, "sign_in_cancel").map((c) => (c as { attempt: number }).attempt)).toEqual([
      attempt,
    ]);
    expect(sim.record().signIn.attempts.at(-1)?.cancel).toBe("done");
    // A cancel again changes nothing: the attempt has ended; its state stays cancelled.
    expect(
      await sim.controller.signInCancel({ service: "claude", attempt, session: SESSION }),
    ).toEqual({ outcome: "refused", reason: "stale" });
    expect(
      accepted(await sim.controller.signInStatus({ service: "claude", attempt, session: SESSION }))
        .view.state,
    ).toBe("cancelled");
  });

  it("a second tab's start supersedes the first; the first tab's code is refused", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const first = accepted(await start(sim)).view.attempt;
    const second = accepted(await start(sim, "claude", OTHER)).view.attempt;
    expect(second).toBeGreaterThan(first);
    expect(
      accepted(
        await sim.controller.signInStatus({ service: "claude", attempt: first, session: SESSION }),
      ).view.state,
    ).toBe("superseded");
    expect(
      await sim.controller.signInInput({
        service: "claude",
        attempt: first,
        code: "x#y",
        session: SESSION,
        operationId: op(),
      }),
    ).toEqual({ outcome: "refused", reason: "stale" });
    await sim.settle();
    // The superseded attempt's cancel is delivered too (a no-op once the newer start arrived).
    expect(sent(sim, "sign_in_cancel").map((c) => (c as { attempt: number }).attempt)).toContain(
      first,
    );
    expect(
      accepted(
        await sim.controller.signInStatus({ service: "claude", attempt: second, session: OTHER }),
      ).view.state,
    ).toBe("awaiting_user");
  });
});

/** Only `type`'s commands get "unavailable" while `fn` runs; the rest reach the supervisor. */
async function refusing<T>(sim: ComputerSim, type: string, fn: () => Promise<T>): Promise<T> {
  const handler = sim.computer.supervisor;
  sim.computer.supervisor = async (request) => {
    const body = (await request.clone().json()) as { type?: string };
    if (body.type === type) {
      return Response.json(
        { error: { code: "unavailable", message: "down", retryable: true } },
        { status: 503 },
      );
    }
    return (handler as (r: Request) => Promise<Response>)(request);
  };
  try {
    return await fn();
  } finally {
    sim.computer.supervisor = handler;
  }
}

describe("more sign-in edges", () => {
  it("ends an attempt whose start already failed on the computer", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).options.signInMode = "unexpected";
    const view = accepted(await start(sim)).view;
    expect(view).toMatchObject({ state: "failed", reason: "unexpected_output" });
    expect(sim.record().signIn.attempts.at(-1)?.ended).toBe("finished");
    expect(sim.controller.sessionAttempts(SESSION)).toEqual([]);
  });

  it("gives up a cancel an older supervisor cannot take", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const { attempt } = accepted(await offline(sim, () => start(sim))).view;
    live(sim).options.legacy = true;
    expect(
      accepted(await sim.controller.signInCancel({ service: "claude", attempt, session: SESSION }))
        .view.state,
    ).toBe("cancelled");
    expect(sim.record().signIn.attempts.at(-1)?.cancel).toBe("done");
  });

  it("holds a stop's credential barrier and a sign-out's logouts until the cancel is answered", async () => {
    const sim = new ComputerSim();
    await sim.running();
    accepted(await start(sim));
    await refusing(sim, "sign_in_cancel", async () => {
      await sim.controller.pages({ interfaceVersion: 1, action: "restart", operationId: op() });
      await sim.advance(10_000);
      expect(sent(sim, "capture").length).toBeGreaterThan(0);
      expect(sent(sim, "credential_snapshot")).toHaveLength(0);
    });
    await sim.advance(10_000);
    expect(sent(sim, "credential_snapshot").length).toBeGreaterThan(0);

    const out = new ComputerSim();
    await out.running();
    accepted(await start(out, "codex"));
    await refusing(out, "sign_in_cancel", async () => {
      await out.controller.pages({ interfaceVersion: 1, action: "sign_out", operationId: op() });
      await out.advance(10_000);
      expect(sent(out, "sign_out")).toHaveLength(0);
    });
    await out.advance(10_000);
    expect(sent(out, "sign_out")).toHaveLength(1);
  });

  it("knows no attempt of a computer that has no record", () => {
    expect(new ComputerSim().controller.sessionAttempts(SESSION)).toEqual([]);
  });
});

describe("Codex WP3.23 r1 regressions", () => {
  it("r1-1: never forgets an active attempt or an owed cancel, however many starts pile up", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const codex = accepted(await start(sim, "codex")).view.attempt;
    await offline(sim, async () => {
      for (let i = 0; i < 9; i += 1) accepted(await start(sim));
    });
    const r = sim.record();
    expect(r.signIn.attempts.find((a) => a.attempt === codex)?.ended).toBeNull();
    expect(r.signIn.attempts.length).toBeLessThanOrEqual(8);
    expect(
      r.signIn.attempts.filter((a) => a.cancel === "pending" && a.service === "claude"),
    ).toHaveLength(1);
    live(sim).runnerProcesses = 0;
    expect(await sim.call(sim.client.suspendRequest())).toMatchObject({ reason: "terminal_open" });
    await sim.controller.pages({ interfaceVersion: 1, action: "restart", operationId: op() });
    await sim.advance(30_000);
    const types = sim.computer.supervisors[0]?.commands.map((c) => c) ?? [];
    const codexCancel = types.findIndex(
      (c) => c.type === "sign_in_cancel" && (c as { attempt: number }).attempt === codex,
    );
    expect(codexCancel).toBeGreaterThan(-1);
    expect(codexCancel).toBeLessThan(types.findIndex((c) => c.type === "credential_snapshot"));
  });

  it("r1-2: refuses a start prepared for another generation", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const shown = generation(sim);
    expect(
      await sim.controller.signInStart({
        service: "claude",
        session: SESSION,
        operationId: op(),
        generation: shown + 1,
      }),
    ).toEqual({ outcome: "refused", reason: "stale" });
    // The page loaded in generation 1; the computer is restarted into generation 2 meanwhile.
    live(sim).runnerProcesses = 0;
    await sim.controller.pages({ interfaceVersion: 1, action: "restart", operationId: op() });
    await sim.advance(120_000);
    await sim.call(sim.client.resumeRequest());
    await sim.advance(5_000);
    expect(generation(sim)).toBeGreaterThan(shown);
    expect(
      await sim.controller.signInStart({
        service: "claude",
        session: SESSION,
        operationId: op(),
        generation: shown,
      }),
    ).toEqual({ outcome: "refused", reason: "stale" });
    expect(sent(sim, "sign_in_start")).toHaveLength(0);
  });

  it("r1-4: a repeated start whose attempt is no longer kept never starts another", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const first = op();
    const g = generation(sim);
    const view = accepted(
      await sim.controller.signInStart({
        service: "claude",
        session: SESSION,
        operationId: first,
        generation: g,
      }),
    ).view;
    await sim.controller.signInCancel({
      service: "claude",
      attempt: view.attempt,
      session: SESSION,
    });
    for (let i = 0; i < 9; i += 1) {
      const a = accepted(await start(sim)).view.attempt;
      await sim.controller.signInCancel({ service: "claude", attempt: a, session: SESSION });
    }
    await sim.restart();
    expect(sim.record().signIn.attempts.some((a) => a.attempt === view.attempt)).toBe(false);
    const before = sim.record().signIn.next;
    expect(
      await sim.controller.signInStart({
        service: "claude",
        session: SESSION,
        operationId: first,
        generation: g,
      }),
    ).toEqual({ outcome: "refused", reason: "stale" });
    expect(sim.record().signIn.next).toBe(before);
  });

  it("r1-6: an unanswered cancel stays pending, and the terminal waits for it", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const { attempt } = accepted(await start(sim, "codex")).view;
    const cancelled = await offline(sim, () =>
      sim.controller.signInCancel({ service: "codex", attempt, session: SESSION }),
    );
    expect(accepted(cancelled).view).toMatchObject({ state: "cancelled", pending: true });
    expect((await sim.page()).signIn?.cancelPending).toBe(true);
    expect(
      accepted(await sim.controller.signInStatus({ service: "codex", attempt, session: SESSION }))
        .view.pending,
    ).toBe(true);
    await sim.advance(2_000);
    expect((await sim.page()).signIn?.cancelPending).toBe(false);
    expect(
      accepted(await sim.controller.signInStatus({ service: "codex", attempt, session: SESSION }))
        .view,
    ).toMatchObject({ state: "cancelled" });
  });

  it("an expired attempt is pending until its cancel is answered", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const { attempt } = accepted(await start(sim)).view;
    sim.now += 10 * 60_000 + 1;
    expect(
      accepted(await sim.controller.signInStatus({ service: "claude", attempt, session: SESSION }))
        .view,
    ).toMatchObject({ state: "expired", pending: true });
    expect((await sim.page()).signIn?.cancelPending).toBe(true);
    await sim.advance(5_000);
    expect((await sim.page()).signIn?.cancelPending).toBe(false);
  });

  it("asks a silent supervisor for its status at most once an interval", async () => {
    const sim = new ComputerSim();
    await sim.running();
    await sim.advance(5 * 60_000);
    let asked = 0;
    const handler = sim.computer.supervisor;
    sim.computer.supervisor = async (request) => {
      const body = (await request.clone().json()) as { type?: string };
      if (body.type === "computer_status") {
        asked += 1;
        return Response.json(
          { error: { code: "unavailable", message: "down", retryable: true } },
          { status: 503 },
        );
      }
      return (handler as (r: Request) => Promise<Response>)(request);
    };
    await sim.advance(5 * 60_000 + 1_000);
    expect(asked).toBe(1);
    await sim.advance(4 * 60_000);
    expect(asked).toBe(1);
    await sim.advance(2 * 60_000);
    expect(asked).toBe(2);
    sim.computer.supervisor = handler;
    expect(sim.logs.filter((l) => l.event === "computer_status").at(-1)?.fields.supervisor).toBe(
      "unreachable",
    );
  });
});

describe("the sign-in lease", () => {
  it("keeps the computer awake until its deadline, then expires on its own", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const { attempt } = accepted(await start(sim)).view;
    live(sim).runnerProcesses = 0;
    await sim.restart();
    expect(await sim.call(sim.client.suspendRequest())).toMatchObject({ reason: "terminal_open" });
    await sim.advance(9 * 60_000);
    expect(await sim.call(sim.client.suspendRequest())).toMatchObject({ reason: "terminal_open" });
    await sim.advance(61_000);
    const a = sim.record().signIn.attempts.find((x) => x.attempt === attempt);
    expect(a).toMatchObject({ ended: "expired", cancel: "done" });
    expect(sim.logs.some((l) => l.event === "sign_in_expired")).toBe(true);
    expect(
      accepted(await sim.controller.signInStatus({ service: "claude", attempt, session: SESSION }))
        .view.state,
    ).toBe("expired");
    expect(await sim.call(sim.client.suspendRequest())).toEqual({
      operation: "suspend",
      outcome: "in_progress",
    });
  });

  it("defers the start deadline of a computer without a host, as an open terminal does", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    await sim.call(sim.client.resumeRequest());
    await sim.advance(sim.timing.pollMs);
    expect(sim.record().lifecycle.context.state).toBe("started_no_host");
    accepted(await start(sim));
    await sim.advance(sim.timing.startDeadlineMs + 10_000);
    expect(sim.record().lifecycle.context.state).toBe("started_no_host");
    await sim.advance(10 * 60_000);
    expect(["stopping", "asleep", "stopped"]).toContain(sim.record().lifecycle.context.state);
  });

  it("is ended by a stop, whose credential barrier waits for the cancel", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const { attempt } = accepted(await start(sim)).view;
    live(sim).runnerProcesses = 0;
    // The suspend is refused while the lease holds; a restart from the page stops it anyway.
    await sim.controller.pages({ interfaceVersion: 1, action: "restart", operationId: op() });
    expect(sim.record().signIn.attempts.find((a) => a.attempt === attempt)?.ended).toBe(
      "cancelled",
    );
    await sim.advance(30_000);
    const types = sim.computer.supervisors[0]?.commands.map((c) => c.type) ?? [];
    expect(types.indexOf("sign_in_cancel")).toBeGreaterThan(-1);
    expect(types.indexOf("sign_in_cancel")).toBeLessThan(types.lastIndexOf("credential_snapshot"));
    expect(sim.record().signIn.attempts.every((a) => a.ended !== null)).toBe(true);
  });

  it("is ended before a sign-out's logouts", async () => {
    const sim = new ComputerSim();
    await sim.running();
    accepted(await start(sim, "codex"));
    await sim.controller.pages({ interfaceVersion: 1, action: "sign_out", operationId: op() });
    await sim.advance(30_000);
    const types = sim.computer.supervisors[0]?.commands.map((c) => c.type) ?? [];
    expect(types.indexOf("sign_in_cancel")).toBeLessThan(types.indexOf("sign_out"));
  });

  it("waits with a stop's barrier while a cancel gets no answer", async () => {
    const sim = new ComputerSim();
    await sim.running();
    accepted(await start(sim));
    await offline(sim, async () => {
      await sim.controller.pages({ interfaceVersion: 1, action: "restart", operationId: op() });
      await sim.advance(10_000);
    });
    expect(sent(sim, "credential_snapshot")).toHaveLength(0);
    await sim.advance(10_000);
    expect(sent(sim, "credential_snapshot").length).toBeGreaterThan(0);
  });

  it("ends with the generation", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const { attempt } = accepted(await start(sim)).view;
    sim.computer.stopByPlatform("maintenance");
    await sim.advance(5_000);
    const a = sim.record().signIn.attempts.find((x) => x.attempt === attempt);
    expect(a?.ended).toBe("gone");
    expect(
      accepted(await sim.controller.signInStatus({ service: "claude", attempt, session: SESSION }))
        .view.state,
    ).toBe("none");
  });
});

describe("the computer's status", () => {
  it("composes the supervisor's metrics with the record, and caches them briefly", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).signIn("claude");
    await sim.settle();
    sim.now += 20_000; // past the runner's last read: a page read asks the supervisor now
    const before = sent(sim, "computer_status").length;
    const status = await sim.controller.computerStatus();
    expect(status.supervisor).toBe("ok");
    expect(status.metrics?.versions).toEqual({
      claude: "2.1.311",
      codex: "0.164.0",
      gh: "2.103.3",
    });
    expect(status.credentials.files.map((f) => [f.path, f.state])).toEqual([
      [".claude/.credentials.json", "present"],
      [".claude/.device-keys.json", "tombstone"],
      [".codex/auth.json", "tombstone"],
      [".codex/.credentials.json", "tombstone"],
    ]);
    expect(status.signOut).toEqual({ phase: "none", running: false });
    expect(status.rc53).toEqual({ staging: false, desired: null, applied: false });
    await sim.controller.computerStatus();
    expect(sent(sim, "computer_status").length).toBe(before + 1);
    sim.now += 20_000;
    await offline(sim, async () => {
      expect((await sim.controller.computerStatus()).supervisor).toBe("unreachable");
    });
  });

  it("says what is missing: not running, or an older supervisor", async () => {
    const asleep = new ComputerSim();
    await asleep.call(asleep.client.provisionRequest("managed-7f3c2a9e"));
    const s = await asleep.controller.computerStatus();
    expect(s.supervisor).toBe("not_running");
    expect(s.credentials.files.every((f) => f.state === "none")).toBe(true);
    const older = new ComputerSim();
    older.computer.supervisorOptions = { legacy: true };
    await older.running();
    expect((await older.controller.computerStatus()).supervisor).toBe("unsupported");
  });

  it("logs computer_status with names and counts, on change and at its interval", async () => {
    const sim = new ComputerSim();
    await sim.running();
    await sim.advance(1_000);
    const logged = () => sim.logs.filter((l) => l.event === "computer_status");
    const first = logged().length;
    expect(first).toBeGreaterThan(0);
    expect(logged().at(-1)?.fields).toMatchObject({
      supervisor: "ok",
      versions: { claude: "2.1.311", codex: "0.164.0", gh: "2.103.3" },
      signOut: "none",
      lastSave: null,
    });
    await sim.advance(60_000);
    expect(logged().length).toBe(first);
    live(sim).options.failCaptures = 1;
    live(sim).write("work/a.txt", "1");
    await sim.call(sim.client.checkpointRequest());
    await sim.advance(2_000);
    expect(logged().at(-1)?.fields).toMatchObject({
      lastSave: { outcome: "failed", reason: "lease_expired" },
      failedSaves: 1,
    });
    const afterChange = logged().length;
    await sim.advance(5 * 60_000);
    expect(logged().length).toBeGreaterThan(afterChange);
    noSecrets(sim);
  });

  it("keeps what it logged across new instances, each of which says it started (WP3.27)", async () => {
    const sim = new ComputerSim();
    await sim.running();
    await sim.advance(1_000);
    const logged = () => sim.logs.filter((l) => l.event === "computer_status").length;
    const started = () => sim.logs.filter((l) => l.event === "instance_started");
    const first = logged();
    const instances = started().length;
    for (let i = 0; i < 4; i += 1) {
      await sim.restart();
      await sim.advance(30_000);
    }
    expect(logged()).toBe(first);
    const lines = started().slice(instances);
    expect(lines).toHaveLength(4);
    expect(new Set(lines.map((l) => l.fields.instanceId)).size).toBe(4);
    expect(lines[0]?.fields).toMatchObject({
      class: "WorkspaceDO",
      generation: 1,
      state: "host_running",
    });
    // An unreadable record counts as nothing logged: the next pass logs again.
    sim.store.put(STATUS_LOG_KEY, { logged: "not a record" });
    await sim.restart();
    await sim.advance(1_000);
    expect(logged()).toBe(first + 1);
    await sim.advance(5 * 60_000);
    expect(logged()).toBe(first + 2);
  });

  it("records final save outcomes, bounded; the page shows the last; failures have reasons", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).write("work/a.txt", "1");
    await sim.call(sim.client.checkpointRequest());
    await sim.advance(2_000);
    expect((await sim.page()).lastSave).toMatchObject({ outcome: "published", reason: null });
    for (let i = 0; i < 12; i += 1) {
      live(sim).write("work/a.txt", String(i + 2));
      await sim.call(sim.client.checkpointRequest());
      await sim.advance(2_000);
    }
    expect(sim.record().saves).toHaveLength(10);
    live(sim).options.failCaptures = 1;
    live(sim).write("work/a.txt", "x");
    await sim.call(sim.client.checkpointRequest());
    await sim.advance(2_000);
    expect((await sim.page()).lastSave).toMatchObject({
      outcome: "failed",
      reason: "lease_expired",
    });
  });
});

describe("the staging RC-53 switch", () => {
  it("is refused on production, and nothing is stored", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const before = sim.store.dump();
    expect(await sim.controller.setStagingCheck({ rc53: true })).toEqual({
      outcome: "refused",
      reason: "not_staging",
    });
    expect(sim.store.dump()).toBe(before);
    expect((await sim.page()).stagingChecks).toBe(false);
    expect(sent(sim, "staging_check")).toHaveLength(0);
  });

  it("is applied before captures, again in every generation, with RC-53's counts kept", async () => {
    const sim = new ComputerSim({ staging: true });
    await sim.running();
    expect((await sim.page()).stagingChecks).toBe(true);
    expect(await sim.controller.setStagingCheck({ rc53: true })).toEqual({
      outcome: "accepted",
      rc53: true,
    });
    await sim.restart();
    live(sim).options.rc53Findings = 14;
    live(sim).write("work/a.txt", "1");
    await sim.call(sim.client.checkpointRequest());
    await sim.advance(2_000);
    const types = sim.computer.supervisors[0]?.commands.map((c) => c.type) ?? [];
    expect(types.indexOf("staging_check")).toBeLessThan(types.indexOf("capture"));
    expect(sim.record().rc53).toEqual({ desired: true, applied: { generation: 1, rc53: true } });
    await sim.advance(5 * 60_000);
    expect(sim.record().saves[0]).toMatchObject({
      outcome: "failed",
      reason: "policy_violation",
      rc53: { findings: 14, status: 1 },
    });
    const status = await sim.controller.computerStatus();
    expect(status.rc53).toEqual({ staging: true, desired: true, applied: true });
    expect(status.saves[0]?.rc53?.findings).toBe(14);
    // A new generation: applied again before its first capture.
    live(sim).runnerProcesses = 0;
    live(sim).options.rc53Findings = 0;
    await sim.controller.pages({ interfaceVersion: 1, action: "restart", operationId: op() });
    await sim.advance(120_000);
    await sim.call(sim.client.resumeRequest());
    await sim.advance(5_000);
    const second = sim.computer.supervisors.at(-1);
    expect(second?.rc53).toBe(true);
    expect(sim.record().rc53?.applied?.generation).toBe(sim.record().lifecycle.generation);
    // Turned off again: applied in this generation, keeping what was applied meanwhile.
    expect(await sim.controller.setStagingCheck({ rc53: false })).toMatchObject({ rc53: false });
    expect(sim.record().rc53?.applied?.rc53).toBe(true);
    await sim.advance(2_000);
    expect(second?.rc53).toBe(false);
    expect(sim.record().rc53?.applied?.rc53).toBe(false);
  });

  it("blocks captures while it cannot be applied, and gives way for an older supervisor", async () => {
    const sim = new ComputerSim({ staging: true });
    await sim.running();
    await offline(sim, async () => {
      await sim.controller.setStagingCheck({ rc53: true });
      live(sim).write("work/a.txt", "1");
      await sim.call(sim.client.checkpointRequest());
      await sim.advance(2_000);
    });
    expect(sent(sim, "capture")).toHaveLength(0);
    await sim.advance(2_000);
    expect(sent(sim, "capture").length).toBeGreaterThan(0);

    const older = new ComputerSim({ staging: true });
    older.computer.supervisorOptions = { legacy: true };
    await older.running();
    await older.controller.setStagingCheck({ rc53: true });
    live(older).write("work/a.txt", "1");
    await older.call(older.client.checkpointRequest());
    await older.advance(2_000);
    expect(older.logs.some((l) => l.event === "staging_check_unsupported")).toBe(true);
    expect(sent(older, "capture").length).toBeGreaterThan(0);
  });

  it("is not offered during a removal", async () => {
    const sim = new ComputerSim({ staging: true });
    await sim.running();
    await sim.call(sim.client.terminateRequest());
    expect(await sim.controller.setStagingCheck({ rc53: false })).toEqual({
      outcome: "refused",
      reason: "not_offered",
    });
  });
});

describe("the staging keep-awake switch (WP3.27)", () => {
  it("is refused on production, nothing is stored, and Omnigent's sleep goes ahead", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const before = sim.store.dump();
    expect(await sim.controller.setStagingKeepAwake({ on: true })).toEqual({
      outcome: "refused",
      reason: "not_staging",
    });
    expect(sim.store.dump()).toBe(before);
    expect((await sim.controller.computerStatus()).keepAwake).toEqual({
      staging: false,
      on: null,
    });
    live(sim).runnerProcesses = 0;
    expect(await sim.call(sim.client.suspendRequest())).toEqual({
      operation: "suspend",
      outcome: "in_progress",
    });
  });

  it("refuses Omnigent's sleep as an open terminal does, persisted, in every generation, until off", async () => {
    const sim = new ComputerSim({ staging: true });
    await sim.running();
    expect(await sim.controller.setStagingKeepAwake({ on: true })).toEqual({
      outcome: "accepted",
      on: true,
    });
    expect(sim.logs.some((l) => l.event === "staging_keep_awake_set")).toBe(true);
    // A new instance (a reset) reads it from storage.
    await sim.restart();
    live(sim).runnerProcesses = 0;
    expect(await sim.call(sim.client.suspendRequest())).toMatchObject({
      outcome: "refused",
      reason: "terminal_open",
    });
    expect(sim.logs.some((l) => l.event === "sleep_kept_awake")).toBe(true);
    expect((await sim.controller.computerStatus()).keepAwake).toEqual({ staging: true, on: true });
    // A new generation: still held.
    await sim.controller.pages({ interfaceVersion: 1, action: "restart", operationId: op() });
    await sim.advance(120_000);
    await sim.call(sim.client.resumeRequest());
    await sim.advance(5_000);
    const generation = sim.record().lifecycle.generation;
    expect(generation).toBeGreaterThan(1);
    live(sim).runnerProcesses = 0;
    expect(await sim.call(sim.client.suspendRequest())).toMatchObject({
      reason: "terminal_open",
    });
    expect(sim.record().lifecycle.generation).toBe(generation);
    // Off: the next sleep goes ahead.
    expect(await sim.controller.setStagingKeepAwake({ on: false })).toEqual({
      outcome: "accepted",
      on: false,
    });
    expect(await sim.call(sim.client.suspendRequest())).toEqual({
      operation: "suspend",
      outcome: "in_progress",
    });
    noSecrets(sim);
  });

  it("is not offered during a removal, and a removal's sleep is gone whatever it says", async () => {
    const sim = new ComputerSim({ staging: true });
    await sim.running();
    await sim.controller.setStagingKeepAwake({ on: true });
    await sim.call(sim.client.terminateRequest());
    expect(await sim.controller.setStagingKeepAwake({ on: false })).toEqual({
      outcome: "refused",
      reason: "not_offered",
    });
    expect(await sim.client.refusal(sim.client.suspendRequest())).toBe("gone");
  });
});
