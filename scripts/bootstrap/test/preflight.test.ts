// The preflight before `plan` (WP3.31): what the account lacks, read-only, never a stop on
// uncertainty; and its cf adapter, against a fake cf.

import { describe, expect, it } from "vitest";
import type { CommandResult, RunOptions } from "../../staging/cloud.ts";
import { cfPreflightApi } from "../cloud.ts";
import { type PreflightApi, preflight, preflightReport, zoneCandidates } from "../preflight.ts";

const ACCOUNT = "1".repeat(32);
const OTHER = "2".repeat(32);
const HOST = "omnigent.example.test";

const sub = (id: string, product: string, state = "Paid") => ({
  rate_plan: { id, public_name: id },
  product: { name: product },
  state,
});

/** An account with everything, unless told otherwise. */
function account(overrides: Partial<PreflightApi> = {}): PreflightApi {
  return {
    subscriptions: () => [sub("workers_paid", "prod_workers"), sub("r2_paid", "prod_r2")],
    r2Enabled: () => true,
    zones: (name) =>
      name === "example.test" ? [{ name, status: "active", account: { id: ACCOUNT } }] : [],
    teamDomain: () => "team.cloudflareaccess.com",
    ...overrides,
  };
}

const states = (api: PreflightApi) => preflight(api, ACCOUNT, HOST).map((i) => i.state);

describe("preflight", () => {
  it("finds everything in a ready account, and lets the plan go on", () => {
    const items = preflight(account(), ACCOUNT, HOST);
    expect(items.map((i) => [i.item, i.state, i.text])).toEqual([
      ["the Workers Paid plan", "present", "subscribed"],
      ["R2", "present", "enabled"],
      [`the domain of ${HOST}`, "present", "example.test, active"],
      ["a Zero Trust organization", "present", "team.cloudflareaccess.com"],
    ]);
    expect(preflightReport(items)).toEqual({
      ready: true,
      lines: [
        "the Workers Paid plan: subscribed",
        "R2: enabled",
        `the domain of ${HOST}: example.test, active`,
        "a Zero Trust organization: team.cloudflareaccess.com",
      ],
    });
  });

  it("names each missing thing in one sentence with its dashboard link, and stops the plan", () => {
    const items = preflight(
      account({
        subscriptions: () => [sub("workers_free", "prod_workers"), sub("images", "prod_stream")],
        r2Enabled: () => false,
        zones: () => [],
        teamDomain: () => undefined,
      }),
      ACCOUNT,
      HOST,
    );
    const report = preflightReport(items);
    expect(report.ready).toBe(false);
    expect(report.lines).toEqual([
      "missing: the Workers Paid plan, which the server's container needs: subscribe at https://dash.cloudflare.com/?to=/:account/workers/plans",
      "missing: R2 object storage, which keeps the database replica and Omnigent's files: enable it at https://dash.cloudflare.com/?to=/:account/r2/overview",
      `missing: a domain on Cloudflare for ${HOST}: add your domain, or register one, at https://dash.cloudflare.com/?to=/:account/add-site`,
      "missing: your Cloudflare account has no Zero Trust organization yet, which puts Access in front of Omnigent: open https://one.dash.cloudflare.com/, choose a team name and the Free plan (Cloudflare asks for a payment method even for the Free plan), then run again",
    ]);
  });

  it("never stops on what it cannot read: could not check, and going on", () => {
    const failing = () => {
      throw new Error("cf failed: 403 Forbidden");
    };
    const items = preflight(
      account({ subscriptions: failing, r2Enabled: failing, zones: failing, teamDomain: failing }),
      ACCOUNT,
      HOST,
    );
    expect(items.map((i) => i.state)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    const report = preflightReport(items);
    expect(report.ready).toBe(true);
    expect(report.lines[0]).toBe(
      "could not check the Workers Paid plan (cf failed: 403 Forbidden); going on",
    );
    expect(
      preflightReport(
        preflight(
          account({
            zones: () => {
              throw "x";
            },
          }),
          ACCOUNT,
          HOST,
        ),
      ).lines[2],
    ).toBe(`could not check the domain of ${HOST} (x); going on`);
  });

  it.each([
    [
      "an ended Workers subscription",
      [sub("workers_paid", "prod_workers", "Cancelled")],
      "missing",
    ],
    ["a Workers plan by product only", [sub("enterprise", "prod_workers")], "present"],
    [
      "a Workers plan in an unknown state",
      [sub("workers_paid", "x", "AwaitingPayment")],
      "present",
    ],
    ["no subscription at all", [], "missing"],
    ["malformed entries", [null, "x", { rate_plan: 7 }], "unknown"],
    [
      "one malformed entry beside a free plan",
      [sub("workers_free", "prod_workers"), {}],
      "unknown",
    ],
  ])("Workers: %s", (_name, subscriptions, state) => {
    expect(states(account({ subscriptions: () => subscriptions }))[0]).toBe(state);
  });

  it("reads a malformed answer as could not check, never missing (Codex r1-4)", () => {
    const report = preflightReport(
      preflight(
        account({
          subscriptions: () => [{ state: "Paid" }],
          zones: (name) => (name === "example.test" ? [{ name, status: "active" }] : []),
        }),
        ACCOUNT,
        HOST,
      ),
    );
    expect(report.ready).toBe(true);
    expect(report.lines[0]).toBe(
      "could not check the Workers Paid plan (a subscription in Cloudflare's answer names no plan); going on",
    );
    expect(report.lines[2]).toBe(
      `could not check the domain of ${HOST} (Cloudflare's answer for example.test is incomplete); going on`,
    );
  });

  it.each([
    ["an empty plan ID", { subscriptions: () => [sub("", "")] }, 0],
    [
      "a zone without its name",
      { zones: () => [{ status: "active", account: { id: ACCOUNT } }] },
      2,
    ],
    ["a zone without its status", { zones: () => [{ name: HOST, account: { id: ACCOUNT } }] }, 2],
    [
      "an empty account ID",
      { zones: () => [{ name: HOST, status: "active", account: { id: "" } }] },
      2,
    ],
  ] as const)("reads %s as could not check (Codex r2-3)", (_name, overrides, index) => {
    const items = preflight(account(overrides as Partial<PreflightApi>), ACCOUNT, HOST);
    expect(items[index]?.state).toBe("unknown");
    expect(preflightReport(items).ready).toBe(true);
  });

  it("finds the zone by the longest suffix in this account, and tells a pending or foreign one", () => {
    expect(zoneCandidates("a.b.example.test")).toEqual([
      "a.b.example.test",
      "b.example.test",
      "example.test",
    ]);
    expect(zoneCandidates("Example.Test")).toEqual(["example.test"]);
    // A zone for the subdomain itself wins over its parent.
    const nested = account({
      zones: (name) =>
        name === HOST || name === "example.test"
          ? [{ name, status: "active", account: { id: ACCOUNT } }]
          : [],
    });
    expect(preflight(nested, ACCOUNT, HOST)[2]?.text).toBe(`${HOST}, active`);
    const pending = account({
      zones: (name) =>
        name === "example.test" ? [{ name, status: "pending", account: { id: ACCOUNT } }] : [],
    });
    expect(preflight(pending, ACCOUNT, HOST)[2]).toMatchObject({
      state: "missing",
      text: "example.test is in your account but not active yet (pending): finish adding it, as https://dash.cloudflare.com/?to=/:account/example.test shows (its nameservers), then run again",
    });
    const foreign = account({
      zones: (name) =>
        name === "example.test" ? [{ name, status: "active", account: { id: OTHER } }] : [],
    });
    const item = preflight(foreign, ACCOUNT, HOST)[2];
    expect(item).toMatchObject({
      state: "missing",
      text: "example.test is in another of your Cloudflare accounts: plan with that account (--account), or add the domain to this one at https://dash.cloudflare.com/?to=/:account/add-site",
    });
    expect(item?.text).not.toContain(OTHER);
    // A listing that answers with other names is filtered again.
    const loose = account({
      zones: () => [{ name: "other.test", status: "active", account: { id: ACCOUNT } }],
    });
    expect(states(loose)[2]).toBe("missing");
  });
});

describe("cfPreflightApi: read-only through cf", () => {
  function fake(answer: (args: readonly string[]) => Partial<CommandResult>) {
    const calls: { args: readonly string[]; options: RunOptions }[] = [];
    const runner = (_command: string, args: readonly string[], options: RunOptions) => {
      calls.push({ args, options });
      return { status: 0, stdout: "", stderr: "", ...answer(args) };
    };
    return { api: cfPreflightApi(runner), calls };
  }

  it("asks cf exactly these read-only questions", () => {
    const { api, calls } = fake((args) => {
      if (args[0] === "accounts")
        return { stdout: JSON.stringify({ result: [sub("workers_paid", "prod_workers")] }) };
      if (args[0] === "r2") return { stdout: JSON.stringify({ buckets: [] }) };
      if (args[0] === "zones")
        return { stdout: JSON.stringify({ result: [{ name: "example.test" }] }) };
      return { stdout: JSON.stringify({ result: { auth_domain: "team.cloudflareaccess.com" } }) };
    });
    expect(api.subscriptions()).toHaveLength(1);
    expect(api.r2Enabled()).toBe(true);
    expect(api.zones("example.test")).toEqual([{ name: "example.test" }]);
    expect(api.teamDomain()).toBe("team.cloudflareaccess.com");
    expect(calls.map((c) => c.args)).toEqual([
      ["accounts", "subscriptions", "get"],
      ["r2", "buckets", "list", "--per-page", "1"],
      ["zones", "list", "--name", "example.test"],
      ["zero-trust", "organization", "get"],
    ]);
    expect(calls.every((c) => c.options.inherit === false)).toBe(true);
  });

  it("tells R2 not enabled (10042) from a failure, and refuses odd answers", () => {
    const answers: Partial<CommandResult>[] = [
      {
        status: 1,
        stderr: "┌ APIError\n│ [10042] Please enable R2 through the Cloudflare Dashboard.\n└",
      },
      { status: 1, stderr: "403 Forbidden owner-canary@example.test" },
    ];
    const { api } = fake(() => answers.shift() ?? {});
    expect(api.r2Enabled()).toBe(false);
    expect(() => api.r2Enabled()).toThrow("cf r2 buckets list failed: 403 Forbidden <email>");
    const odd = fake(() => ({ stdout: JSON.stringify({ result: { not: "a list" } }) })).api;
    expect(() => odd.subscriptions()).toThrow(/answered no list/);
    expect(() => odd.zones("example.test")).toThrow("cf zones list answered no list");
  });
});
