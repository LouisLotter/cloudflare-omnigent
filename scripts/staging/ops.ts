// Staging orchestration: deploy, teardown and sweep, written against small ports so that tests
// can drive them with a fake Cloudflare and interrupt them at any step.
//
// The invariant: a staging Worker is never reachable without its owner-only Access application.
//   - Every cloud mutation happens after the deployment's record is saved, and the record is
//     removed only after both resources are gone. An interrupted run leaves a record to finish.
//   - The Worker configuration is checked before the first cloud call (validateDeployConfig).
//   - Access is created, or claimed and checked, before the Worker is deployed.
//   - Teardown removes Access only after Cloudflare confirms that the Worker no longer exists.
//     An unknown answer keeps Access and the record.
//   - Worker and Access share one record and one expiry, so a sweep removes them together.

import {
  type AccessApp,
  accessAppBody,
  assertAccount,
  assertManaged,
  assertOwnerOnly,
  claimAccessApp,
  type DeployConfigView,
  type Deployment,
  expired,
  expiry,
  hostnameFor,
  resourceName,
  type StagingConfig,
  validateDeployConfig,
} from "./guard.ts";

export interface Cloud {
  accountIds(): string[];
  /** The Access applications on exactly this hostname. */
  listAccessApps(hostname: string): AccessApp[];
  /** Returns the new application's ID. */
  createAccessApp(body: Record<string, unknown>): string;
  deleteAccessApp(id: string): void;
  /** True or false only when Cloudflare answered; throws when the answer is unknown. */
  workerExists(name: string): boolean;
  deployWorker(name: string, hostname: string, configPath: string): void;
  deleteWorker(name: string): void;
}

export interface Store {
  load(): Deployment[];
  save(deployments: readonly Deployment[]): void;
}

export interface Context {
  readonly config: StagingConfig;
  readonly cloud: Cloud;
  readonly store: Store;
  readonly readConfig: (path: string) => DeployConfigView;
  readonly now: () => Date;
  readonly log: (message: string) => void;
}

export interface DeployRequest {
  readonly suffix: string;
  readonly owner: string;
  readonly configPath: string;
  readonly days: number;
}

function put(ctx: Context, deployment: Deployment): Deployment {
  const others = ctx.store.load().filter((d) => d.name !== deployment.name);
  ctx.store.save([...others, deployment]);
  return deployment;
}

function remove(ctx: Context, name: string): void {
  ctx.store.save(ctx.store.load().filter((d) => d.name !== name));
}

export function deploy(ctx: Context, request: DeployRequest): Deployment {
  const name = resourceName(request.suffix);
  const hostname = hostnameFor(name, ctx.config.zone);
  // Local checks first: nothing below runs for a configuration that could open another route.
  validateDeployConfig(ctx.readConfig(request.configPath));
  const now = ctx.now();
  const expiresAt = expiry(now, request.days);
  const existing = ctx.store.load().find((d) => d.name === name);
  if (existing?.state === "deleting") {
    throw new Error(`${name} is being torn down; run teardown --suffix ${request.suffix} first`);
  }
  if (existing && existing.owner !== request.owner) {
    throw new Error(`${name} belongs to ${existing.owner}, not ${request.owner}`);
  }
  if (existing && existing.hostname !== hostname) {
    throw new Error(`${name} is recorded at ${existing.hostname}; tear it down first`);
  }
  assertAccount(ctx.config.accountId, ctx.cloud.accountIds());

  // The record exists before anything is created, and one expiry covers both resources.
  let record = put(ctx, {
    ...(existing ?? { name, hostname, owner: request.owner, createdAt: now.toISOString() }),
    expiresAt,
    state: "pending",
  });

  // Access before the Worker: the hostname never serves traffic without the owner-only gate.
  const app = claimAccessApp(ctx.cloud.listAccessApps(hostname), record);
  if (app) {
    assertOwnerOnly(app, hostname, ctx.config.ownerEmail);
    if (record.accessAppId !== app.id) record = put(ctx, { ...record, accessAppId: app.id });
  } else {
    const id = ctx.cloud.createAccessApp(accessAppBody(name, hostname, ctx.config));
    record = put(ctx, { ...record, accessAppId: id });
    ctx.log(`created Access application for ${hostname}`);
  }

  // If this throws, the record stays pending: the Worker may exist, and teardown or a later
  // deploy reconciles it.
  ctx.cloud.deployWorker(name, hostname, request.configPath);
  record = put(ctx, { ...record, state: "deployed" });
  ctx.log(`deployed ${name} at https://${hostname} (expires ${expiresAt})`);
  return record;
}

export function teardown(ctx: Context, name: string): void {
  assertManaged(name);
  const found = ctx.store.load().find((d) => d.name === name);
  if (!found) throw new Error(`no recorded deployment named ${name}`);
  assertAccount(ctx.config.accountId, ctx.cloud.accountIds());
  const record = put(ctx, { ...found, state: "deleting" });

  if (ctx.cloud.workerExists(name)) {
    let failure: unknown;
    try {
      ctx.cloud.deleteWorker(name);
    } catch (error) {
      // The delete may still have taken effect; the check below decides.
      failure = error;
    }
    if (ctx.cloud.workerExists(name)) {
      throw new Error(`${name}: the Worker still exists, so its Access application was kept`, {
        cause: failure,
      });
    }
  }

  // The Worker is confirmed absent. Remove the Access application the record points to, or, if
  // an interrupted deploy never recorded its ID, the one carrying this deployment's name.
  for (const app of ctx.cloud.listAccessApps(record.hostname)) {
    if (app.domain !== record.hostname) continue;
    const ours = record.accessAppId ? app.id === record.accessAppId : app.name === record.name;
    if (ours) ctx.cloud.deleteAccessApp(app.id);
  }
  remove(ctx, name);
  ctx.log(`removed ${name}: Worker, then Access`);
}

/** Lists expired deployments and, with `apply`, tears each one down. Returns the failures. */
export function sweep(ctx: Context, apply: boolean): string[] {
  const due = expired(ctx.store.load(), ctx.now());
  if (due.length === 0) ctx.log("no expired deployments");
  for (const d of due) ctx.log(`expired: ${d.name} (owner ${d.owner}, ${d.state})`);
  if (!apply) {
    if (due.length > 0) ctx.log("re-run with --yes to remove them");
    return [];
  }
  const failures: string[] = [];
  for (const d of due) {
    try {
      teardown(ctx, d.name);
    } catch (error) {
      failures.push(`${d.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}
