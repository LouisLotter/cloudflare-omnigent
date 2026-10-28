import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type ApiToken,
  ensureR2Token,
  manualR2Step,
  R2_WRITE_GROUP,
  type RecordedToken,
  r2TokenExpiry,
  r2TokenName,
  r2TokenProblems,
  r2TokenRequest,
  r2TokenResources,
  removeR2Token,
  s3Credentials,
} from "../r2-token.ts";
import { FakeWorld, R2_GROUP_ID } from "./fake-cloud.ts";
import { accountPlan, INSTALLATION, stagingPlan } from "./fixtures.ts";

const ACCOUNT = "1".repeat(32);
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

function token(plan: Awaited<ReturnType<typeof accountPlan>>, change: Partial<ApiToken> = {}) {
  return {
    id: "cfocanary-token",
    name: r2TokenName(plan),
    status: "active",
    ipLimited: false,
    policies: [
      { effect: "allow", permissionGroups: [R2_GROUP_ID], resources: r2TokenResources(plan) },
    ],
    ...change,
  } satisfies ApiToken;
}

describe("the R2 token's shape", () => {
  it("derives R2's S3 key pair: the ID, and the SHA-256 of the value in hex", () => {
    expect(s3Credentials("cfocanary-id", "abc")).toEqual({
      accessKeyId: "cfocanary-id",
      secretAccessKey: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (value) => {
        expect(s3Credentials("i", value).secretAccessKey).toMatch(/^[0-9a-f]{64}$/);
      }),
    );
  });

  it("names the installation, and covers exactly its two buckets", async () => {
    const plan = await accountPlan();
    expect(r2TokenName(plan)).toBe(`cloudflare-omnigent-r2--${INSTALLATION}`);
    expect(r2TokenResources(plan)).toEqual({
      [`com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_cfo-canary-replica`]: "*",
      [`com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_cfo-canary-artifacts`]: "*",
    });
    expect(r2TokenRequest(plan, R2_GROUP_ID, NOW)).toEqual({
      name: r2TokenName(plan),
      policies: [
        {
          effect: "allow",
          permission_groups: [{ id: R2_GROUP_ID }],
          resources: r2TokenResources(plan),
        },
      ],
    });
    // Never the checkpoint bucket, which only the Worker's binding reaches.
    expect(JSON.stringify(r2TokenResources(plan))).not.toContain("checkpoints");
  });

  it("expires never for an installation, and a day after a staging installation's deployments", async () => {
    expect(r2TokenExpiry(await accountPlan(), NOW)).toBeUndefined();
    expect(r2TokenExpiry(await stagingPlan(), NOW)).toBe("2026-10-30T12:00:00Z");
  });

  it("gives the dashboard step for one bucket or two", async () => {
    expect(manualR2Step(await accountPlan())).toContain(
      "apply it to the buckets cfo-canary-replica and cfo-canary-artifacts only",
    );
    const one = await stagingPlan({ artifacts: { url: "s3://cfo-stg-wp24-artifacts" } });
    expect(manualR2Step(one)).toContain("apply it to the bucket cfo-stg-wp24-artifacts only");
  });
});

describe("r2TokenProblems: whether a token of the installation can be kept", () => {
  it("keeps an active, unlimited, exact token", async () => {
    const plan = await accountPlan();
    expect(r2TokenProblems(token(plan), plan, R2_GROUP_ID, NOW)).toEqual([]);
  });

  it.each([
    [{ status: "disabled" }, "it is disabled"],
    [{ status: undefined }, "it is of unknown status"],
    [{ notBefore: "2026-11-01T00:00:00Z" }, "it is not valid yet"],
    [{ notBefore: "not a time" }, "it is not valid yet"],
    [{ expiresOn: "2030-01-01T00:00:00Z" }, "it expires"],
    [{ ipLimited: true }, "it is limited to client addresses"],
  ])("refuses %j", async (change, problem) => {
    const plan = await accountPlan();
    const { status, ...rest } = token(plan, change as Partial<ApiToken>);
    const t = "status" in change && change.status === undefined ? rest : { ...rest, status };
    expect(r2TokenProblems(t as ApiToken, plan, R2_GROUP_ID, NOW)).toEqual([problem]);
  });

  it("refuses any policy but the one exact policy", async () => {
    const plan = await accountPlan();
    const [policy] = token(plan).policies;
    const wrong = [
      [],
      [policy, policy],
      [{ ...policy, effect: "deny" }],
      [{ ...policy, permissionGroups: [R2_GROUP_ID, "x"] }],
      [{ ...policy, permissionGroups: ["x"] }],
      [{ ...policy, resources: {} }],
      [{ ...policy, resources: { ...policy?.resources, more: "*" } }],
      [
        {
          ...policy,
          resources: Object.fromEntries(
            Object.keys(policy?.resources ?? {}).map((k) => [k, { nested: "*" }]),
          ),
        },
      ],
    ];
    for (const policies of wrong) {
      expect(
        r2TokenProblems(token(plan, { policies } as Partial<ApiToken>), plan, R2_GROUP_ID, NOW),
      ).toEqual(["its permissions are not exactly the installation's buckets"]);
    }
  });

  it("wants a staging token to last as long as the staging deployments", async () => {
    const plan = await stagingPlan({ artifacts: { url: "s3://cfo-stg-wp24-artifacts" } });
    const lasting = token(plan, { expiresOn: "2026-10-29T13:00:00Z" });
    expect(r2TokenProblems(lasting, plan, R2_GROUP_ID, NOW)).toEqual([]);
    for (const expiresOn of ["2026-10-29T11:00:00Z", undefined]) {
      const { expiresOn: _e, ...t } = token(plan);
      const short = expiresOn === undefined ? t : { ...t, expiresOn };
      expect(r2TokenProblems(short, plan, R2_GROUP_ID, NOW)).toEqual(["it expires too soon"]);
    }
  });
});

describe("ensureR2Token and removeR2Token, against the fake", () => {
  async function setup() {
    const plan = await accountPlan();
    const world = new FakeWorld(plan);
    let recorded: RecordedToken | undefined;
    const lines: string[] = [];
    const ctx = {
      api: world.tokenApi(),
      plan,
      recorded: () => recorded,
      record: (t: RecordedToken) => {
        recorded = t;
      },
      now: () => NOW,
      sleep: async () => {},
      log: (line: string) => lines.push(line),
    };
    return { plan, world, ctx, lines, recorded: () => recorded };
  }

  it("leaves another installation's token, and every other token, alone", async () => {
    const { plan, world, ctx } = await setup();
    const other = world.addToken({ ...token(plan), id: undefined, name: "someone-else" } as never);
    const pair = await ensureR2Token(ctx);
    expect(world.tokens.has(other)).toBe(true);
    expect(world.tokens.size).toBe(2);
    expect(
      removeR2Token(world.tokenApi(), plan, { name: r2TokenName(plan), id: pair.accessKeyId }),
    ).toBe(1);
    expect([...world.tokens.keys()]).toEqual([other]);
  });

  it("prefers the recorded token over another valid one, and deletes the other", async () => {
    const { plan, world, ctx, lines } = await setup();
    const { id: _a, ...valid } = token(plan);
    const first = world.addToken(valid);
    const second = world.addToken(valid);
    ctx.record({ name: r2TokenName(plan), id: second, createdAt: "2026-10-28T11:00:00.000Z" });
    expect((await ensureR2Token(ctx)).accessKeyId).toBe(second);
    expect([...world.tokens.keys()]).toEqual([second]);
    expect(lines[0]).toBe("deleting an R2 token of this installation: a second one");
    expect(first).not.toBe(second);
  });

  it("finds a recorded token renamed by hand, and replaces it when it no longer fits", async () => {
    const { plan, world, ctx, recorded } = await setup();
    const renamed = world.addToken({ ...token(plan), id: undefined, name: "renamed" } as never);
    ctx.record({ name: r2TokenName(plan), id: renamed });
    // Still exact: kept, under its new name, and rolled.
    expect((await ensureR2Token(ctx)).accessKeyId).toBe(renamed);
    expect(recorded()?.createdAt).toBeUndefined();
    const entry = world.tokens.get(renamed);
    if (entry) entry.token = { ...entry.token, status: "expired" };
    const made = await ensureR2Token(ctx);
    expect(made.accessKeyId).not.toBe(renamed);
    expect(world.tokens.has(renamed)).toBe(false);
  });

  it("removes a token already gone as gone, and every token under the name", async () => {
    const { plan, world } = await setup();
    const { id: _id, ...valid } = token(plan);
    world.addToken(valid);
    world.addToken(valid);
    expect(removeR2Token(world.tokenApi(), plan, { name: r2TokenName(plan), id: "gone" })).toBe(2);
    expect(world.tokens.size).toBe(0);
    expect(removeR2Token(world.tokenApi(), plan, undefined)).toBe(0);
  });

  it("asks for the permission group by its name", async () => {
    const { world } = await setup();
    expect(world.tokenApi().permissionGroup(R2_WRITE_GROUP)).toBe(R2_GROUP_ID);
    expect(() => world.tokenApi().permissionGroup("Account Settings Write")).toThrow();
  });
});
