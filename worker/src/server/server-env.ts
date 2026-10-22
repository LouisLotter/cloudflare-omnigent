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
