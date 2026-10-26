// What the platform pages show (WP3.5, `pages/view.ts`): the two sign-in cards, statuses, the
// notices (restore, unexpected stop, not saved, size, refused sleeps, outage, replication), the
// removal flow's next step, and what each state offers.
import { type ComputerPageState, OutageRecord, type SetupCard } from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import {
  cardView,
  computerView,
  formatTime,
  minutesSince,
  outageNotices,
  pendingRemoval,
  removalStep,
  replicationNotice,
} from "../../src/pages/view.ts";
import { NEVER_SIGNED_IN, NOW, pageState } from "../support/page-states.ts";

const kinds = (state: Partial<ComputerPageState>) =>
  computerView(pageState(state), NOW).notices.map((n) => n.kind);
const removal = (r: Partial<ComputerPageState["removal"]>) => ({
  removal: {
    state: "pending",
    signOut: "none",
    loginPossiblyLost: false,
    revocationRecorded: false,
    ...r,
  } as ComputerPageState["removal"],
});

describe("the sign-in cards", () => {
  it.each([
    [{ provider: "claude", state: "signed_in" }, "Signed in", "ok", false],
    [{ provider: "codex", state: "saving" }, "Saving the login", "info", false],
    [{ provider: "claude", state: "unknown" }, "Not known now", "info", false],
    [
      { provider: "codex", state: "needs_sign_in", reason: "not_signed_in" },
      "Needs sign-in",
      "warn",
      true,
    ],
    [{ provider: "claude", state: "needs_sign_in" }, "Needs sign-in", "warn", true],
    [
      { provider: "claude", state: "needs_sign_in", reason: "expired" },
      "Sign in again",
      "danger",
      true,
    ],
    [
      { provider: "codex", state: "needs_sign_in", reason: "refused" },
      "Sign in again",
      "danger",
      true,
    ],
  ] as const)("%o is %s", (card, label, tone, open) => {
    const view = cardView(card as SetupCard);
    expect([view.label, view.tone, view.open]).toEqual([label, tone, open]);
    expect(view.title).toBe(card.provider === "claude" ? "Claude" : "Codex");
  });

  it("never shows an unknown login as signed out", () => {
    expect(cardView({ provider: "claude", state: "unknown" }).detail).toContain(
      "not the same as signed out",
    );
  });

  it("reopens only the card whose login expired", () => {
    const view = computerView(
      pageState({
        setupCards: [
          { provider: "claude", state: "signed_in" },
          { provider: "codex", state: "needs_sign_in", reason: "expired" },
        ],
      }),
      NOW,
    );
    expect(view.cards.map((c) => c.open)).toEqual([false, true]);
  });
});

describe("statuses", () => {
  it.each([
    [{}, "Awake", "ok"],
    [{ lifecycle: "provisioned", status: "stopped" }, "Not started yet", "info"],
    [{ lifecycle: "waking", status: "started_no_host" }, "Starting", "info"],
    [{ lifecycle: "restoring", status: "started_no_host" }, "Starting", "info"],
    [{ lifecycle: "start_claimed", status: "start_claimed" }, "Starting Omnigent's host", "info"],
    [
      { lifecycle: "started_no_host", status: "started_no_host" },
      "Starting Omnigent's host",
      "info",
    ],
    [{ lifecycle: "host_refused", status: "host_refused" }, "Not connected to Omnigent", "danger"],
    [{ status: "stopping" }, "Stopping", "info"],
    [{ lifecycle: "stopping", status: "stopping" }, "Stopping", "info"],
    [{ lifecycle: "asleep", status: "stopped" }, "Asleep", "info"],
    [{ lifecycle: "stopped", status: "stopped" }, "Stopped unexpectedly", "warn"],
    [{ lifecycle: "failed", status: "stopped" }, "Failed to start", "danger"],
    [
      { lifecycle: "removal_pending", status: "stopped", ...removal({}) },
      "Removal pending",
      "warn",
    ],
    [{ lifecycle: "removed", status: "stopped" }, "Removed", "info"],
    [{ noContact: true }, "Not connected to Omnigent", "danger"],
    [{ lifecycle: "bogus" as never }, "Unknown", "warn"],
  ] as const)("%o reads %s", (overrides, status, tone) => {
    const view = computerView(pageState(overrides as Partial<ComputerPageState>), NOW);
    expect([view.status, view.statusTone]).toEqual([status, tone]);
  });

  it("names an unnamed computer by its ID", () => {
    expect(computerView(pageState({ hostName: null }), NOW).name).toBe("Computer 01hzy3m8");
  });

  it("lists a new computer as needing setup, and not while it is being removed", () => {
    expect(computerView(pageState({ setupCards: [...NEVER_SIGNED_IN] }), NOW).needsSetup).toBe(
      true,
    );
    expect(computerView(pageState(), NOW).needsSetup).toBe(false);
    expect(
      computerView(pageState({ setupCards: [...NEVER_SIGNED_IN], ...removal({}) }), NOW).needsSetup,
    ).toBe(false);
  });
});

describe("saves (RC-36) and notices", () => {
  it("shows saving, the last save, or none", () => {
    expect(computerView(pageState({ saving: true }), NOW).saving).toBe("Saving…");
    expect(computerView(pageState(), NOW).saving).toBe("Last saved 09:14 UTC");
    expect(computerView(pageState({ lastSavedAt: null }), NOW).saving).toBe("Not saved yet");
  });

  it("shows the restore notice with the checkpoint's time", () => {
    const view = computerView(pageState({ restoredTo: "2026-10-22T08:05:00.000Z" }), NOW);
    expect(view.notices.find((n) => n.kind === "restored")?.text).toBe(
      "Restored to 08:05 UTC; later file changes were lost.",
    );
  });

  it("shows an unexpected stop only while the computer is not running", () => {
    const at = { unexpectedStopAt: "2026-10-21T22:00:00.000Z" };
    expect(kinds({ ...at, lifecycle: "stopped", status: "stopped" })).toContain("unexpected_stop");
    expect(kinds(at)).not.toContain("unexpected_stop");
  });

  it("shows 'not saved for N minutes' when admission closed for it", () => {
    const view = computerView(
      pageState({
        admission: { admitting: false, reason: "not_saved" },
        verifiedAt: "2026-10-22T08:50:00.000Z",
      }),
      NOW,
    );
    expect(view.notices.find((n) => n.kind === "not_saved")?.text).toMatch(
      /^Not saved for 30 minutes: new work is refused/,
    );
    expect(
      computerView(
        pageState({
          admission: { admitting: false, reason: "not_saved" },
          verifiedAt: null,
          lastSavedAt: null,
        }),
        NOW,
      ).notices[0]?.text,
    ).toMatch(/^Not saved: /);
    expect(kinds({ admission: { admitting: false, reason: "stopping" as never } })).not.toContain(
      "not_saved",
    );
  });

  it("warns above the 1.5 GB size budget", () => {
    expect(kinds({ workspaceBytes: 1_600_000_000 })).toContain("size");
    expect(kinds({ workspaceBytes: 1_400_000_000 })).not.toContain("size");
    expect(kinds({ workspaceBytes: null, sizeWarning: true })).toContain("size");
    expect(kinds({ workspaceBytes: null })).not.toContain("size");
  });

  it("offers 'Stop without saving' after three refused sleeps (FH-35), and notes fewer", () => {
    const three = computerView(pageState({ refusedSleeps: 3 }), NOW);
    expect(three.offerStopWithoutSaving).toBe(true);
    expect(three.notices.find((n) => n.kind === "sleeps_refused")?.tone).toBe("warn");
    expect(
      computerView(pageState({ stopWithoutSavingOffered: true, refusedSleeps: 3 }), NOW)
        .offerStopWithoutSaving,
    ).toBe(true);
    const one = computerView(pageState({ refusedSleeps: 1 }), NOW);
    expect(one.offerStopWithoutSaving).toBe(false);
    expect(one.notices[0]?.text).toContain("The last sleep was refused");
    expect(computerView(pageState({ refusedSleeps: 2 }), NOW).notices[0]?.text).toContain(
      "2 sleeps were",
    );
    expect(
      computerView(pageState({ refusedSleeps: 3, lifecycle: "asleep", status: "stopped" }), NOW)
        .offerStopWithoutSaving,
    ).toBe(false);
  });

  it("shows a failed start and a pending removal", () => {
    expect(kinds({ lifecycle: "failed", status: "stopped" })).toContain("start_failed");
    expect(kinds({ ...removal({}) })).toContain("removal_pending");
  });

  it("shows the size that applies at the next start", () => {
    expect(computerView(pageState({ nextSize: "standard-3" }), NOW).size).toBe(
      "standard-2 (standard-3 from the next start)",
    );
    expect(computerView(pageState({ nextSize: "standard-2" }), NOW).size).toBe("standard-2");
  });
});

describe("not connected to Omnigent (FH-30, FH-31, FH-29)", () => {
  it("after an hour without a launcher call: a restart with its warning, and removal", () => {
    const view = computerView(pageState({ noContact: true }), NOW);
    expect(view).toMatchObject({ notConnected: true, offerRestart: true, offerRemove: true });
    expect(view.notices[0]?.text).toContain(
      "Omnigent has not called this computer since 09:19 UTC",
    );
    expect(
      computerView(pageState({ noContact: true, lastContactAt: null }), NOW).notices[0]?.text,
    ).toContain("since it was added");
  });

  it("when its host's token was refused: a restart, but no removal", () => {
    const view = computerView(
      pageState({ lifecycle: "host_refused", status: "host_refused" }),
      NOW,
    );
    expect(view).toMatchObject({ notConnected: true, offerRestart: true, offerRemove: false });
  });

  it("an asleep computer Omnigent no longer calls is offered for removal, not a restart", () => {
    const view = computerView(
      pageState({ noContact: true, lifecycle: "asleep", status: "stopped" }),
      NOW,
    );
    expect(view).toMatchObject({ offerRestart: false, offerRemove: true });
  });

  it("nothing is offered while a removal is pending", () => {
    const view = computerView(pageState({ noContact: true, ...removal({}) }), NOW);
    expect(view).toMatchObject({ notConnected: false, offerRestart: false, offerRemove: false });
  });
});

describe("the removal flow (design, Signing in, Removal)", () => {
  it.each([
    [{}, "sign_out"],
    [{ status: "stopping" }, "delete_then_sign_out"],
    [{ lifecycle: "asleep", status: "stopped" }, "delete_then_sign_out"],
    [{ setupCards: [...NEVER_SIGNED_IN] }, "delete"],
    [
      {
        removal: {
          state: "none",
          signOut: "requested",
          loginPossiblyLost: false,
          revocationRecorded: false,
        },
      },
      "signing_out",
    ],
    [
      {
        removal: {
          state: "none",
          signOut: "tombstoned",
          loginPossiblyLost: false,
          revocationRecorded: false,
        },
      },
      "delete",
    ],
    [
      {
        removal: {
          state: "none",
          signOut: "verified",
          loginPossiblyLost: false,
          revocationRecorded: false,
        },
      },
      "delete",
    ],
    [removal({}), "pending"],
    [
      {
        removal: {
          state: "resolved",
          signOut: "verified",
          loginPossiblyLost: false,
          revocationRecorded: false,
        },
      },
      "resolved",
    ],
    [{ lifecycle: "removed" }, "resolved"],
  ] as const)("%o → %s", (overrides, step) => {
    expect(removalStep(pageState(overrides as Partial<ComputerPageState>))).toBe(step);
  });

  it("a pending removal needs a sign-out while a login may be saved (P4)", () => {
    expect(pendingRemoval(pageState())).toBeNull();
    expect(pendingRemoval(pageState(removal({})))).toEqual({
      signOut: true,
      recordRevocation: false,
      resolvable: false,
    });
    expect(
      pendingRemoval(
        pageState({
          ...removal({}),
          setupCards: [
            { provider: "claude", state: "unknown" },
            { provider: "codex", state: "unknown" },
          ],
        }),
      ),
    ).toEqual({
      signOut: true,
      recordRevocation: false,
      resolvable: false,
    });
    expect(pendingRemoval(pageState(removal({ signOut: "tombstoned" })))).toEqual({
      signOut: false,
      recordRevocation: false,
      resolvable: true,
    });
    expect(pendingRemoval(pageState({ ...removal({}), setupCards: [...NEVER_SIGNED_IN] }))).toEqual(
      {
        signOut: false,
        recordRevocation: false,
        resolvable: true,
      },
    );
  });

  it("a possibly lost login needs the owner's revocation record before it resolves (P5)", () => {
    expect(
      pendingRemoval(pageState(removal({ signOut: "verified", loginPossiblyLost: true }))),
    ).toEqual({
      signOut: false,
      recordRevocation: true,
      resolvable: false,
    });
    expect(
      pendingRemoval(
        pageState(
          removal({ signOut: "verified", loginPossiblyLost: true, revocationRecorded: true }),
        ),
      ),
    ).toEqual({
      signOut: false,
      recordRevocation: false,
      resolvable: true,
    });
  });
});

describe("outage and replication notices (FH-06, FH-15)", () => {
  const outage = (
    endedAt: string | null,
    cause = "not_answering",
    exitCode: number | null = null,
  ): OutageRecord =>
    OutageRecord.parse({
      outageId: "out_01hzy4a7b8c9d0e1f2g3h4j5k6",
      cause: "not_answering",
      startedAt: "2026-10-22T03:00:00.000Z",
      detectedAt: "2026-10-22T03:00:30.000Z",
      endedAt,
      restarts: 1,
      exitCode,
    }) &&
    ({
      outageId: "out_01hzy4a7b8c9d0e1f2g3h4j5k6",
      cause,
      startedAt: "2026-10-22T03:00:00.000Z",
      detectedAt: "2026-10-22T03:00:30.000Z",
      endedAt,
      restarts: 1,
      exitCode,
    } as OutageRecord);
  const END = "2026-10-22T03:12:00.000Z";

  it("shows each outage's interval", () => {
    expect(outageNotices([outage(END)], NOW)[0]?.text).toBe(
      "Omnigent was unavailable from 03:00 UTC to 03:12 UTC; scheduled runs due then may not have run.",
    );
    expect(outageNotices([outage(null)], NOW)[0]?.text).toContain(
      "has been unavailable since 03:00 UTC",
    );
    expect(outageNotices([outage(END, "container_stopped")], NOW)[0]?.kind).toBe("outage");
  });

  it("says why for a configuration change (config_changed, G2-SEC-001) and recovery mode", () => {
    expect(outageNotices([outage(END, "config_changed")], NOW)[0]?.text).toBe(
      "Omnigent restarted to apply a configuration change. It was unavailable from 03:00 UTC to 03:12 UTC; scheduled runs due then may not have run.",
    );
    expect(outageNotices([outage(null, "config_changed")], NOW)[0]?.text).toContain(
      "Omnigent is restarting to apply a configuration change (since 03:00 UTC)",
    );
    const recovering = outageNotices([outage(null, "recovery_mode")], NOW)[0]?.text;
    expect(recovering).toContain("recovery mode since 03:00 UTC");
    expect(recovering).toContain(
      "A configuration change released meanwhile is applied once recovery ends.",
    );
    expect(outageNotices([outage(END, "recovery_mode")], NOW)[0]?.text).toContain(
      "was in recovery mode from 03:00 UTC to 03:12 UTC",
    );
  });

  it("says when the server stopped without confirming its last changes reached the replica", () => {
    expect(outageNotices([outage(END, "container_stopped", 75)], NOW)[0]?.text).toContain(
      "without confirming that every change reached the replica",
    );
    expect(outageNotices([outage(END, "container_stopped", 0)], NOW)[0]?.text).not.toContain(
      "replica",
    );
  });

  it("warns while replication lags, fails or cannot be checked, and not while it runs", () => {
    const at = "2026-10-22T09:15:00.000Z";
    expect(
      replicationNotice({ state: "replicating", lastSyncAt: at, checkedAt: at }, NOW),
    ).toBeNull();
    expect(
      replicationNotice({ state: "lagging", lastSyncAt: at, checkedAt: at }, NOW)?.text,
    ).toContain("last copied 09:15 UTC");
    expect(
      replicationNotice({ state: "lagging", lastSyncAt: null, checkedAt: at }, NOW)?.text,
    ).toContain("replica is behind.");
    expect(
      replicationNotice({ state: "failing", lastSyncAt: null, checkedAt: at }, NOW)?.tone,
    ).toBe("danger");
    expect(
      replicationNotice({ state: "unknown", lastSyncAt: null, checkedAt: at }, NOW)?.tone,
    ).toBe("warn");
    expect(replicationNotice(null, NOW)?.text).toContain("could not be checked");
  });
});

describe("times", () => {
  it("formats today's times without the date, others with it, in UTC", () => {
    expect(formatTime("2026-10-22T09:05:00.000Z", NOW)).toBe("09:05 UTC");
    expect(formatTime("2026-10-21T23:59:00.000Z", NOW)).toBe("21 Oct 23:59 UTC");
    expect(minutesSince("2026-10-22T09:19:59.000Z", NOW)).toBe(1);
  });
});
