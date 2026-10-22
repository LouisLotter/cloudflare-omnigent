// `platform.internal`, the virtual host only the server container reaches (design: "Internal
// bridges"). OmnigentServer registers this entrypoint for it before every start and in every new
// instance; no other container gets it. The launcher API and the key service behind it arrive
// with WP3.3 (`internal/platform-api.ts`, `internal/key-service.ts`), which checks each call's
// HMAC. Until then every call is refused before any effect.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { PlatformEnv } from "../env.ts";
import { errorResponse, logEvent } from "./responses.ts";

export const PLATFORM_INTERNAL_HOST = "platform.internal";

/** Intercept props carry a version (R-26): a running container keeps props an older build wrote. */
export const PLATFORM_INTERNAL_PROPS_VERSION = 1;

export interface PlatformInternalProps {
  readonly propsVersion: number;
  /** Who the intercept was registered for. Only the server is. */
  readonly caller: "omnigent-server";
}

export class PlatformInternal extends WorkerEntrypoint<PlatformEnv, PlatformInternalProps> {
  override async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    logEvent("platform_internal", "refused", {
      method: request.method,
      path: new URL(request.url).pathname,
      propsVersion: props?.propsVersion ?? null,
    });
    return errorResponse(503, "unavailable", "This platform service is not available.", false);
  }
}
