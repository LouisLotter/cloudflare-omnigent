import { z } from "zod";
import type { CliLoginStatus } from "./computer-protocol.ts";
import { type CredentialManifest, LOGIN_FILE } from "./manifests.ts";

// The setup page's two sign-in cards, Claude and Codex (design, Signing in). Derived, never
// stored: from the latest published credential checkpoint, what the supervisor reports, and the
// CLIs' own status commands. Platform code never reads a login file. Unknown state is never shown
// as signed out.

export const SetupProvider = z.enum(["claude", "codex"]);
export type SetupProvider = z.infer<typeof SetupProvider>;

/**
 * - `signed_in`: the latest published credential checkpoint holds this provider's login, and its
 *   CLI does not report it expired or signed out.
 * - `needs_sign_in`: no published login, or the CLI reports it expired or refused; only this
 *   provider's card reopens (UJ8, FH-12).
 * - `saving`: a change to this provider's login is not yet in a published credential checkpoint;
 *   right after a sign-in, or while publication is retried (R-18).
 * - `unknown`: the state cannot be read now (no answer from the computer or the checkpoint).
 */
export const SetupCardState = z.enum(["signed_in", "needs_sign_in", "saving", "unknown"]);
export type SetupCardState = z.infer<typeof SetupCardState>;

export const NeedsSignInReason = z.enum(["not_signed_in", "expired", "refused"]);

export const SetupCard = z.looseObject({
  provider: SetupProvider,
  state: SetupCardState,
  reason: NeedsSignInReason.optional(),
});
export type SetupCard = z.infer<typeof SetupCard>;

export function deriveSetupCard(input: {
  readonly provider: SetupProvider;
  /** The published credential checkpoint; null if none exists; undefined if it can't be read. */
  readonly manifest: CredentialManifest | null | undefined;
  /** A change to this provider's declared files awaits publication. */
  readonly pending: boolean;
  /** The CLI's own status, from the supervisor's latest report; `unknown` while asleep. */
  readonly cli: z.infer<typeof CliLoginStatus>;
}): SetupCard {
  const { provider } = input;
  if (input.manifest === undefined) return { provider, state: "unknown" };
  if (input.pending) return { provider, state: "saving" };
  const login = input.manifest?.files[LOGIN_FILE[provider]];
  if (login?.state !== "present") {
    return { provider, state: "needs_sign_in", reason: "not_signed_in" };
  }
  if (input.cli === "expired") return { provider, state: "needs_sign_in", reason: "expired" };
  if (input.cli === "signed_out") return { provider, state: "needs_sign_in", reason: "refused" };
  return { provider, state: "signed_in" };
}
