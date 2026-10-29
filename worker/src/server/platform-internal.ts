// `platform.internal`, the virtual host only the server container reaches (design: "Internal
// bridges"). OmnigentServer registers the `PlatformInternal` entrypoint for it before every start
// and in every new instance; no other container gets it. The entrypoint, which serves the
// launcher API (WP3.3) and core change 19's key service (WP5.9), each with its own HMAC checks,
// is in `internal/entrypoints.ts`. These are the registration's constants.

export { PLATFORM_INTERNAL_HOST } from "@cfo/contracts";

/** Intercept props carry a version (R-26): a running container keeps props an older build wrote. */
export const PLATFORM_INTERNAL_PROPS_VERSION = 1;

export interface PlatformInternalProps {
  readonly propsVersion: number;
  /** Who the intercept was registered for. Only the server is. */
  readonly caller: "omnigent-server";
}

/** Whether `props` are the server's own, of a version this code knows. */
export function isServerProps(props: unknown): props is PlatformInternalProps {
  const p = props as Partial<PlatformInternalProps> | null | undefined;
  return (
    typeof p === "object" &&
    p !== null &&
    p.caller === "omnigent-server" &&
    p.propsVersion === PLATFORM_INTERNAL_PROPS_VERSION
  );
}
