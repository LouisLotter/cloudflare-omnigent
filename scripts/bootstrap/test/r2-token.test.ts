import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  API_TOKENS_PAGE,
  deleteTokens,
  type EnsureContext,
  isR2TokenName,
  type LeftToken,
  makeR2Token,
  manualDeletion,
  manualR2Step,
  type RecordedToken,
  r2TokenExpiry,
  r2TokenName,
  r2TokenPrefix,
  r2TokenRequest,
  r2TokenResources,
  retireR2Token,
  s3Credentials,
  TokensUnavailable,
} from "../r2-token.ts";
import type { Installation } from "../settings.ts";
import { FakeWorld, R2_GROUP_ID } from "./fake-cloud.ts";
import { accountPlan, INSTALLATION, stagingPlan } from "./fixtures.ts";

const ACCOUNT = "1".repeat(32);
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

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

  it("names each token after the installation and the second of its create", async () => {
    const plan = await accountPlan();
    expect(r2TokenPrefix(plan)).toBe(`cloudflare-omnigent-r2--${INSTALLATION}`);
    const name = r2TokenName(plan, NOW + 999);
    expect(name).toBe(`cloudflare-omnigent-r2--${INSTALLATION}--20261028T120000Z`);
    expect(isR2TokenName(plan, name)).toBe(true);
    for (const other of [
      r2TokenPrefix(plan),
      `${r2TokenPrefix(plan)}--x`,
      `${r2TokenPrefix(plan)}--20261028T120000`,
      `cloudflare-omnigent-r2--ins_00000000000000000000000000--20261028T120000Z`,
    ]) {
      expect(isR2TokenName(plan, other)).toBe(false);
    }
    // At most 120 characters, Cloudflare's limit, for the longest Worker name.
    const longest = await accountPlan({ platformWorker: "a".repeat(63) });
    expect(r2TokenName(longest, NOW).length).toBeLessThanOrEqual(120);
  });

  it("covers exactly the installation's two buckets", async () => {
    const plan = await accountPlan();
    expect(r2TokenResources(plan)).toEqual({
      [`com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_cfo-canary-replica`]: "*",
      [`com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_cfo-canary-artifacts`]: "*",
    });
    expect(r2TokenRequest(plan, R2_GROUP_ID, NOW)).toEqual({
      name: r2TokenName(plan, NOW),
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

describe("manualDeletion: the one link and the one click", () => {
  it("names each token exactly", () => {
    expect(manualDeletion([{ name: "a--20261028T120000Z", id: "i" }])).toBe(
      `Cloudflare does not let this cf login delete API tokens, so delete the token named exactly a--20261028T120000Z by hand: open ${API_TOKENS_PAGE}, open the three-dot menu next to it, and choose Delete.`,
    );
    const several = manualDeletion([
      { name: "a", id: "i" },
      { name: "b", expiresOn: "2026-10-30T12:00:00Z" },
    ]);
    expect(several).toContain(
      "delete each of the tokens named exactly a; b if it exists (its create was never answered) (or leave it: it expires on 2026-10-30T12:00:00Z) by hand",
    );
    expect(several).toContain("open the three-dot menu next to each, and choose Delete.");
    expect(API_TOKENS_PAGE).toBe("https://dash.cloudflare.com/profile/api-tokens");
  });
});

describe("deleteTokens: what the login may delete, and what it may not", () => {
  function world(oauth: boolean) {
    return accountPlan().then((plan) => {
      const w = new FakeWorld(plan);
      w.oauthLogin = oauth;
      const token = (name: string) =>
        w.addToken({
          name,
          status: "active",
          policies: [
            { effect: "allow", permissionGroups: [R2_GROUP_ID], resources: r2TokenResources(plan) },
          ],
        });
      return { plan, w, token };
    });
  }

  it("an OAuth login: nothing is deleted, nothing is lost", async () => {
    const { w, token } = await world(true);
    const id = token("a");
    const tokens: LeftToken[] = [{ name: "a", id }, { name: "b" }];
    expect(deleteTokens(w.tokenApi(), tokens)).toEqual({
      deleted: [],
      left: [tokens[1], tokens[0]],
    });
    expect(w.tokens.size).toBe(1);
  });

  it("a login with API Tokens Write: deletes by ID, finds an unanswered create by name, and drops one never made", async () => {
    const { plan, w, token } = await world(false);
    const a = token("a");
    const b = token("b");
    const stray = token(r2TokenName(plan, NOW));
    token("someone-else");
    const result = deleteTokens(
      w.tokenApi(),
      [{ name: "a", id: a }, { name: "b" }, { name: "never-made" }, { name: "gone", id: "x" }],
      { also: (t) => isR2TokenName(plan, t.name) },
    );
    expect(result.left).toEqual([]);
    expect(result.deleted.map((t) => t.id)).toEqual([a, b, "x", stray]);
    expect([...w.tokens.values()].map((t) => t.token.name)).toEqual(["someone-else"]);
  });

  it("passes on anything but a refusal", async () => {
    const { w } = await world(false);
    const api = {
      ...w.tokenApi(),
      remove: () => {
        throw new Error("network down");
      },
    };
    expect(() => deleteTokens(api, [{ name: "a", id: "i" }])).toThrow("network down");
    const listing = {
      ...w.tokenApi(),
      list: () => {
        throw new Error("network down");
      },
    };
    expect(() => deleteTokens(listing, [{ name: "a" }])).toThrow("network down");
  });
});

describe("makeR2Token and retireR2Token", () => {
  async function setup(plan?: Installation) {
    const p = plan ?? (await accountPlan());
    const w = new FakeWorld(p);
    let current: RecordedToken | undefined;
    let left: readonly LeftToken[] = [];
    const lines: string[] = [];
    const saves: { current: RecordedToken | undefined; left: readonly LeftToken[] }[] = [];
    const ctx: EnsureContext = {
      api: w.tokenApi(),
      plan: p,
      recorded: () => ({ current, left }),
      record: (c, l) => {
        current = c;
        left = l;
        saves.push({ current: c, left: l });
      },
      now: () => w.now,
      log: (line) => lines.push(line),
    };
    return { w, ctx, lines, saves, state: () => ({ current, left }) };
  }

  it("records the intent before the create, and the ID after", async () => {
    const s = await setup();
    const made = makeR2Token(s.ctx);
    expect(made.left).toEqual([]);
    expect(s.saves.map((x) => Object.keys(x.current ?? {}).sort())).toEqual([
      ["createStartedAt", "name"],
      ["createdAt", "id", "name"],
    ]);
    expect(made.pair).toEqual(s.w.pairOf(String(s.state().current?.id)));
  });

  it("retires nothing when nothing is recorded, and the current token otherwise", async () => {
    const s = await setup();
    expect(retireR2Token(s.ctx)).toEqual([]);
    expect(s.saves).toEqual([]);
    makeR2Token(s.ctx);
    const id = s.state().current?.id;
    expect(retireR2Token(s.ctx)).toEqual([{ name: s.state().left[0]?.name, id }]);
    expect(s.state().current).toBeUndefined();
  });

  it("a refused create leaves no intent; a lost answer leaves it", async () => {
    const s = await setup();
    s.w.tokensForbidden = true;
    expect(() => makeR2Token(s.ctx)).toThrow(TokensUnavailable);
    expect(s.state().current).toBeUndefined();
    const t = await setup();
    t.w.late = { call: "tokenCreate", nth: 1, afterMs: 1 };
    expect(() => makeR2Token(t.ctx)).toThrow("timeout");
    expect(t.state().current?.createStartedAt).toBeDefined();
  });

  it("a staging token records its expiry", async () => {
    const s = await setup(await stagingPlan({ artifacts: { url: "s3://cfo-stg-wp24-artifacts" } }));
    makeR2Token(s.ctx);
    expect(s.state().current?.expiresOn).toBe("2026-10-24T12:00:00Z");
    expect(retireR2Token(s.ctx)[0]?.expiresOn).toBe("2026-10-24T12:00:00Z");
  });
});
