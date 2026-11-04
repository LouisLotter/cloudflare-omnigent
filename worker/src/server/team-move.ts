// Moving an installation's team of one behind Access (WP8.11). Pure apart from the container
// port the caller passes.
//
// While `bootstrap.ts update --team-admission members` moves the installation, the platform Worker
// holds `CFO_TEAM_MOVE` (the move's ID, never a credential). Like an update's read-only window, it
// keeps the watchdog's status line logged on every check, and the line then carries what the
// installer waits for: the server's identity mode (`bind`, then `required`), the team's binding
// state from the server container (`/_cfo/team-status`: active owners and how many are bound, the
// admission revision, each connected host with what its tunnel's handshake presented) and the
// admission revision this platform last applied to the member group. No line names a person:
// hosts by ID, owners by count.

import {
  signPlatformCall,
  TEAM_STATUS_CALL_PATH,
  type TeamStatusReport,
  TeamStatusReport as TeamStatusReportSchema,
} from "@cfo/contracts";

/** The secret the installer holds while it moves the team; its value is the move's ID. */
export const TEAM_MOVE_SECRET = "CFO_TEAM_MOVE";
/** The server's identity mode, as the container receives it. */
export const IDENTITY_MODE_VAR = "SERVER_ENV_OMNIGENT_EXTERNAL_IDENTITY_MODE";

const MOVE_ID = /^tm-\d{8}T\d{6}Z-[0-9a-f]{8}$/;

/** The move this version holds, or null for none (or a malformed value, which holds nothing). */
export function teamMoveOf(env: Readonly<Record<string, unknown>>): string | null {
  const value = env[TEAM_MOVE_SECRET];
  return typeof value === "string" && MOVE_ID.test(value) ? value : null;
}

/** The identity mode the server is started with: `off` unless `bind` or `required`. */
export function identityModeOf(
  env: Readonly<Record<string, unknown>>,
): "off" | "bind" | "required" {
  const value = env[IDENTITY_MODE_VAR];
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return mode === "bind" || mode === "required" ? mode : "off";
}

/** A move's ID: the UTC second it began and eight random hex digits. */
export function newTeamMoveId(nowMs: number, random: (n: number) => Uint8Array): string {
  const stamp = new Date(nowMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const hex = [...random(4)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `tm-${stamp}-${hex}`;
}

/** Sends one request to the server container's Omnigent port. */
export type ContainerFetch = (request: Request) => Promise<Response>;

/**
 * The server container's team status, through the signed platform call; null when the server
 * does not answer, has no team model (501) or answers something else. Never throws.
 */
export async function readTeamStatus(
  fetchContainer: ContainerFetch,
  cookieSecret: string,
  nowMs: number,
  random: (n: number) => Uint8Array,
): Promise<TeamStatusReport | null> {
  try {
    const nonce = [...random(16)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const body = new TextEncoder().encode(JSON.stringify({ nonce }));
    const headers = await signPlatformCall({
      cookieSecret,
      method: "POST",
      path: TEAM_STATUS_CALL_PATH,
      timestamp: Math.floor(nowMs / 1000),
      body,
    });
    const response = await fetchContainer(
      new Request(`http://omnigent${TEAM_STATUS_CALL_PATH}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body,
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const parsed = TeamStatusReportSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
