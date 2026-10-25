// The Env types of the two deployments (AR-17), layered on the generated platform types.

import type { IngressEnv } from "./ingress/index.ts";
import type { OmnigentServer } from "./server/OmnigentServer.ts";

/**
 * The platform Worker's variables and secrets that `wrangler types` cannot see: they are set per
 * installation, never in the repository.
 */
export interface PlatformVars {
  /** This installation's ID, an `InstallationId` (WP2.4). */
  readonly CFO_INSTALLATION_ID?: string;
  /** Variables and secrets for the server container: `SERVER_ENV_<NAME>` reaches it as `<NAME>`.
   * The launcher API verifies with the server's own `SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY` and
   * `…_ID` (WP3.3, `internal/platform-api.ts`). */
  readonly [name: `SERVER_ENV_${string}`]: string | undefined;
  /** The launcher's previous signing key and its ID, set only during a rotation (WP3.3). */
  readonly CFO_LAUNCHER_SIGNING_KEY_PREVIOUS?: string;
  readonly CFO_LAUNCHER_SIGNING_KEY_PREVIOUS_ID?: string;
}

/** The platform Worker (`wrangler.jsonc`): every Durable Object and container class. */
export type PlatformEnv = Env & PlatformVars;

/**
 * The web Worker (`wrangler.web.jsonc`): ingress, the forwarding path and, later, the platform
 * pages. It holds no Durable Object class and reaches the platform Worker's only through
 * cross-script bindings. Written by hand, and checked against `wrangler.web.jsonc` by a test,
 * because `wrangler types` generates one Worker's types per program.
 */
export interface WebEnv extends IngressEnv {
  readonly OMNIGENT: DurableObjectNamespace<OmnigentServer>;
}
