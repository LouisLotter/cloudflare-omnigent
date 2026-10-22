// What the platform Worker passes into the server container's environment. Pure.
//
// The server container holds only what Omnigent and its image need (code-structure plan,
// principle 4): its cookie secret, the bootstrap credentials until the owner is durable, the
// replica's bucket-scoped credentials, and the HMAC keys for `platform.internal`. Nothing is
// forwarded by accident: only Worker variables and secrets named `SERVER_ENV_<NAME>` reach the
// container, as `<NAME>`. The server image (WP2.3) and the installer (WP2.4) choose the names.

import { InstallationId } from "@cfo/contracts";

export const SERVER_ENV_PREFIX = "SERVER_ENV_";

/** The bootstrap password, in the form the Worker holds it. While it exists, it is logged as present. */
export const BOOTSTRAP_PASSWORD_SECRET = `${SERVER_ENV_PREFIX}OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD`;

/** Set by the platform itself; a `SERVER_ENV_` variable of the same name is ignored. */
export const PLATFORM_SET_NAMES: ReadonlySet<string> = new Set(["CFO_INSTALLATION_ID"]);

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_VALUE_BYTES = 32 * 1024;

export interface ServerEnv {
  readonly vars: Readonly<Record<string, string>>;
  /** Names left out, with the reason. Never values. */
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

/**
 * The container's environment from the Worker's: every `SERVER_ENV_<NAME>` string, plus the
 * installation ID from `CFO_INSTALLATION_ID` when it is valid.
 */
export function serverContainerEnv(env: Readonly<Record<string, unknown>>): ServerEnv {
  const vars: Record<string, string> = {};
  const skipped: { name: string; reason: string }[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(SERVER_ENV_PREFIX)) continue;
    const name = key.slice(SERVER_ENV_PREFIX.length);
    if (!NAME.test(name)) skipped.push({ name: key, reason: "invalid name" });
    else if (PLATFORM_SET_NAMES.has(name))
      skipped.push({ name: key, reason: "set by the platform" });
    else if (typeof value !== "string") skipped.push({ name: key, reason: "not a string" });
    else if (value.includes("\0")) skipped.push({ name: key, reason: "contains NUL" });
    else if (new TextEncoder().encode(value).byteLength > MAX_VALUE_BYTES) {
      skipped.push({ name: key, reason: "too long" });
    } else vars[name] = value;
  }
  const installation = InstallationId.safeParse(env.CFO_INSTALLATION_ID);
  if (installation.success) vars.CFO_INSTALLATION_ID = installation.data;
  else if (env.CFO_INSTALLATION_ID !== undefined) {
    skipped.push({ name: "CFO_INSTALLATION_ID", reason: "invalid installation ID" });
  }
  return { vars, skipped };
}

/** Whether the bootstrap password is still configured: until the owner is durable, it should be. */
export function bootstrapSecretPresent(env: Readonly<Record<string, unknown>>): boolean {
  const value = env[BOOTSTRAP_PASSWORD_SECRET];
  return typeof value === "string" && value.length > 0;
}

/** A set value the watchdog cannot read as the image does: assume a long one, never a short one. */
const UNREAD_SECONDS = 3600;

/** Unicode decimal digits as ASCII, as Python's `float` reads them ("９００", "٩٠٠" → "900"). */
function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    // Unicode lays decimal digits out in runs of ten, zero first: the digit is its distance
    // from the start of its run, modulo ten.
    let start = code;
    while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
    return String((code - start) % 10);
  });
}

/**
 * A number of seconds from a `SERVER_ENV_` setting, read as the image reads it (WP2.3's
 * `parse_seconds`: Python's `float`, so `900`, `900.0`, `9e2`, `9_00` and `９００` are all 900).
 * Unset: the image's default. Set but not readable here: a long value, so the grace is never
 * shorter than the image's own; if the image cannot read it either, it exits 78 and the
 * watchdog holds it (Codex WP2.2 r3-3, r4-1).
 */
function seconds(env: Readonly<Record<string, unknown>>, name: string, fallback: number): number {
  const raw = env[`${SERVER_ENV_PREFIX}${name}`];
  if (raw === undefined) return fallback;
  if (typeof raw !== "string") return Math.max(fallback, UNREAD_SECONDS);
  const text = asciiDigits(raw.trim()).replace(/(?<=\d)_(?=\d)/g, "");
  if (!/^[+]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
    return Math.max(fallback, UNREAD_SECONDS);
  }
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : Math.max(fallback, UNREAD_SECONDS);
}

/**
 * The entrypoint's database check after a restore (`PRAGMA integrity_check`) has no deadline of
 * its own: it reads the whole file. Measured at 1 GB: 71 s on `basic` (its disk and a quarter
 * CPU), 1 s on `standard-1` (WP2.5); this allowance covers it at the supported size (WP2.6).
 */
export const DATABASE_CHECK_ALLOWANCE_S = 120;

/**
 * The server image's own deadlines, from the settings it reads (WP2.3), for the watchdog:
 * - the boot and restore may take `CFO_RESTORE_DEADLINE_S` (300), then the database check
 *   (`DATABASE_CHECK_ALLOWANCE_S`), then Litestream's start (`CFO_LITESTREAM_READY_TIMEOUT_S`,
 *   60), with a minute's margin;
 * - a stop may take about twice `CFO_FINAL_SYNC_TIMEOUT_S` (300) while R2 is down: the
 *   entrypoint's confirmation, then Litestream's own retry, with a minute's margin.
 */
export function serverDeadlines(env: Readonly<Record<string, unknown>>): {
  restoreWaitMs: number;
  stopGraceMs: number;
} {
  const restore = seconds(env, "CFO_RESTORE_DEADLINE_S", 300);
  const ready = seconds(env, "CFO_LITESTREAM_READY_TIMEOUT_S", 60);
  const finalSync = seconds(env, "CFO_FINAL_SYNC_TIMEOUT_S", 300);
  return {
    restoreWaitMs: Math.ceil((restore + DATABASE_CHECK_ALLOWANCE_S + ready + 60) * 1000),
    stopGraceMs: Math.ceil((2 * finalSync + 60) * 1000),
  };
}

/**
 * A fingerprint of the container's configuration: after an exit 78, the watchdog starts the
 * server again only once this changes. A digest, stored, never logged.
 */
export async function configFingerprint(vars: Readonly<Record<string, string>>): Promise<string> {
  const text = JSON.stringify(Object.entries(vars).sort(([a], [b]) => a.localeCompare(b)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
