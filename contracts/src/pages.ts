import { z } from "zod";
import { ComputerId, Generation, OperationId, Timestamp } from "./ids.ts";

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
]);
export type PageFrontResult = z.infer<typeof PageFrontResult>;

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
