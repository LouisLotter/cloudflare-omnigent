// Pure rules for staging resources. Every mutation the staging tool performs goes through these.

export const STAGING_PREFIX = "cfo-stg-";
const SUFFIX = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/;

export type ResourceKind = "worker" | "access-app";

export interface StagingResource {
  readonly kind: ResourceKind;
  readonly name: string;
  readonly id?: string;
  readonly hostname?: string;
  readonly owner: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface StagingConfig {
  readonly accountId: string;
  readonly zone: string;
  readonly ownerEmail: string;
  readonly identityProviderId?: string;
}

export function resourceName(suffix: string): string {
  if (!SUFFIX.test(suffix) || suffix.includes("--")) {
    throw new Error(
      `invalid staging suffix "${suffix}": use lowercase letters, digits and single hyphens`,
    );
  }
  const name = `${STAGING_PREFIX}${suffix}`;
  if (name.length > 63) throw new Error(`staging name "${name}" is longer than a DNS label allows`);
  return name;
}

/** Refuses to act on anything the staging tool did not name. */
export function assertManaged(name: string): void {
  if (!name.startsWith(STAGING_PREFIX) || name.length === STAGING_PREFIX.length) {
    throw new Error(`refusing to touch "${name}": not a ${STAGING_PREFIX} staging resource`);
  }
}

export function hostnameFor(name: string, zone: string): string {
  assertManaged(name);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(zone)) throw new Error(`invalid zone "${zone}"`);
  return `${name}.${zone}`;
}

export function assertAccount(expected: string, accessible: readonly string[]): void {
  if (!/^[0-9a-f]{32}$/.test(expected)) throw new Error("staging config has no valid account ID");
  if (!accessible.includes(expected)) {
    throw new Error("the configured staging account is not accessible with the current login");
  }
}

export function expiry(now: Date, lifetimeDays: number): string {
  if (!Number.isInteger(lifetimeDays) || lifetimeDays < 1 || lifetimeDays > 30) {
    throw new Error("lifetime must be 1 to 30 days");
  }
  return new Date(now.getTime() + lifetimeDays * 86_400_000).toISOString();
}

export function expired(resources: readonly StagingResource[], now: Date): StagingResource[] {
  return resources.filter((r) => Date.parse(r.expiresAt) <= now.getTime());
}

/** Teardown order: remove the Worker first, then the Access app that protected it. */
export function teardownOrder(resources: readonly StagingResource[]): StagingResource[] {
  for (const r of resources) assertManaged(r.name);
  const rank = (r: StagingResource) => (r.kind === "worker" ? 0 : 1);
  return [...resources].sort((a, b) => rank(a) - rank(b));
}

/** Owner-only Access application for one staging hostname. */
export function accessAppBody(
  name: string,
  hostname: string,
  config: StagingConfig,
): Record<string, unknown> {
  assertManaged(name);
  if (!hostname.startsWith(`${name}.`))
    throw new Error("hostname does not belong to this resource");
  return {
    type: "self_hosted",
    name,
    domain: hostname,
    session_duration: "24h",
    app_launcher_visible: false,
    ...(config.identityProviderId
      ? { allowed_idps: [config.identityProviderId], auto_redirect_to_identity: true }
      : {}),
    policies: [
      {
        name: "Allow owner",
        decision: "allow",
        include: [{ email: { email: config.ownerEmail } }],
      },
    ],
  };
}
