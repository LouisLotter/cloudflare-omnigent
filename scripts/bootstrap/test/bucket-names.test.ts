// Owner decision D33 (WP3.30): a new installation's default bucket names carry part of its
// installation ID, its tag, so that an R2 token removal could not delete never covers a later
// installation's bucket. The critical invariant: an installation's buckets never change name. A
// plan records its tag (state file version 2), a plan from before D33 records none (version 1)
// and keeps its untagged names, and every run, deploy and removal names the buckets from the
// recorded plan, never from today's defaults. A rename would start the server, its computers or
// its artifacts from empty buckets.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunContext, type RunOptions, runBootstrap, type StateStore } from "../machine.ts";
import { manualR2Step, r2TokenResources } from "../r2-token.ts";
import { removeInstallationToken, stillCovers } from "../remove.ts";
import {
  BUCKET_TAG_DIGITS,
  bucketsOf,
  bucketTagOf,
  derivedBucketProblem,
  type Installation,
  installationProblems,
  newInstallationId,
  type PlanRequest,
  planInstallation,
  platformBucketNames,
  platformVars,
  r2Endpoint,
  renderPlatformConfig,
} from "../settings.ts";
import { fileStateStore, stateVersionFor } from "../state.ts";
import { Crash, FakeWorld } from "./fake-cloud.ts";
import { baseConfigs, INSTALLATION, OWNER_PASSWORD, ownerPin } from "./fixtures.ts";

const BASE = baseConfigs();
const ACCOUNT = "1".repeat(32);
const TAG = "01hs3f9q";
const OPTIONS: RunOptions = {
  waitMs: 30 * 60_000,
  pollMs: 30_000,
  verify: true,
  switchMs: 330_000,
  verifyWaitMs: 10 * 60_000,
};
const BASE32 = /^[0-9a-hjkmnp-tv-z]+$/;
const R2_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfo-bucket-names-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** What `bootstrap.ts plan --hostname … --owner-email … --owner-username owner` gives. */
async function request(overrides: Partial<PlanRequest> = {}): Promise<PlanRequest> {
  return {
    installationId: INSTALLATION,
    accountId: ACCOUNT,
    platformWorker: "cloudflare-omnigent",
    webWorker: "cloudflare-omnigent-web",
    hostname: "omnigent.example.test",
    ownerPin: await ownerPin(),
    ownerUsername: "owner",
    target: { kind: "account" },
    plannedAt: "2026-10-28T12:00:00.000Z",
    ...overrides,
  };
}

/** The bucket names a plan resolves to, wherever they are used. */
function namesOf(plan: Installation) {
  const rendered = renderPlatformConfig(BASE.platform, plan);
  const vars = rendered.vars as Record<string, string>;
  return {
    checkpoints: (rendered.r2_buckets as { bucket_name: string }[]).map((b) => b.bucket_name),
    replicaUrl: vars.SERVER_ENV_CFO_REPLICA_URL,
    artifactsUrl: vars.SERVER_ENV_OMNIGENT_ARTIFACT_URI,
    created: bucketsOf(plan),
    tokenScope: Object.keys(r2TokenResources(plan)),
  };
}

/**
 * A state file exactly as the bootstrap before WP3.30 wrote it for `plan --replica-url
 * s3://cfo-canary-replica/omnigent` (artifacts by the old default), mid-run: its first platform
 * deploy started, and its token made, when the run stopped.
 */
function legacyStateFile(pin: string): string {
  return `${JSON.stringify(
    {
      stateVersion: 1,
      installation: {
        installationId: INSTALLATION,
        accountId: ACCOUNT,
        platformWorker: "cloudflare-omnigent",
        webWorker: "cloudflare-omnigent-web",
        hostname: "omnigent.example.test",
        ownerPin: pin,
        ownerUsername: "owner",
        replica: { url: "s3://cfo-canary-replica/omnigent", endpoint: r2Endpoint(ACCOUNT) },
        artifacts: { url: "s3://cloudflare-omnigent-artifacts" },
        target: { kind: "account" },
        plannedAt: "2026-10-26T12:00:00.000Z",
      },
      journal: { platformDeployStartedAt: "2026-10-26T12:01:00.000Z" },
    },
    null,
    2,
  )}\n`;
}

const UNTAGGED = {
  checkpoints: ["cloudflare-omnigent-checkpoints"],
  replicaUrl: "s3://cfo-canary-replica/omnigent",
  artifactsUrl: "s3://cloudflare-omnigent-artifacts",
  created: ["cfo-canary-replica", "cloudflare-omnigent-artifacts"],
  tokenScope: [
    `com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_cfo-canary-replica`,
    `com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_cloudflare-omnigent-artifacts`,
  ],
};

const TAGGED = {
  checkpoints: [`cloudflare-omnigent-${TAG}-checkpoints`],
  replicaUrl: `s3://cloudflare-omnigent-${TAG}-replica/omnigent`,
  artifactsUrl: `s3://cloudflare-omnigent-${TAG}-artifacts`,
  created: [`cloudflare-omnigent-${TAG}-replica`, `cloudflare-omnigent-${TAG}-artifacts`],
  tokenScope: [
    `com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_cloudflare-omnigent-${TAG}-replica`,
    `com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_cloudflare-omnigent-${TAG}-artifacts`,
  ],
};

/** One bootstrap run against the fake Cloudflare, with the installer's token API. */
function run(world: FakeWorld, store: StateStore, lines: string[] = []) {
  const ctx: RunContext = {
    cloud: world.cloud(),
    store,
    baseConfigs: BASE,
    secrets: () => ({ ownerPassword: OWNER_PASSWORD }),
    r2Tokens: world.tokenApi(),
    random: (n) => new Uint8Array(n).fill(0xab),
    now: () => world.now,
    sleep: async (ms) => {
      world.now += Math.max(0, ms);
    },
    log: (line) => lines.push(line),
  };
  return runBootstrap(ctx, OPTIONS);
}

/** The bucket names in every platform configuration deployed, and every token's scope. */
function deployedNames(world: FakeWorld, plan: Installation) {
  const configs = world.configs.get(plan.platformWorker) ?? [];
  return {
    checkpoints: [
      ...new Set(
        configs.flatMap((c) =>
          (c.r2_buckets as { bucket_name: string }[]).map((b) => b.bucket_name),
        ),
      ),
    ],
    replicaUrl: [
      ...new Set(configs.map((c) => (c.vars as Record<string, string>).SERVER_ENV_CFO_REPLICA_URL)),
    ],
    artifactsUrl: [
      ...new Set(
        configs.map((c) => (c.vars as Record<string, string>).SERVER_ENV_OMNIGENT_ARTIFACT_URI),
      ),
    ],
    tokenScope: [
      ...new Set(
        [...world.tokens.values()].flatMap((t) =>
          t.token.policies.flatMap((p) => Object.keys(p.resources)),
        ),
      ),
    ],
  };
}

describe("the tag (D33)", () => {
  it("is the installation ID's first 8 base32 digits", () => {
    expect(bucketTagOf(INSTALLATION)).toBe(TAG);
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 26, maxLength: 26 }), (bytes) => {
        const id = newInstallationId(() => bytes);
        const tag = bucketTagOf(id);
        expect(tag).toHaveLength(BUCKET_TAG_DIGITS);
        expect(tag).toMatch(BASE32);
        expect(id.startsWith(`ins_${tag}`)).toBe(true);
      }),
    );
  });

  it("must be the plan's own: a tag from another ID makes the plan unusable", async () => {
    const plan = planInstallation(await request(), BASE.platform);
    expect(installationProblems(plan)).toEqual([]);
    expect(installationProblems({ ...plan, bucketTag: "01hs3f9r" })).toEqual([
      "the bucket tag is not the first 8 digits of the installation ID (D33)",
    ]);
  });
});

describe("a new plan (D33)", () => {
  it("gets tagged names for every bucket it derives, and records the tag", async () => {
    const plan = planInstallation(await request(), BASE.platform);
    expect(plan.bucketTag).toBe(TAG);
    expect(plan.replica).toEqual({
      url: `s3://cloudflare-omnigent-${TAG}-replica/omnigent`,
      endpoint: r2Endpoint(ACCOUNT),
    });
    expect(plan.artifacts).toEqual({ url: `s3://cloudflare-omnigent-${TAG}-artifacts` });
    expect(namesOf(plan)).toEqual(TAGGED);
    expect(platformBucketNames(BASE.platform, plan)).toEqual(TAGGED.checkpoints);
    expect(platformVars(plan)).toMatchObject({
      SERVER_ENV_CFO_REPLICA_URL: TAGGED.replicaUrl,
      SERVER_ENV_CFO_REPLICA_ENDPOINT: r2Endpoint(ACCOUNT),
      SERVER_ENV_OMNIGENT_ARTIFACT_URI: TAGGED.artifactsUrl,
      SERVER_ENV_AWS_ENDPOINT_URL_S3: r2Endpoint(ACCOUNT),
    });
    // The dashboard step and removal's message name the same buckets.
    expect(manualR2Step(plan)).toContain(`the buckets ${TAGGED.created.join(" and ")} only`);
    expect(stillCovers(plan, 1)).toContain(`the buckets ${TAGGED.created.join(" and ")}`);
    expect(stillCovers(plan, 2)).toMatch(/^ Until then each can read and write/);
    const { artifacts: _none, ...onDisk } = plan;
    expect(stillCovers({ ...onDisk, replica: { url: "file:///replica" } }, 1)).toBe("");
  });

  it("keeps the names the installer gives exactly; only the platform Worker's own are derived", async () => {
    const given = planInstallation(
      await request({
        replicaUrl: "s3://my-db/x/y",
        replicaEndpoint: "https://s3.example.test",
        artifactsUrl: "s3://my-files/up",
        artifactsEndpoint: "https://files.example.test",
      }),
      BASE.platform,
    );
    expect(given.replica).toEqual({ url: "s3://my-db/x/y", endpoint: "https://s3.example.test" });
    expect(given.artifacts).toEqual({
      url: "s3://my-files/up",
      endpoint: "https://files.example.test",
    });
    expect(bucketsOf(given)).toEqual(["my-db", "my-files"]);
    expect(namesOf(given).checkpoints).toEqual(TAGGED.checkpoints);
    // A replica named, the artifacts by default (at the replica's endpoint).
    const replicaOnly = planInstallation(
      await request({ replicaUrl: "s3://my-db/omnigent" }),
      BASE.platform,
    );
    expect(replicaOnly.replica).toEqual({
      url: "s3://my-db/omnigent",
      endpoint: r2Endpoint(ACCOUNT),
    });
    expect(replicaOnly.artifacts).toEqual({ url: TAGGED.artifactsUrl });
  });

  it("a staging installation names its replica; its checkpoints are tagged too", async () => {
    const staging = {
      platformWorker: "cfo-stg-wp24-platform",
      webWorker: "cfo-stg-wp24-web",
      hostname: "cfo-stg-wp24-web.example.test",
      target: {
        kind: "staging",
        owner: "WP2.4",
        platformSuffix: "wp24-platform",
        webSuffix: "wp24-web",
        days: 1,
      },
    } as const;
    await expect(async () =>
      planInstallation(await request(staging), BASE.platform),
    ).rejects.toThrow(/^a staging installation names its replica \(--replica-url\)/);
    const plan = planInstallation(
      await request({ ...staging, replicaUrl: "file:///replica" }),
      BASE.platform,
    );
    expect(plan.bucketTag).toBe(TAG);
    expect(plan.replica).toEqual({ url: "file:///replica" });
    expect(plan.artifacts).toBeUndefined();
    expect(namesOf(plan).checkpoints).toEqual([`cfo-stg-wp24-platform-${TAG}-checkpoints`]);
  });

  it("refuses a platform Worker name too long for a derived name, never shortening it", async () => {
    // `<name>-<tag>-checkpoints` is the longest derived name: 21 characters past the name.
    const fits = "a".repeat(42);
    const plan = planInstallation(
      await request({ platformWorker: fits, webWorker: "web" }),
      BASE.platform,
    );
    expect(namesOf(plan).checkpoints).toEqual([`${fits}-${TAG}-checkpoints`]);
    expect(`${fits}-${TAG}-checkpoints`).toHaveLength(63);
    const long = "a".repeat(43);
    const message = `the platform Worker's name is too long for the R2 bucket ${long}-${TAG}-checkpoints (64 characters, and R2 allows 63): choose a platform Worker name of at most 42 characters`;
    await expect(async () =>
      planInstallation(await request({ platformWorker: long, webWorker: "web" }), BASE.platform),
    ).rejects.toThrow(message);
    // Named buckets do not lift the limit: the checkpoints are always the platform Worker's own.
    await expect(async () =>
      planInstallation(
        await request({
          platformWorker: long,
          webWorker: "web",
          replicaUrl: "s3://my-db/x",
          artifactsUrl: "s3://my-files",
        }),
        BASE.platform,
      ),
    ).rejects.toThrow(message);
    // Each derived name too long is named.
    const longer = "a".repeat(47);
    await expect(async () =>
      planInstallation(await request({ platformWorker: longer, webWorker: "web" }), BASE.platform),
    ).rejects.toThrow(
      new RegExp(`${longer}-${TAG}-replica \\(64 .*; .*-artifacts \\(66 .*; .*-checkpoints \\(68 `),
    );
    // A deploy refuses one too, whatever made the plan.
    expect(() => renderPlatformConfig(BASE.platform, { ...plan, platformWorker: long })).toThrow(
      message,
    );
    expect(derivedBucketProblem("ab", { platformWorker: "a" })).toBe(
      "ab is not a valid R2 bucket name",
    );
  });

  it("every derived name is one R2 accepts, carries the tag, and is never an untagged one", async () => {
    const pin = await ownerPin();
    const worker = fc
      .stringMatching(/^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/)
      .filter((name) => name.length <= 42 && !name.startsWith("cfo-stg-"));
    fc.assert(
      fc.property(worker, fc.uint8Array({ minLength: 26, maxLength: 26 }), (name, bytes) => {
        const id = newInstallationId(() => bytes);
        const plan = planInstallation(
          {
            installationId: id,
            accountId: ACCOUNT,
            platformWorker: name,
            webWorker: `${name}-w`,
            hostname: "omnigent.example.test",
            ownerPin: pin,
            ownerUsername: "owner",
            target: { kind: "account" },
            plannedAt: "2026-10-28T12:00:00.000Z",
          },
          BASE.platform,
        );
        const tag = bucketTagOf(id);
        const names = [...bucketsOf(plan), ...platformBucketNames(BASE.platform, plan)];
        expect(names).toHaveLength(3);
        for (const bucket of names) {
          expect(bucket).toMatch(R2_NAME);
          expect(bucket.startsWith(`${name}-${tag}-`)).toBe(true);
        }
        expect(names).not.toContain(`${name}-checkpoints`);
        expect(names).not.toContain(`${name}-artifacts`);
        expect(names).not.toContain(`${name}-replica`);
      }),
      { numRuns: 200 },
    );
  });

  it("renames only the configuration's own buckets, and keeps any other as it is", async () => {
    const plan = planInstallation(await request(), BASE.platform);
    const base = {
      name: "base",
      r2_buckets: [
        { binding: "A", bucket_name: "other" },
        null,
        { binding: "B" },
        { binding: "C", bucket_name: "base-files" },
      ],
    };
    expect(platformBucketNames(base, plan)).toEqual([`cloudflare-omnigent-${TAG}-files`]);
    expect(renderPlatformConfig(base, plan).r2_buckets).toEqual([
      { binding: "A", bucket_name: "other" },
      null,
      { binding: "B" },
      { binding: "C", bucket_name: `cloudflare-omnigent-${TAG}-files` },
    ]);
    // Without a name of its own, or without buckets, nothing is renamed.
    const { name: _name, ...nameless } = base;
    expect(platformBucketNames(nameless, plan)).toEqual([]);
    expect(renderPlatformConfig(nameless, plan).r2_buckets).toEqual(base.r2_buckets);
    expect(platformBucketNames({ name: "base" }, plan)).toEqual([]);
    expect(renderPlatformConfig({ name: "base" }, plan)).not.toHaveProperty("r2_buckets");
  });

  it("names every other problem of the plan", async () => {
    await expect(async () =>
      planInstallation(await request({ installationId: "ins_short" }), BASE.platform),
    ).rejects.toThrow("the installation ID is not ins_<26 base32 digits>");
    await expect(async () =>
      planInstallation(await request({ hostname: "Not A Host" }), BASE.platform),
    ).rejects.toThrow("the hostname is not a lowercase DNS name");
  });
});

describe("an existing installation never changes bucket names (D33's invariant)", () => {
  it("a plan from before D33 keeps its untagged names, for every bucket, through a re-run", async () => {
    const path = join(dir, "cloudflare-omnigent.json");
    const before = legacyStateFile(await ownerPin());
    writeFileSync(path, before, { mode: 0o600 });
    const store = fileStateStore(path);
    const plan = store.load().installation;
    expect(plan.bucketTag).toBeUndefined();
    expect(namesOf(plan)).toEqual(UNTAGGED);

    // The run that stopped is run again, by today's bootstrap: it stops once more before its
    // deploy, then a third run finishes. Every deploy, the bucket creation list and the token's
    // scope keep the old names.
    const world = new FakeWorld(plan);
    world.crash = { call: "deployPlatform", nth: 1, when: "before" };
    await expect(run(world, store)).rejects.toThrow(Crash);
    expect(await run(world, store)).toEqual({ kind: "done" });
    expect(world.configs.get(plan.platformWorker)).toHaveLength(1);
    expect(deployedNames(world, plan)).toEqual({
      checkpoints: UNTAGGED.checkpoints,
      replicaUrl: [UNTAGGED.replicaUrl],
      artifactsUrl: [UNTAGGED.artifactsUrl],
      tokenScope: UNTAGGED.tokenScope,
    });

    // The file is still version 1 with the same plan, which an earlier bootstrap reads as before.
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.stateVersion).toBe(1);
    expect(after.installation).toEqual(JSON.parse(before).installation);
    expect(after.installation).not.toHaveProperty("bucketTag");
    expect(namesOf(store.load().installation)).toEqual(UNTAGGED);

    // Removal names the same buckets.
    const lines: string[] = [];
    removeInstallationToken({
      store,
      api: world.tokenApi(),
      workerExists: () => false,
      force: false,
      now: () => world.now,
      log: (line) => lines.push(line),
    });
    expect(lines.join("\n")).toContain(`the buckets ${UNTAGGED.created.join(" and ")}, and`);
    expect(JSON.parse(readFileSync(path, "utf8")).stateVersion).toBe(1);
  });

  it("a new plan's re-run is stable: the same tagged names from the file, every time", async () => {
    const path = join(dir, "cloudflare-omnigent.json");
    const planned = planInstallation(await request(), BASE.platform);
    const store = fileStateStore(path);
    store.save({ stateVersion: stateVersionFor(planned), installation: planned, journal: {} });
    const file = JSON.parse(readFileSync(path, "utf8"));
    // Version 2: an earlier bootstrap refuses it ("unknown version") rather than drop the tag.
    expect(file.stateVersion).toBe(2);
    expect(file.installation.bucketTag).toBe(TAG);

    const world = new FakeWorld(planned);
    world.crash = { call: "deployPlatform", nth: 1, when: "before" };
    await expect(run(world, store)).rejects.toThrow(Crash);
    world.failAfter = { call: "deployWeb", nth: 1, message: "the web deploy failed" };
    await expect(run(world, store)).rejects.toThrow("the web deploy failed");
    // A new deploy of the platform from the same file (a lost deploy, as `run` sees it).
    const { platformDeployedAt: _deployed, ...journal } = store.load().journal;
    store.save({ ...store.load(), journal });
    expect(await run(world, store)).toEqual({ kind: "done" });
    expect(world.configs.get(planned.platformWorker)).toHaveLength(2);
    expect(deployedNames(world, planned)).toEqual({
      checkpoints: TAGGED.checkpoints,
      replicaUrl: [TAGGED.replicaUrl],
      artifactsUrl: [TAGGED.artifactsUrl],
      tokenScope: TAGGED.tokenScope,
    });
    const loaded = store.load();
    expect(loaded.stateVersion).toBe(2);
    expect(loaded.installation).toEqual(planned);
    expect(namesOf(loaded.installation)).toEqual(TAGGED);
  });
});
