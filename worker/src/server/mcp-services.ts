// Omnigent's MCP registry as the platform reads it (WP5.10). Pure: OmnigentServer uses it for the
// status line the installer's `services` step waits on.
//
// What counts is Omnigent's own answer: `GET /v1/info` lists `mcp` in `enabled_connections`
// exactly when the server passed Omnigent a registry, and that list is what makes Omnigent's
// interface show Settings → MCP. The server image decides whether to build one (images/server,
// cfo_server/mcp.py); the platform never repeats that decision, it only reports Omnigent's.
//
// Which choices a server runs with is told by their revision: a random marker the installer
// writes with every change of the MCP services, in the same secrets change. It reaches the server
// (as `update`'s deploy ID does), so every change changes the server's configuration and the
// watchdog restarts it once and logs its status line under the new configuration: the change's
// proof, even when the values written were the ones held. The image ignores it. Not a secret, and
// no digest of one.
//
// The MCP servers administrators add on Omnigent's own page (WP8.14) are in Omnigent's database,
// which the installer never reads. The server image counts them at each start: how many it
// expects (inside an update's window, those the update's restore point recorded before Omnigent
// first started on the new release), and how many of those Omnigent's registry serves (the
// entrypoint's `GET :8001/status`, `mcpAdminServices`). Inside an update's window the watchdog puts
// both on its status line, so the update can refuse a restart that lost one. Counts only, never a
// name or a URL.

/** The revision of the installation's MCP choices. */
export const MCP_REVISION_ENV = "SERVER_ENV_CFO_MCP_REVISION";

/** A revision as the installer writes it: 16 to 64 lower-case hex digits. */
const REVISION = /^[0-9a-f]{16,64}$/;

/** The revision of the MCP choices this Worker version holds, or null (none, or not ours). */
export function mcpRevisionOf(env: Readonly<Record<string, unknown>>): string | null {
  const value = env[MCP_REVISION_ENV];
  if (typeof value !== "string") return null;
  const revision = value.trim();
  return REVISION.test(revision) ? revision : null;
}

/**
 * Whether Omnigent's `/v1/info` answer lists its MCP registry: true or false, or null when the
 * answer does not say (no `enabled_connections` list: an Omnigent from before it, or no answer).
 */
export function mcpRegistryOf(info: unknown): boolean | null {
  if (info === null || typeof info !== "object" || Array.isArray(info)) return null;
  const list = (info as Record<string, unknown>).enabled_connections;
  if (!Array.isArray(list)) return null;
  return list.includes("mcp");
}

/** The MCP servers added on Omnigent's page at the server's start, as its entrypoint reports them. */
export interface McpAdminServices {
  /** How many the server expects (the restore point's record in a window); null: unknown. */
  readonly stored: number | null;
  /** How many of those Omnigent's registry serves; null: the app has not reported yet. */
  readonly served: number | null;
}

/** The largest count the platform repeats; anything larger is not a count it trusts. */
const MAX_COUNT = 1_000_000;

function count(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_COUNT
    ? value
    : undefined;
}

/**
 * The `mcpAdminServices` member of the entrypoint's `GET /status` (images/server, WP8.14), or null
 * when the answer does not carry one in this form (an image from before it, or no answer).
 */
export function mcpAdminServicesOf(status: unknown): McpAdminServices | null {
  if (status === null || typeof status !== "object" || Array.isArray(status)) return null;
  const member = (status as Record<string, unknown>).mcpAdminServices;
  if (member === null || typeof member !== "object" || Array.isArray(member)) return null;
  const { stored, served } = member as Record<string, unknown>;
  const counts = { stored: count(stored), served: count(served) };
  if (counts.stored === undefined || counts.served === undefined) return null;
  return { stored: counts.stored, served: counts.served };
}
