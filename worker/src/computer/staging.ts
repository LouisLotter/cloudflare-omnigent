// Pure: how the platform Worker recognizes a staging installation (WP3.23), for the setup page's
// RC-53 switch, which production must never offer or apply.
//
// The bootstrap (`scripts/bootstrap/settings.ts`, `platformVars`) sets `CFO_STAGING_INSTALLATION`
// to the platform Worker's name for a staging target only, and the staging tool deploys only
// `cfo-stg-` names; an account (production) installation never gets the variable, and its
// Workers may not carry the prefix (the bootstrap refuses them). Both must hold.

/** The staging tool's prefix (`scripts/staging/guard.ts`, STAGING_PREFIX). */
export const STAGING_PREFIX = "cfo-stg-";

export function isStagingInstallation(value: string | undefined): boolean {
  return (
    typeof value === "string" &&
    value.startsWith(STAGING_PREFIX) &&
    value.length > STAGING_PREFIX.length &&
    /^[a-z0-9-]+$/.test(value)
  );
}
