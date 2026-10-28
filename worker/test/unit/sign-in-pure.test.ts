// WP3.23's pure modules: the sign-in attempts' rules (`computer/sign-in.ts`), the status's
// composition and log (`computer/status.ts`) and how a staging installation is recognized
// (`computer/staging.ts`).
import type { CredentialManifest, SupervisorStatus } from "@cfo/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  attemptOfOp,
  begin,
  callerAttempt,
  closeAll,
  endedState,
  endWithContainer,
  finalState,
  isActive,
  leaseActive,
  leaseUntil,
  MAX_ATTEMPTS,
  MAX_START_OPS,
  NO_SIGN_IN,
  pageView,
  prune,
  type SignInRecord,
  sessionAttempts,
  signInAvailable,
  startRefusal,
  update,
} from "../../src/computer/sign-in.ts";
import { isStagingInstallation } from "../../src/computer/staging.ts";
import {
  composeStatus,
  MAX_SAVES,
  recordSave,
  type SaveRecord,
  saveReason,
  statusLog,
  withRc53,
} from "../../src/computer/status.ts";

const S = "ab".repeat(32);
const LINK = "https://claude.com/cai/oauth/authorize?code=true&state=synthetic";

function started(r: SignInRecord, n = 0, service: "claude" | "codex" = "claude") {
  return begin(r, { service, generation: 1, session: S, op: `op_${n}`, now: 1_000 });
}

describe("sign-in attempts", () => {
  it("numbers attempts upward, supersedes the service's active one and queues its cancel", () => {
    const a = started(NO_SIGN_IN, 1);
    expect(a.attempt).toMatchObject({
      attempt: 1,
      deadline: 601_000,
      delivered: false,
      ended: null,
    });
    const b = started(a.record, 2);
    expect(b.attempt.attempt).toBe(2);
    expect(b.record.attempts[0]).toMatchObject({ ended: "superseded", cancel: "pending" });
    const c = started(b.record, 3, "codex");
    expect(c.record.attempts[1]?.ended).toBeNull();
    expect(attemptOfOp(c.record, "op_2")?.attempt).toBe(2);
    expect(attemptOfOp(c.record, "op_9")).toBeUndefined();
    const custom = begin(NO_SIGN_IN, {
      service: "claude",
      generation: 1,
      session: S,
      op: "x",
      now: 0,
      deadlineMs: 5,
    });
    expect(custom.attempt.deadline).toBe(5);
  });

  it("keeps a bounded record, never dropping an attempt still owed a cancel", () => {
    let r = NO_SIGN_IN;
    for (let i = 0; i < 30; i += 1) r = started(r, i, i % 2 === 0 ? "claude" : "codex").record;
    expect(r.attempts.length).toBeLessThanOrEqual(MAX_ATTEMPTS + 1);
    expect(r.ops).toHaveLength(MAX_START_OPS);
    const owed: SignInRecord = {
      next: 20,
      ops: [],
      attempts: Array.from({ length: 12 }, (_, i) => ({
        ...started(NO_SIGN_IN, i).attempt,
        attempt: i + 1,
        ended: "cancelled" as const,
        cancel: "pending" as const,
      })),
    };
    expect(prune(owed).attempts).toHaveLength(MAX_ATTEMPTS + 1);
  });

  it("closes every active attempt, and ends them all with the container", () => {
    const r = started(started(NO_SIGN_IN, 1).record, 2, "codex").record;
    const closed = closeAll(r);
    expect(closed.attempts.every((a) => a.ended !== null && a.cancel === "pending")).toBe(true);
    const gone = endWithContainer(closed);
    expect(gone.attempts.every((a) => a.cancel === "done")).toBe(true);
    expect(gone.attempts.map((a) => a.ended)).toEqual(["cancelled", "cancelled"]);
    const fresh = endWithContainer(r);
    expect(fresh.attempts.map((a) => a.ended)).toEqual(["gone", "gone"]);
    const done = update(r, 1, (a) => ({ ...a, ended: "finished" }));
    expect(endWithContainer(done).attempts[0]?.ended).toBe("finished");
  });

  it("holds the lease while an attempt is active, until its deadline", () => {
    const { record } = started(NO_SIGN_IN, 1);
    expect(leaseActive(record, 1, 1_000)).toBe(true);
    expect(leaseUntil(record, 1, 1_000)).toBe(601_000);
    expect(leaseActive(record, 1, 601_000)).toBe(false);
    expect(leaseUntil(record, 1, 601_000)).toBeNull();
    expect(leaseActive(record, 2, 1_000)).toBe(false);
    expect(leaseActive(closeAll(record), 1, 1_000)).toBe(false);
  });

  it("is a property: the lease never outlives the latest deadline", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(10), { maxLength: 12 }), fc.nat(2_000_000), (gaps, at) => {
        let r = NO_SIGN_IN;
        let now = 0;
        for (const [i, gap] of gaps.entries()) {
          now += gap * 1000;
          r = begin(r, {
            service: i % 2 === 0 ? "claude" : "codex",
            generation: 1,
            session: S,
            op: `op_${i}`,
            now,
          }).record;
        }
        const until = leaseUntil(r, 1, at);
        return until === null ? !leaseActive(r, 1, at) : until > at && leaseActive(r, 1, at);
      }),
    );
  });

  it("refuses starts by the computer's state, and tells older supervisors apart", () => {
    const facts = { removal: false, running: true, busy: false, available: "yes" as const };
    expect(startRefusal(facts)).toBeNull();
    expect(startRefusal({ ...facts, available: "unknown" })).toBeNull();
    expect(startRefusal({ ...facts, removal: true })).toBe("not_offered");
    expect(startRefusal({ ...facts, busy: true })).toBe("busy");
    expect(startRefusal({ ...facts, running: false })).toBe("not_running");
    expect(startRefusal({ ...facts, available: "no" })).toBe("unsupported");
    expect(signInAvailable(null, 1)).toBe("unknown");
    expect(signInAvailable({ generation: 0, features: ["sign_in"] }, 1)).toBe("unknown");
    expect(signInAvailable({ generation: 1, features: ["sign_in"] }, 1)).toBe("yes");
    expect(signInAvailable({ generation: 1, features: [] }, 1)).toBe("no");
  });

  it("lets only the starting session act, on a live attempt", () => {
    const { attempt } = started(NO_SIGN_IN, 1);
    const ok = { service: "claude" as const, session: S, generation: 1, now: 2_000 };
    expect(callerAttempt(attempt, ok)).toBe(attempt);
    expect(callerAttempt(undefined, ok)).toBe("stale");
    expect(callerAttempt(attempt, { ...ok, service: "codex" })).toBe("stale");
    expect(callerAttempt(attempt, { ...ok, session: "x" })).toBe("not_yours");
    expect(callerAttempt(attempt, { ...ok, generation: 2 })).toBe("stale");
    expect(callerAttempt(attempt, { ...ok, now: 601_000 })).toBe("stale");
    expect(isActive(attempt, 1, 2_000)).toBe(true);
  });

  it("names an ended attempt's state without asking the computer", () => {
    const { attempt: a } = started(NO_SIGN_IN, 1);
    expect(endedState({ ...a, ended: "cancelled" }, 1, 0)).toBe("cancelled");
    expect(endedState({ ...a, ended: "superseded" }, 1, 0)).toBe("superseded");
    expect(endedState({ ...a, ended: "expired" }, 1, 0)).toBe("expired");
    expect(endedState({ ...a, ended: "gone" }, 1, 0)).toBe("none");
    expect(endedState({ ...a, ended: "finished" }, 1, 0)).toBeNull();
    expect(endedState(a, 2, 0)).toBe("none");
    expect(endedState(a, 1, 601_000)).toBe("expired");
    expect(endedState(a, 1, 2_000)).toBeNull();
  });

  it("shows the supervisor's view, re-checking the link and dropping stale fields", () => {
    const { attempt: a } = started(NO_SIGN_IN, 1);
    expect(pageView(a, null, "cancelled")).toMatchObject({ state: "cancelled" });
    expect(pageView(a, null, null)).toMatchObject({ state: "starting" });
    const waiting = pageView(
      a,
      {
        service: "claude",
        attempt: 1,
        state: "awaiting_user",
        url: LINK,
        notice: "incomplete_code",
      },
      null,
    );
    expect(waiting).toMatchObject({ url: LINK, notice: "incomplete_code" });
    expect(
      pageView(
        a,
        { service: "claude", attempt: 1, state: "awaiting_user", url: "https://evil.example/x" },
        null,
      ),
    ).toMatchObject({ state: "failed", reason: "unexpected_output" });
    expect(
      pageView(a, { service: "claude", attempt: 1, state: "done", url: LINK }, null).url,
    ).toBeUndefined();
    expect(
      pageView(
        a,
        { service: "claude", attempt: 1, state: "failed", reason: "code_rejected" },
        null,
      ),
    ).toMatchObject({ reason: "code_rejected" });
    const codex = started(NO_SIGN_IN, 1, "codex").attempt;
    expect(
      pageView(
        codex,
        {
          service: "codex",
          attempt: 1,
          state: "awaiting_user",
          url: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH1",
        },
        null,
      ).userCode,
    ).toBe("ABCD-EFGH1");
    expect(
      pageView(
        codex,
        { service: "codex", attempt: 1, state: "completing", userCode: "ABCD-EFGH1" },
        null,
      ).userCode,
    ).toBeUndefined();
    expect(finalState("awaiting_user")).toBe(false);
    expect(finalState("none")).toBe(true);
    expect(sessionAttempts(started(NO_SIGN_IN, 1).record, S, 1, 2_000)).toEqual([
      { service: "claude", attempt: 1 },
    ]);
  });
});

const METRICS: SupervisorStatus = {
  supervisorVersion: "0.2.0",
  versions: { claude: "2.1.311", codex: null, gh: "2.103.3" },
  logins: { claude: "signed_in", codex: "unknown" },
  signIn: { claude: "none", codex: "awaiting_user" },
  rc53: true,
  hostname: "mapped",
  disk: { totalBytes: 2e10, freeBytes: 1e10 },
  alerts: [{ kind: "rc53_finding", count: 2 }],
  captures: [
    {
      jobOperationId: "op_a",
      rc53: { status: 1, values: 3, files: 4, findings: 2, incomplete: 0 },
    },
  ],
};

function save(op: string, outcome: SaveRecord["outcome"], reason: string | null): SaveRecord {
  return { at: 1_000, generation: 1, op, outcome, reason, kind: "delta", rc53: null };
}

describe("the status", () => {
  it("maps save reasons to names, and keeps the newest saves", () => {
    expect(saveReason(null)).toBeNull();
    expect(saveReason("policy_violation")).toBe("policy_violation");
    expect(saveReason("parent changed")).toBe("parent_changed");
    expect(saveReason("unexpected reply")).toBe("internal");
    let saves: SaveRecord[] = [];
    for (let i = 0; i < 15; i += 1) saves = recordSave(saves, save(`op_${i}`, "published", null));
    expect(saves).toHaveLength(MAX_SAVES);
    expect(saves[0]?.op).toBe("op_14");
  });

  it("adds RC-53's counts to the saves of their captures only", () => {
    const merged = withRc53(
      [save("op_a", "failed", "policy_violation"), save("op_b", "published", null)],
      METRICS.captures,
    );
    expect(merged[0]?.rc53?.findings).toBe(2);
    expect(merged[1]?.rc53).toBeNull();
    const kept = withRc53(merged, []);
    expect(kept[0]?.rc53?.findings).toBe(2);
  });

  it("composes all four login files, the sign-out, the saves and the switch", () => {
    const credential = {
      generation: 1,
      order: 3,
      createdAt: "2026-10-28T09:00:00.000Z",
      files: {
        ".claude/.credentials.json": { state: "present" },
        ".claude/.device-keys.json": { state: "tombstone" },
        ".codex/auth.json": { state: "present" },
        ".codex/.credentials.json": { state: "tombstone" },
      },
    } as unknown as CredentialManifest;
    const view = composeStatus({
      now: 0,
      supervisor: "ok",
      metrics: METRICS,
      credential,
      signOut: { phase: "tombstoned", running: false },
      saves: [save("op_a", "failed", "upload")],
      staging: true,
      rc53Desired: true,
    });
    expect(view.credentials.files.map((f) => f.state)).toEqual([
      "present",
      "tombstone",
      "present",
      "tombstone",
    ]);
    expect(view.credentials.checkpoint).toEqual({
      generation: 1,
      order: 3,
      createdAt: "2026-10-28T09:00:00.000Z",
    });
    expect(view.rc53).toEqual({ staging: true, desired: true, applied: true });
    expect(view.saves[0]).toMatchObject({ outcome: "failed", reason: "upload" });
    expect(JSON.stringify(view)).not.toContain("op_a");
    const bare = composeStatus({
      now: 0,
      supervisor: "not_running",
      metrics: null,
      credential: null,
      signOut: { phase: "none", running: false },
      saves: [],
      staging: false,
      rc53Desired: false,
    });
    expect(bare.metrics).toBeNull();
    expect(bare.rc53).toEqual({ staging: false, desired: null, applied: null });
    expect(bare.credentials.files.every((f) => f.state === "none")).toBe(true);
    expect(
      composeStatus({
        ...{
          now: 0,
          supervisor: "ok",
          credential: null,
          signOut: { phase: "none", running: false },
          saves: [],
          staging: false,
          rc53Desired: false,
        },
        metrics: { ...METRICS, disk: null },
      }).metrics?.disk,
    ).toBeNull();
  });

  it("logs names and counts; its signature ignores time and free disk", () => {
    const base = {
      now: 0,
      supervisor: "ok" as const,
      metrics: METRICS,
      credential: null,
      signOut: { phase: "none" as const, running: false },
      saves: [save("op_a", "failed", "upload")],
      staging: false,
      rc53Desired: false,
    };
    const a = statusLog(composeStatus(base));
    const b = statusLog(
      composeStatus({
        ...base,
        now: 99_000,
        metrics: { ...METRICS, disk: { totalBytes: 2e10, freeBytes: 5e9 } },
      }),
    );
    expect(a.signature).toBe(b.signature);
    expect(a.fields).toMatchObject({
      lastSave: { outcome: "failed", reason: "upload" },
      failedSaves: 1,
      alerts: { rc53_finding: 2 },
      diskFreeBytes: 1e10,
    });
    const empty = statusLog(composeStatus({ ...base, metrics: null, saves: [] }));
    expect(empty.fields).toMatchObject({ versions: null, lastSave: null, diskFreeBytes: null });
    expect(empty.signature).not.toBe(a.signature);
  });
});

describe("a staging installation", () => {
  it("is recognized only by the staging tool's variable with its prefix", () => {
    expect(isStagingInstallation("cfo-stg-wp318-platform")).toBe(true);
    expect(isStagingInstallation(undefined)).toBe(false);
    expect(isStagingInstallation("")).toBe(false);
    expect(isStagingInstallation("cfo-stg-")).toBe(false);
    expect(isStagingInstallation("omnigent-platform")).toBe(false);
    expect(isStagingInstallation("cfo-stg-UPPER")).toBe(false);
    expect(isStagingInstallation("true")).toBe(false);
  });
});
