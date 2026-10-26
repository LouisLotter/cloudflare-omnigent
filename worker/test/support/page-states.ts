/**
 * Page states for the platform pages' tests (WP3.5): a running, signed-in computer, and helpers
 * to change any field. Synthetic values only.
 */
import type { ComputerId, ComputerPageState, SetupCard } from "@cfo/contracts";

export const PAGE_CMP = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3" as ComputerId;
export const NOW = Date.parse("2026-10-22T09:20:00.000Z");

export const SIGNED_IN: readonly SetupCard[] = [
  { provider: "claude", state: "signed_in" },
  { provider: "codex", state: "signed_in" },
];
export const NEVER_SIGNED_IN: readonly SetupCard[] = [
  { provider: "claude", state: "needs_sign_in", reason: "not_signed_in" },
  { provider: "codex", state: "needs_sign_in", reason: "not_signed_in" },
];

export function pageState(overrides: Partial<ComputerPageState> = {}): ComputerPageState {
  return {
    computerId: PAGE_CMP,
    hostName: "Work computer",
    hostId: "7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f",
    size: "standard-2",
    nextSize: null,
    lifecycle: "host_running",
    status: "host_running",
    generation: 7,
    admission: { admitting: true },
    saving: false,
    lastSavedAt: "2026-10-22T09:14:58.000Z",
    verifiedAt: "2026-10-22T09:14:58.000Z",
    workspaceBytes: 724_000_000,
    lastContactAt: "2026-10-22T09:19:00.000Z",
    lastKeepAliveAt: "2026-10-22T09:10:00.000Z",
    restoredTo: null,
    unexpectedStopAt: null,
    refusedSleeps: 0,
    setupCards: [...SIGNED_IN],
    removal: {
      state: "none",
      signOut: "none",
      loginPossiblyLost: false,
      revocationRecorded: false,
    },
    noContact: false,
    sizeWarning: false,
    stopWithoutSavingOffered: false,
    ...overrides,
  };
}
