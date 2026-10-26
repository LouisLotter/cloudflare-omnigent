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
  /** How many computers may be awake at once (ControlDO, WP3.2): 0 to 1000; unset means 2. */
  readonly CFO_MAX_AWAKE_COMPUTERS?: string;
  /** The largest instance size a computer may start with (ControlDO); unset means `standard-4`. */
  readonly CFO_MAX_INSTANCE_SIZE?: string;
  /** Variables and secrets for the server container: `SERVER_ENV_<NAME>` reaches it as `<NAME>`. */
  readonly [name: `SERVER_ENV_${string}`]: string | undefined;
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
