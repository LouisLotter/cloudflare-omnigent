// Staging orchestration: deploy, teardown and sweep, written against small ports so that tests
// can drive them with a fake Cloudflare and interrupt them at any step.
//
// The invariant: a staging Worker is never reachable without its owner-only Access application.
//   - Every cloud mutation happens after the deployment's record is saved, and the record is
//     removed only after both resources are gone. An interrupted run leaves a record to finish.
//   - Deploy and teardown of one deployment hold its lock for their whole run, so they never
//     overlap, even when started from different worktrees. The lock outlives a crashed command
//     until its child processes exit (lock.ts). Registry updates are atomic (Store.update).
//   - The Worker configuration is checked before the first cloud call (validateDeployConfig):
//     the staging account, no other route, no resource the tool does not manage.
//   - Access is created, or claimed and checked, before the Worker is deployed, and a deploy
//     counts only once the Worker is found in the staging account.
//   - Teardown removes Access only after Cloudflare confirms that the Worker no longer exists.
//     An interrupted upload may still land for up to `settleMs` after its process ended. Once
//     a record shows one (markInterrupted), no later deploy clears that, and every teardown
//     waits the full `settleMs` on its own process's monotonic clock, then starts a fresh
//     lookup, before removing Access. No wall-clock deadline is trusted, and no lookup that
//     began before the wait counts. An unknown answer keeps Access and the record.
//   - Worker and Access share one record and one expiry, so a sweep removes them together.
//     Containers and R2 buckets the configuration declares carry the deployment's name, are
//     recorded before the deploy that creates them, and are removed by the same teardown,
//     after the Worker and before Access.

import {
  type AccessApp,
  accessAppBody,
  assertAccount,
  assertManaged,
  assertOwnerOnly,
  claimAccessApp,
  type DeployConfigView,
  type Deployment,
  declaredResources,
  expired,
  expiry,
  hostnameFor,
  markInterrupted,
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
  /** True or false only when Cloudflare answered; throws when the answer is unknown. */
  bucketExists(name: string): boolean;
  createBucket(name: string): void;
  /** Deletes every object, then the bucket. */
  emptyAndDeleteBucket(name: string): void;
  /** IDs of the container applications with exactly this name. */
  containerApps(name: string): string[];
  deleteContainerApp(id: string): void;
  /** Image references (`repository:tag`) in this repository of the managed registry. */
  containerImages(repository: string): string[];
  deleteContainerImage(reference: string): void;
}

export interface Store {
  load(): Deployment[];
  /** Replaces the registry with `change(current)`, atomically with respect to other commands. */
  update(change: (current: Deployment[]) => Deployment[]): void;
}

export interface Context {
  readonly config: StagingConfig;
  readonly cloud: Cloud;
  readonly store: Store;
  readonly readConfig: (path: string) => DeployConfigView;
  /** Takes the deployment's lock, or throws if another command holds it. Returns the release. */
  readonly lock: (name: string) => () => void;
  readonly sleep: (ms: number) => void;
  /** How long a request whose client died may still take effect at Cloudflare. */
  readonly settleMs: number;
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
  ctx.store.update((all) => [...all.filter((d) => d.name !== deployment.name), deployment]);
  return deployment;
}

function remove(ctx: Context, name: string): void {
  ctx.store.update((all) => all.filter((d) => d.name !== name));
}

/**
 * The registry repositories a record owns: one per default-policy container, named after it,
 * and the recorded ones, such as a `durable_object`-policy container's `<worker>-<class>-<image>`.
 */
function repositoriesOf(d: Deployment | undefined): string[] {
  return [...new Set([...(d?.containers ?? []), ...(d?.repositories ?? [])])];
}

function locked<T>(ctx: Context, name: string, run: () => T): T {
  const release = ctx.lock(name);
  try {
    return run();
  } finally {
    release();
  }
}

export function deploy(ctx: Context, request: DeployRequest): Deployment {
  const name = resourceName(request.suffix);
  const hostname = hostnameFor(name, ctx.config.zone);
  // Local checks first: nothing below runs for a configuration that could reach outside
  // staging.
  const view = ctx.readConfig(request.configPath);
  validateDeployConfig(view, ctx.config.accountId, name);
  const declared = declaredResources(view.raw, name);
  return locked(ctx, name, () => {
    const now = ctx.now();
    const expiresAt = expiry(now, request.days);
    const found = ctx.store.load().find((d) => d.name === name);
    const existing = found && markInterrupted(found, now);
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

    // A container or bucket new to this deployment must not exist yet: otherwise it belongs to
    // someone else, and recording it would let teardown delete it. Checked before recording.
    for (const container of declared.containers) {
      if (
        !existing?.containers?.includes(container) &&
        ctx.cloud.containerApps(container).length > 0
      ) {
        throw new Error(
          `container application ${container} exists but this deployment did not create it`,
        );
      }
    }
    for (const bucket of declared.buckets) {
      if (!existing?.buckets?.includes(bucket) && ctx.cloud.bucketExists(bucket)) {
        throw new Error(`R2 bucket ${bucket} exists but this deployment did not create it`);
      }
    }
    const ownRepositories = repositoriesOf(existing);
    for (const repository of declared.repositories) {
      if (
        !ownRepositories.includes(repository) &&
        ctx.cloud.containerImages(repository).length > 0
      ) {
        throw new Error(
          `registry repository ${repository} has images this deployment did not push`,
        );
      }
    }

    // The record exists before anything is created, and one expiry covers every resource.
    // Containers and buckets accumulate across deploys, so none is ever forgotten.
    const union = (a: readonly string[] | undefined, b: string[]) => [
      ...new Set([...(a ?? []), ...b]),
    ];
    const intent: Deployment = {
      ...(existing ?? { name, hostname, owner: request.owner, createdAt: now.toISOString() }),
      expiresAt,
      state: "pending",
      containers: union(existing?.containers, declared.containers),
      buckets: union(existing?.buckets, declared.buckets),
      repositories: union(existing?.repositories, declared.repositories),
    };
    // Deployment names can nest (cfo-stg-a owns cfo-stg-a-x, and so does the deployment
    // cfo-stg-a-x), and their locks are separate, so the claim is checked and recorded in one
    // atomic registry update: no resource is ever recorded for two deployments.
    ctx.store.update((all) => {
      const claimed = (d: Deployment) => [
        ...(d.containers ?? []),
        ...(d.buckets ?? []),
        ...(d.repositories ?? []),
      ];
      const mine = claimed(intent);
      for (const other of all) {
        if (other.name === name) continue;
        const theirs = claimed(other);
        const clash = mine.find((r) => theirs.includes(r));
        if (clash) throw new Error(`${clash} is recorded for the deployment ${other.name}`);
      }
      return [...all.filter((d) => d.name !== name), intent];
    });
    let record = intent;

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

    // Buckets before the Worker binds them, so Wrangler never provisions one itself. A bucket
    // that exists here is one this record already owned (checked above), or one an
    // interrupted run of this deploy created after recording it.
    for (const bucket of declared.buckets) {
      if (!ctx.cloud.bucketExists(bucket)) {
        ctx.cloud.createBucket(bucket);
        ctx.log(`created R2 bucket ${bucket}`);
      }
    }

    // If the upload throws, the record keeps uploadStartedAt: the Worker may exist, or may
    // still appear, and the next command marks the upload interrupted.
    record = put(ctx, { ...record, uploadStartedAt: ctx.now().toISOString() });
    ctx.cloud.deployWorker(name, hostname, request.configPath);
    if (!ctx.cloud.workerExists(name)) {
      throw new Error(
        `${name}: Wrangler reported success, but the staging account has no such Worker`,
      );
    }
    const { uploadStartedAt: _, ...settled } = record;
    record = put(ctx, { ...settled, state: "deployed" });
    ctx.log(`deployed ${name} at https://${hostname} (expires ${expiresAt})`);
    return record;
  });
}

/** Removes a deployment: its Worker first, then its Access application, then its record. */
export function teardown(
  ctx: Context,
  name: string,
  options: { readonly ifPresent?: boolean; readonly ifExpiredAt?: Date } = {},
): void {
  assertManaged(name);
  locked(ctx, name, () => {
    const found = ctx.store.load().find((d) => d.name === name);
    if (!found) {
      if (options.ifPresent) return;
      throw new Error(`no recorded deployment named ${name}`);
    }
    if (options.ifExpiredAt && expired([found], options.ifExpiredAt).length === 0) return;
    assertAccount(ctx.config.accountId, ctx.cloud.accountIds());
    const record = put(ctx, { ...markInterrupted(found, ctx.now()), state: "deleting" });

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
    if (record.uploadInterruptedAt !== undefined) {
      // The interrupted upload's process ended before this command took the lock, so after a
      // full settle time from here any request it left behind has landed or never will.
      ctx.log(`${name}: an upload was interrupted; checking again in ${ctx.settleMs / 1000}s`);
      ctx.sleep(ctx.settleMs);
      if (ctx.cloud.workerExists(name)) {
        throw new Error(
          `${name}: the Worker appeared after an interrupted upload, so its Access application was kept; run teardown again`,
        );
      }
    }

    // With the Worker gone, nothing reaches its containers or buckets. Remove them, checking
    // each, and keep the record (and Access) if any is left.
    for (const container of record.containers ?? []) {
      for (const id of ctx.cloud.containerApps(container)) ctx.cloud.deleteContainerApp(id);
      if (ctx.cloud.containerApps(container).length > 0) {
        throw new Error(`${name}: container application ${container} still exists`);
      }
    }
    for (const repository of repositoriesOf(record)) {
      for (const image of ctx.cloud.containerImages(repository)) {
        ctx.cloud.deleteContainerImage(image);
      }
      if (ctx.cloud.containerImages(repository).length > 0) {
        throw new Error(`${name}: images of ${repository} are still in the registry`);
      }
    }
    for (const bucket of record.buckets ?? []) {
      if (ctx.cloud.bucketExists(bucket)) ctx.cloud.emptyAndDeleteBucket(bucket);
      if (ctx.cloud.bucketExists(bucket))
        throw new Error(`${name}: R2 bucket ${bucket} still exists`);
    }

    // The Worker is confirmed absent. Remove the Access application the record points to, or,
    // if an interrupted deploy never recorded its ID, the one carrying this deployment's name.
    for (const app of ctx.cloud.listAccessApps(record.hostname)) {
      if (app.domain !== record.hostname) continue;
      const ours = record.accessAppId ? app.id === record.accessAppId : app.name === record.name;
      if (ours) ctx.cloud.deleteAccessApp(app.id);
    }
    remove(ctx, name);
    ctx.log(`removed ${name}: Worker, containers and buckets, then Access`);
  });
}

/** Lists expired deployments and, with `apply`, tears each one down. Returns the failures. */
export function sweep(ctx: Context, apply: boolean): string[] {
  const now = ctx.now();
  const due = expired(ctx.store.load(), now);
  if (due.length === 0) ctx.log("no expired deployments");
  for (const d of due) ctx.log(`expired: ${d.name} (owner ${d.owner}, ${d.state})`);
  if (!apply) {
    if (due.length > 0) ctx.log("re-run with --yes to remove them");
    return [];
  }
  const failures: string[] = [];
  for (const d of due) {
    try {
      // Another command may have removed or redeployed it since the list was read.
      teardown(ctx, d.name, { ifPresent: true, ifExpiredAt: now });
    } catch (error) {
      failures.push(`${d.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}
