import { z } from "zod";
import {
  CliLoginStatus,
  CliVersion,
  HostnameState,
  Rc53Counts,
  SignInAttempt,
  SignInCode,
  SignInFailure,
  SignInLink,
  SignInNotice,
  SignInService,
  SignInState,
  SignInUserCode,
  SupervisorAlertKind,
} from "./computer-protocol.ts";
import { ComputerId, Generation, OperationId, Timestamp } from "./ids.ts";
import { DeclaredCredentialPath } from "./manifests.ts";

// The platform pages (WP3.5): what the web Worker's pages send to WorkspaceDO beyond the
// controller's own `PagesCall`, and the setup terminal's stream. WorkspaceDO's page front
// (`worker/src/computer/page-front.ts`) answers these itself and checks every mutating page call
// before the controller sees it:
//   - each carries the admitted owner (ingress's pinned `sub` and Access session ID) and the
//     page's request-intent token, which the front compares in constant time with the one it
//     derives for that session from a secret stored in the computer's WorkspaceDO (design,
//     Platform pages, "State changes"; P1);
//   - a terminal capability is bound to the owner, the session, its purpose, the computer and its
//     generation, and the terminal window (R-29); it is used once, within a short handshake time,
//     and never travels in a URL.
// The same versioning rules as the controllers' RPC apply: additive only, unknown fields
// tolerated, and a newer `interfaceVersion` refused.

/** The setup terminal's container port: ttyd, started by the supervisor after both restores. */
export const TERMINAL_PORT = 7681;
/** ttyd's WebSocket path and subprotocol (ttyd 1.7.7). */
export const TERMINAL_WS_PATH = "/ws";
export const TERMINAL_SUBPROTOCOL = "tty";
/**
 * The browser offers its capability as a second WebSocket subprotocol,
 * `cfo-capability.<value>`, so it stays out of URLs, cookies and logs. The web Worker takes it out
 * and answers with `tty` alone.
 */
export const CAPABILITY_SUBPROTOCOL_PREFIX = "cfo-capability.";
/** The header the web Worker's upgrade to WorkspaceDO's `fetch` carries (`TerminalUpgrade`). */
export const TERMINAL_UPGRADE_HEADER = "x-cfo-terminal";

/** A capability value: 32 random bytes, base64url without padding. */
export const TerminalCapability = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export type TerminalCapability = z.infer<typeof TerminalCapability>;

/** A request-intent token: 32 bytes, lowercase hex. */
export const IntentToken = z.string().regex(/^[0-9a-f]{64}$/);
export type IntentToken = z.infer<typeof IntentToken>;

/** Who ingress admitted (WP2.1): the pinned owner's Access `sub` and the Access session's ID. */
export const PageOwner = z.looseObject({
  sub: z.string().min(1).max(256),
  sessionId: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PageOwner = z.infer<typeof PageOwner>;

/** The purposes a capability may name. Version 1 has the setup terminal only. */
export const CapabilityPurpose = z.enum(["setup_terminal"]);
export type CapabilityPurpose = z.infer<typeof CapabilityPurpose>;

/** A terminal window: opened by the owner, closed by them, at its deadline, or by WorkspaceDO. */
export const TerminalWindow = z.looseObject({
  /** Counts up per computer; an upgrade under an older window is refused. */
  window: z.number().int().min(0),
  open: z.boolean(),
  /** The computer generation the window was opened for. */
  generation: Generation.nullable(),
  /** The window's hard deadline. */
  until: Timestamp.nullable(),
  /** Streams bridged now. */
  streams: z.number().int().min(0),
});
export type TerminalWindow = z.infer<typeof TerminalWindow>;

const front = {
  interfaceVersion: z.number().int().min(1),
  operationId: OperationId,
  owner: PageOwner,
  intent: IntentToken,
};

/** What the page front answers itself. Every one is a state change behind a page POST. */
export const PageFrontCall = z.discriminatedUnion("action", [
  /**
   * Opens a terminal window (`window: null`) and issues a capability for it, or issues a fresh
   * capability for the open window `window` (a reconnect, FH-38). A repeated operation ID opens no
   * second window: it issues a fresh capability for the window that operation opened, if it is
   * still open.
   */
  z.looseObject({
    action: z.literal("open_terminal"),
    ...front,
    window: z.number().int().min(0).nullable(),
  }),
  /** Closes the open window and every stream in it. */
  z.looseObject({ action: z.literal("close_terminal"), ...front }),
  /**
   * Records a removal intent, as Omnigent's `terminate` does, for a computer Omnigent no longer
   * calls (FH-29, FH-31): offered only while the page shows it as not connected to Omnigent.
   */
  z.looseObject({ action: z.literal("remove"), ...front }),
  // Sign-in from the page (WP3.23). Each attempt is bound to the computer, its generation, the
  // service and the Access session that started it (the caller's `owner`); input and cancel act
  // only on that attempt, and only from that session. A repeated operation ID returns the same
  // attempt. The pasted code travels in this call only: it is never journaled or stored.
  /**
   * Starts a sign-in attempt; ends the service's earlier attempt. `generation`: the computer's
   * generation the page was showing; a start for any other is refused (Codex WP3.23 r1-2).
   */
  z.looseObject({
    action: z.literal("sign_in_start"),
    ...front,
    service: SignInService,
    generation: Generation,
  }),
  /** Claude: the code the person pastes, for the attempt's CLI. */
  z.looseObject({
    action: z.literal("sign_in_input"),
    ...front,
    service: SignInService,
    attempt: SignInAttempt,
    code: SignInCode,
  }),
  /** Ends the attempt, including one whose start has not reached the computer yet. */
  z.looseObject({
    action: z.literal("sign_in_cancel"),
    ...front,
    service: SignInService,
    attempt: SignInAttempt,
  }),
  /** Staging only: the RC-53 save check's desired state, applied in every generation. */
  z.looseObject({ action: z.literal("staging_check"), ...front, rc53: z.boolean() }),
  /**
   * Staging only (WP3.27): keep the computer awake, for a soak. While it is on, WorkspaceDO refuses
   * Omnigent's `suspend` as it does for an open terminal, in every generation, until it is turned
   * off. Persisted.
   */
  z.looseObject({ action: z.literal("staging_keep_awake"), ...front, on: z.boolean() }),
]);
export type PageFrontCall = z.infer<typeof PageFrontCall>;

export const TerminalRefusal = z.enum([
  /** No restored container runs: asleep, stopped, starting or restoring. */
  "not_running",
  /** A stop or a sign-out is being prepared. */
  "busy",
  /** A removal is pending or resolved. */
  "not_offered",
  /** A reconnect named a window that is closed, expired or not the current one. */
  "window_closed",
]);
export type TerminalRefusal = z.infer<typeof TerminalRefusal>;

/**
 * Why the page cannot start or continue a sign-in now:
 * - `not_running`: the computer is asleep, starting or stopped;
 * - `busy`: it is stopping or signing out;
 * - `not_offered`: a removal is pending or resolved;
 * - `unsupported`: its supervisor predates page sign-in: the page offers the terminal;
 * - `not_yours`: the attempt was started from another browser session;
 * - `stale`: the attempt ended, was replaced, or belongs to an earlier start of the computer;
 * - `unreachable`: the computer did not answer.
 */
export const SignInRefusal = z.enum([
  "not_running",
  "busy",
  "not_offered",
  "unsupported",
  "not_yours",
  "stale",
  "unreachable",
]);
export type SignInRefusal = z.infer<typeof SignInRefusal>;

/** An attempt as the page sees it: the supervisor's view, read now (`SignInView`). */
export const PageSignInView = z.looseObject({
  service: SignInService,
  attempt: SignInAttempt,
  state: SignInState,
  url: SignInLink.optional(),
  userCode: SignInUserCode.optional(),
  reason: SignInFailure.optional(),
  notice: SignInNotice.optional(),
  /** The platform's deadline for the attempt. */
  deadline: Timestamp.optional(),
  /**
   * The attempt has ended here, but the computer has not yet confirmed that its CLI stopped (a
   * cancel not yet answered, or a deadline just passed). The page waits before offering the
   * terminal (Codex WP3.23 r1-6).
   */
  pending: z.literal(true).optional(),
});
export type PageSignInView = z.infer<typeof PageSignInView>;

const signInOutcome = (action: string) =>
  z.discriminatedUnion("outcome", [
    z.looseObject({
      action: z.literal(action),
      outcome: z.literal("accepted"),
      view: PageSignInView,
    }),
    z.looseObject({
      action: z.literal(action),
      outcome: z.literal("refused"),
      reason: SignInRefusal,
    }),
  ]);

export const PageFrontResult = z.discriminatedUnion("action", [
  z.discriminatedUnion("outcome", [
    z.looseObject({
      action: z.literal("open_terminal"),
      outcome: z.literal("accepted"),
      capability: TerminalCapability,
      window: z.number().int().min(1),
      generation: Generation,
      /** The window's hard deadline: the stream is closed then. */
      until: Timestamp,
      /** The capability must be presented by then (a short handshake time). */
      presentBy: Timestamp,
    }),
    z.looseObject({
      action: z.literal("open_terminal"),
      outcome: z.literal("refused"),
      reason: TerminalRefusal,
    }),
  ]),
  z.looseObject({ action: z.literal("close_terminal"), closed: z.boolean() }),
  z.discriminatedUnion("outcome", [
    z.looseObject({ action: z.literal("remove"), outcome: z.literal("accepted") }),
    z.looseObject({
      action: z.literal("remove"),
      outcome: z.literal("refused"),
      reason: z.enum(["not_offered", "busy"]),
    }),
  ]),
  signInOutcome("sign_in_start"),
  signInOutcome("sign_in_input"),
  signInOutcome("sign_in_cancel"),
  z.discriminatedUnion("outcome", [
    z.looseObject({
      action: z.literal("staging_check"),
      outcome: z.literal("accepted"),
      rc53: z.boolean(),
    }),
    z.looseObject({
      action: z.literal("staging_check"),
      outcome: z.literal("refused"),
      /** `not_staging`: a production installation never has the switch. */
      reason: z.enum(["not_staging", "not_offered"]),
    }),
  ]),
  z.discriminatedUnion("outcome", [
    z.looseObject({
      action: z.literal("staging_keep_awake"),
      outcome: z.literal("accepted"),
      on: z.boolean(),
    }),
    z.looseObject({
      action: z.literal("staging_keep_awake"),
      outcome: z.literal("refused"),
      /** `not_staging`: a production installation never has the switch. */
      reason: z.enum(["not_staging", "not_offered"]),
    }),
  ]),
]);
export type PageFrontResult = z.infer<typeof PageFrontResult>;

// ---------------------------------------------------------------------------------------------
// Reads (WP3.23). Behind a page GET: they change nothing, so they carry no intent token, but they
// name the admitted owner, and a sign-in attempt is shown only to the session that started it.

/** A final save outcome, as WorkspaceDO recorded it. */
export const SaveFailureReason = z.enum([
  "lease_expired",
  "disk_budget",
  "copy_failed",
  "stage_failed",
  "parent_mismatch",
  "policy_violation",
  "busy",
  "upload",
  "deadline",
  "parent_changed",
  "internal",
]);
export type SaveFailureReason = z.infer<typeof SaveFailureReason>;

export const SaveOutcome = z.looseObject({
  at: Timestamp,
  generation: Generation,
  outcome: z.enum(["published", "unchanged", "discarded", "failed"]),
  reason: SaveFailureReason.nullable(),
  kind: z.enum(["base", "delta"]).nullable(),
  /** RC-53's counts for this save's capture, when the check ran and the computer reported them. */
  rc53: Rc53Counts.nullable(),
});
export type SaveOutcome = z.infer<typeof SaveOutcome>;

/**
 * The setup page's "Computer status", composed by WorkspaceDO (the design review's revision 3):
 * the supervisor's metrics read now, the published credential manifest, the sign-out phase, its
 * own history of final save outcomes and the RC-53 switch. Names, versions, enum states and
 * counts only.
 */
export const ComputerStatusView = z.looseObject({
  observedAt: Timestamp,
  /** The supervisor's part: `ok` when it answered now; otherwise why it is missing. */
  supervisor: z.enum(["ok", "not_running", "unreachable", "unsupported"]),
  metrics: z
    .looseObject({
      supervisorVersion: z.string().max(64),
      versions: z.looseObject({
        claude: CliVersion.nullable(),
        codex: CliVersion.nullable(),
        gh: CliVersion.nullable(),
      }),
      logins: z.looseObject({ claude: CliLoginStatus, codex: CliLoginStatus }),
      signIn: z.looseObject({ claude: SignInState, codex: SignInState }),
      rc53: z.boolean(),
      hostname: HostnameState,
      disk: z
        .looseObject({ totalBytes: z.number().int().min(0), freeBytes: z.number().int().min(0) })
        .nullable(),
      alerts: z
        .array(z.looseObject({ kind: SupervisorAlertKind, count: z.number().int().min(0) }))
        .max(32),
    })
    .nullable(),
  /**
   * The published credential checkpoint: each declared file present or tombstoned, or `none`
   * without a checkpoint. A tombstone proves only that the saved checkpoint holds no such file.
   */
  credentials: z.looseObject({
    checkpoint: z
      .looseObject({ generation: Generation, order: z.number().int().min(1), createdAt: Timestamp })
      .nullable(),
    files: z
      .array(
        z.looseObject({
          path: DeclaredCredentialPath,
          state: z.enum(["present", "tombstone", "none"]),
        }),
      )
      .max(8),
  }),
  /**
   * The sign-out's phase: `tombstoned` (the published checkpoint holds tombstones for the logins)
   * and `verified` (a read-back of the stored bundle holds four tombstones). Neither is a restore
   * into a fresh computer, nor proof of revocation at the providers.
   */
  signOut: z.looseObject({
    phase: z.enum(["none", "requested", "tombstoned", "verified"]),
    running: z.boolean(),
  }),
  /** The last final save outcomes, newest first. */
  saves: z.array(SaveOutcome).max(10),
  /** The RC-53 switch: offered on a staging installation only. */
  rc53: z.looseObject({
    staging: z.boolean(),
    /** The switch's persisted, desired state; null off staging. */
    desired: z.boolean().nullable(),
    /** What the supervisor reports now; null if it was not read. */
    applied: z.boolean().nullable(),
  }),
  /**
   * The keep-awake switch (WP3.27): offered on a staging installation only; `on` is null off
   * staging. Absent from an older WorkspaceDO.
   */
  keepAwake: z.looseObject({ staging: z.boolean(), on: z.boolean().nullable() }).optional(),
});
export type ComputerStatusView = z.infer<typeof ComputerStatusView>;

export const PageReadCall = z.discriminatedUnion("action", [
  /** An attempt's state now, for the session that started it. */
  z.looseObject({
    action: z.literal("sign_in_status"),
    interfaceVersion: z.number().int().min(1),
    owner: PageOwner,
    service: SignInService,
    attempt: SignInAttempt,
  }),
  /** The computer's status now. */
  z.looseObject({
    action: z.literal("computer_status"),
    interfaceVersion: z.number().int().min(1),
    owner: PageOwner,
  }),
]);
export type PageReadCall = z.infer<typeof PageReadCall>;

export const PageReadResult = z.discriminatedUnion("action", [
  signInOutcome("sign_in_status"),
  z.looseObject({ action: z.literal("computer_status"), status: ComputerStatusView }),
]);
export type PageReadResult = z.infer<typeof PageReadResult>;

/**
 * The web Worker's upgrade to WorkspaceDO's `fetch`, as JSON in `TERMINAL_UPGRADE_HEADER`. The
 * web Worker builds the request itself after ingress admitted the browser's upgrade with the
 * exact origin: nothing of the browser's other headers reaches WorkspaceDO.
 */
export const TerminalUpgrade = z.looseObject({
  interfaceVersion: z.number().int().min(1),
  computerId: ComputerId,
  owner: PageOwner,
  capability: TerminalCapability,
});
export type TerminalUpgrade = z.infer<typeof TerminalUpgrade>;
