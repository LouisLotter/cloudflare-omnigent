import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandResult, RunOptions } from "../../staging/cloud.ts";
import { acquireLock } from "../../staging/lock.ts";
import { AccessUnavailable } from "../access-app.ts";
import {
  accountCloud,
  apiTokenOf,
  bucketExists,
  cfAccessApi,
  cfJson,
  cfTokenApi,
  ensureBuckets,
  queryWorkerLogs,
  soleAccount,
  workerMissing,
} from "../cloud.ts";
import { R2_WRITE_GROUP, r2TokenRequest, TokensUnavailable } from "../r2-token.ts";
import { INITIALIZED_SECRET, PASSWORD_SECRET, RELEASE_CHANGES } from "../settings.ts";
import { stagingCloud, stagingToolStdio } from "../staging.ts";
import {
  accountPlan,
  baseConfigs,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  stagingPlan,
  WORKER,
} from "./fixtures.ts";

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: RunOptions;
  /** What the child could read on descriptor 3, if it got one. */
  readonly fd3?: string;
  /** Files named in the arguments, as they were during the call. */
  readonly files: Record<string, { text: string; mode: number }>;
}

function fdText(fd: number): string {
  const buffer = Buffer.alloc(64 * 1024);
  const n = readSync(fd, buffer, 0, buffer.length, 0);
  return buffer.subarray(0, n).toString("utf8");
}

function fakeRunner(answer: (call: Call) => Partial<CommandResult>) {
  const calls: Call[] = [];
  const runner = (command: string, args: readonly string[], options: RunOptions): CommandResult => {
    const files: Call["files"] = {};
    for (const arg of args) {
      if ((arg.endsWith(".json") || arg.endsWith(".jsonc")) && existsSync(arg)) {
        files[arg] = { text: readFileSync(arg, "utf8"), mode: statSync(arg).mode & 0o777 };
      }
    }
    const fd = options.fds?.[0];
    const call: Call = {
      command,
      args,
      options,
      files,
      ...(fd === undefined ? {} : { fd3: fdText(fd) }),
    };
    calls.push(call);
    return { status: 0, stdout: "", stderr: "", ...answer(call) };
  };
  return { runner, calls };
}

const wranglerArgs = (call: Call) => call.args.slice(2);

describe("the plan's R2 buckets (G2-DUR-001)", () => {
  /** A fake R2: `cf r2 buckets get` and `create`, with the buckets that exist. */
  function r2(existing: string[], failCreate = false) {
    const buckets = new Set(existing);
    return fakeRunner((call) => {
      const [, , verb, name] = call.args;
      if (call.command !== "cf" || call.args[0] !== "r2") throw new Error("not an R2 call");
      if (verb === "get") {
        return buckets.has(String(name))
          ? { stdout: JSON.stringify({ result: { name } }) }
          : { status: 1, stderr: "[10006] The specified bucket does not exist. 404 Not Found" };
      }
      if (verb === "create" && !failCreate) {
        const body = JSON.parse(String(call.args[call.args.indexOf("--body") + 1]));
        buckets.add(body.name);
        return { stdout: JSON.stringify({ result: { name: body.name } }) };
      }
      return { status: 1, stderr: "[10000] Authentication error 403 Forbidden" };
    });
  }

  it("creates only the missing ones, and never deletes or changes another", () => {
    const fake = r2(["cfo-canary-replica"]);
    expect(ensureBuckets(fake.runner, ["cfo-canary-replica", "cfo-canary-artifacts"])).toEqual([
      "cfo-canary-artifacts",
    ]);
    expect(fake.calls.map((c) => c.args.slice(0, 3).join(" "))).toEqual([
      "r2 buckets get",
      "r2 buckets get",
      "r2 buckets create",
      "r2 buckets get",
    ]);
    expect(fake.calls.every((c) => c.options.inherit === false)).toBe(true);
    // Run again: nothing to create.
    const again = r2(["cfo-canary-replica", "cfo-canary-artifacts"]);
    expect(ensureBuckets(again.runner, ["cfo-canary-replica", "cfo-canary-artifacts"])).toEqual([]);
    expect(again.calls.some((c) => c.args.includes("create"))).toBe(false);
  });

  it("stops when a lookup or a creation fails, rather than guess", () => {
    expect(() => ensureBuckets(r2([], true).runner, ["cfo-canary-artifacts"])).toThrow(
      /cf r2 buckets create failed/,
    );
    const unknown = fakeRunner(() => ({ status: 1, stderr: "network unreachable" }));
    expect(() => bucketExists(unknown.runner, "cfo-canary-artifacts")).toThrow(
      /could not tell whether R2 bucket cfo-canary-artifacts exists/,
    );
    expect(bucketExists(r2([]).runner, "cfo-canary-artifacts")).toBe(false);
  });
});

describe("cfTokenApi: the installer's user API tokens through cf (WP3.25)", () => {
  const VALUE = "cfo-canary-r2-token-value-AbCdEf0123456789AbCdEf0123456789AbCd";
  const FORBIDDEN =
    "┌ APIError\n│ [9109] Unauthorized to access requested resource\n│ 403 Forbidden · HTTP /user/tokens\n└\n Check your API token permissions";
  const GROUP = "2".repeat(32);
  const ID = "3".repeat(32);

  /** Every call's arguments, environment and descriptors, with the value nowhere in them. */
  function expectNoValue(calls: readonly Call[]): void {
    for (const call of calls) {
      const outside = JSON.stringify([call.args, call.options.env ?? {}, call.fd3 ?? ""]);
      expect(outside).not.toContain(VALUE);
      expect(call.options.inherit).toBe(false);
    }
  }

  it("creates with the name, the policies and the expiry in flags, and returns the value", async () => {
    const plan = await stagingPlan({ artifacts: { url: "s3://cfo-stg-wp24-artifacts" } });
    const fake = fakeRunner((call) => {
      if (call.args[2] === "permission-groups") {
        return {
          stdout: JSON.stringify([
            { id: "9".repeat(32), name: R2_WRITE_GROUP, scopes: ["com.cloudflare.api.account"] },
            { id: GROUP, name: R2_WRITE_GROUP, scopes: ["com.cloudflare.edge.r2.bucket"] },
          ]),
        };
      }
      return { stdout: JSON.stringify({ id: ID, name: "x", status: "active", value: VALUE }) };
    });
    const api = cfTokenApi(fake.runner);
    const group = api.permissionGroup(R2_WRITE_GROUP);
    expect(group).toBe(GROUP);
    const request = r2TokenRequest(plan, group, Date.UTC(2026, 9, 28));
    expect(api.create(request)).toEqual({ id: ID, value: VALUE });
    expect(fake.calls.map((c) => c.args)).toEqual([
      [
        "user",
        "tokens",
        "permission-groups",
        "list",
        "--name",
        R2_WRITE_GROUP,
        "--scope",
        "com.cloudflare.edge.r2.bucket",
      ],
      [
        "user",
        "tokens",
        "create",
        "--name",
        "cfo-stg-wp24-platform-r2--ins_01hs3f9q2m8z4w7k6t5r1n0ybc--20261028T000000Z",
        "--policies",
        JSON.stringify(request.policies),
        "--expires-on",
        "2026-10-30T00:00:00Z",
      ],
    ]);
    expect(fake.calls.every((c) => c.command === "cf")).toBe(true);
    expectNoValue(fake.calls);
  });

  it("deletes without asking, and never rolls", () => {
    const fake = fakeRunner(() => ({ stdout: JSON.stringify({ id: ID }) }));
    const api = cfTokenApi(fake.runner);
    expect(api.remove(ID)).toBe("deleted");
    expect(fake.calls.map((c) => c.args)).toEqual([["user", "tokens", "delete", ID, "--force"]]);
    expect("roll" in api).toBe(false);
    expectNoValue(fake.calls);
  });

  it("reads one token by its ID: the token, gone (404), or refused (403)", () => {
    const answers: Partial<CommandResult>[] = [
      { stdout: JSON.stringify({ id: ID, name: "n", status: "active", policies: [] }) },
      {
        status: 1,
        stderr: "┌ APIError\n│ [1003] token not found\n│ 404 Not Found · HTTP /user/tokens/x\n└",
      },
      { status: 1, stderr: "│ [9109] Unauthorized\n│ 403 Forbidden · HTTP /user/tokens/x" },
      { stdout: JSON.stringify({ name: "no id" }) },
    ];
    const fake = fakeRunner(() => answers.shift() ?? {});
    const api = cfTokenApi(fake.runner);
    expect(api.get(ID)).toEqual({
      id: ID,
      name: "n",
      status: "active",
      ipLimited: false,
      policies: [],
    });
    expect(api.get(ID)).toBeUndefined();
    expect(() => api.get(ID)).toThrow(TokensUnavailable);
    expect(() => api.get(ID)).toThrow("cf user tokens get answered without a token");
    expect(fake.calls[0]?.args).toEqual(["user", "tokens", "get", ID]);
  });

  it("an OAuth login's answers, as cf printed them on 28 Oct: 403 on list and delete", () => {
    const forbiddenAt = (path: string) =>
      `┌ APIError\n│ [9109] Unauthorized to access requested resource\n│ 403 Forbidden · HTTP ${path}\n└\n → Check your API token permissions`;
    const fake = fakeRunner((call) =>
      call.args[2] === "list"
        ? { status: 1, stderr: forbiddenAt("/user/tokens?per_page=50") }
        : { status: 1, stderr: forbiddenAt(`/user/tokens/${ID}`) },
    );
    const api = cfTokenApi(fake.runner);
    expect(() => api.list()).toThrow(TokensUnavailable);
    expect(() => api.remove(ID)).toThrow(
      "Cloudflare refused `cf user tokens delete` (403): this cf login cannot delete API tokens",
    );
  });

  it("lists every page, expired tokens included", () => {
    const page = (n: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `${n}-${i}`,
        name: `t${n}-${i}`,
        status: "active",
        policies: [],
      }));
    const fake = fakeRunner((call) => {
      const n = Number(call.args[call.args.indexOf("--page") + 1]);
      return { stdout: JSON.stringify(n < 3 ? page(n, 50) : page(n, 7)) };
    });
    const tokens = cfTokenApi(fake.runner).list();
    expect(tokens).toHaveLength(107);
    expect(fake.calls.map((c) => c.args.join(" "))).toEqual([
      "user tokens list --per-page 50 --page 1 --include-expired",
      "user tokens list --per-page 50 --page 2 --include-expired",
      "user tokens list --per-page 50 --page 3 --include-expired",
    ]);
    const endless = fakeRunner(() => ({ stdout: JSON.stringify(page(1, 50)) }));
    expect(() => cfTokenApi(endless.runner).list()).toThrow(/more than 2000 user API tokens/);
  });

  it("reads a listed token's status, expiry, address limits and policies", () => {
    expect(
      apiTokenOf({
        id: ID,
        name: "n",
        status: "active",
        expires_on: "2026-11-01T00:00:00Z",
        not_before: "2026-10-01T00:00:00Z",
        condition: { request_ip: { in: ["192.0.2.0/24"] } },
        policies: [
          {
            id: "p",
            effect: "allow",
            permission_groups: [{ id: GROUP, name: R2_WRITE_GROUP }],
            resources: { r: "*" },
          },
          { permission_groups: "x", resources: ["r"] },
        ],
      }),
    ).toEqual({
      id: ID,
      name: "n",
      status: "active",
      expiresOn: "2026-11-01T00:00:00Z",
      notBefore: "2026-10-01T00:00:00Z",
      ipLimited: true,
      policies: [
        { effect: "allow", permissionGroups: [GROUP], resources: { r: "*" } },
        { permissionGroups: [], resources: {} },
      ],
    });
    expect(apiTokenOf({ id: ID, name: "n", condition: { request_ip: { not_in: [] } } })).toEqual({
      id: ID,
      name: "n",
      ipLimited: false,
      policies: [],
    });
    for (const entry of [null, "x", { id: ID }, { name: "n" }, { id: "", name: "n" }]) {
      expect(apiTokenOf(entry)).toBeUndefined();
    }
    const listed = fakeRunner(() => ({ stdout: JSON.stringify([null, { id: ID, name: "n" }]) }));
    expect(
      cfTokenApi(listed.runner)
        .list()
        .map((t) => t.id),
    ).toEqual([ID]);
  });

  it("turns Cloudflare's 403 into TokensUnavailable, for every call", () => {
    const fake = fakeRunner(() => ({ status: 1, stderr: FORBIDDEN }));
    const api = cfTokenApi(fake.runner);
    expect(() => api.permissionGroup(R2_WRITE_GROUP)).toThrow(TokensUnavailable);
    expect(() => api.list()).toThrow(TokensUnavailable);
    expect(() => api.remove(ID)).toThrow(TokensUnavailable);
    expect(() => api.create({ name: "n", policies: [] })).toThrow(
      /Cloudflare refused `cf user tokens create` \(403\): this cf login cannot make API tokens/,
    );
  });

  it("deletes a token that is already gone as absent, and reports other failures masked", () => {
    const gone = fakeRunner(() => ({
      status: 1,
      stderr: "┌ APIError\n│ [1003] token not found\n│ 404 Not Found · HTTP /user/tokens/x\n└",
    }));
    expect(cfTokenApi(gone.runner).remove(ID)).toBe("absent");
    const down = fakeRunner(() => ({ status: 1, stderr: `[10000] failed for ${ID}` }));
    expect(() => cfTokenApi(down.runner).remove(ID)).toThrow(
      "cf user tokens delete failed: [10000] failed for <id>",
    );
  });

  it("never echoes what cf printed, where a value would be, in an error", () => {
    const halfAnswers = [
      JSON.stringify({ id: ID }),
      JSON.stringify({ value: VALUE }),
      JSON.stringify(null),
      `not json ${VALUE}`,
    ];
    for (const stdout of halfAnswers) {
      const fake = fakeRunner(() => ({ stdout }));
      let message = "";
      try {
        cfTokenApi(fake.runner).create({ name: "n", policies: [] });
      } catch (error) {
        message = String(error);
      }
      expect(message).toMatch(/cf user tokens create (answered without|printed something)/);
      expect(message).not.toContain(VALUE);
    }
    const failing = fakeRunner(() => ({ status: 1, stderr: `boom ${VALUE}` }));
    const create = () => cfTokenApi(failing.runner).create({ name: "n", policies: [] });
    expect(create).toThrow(/^cf user tokens create failed: boom /);
    expect(create).not.toThrow(VALUE);
  });

  it("refuses a permission group it cannot find exactly once", () => {
    for (const listed of [[], [{ id: GROUP, name: R2_WRITE_GROUP, scopes: [] }], {}]) {
      const fake = fakeRunner(() => ({ stdout: JSON.stringify(listed) }));
      expect(() => cfTokenApi(fake.runner).permissionGroup(R2_WRITE_GROUP)).toThrow(
        `Cloudflare lists 0 permission groups named "${R2_WRITE_GROUP}"`,
      );
    }
  });

  it("finds the one account the login reaches, and refuses none or several", () => {
    const one = fakeRunner(() => ({ stdout: JSON.stringify([{ id: "1".repeat(32), name: "a" }]) }));
    expect(soleAccount(one.runner)).toBe("1".repeat(32));
    expect(one.calls[0]?.args).toEqual(["accounts", "list"]);
    const none = fakeRunner(() => ({ stdout: "[]" }));
    expect(() => soleAccount(none.runner)).toThrow(/reaches no Cloudflare account/);
    const two = fakeRunner(() => ({ stdout: JSON.stringify([{ id: "a" }, { id: "b" }, {}]) }));
    expect(() => soleAccount(two.runner)).toThrow(/reaches 2 accounts; choose one with --account/);
  });
});

describe("cfAccessApi: Access in the installer's account through cf (WP3.31)", () => {
  const FORBIDDEN =
    "┌ APIError\n│ [10000] Authentication error\n│ 403 Forbidden · HTTP /access/apps\n└";
  const MISSING = "┌ APIError\n│ [11021] access.api.error.not_found\n│ 404 Not Found · HTTP\n└";
  const ID = "0f0e0d0c-0b0a-4009-8807-060504030201";

  it("reads the team domain, and tells an account without a Zero Trust organization", () => {
    const answers: Partial<CommandResult>[] = [
      { stdout: JSON.stringify({ result: { auth_domain: "team.cloudflareaccess.com" } }) },
      { status: 1, stderr: "┌ APIError\n│ [9999] not found\n│ 404 Not Found · HTTP\n└" },
      { stdout: JSON.stringify({ result: { name: "x" } }) },
      { status: 1, stderr: "network unreachable owner-canary@example.test" },
    ];
    const fake = fakeRunner(() => answers.shift() ?? {});
    const api = cfAccessApi(fake.runner);
    expect(api.teamDomain()).toBe("team.cloudflareaccess.com");
    expect(api.teamDomain()).toBeUndefined();
    // An answer without a team domain is uncertainty, never "no organization" (Codex r1-4).
    expect(() => api.teamDomain()).toThrow("answered without a team domain");
    expect(() => api.teamDomain()).toThrow(
      "cf zero-trust organization get failed: network unreachable <email>",
    );
    expect(fake.calls.map((c) => c.args)).toEqual(
      Array.from({ length: 4 }, () => ["zero-trust", "organization", "get"]),
    );
    expect(fake.calls.every((c) => c.command === "cf" && c.options.inherit === false)).toBe(true);
  });

  it("lists every application in the account page by page, never a filtered listing (Codex r1-1)", () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `app-${i}` }));
    const answers = [page(100), page(3)];
    const fake = fakeRunner(() => ({ stdout: JSON.stringify(answers.shift() ?? []) }));
    expect(cfAccessApi(fake.runner).apps()).toHaveLength(103);
    expect(fake.calls.map((c) => c.args)).toEqual(
      [1, 2].map((n) => [
        "zero-trust",
        "access",
        "applications",
        "list",
        "--per-page",
        "100",
        "--page",
        String(n),
      ]),
    );
    expect(fake.calls.some((c) => c.args.includes("--domain") || c.args.includes("--exact"))).toBe(
      false,
    );
    const endless = fakeRunner(() => ({ stdout: JSON.stringify(page(100)) }));
    expect(() => cfAccessApi(endless.runner).apps()).toThrow(
      /more than 2000 Access applications in the account: too many to check/,
    );
    const odd = fakeRunner(() => ({ stdout: JSON.stringify({ result: { not: "a list" } }) }));
    expect(() => cfAccessApi(odd.runner).apps()).toThrow(/answered no list/);
  });

  it("reads one application by its ID: gone (404), refused (403) or broken are told apart", () => {
    const answers: Partial<CommandResult>[] = [
      { stdout: JSON.stringify({ result: { id: ID, name: "x" } }) },
      { status: 1, stderr: MISSING },
      { status: 1, stderr: FORBIDDEN },
      { stdout: JSON.stringify({ result: null }) },
      { status: 1, stderr: "timeout" },
    ];
    const fake = fakeRunner(() => answers.shift() ?? {});
    const api = cfAccessApi(fake.runner);
    expect(api.app(ID)).toEqual({ id: ID, name: "x" });
    expect(api.app(ID)).toBeUndefined();
    expect(() => api.app(ID)).toThrow(AccessUnavailable);
    expect(() => api.app(ID)).toThrow(/answered without an application/);
    expect(() => api.app(ID)).toThrow(/cf zero-trust access applications failed: timeout/);
    expect(fake.calls[0]?.args).toEqual(["zero-trust", "access", "applications", "get", ID]);
  });

  it("creates an application with its body as the one flag, and returns the new ID", () => {
    const body = { type: "self_hosted", name: "cloudflare-omnigent-web--0a1b2c3d" };
    const answers: Partial<CommandResult>[] = [
      { stdout: JSON.stringify({ result: { id: ID } }) },
      { status: 1, stderr: FORBIDDEN },
      { stdout: JSON.stringify({ result: {} }) },
    ];
    const fake = fakeRunner(() => answers.shift() ?? {});
    const api = cfAccessApi(fake.runner);
    expect(api.create(body)).toBe(ID);
    expect(fake.calls[0]?.args).toEqual([
      "zero-trust",
      "access",
      "applications",
      "create",
      "--body",
      JSON.stringify(body),
    ]);
    expect(() => api.create(body)).toThrow(AccessUnavailable);
    expect(() => api.create(body)).toThrow(/answered without an ID/);
  });

  it("lists the login methods and adds the one-time PIN method", () => {
    const answers: Partial<CommandResult>[] = [
      {
        stdout: JSON.stringify([
          { id: "idp-1", type: "onetimepin", name: "One-time PIN" },
          { id: 7, type: "github" },
          null,
        ]),
      },
      { stdout: JSON.stringify({ result: { id: "idp-2" } }) },
      { status: 1, stderr: FORBIDDEN },
      { status: 1, stderr: FORBIDDEN },
      { stdout: JSON.stringify({ result: {} }) },
    ];
    const fake = fakeRunner(() => answers.shift() ?? {});
    const api = cfAccessApi(fake.runner);
    expect(api.identityProviders()).toEqual([{ id: "idp-1", type: "onetimepin" }]);
    expect(api.createOneTimePin()).toBe("idp-2");
    expect(fake.calls.map((c) => c.args)).toEqual([
      ["zero-trust", "identity-providers", "list", "--per-page", "100"],
      [
        "zero-trust",
        "identity-providers",
        "create",
        "--body",
        JSON.stringify({ name: "One-time PIN", type: "onetimepin", config: {} }),
      ],
    ]);
    expect(() => api.identityProviders()).toThrow(AccessUnavailable);
    expect(() => api.createOneTimePin()).toThrow(AccessUnavailable);
    expect(() => api.createOneTimePin()).toThrow(/answered without an ID/);
  });

  it("deletes an application without asking: deleted, absent, refused or failed", () => {
    const answers: Partial<CommandResult>[] = [
      {},
      { status: 1, stderr: MISSING },
      { status: 1, stderr: FORBIDDEN },
      { status: 1, stderr: "timeout" },
    ];
    const fake = fakeRunner(() => answers.shift() ?? {});
    const api = cfAccessApi(fake.runner);
    expect(api.remove(ID)).toBe("deleted");
    expect(api.remove(ID)).toBe("absent");
    expect(() => api.remove(ID)).toThrow(AccessUnavailable);
    expect(() => api.remove(ID)).toThrow(
      "cf zero-trust access applications delete failed: timeout",
    );
    expect(fake.calls[0]?.args).toEqual([
      "zero-trust",
      "access",
      "applications",
      "delete",
      ID,
      "--force",
    ]);
  });
});

describe("the staging tool's stdio (Codex WP3.25 r2-1)", () => {
  it("hands the bootstrap's locks to the tool, which keeps them if the bootstrap dies", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfo-bootstrap-stdio-"));
    try {
      expect(stagingToolStdio(false)).toEqual(["ignore", "pipe", "inherit"]);
      const release = acquireLock(join(dir, "x.lock"), 0, "test");
      const stdio = stagingToolStdio(true) as unknown[];
      expect(stdio.slice(0, 3)).toEqual(["pipe", "pipe", "inherit"]);
      expect(stdio).toHaveLength(4);
      expect(typeof stdio[3]).toBe("number");
      release();
      expect(stagingToolStdio(true)).toEqual(["pipe", "pipe", "inherit"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cfJson and workerMissing", () => {
  it("unwraps cf's result, and reports failures without their secrets", () => {
    const { runner } = fakeRunner(() => ({ stdout: '{"result":{"a":1}}' }));
    expect(cfJson(runner, ["x"])).toEqual({ a: 1 });
    const bare = fakeRunner(() => ({ stdout: "[1]" }));
    expect(cfJson(bare.runner, ["x"])).toEqual([1]);
    const failing = fakeRunner(() => ({ status: 1, stderr: `denied for ${OWNER_EMAIL}` }));
    expect(() => cfJson(failing.runner, ["zero-trust", "access", "applications"])).toThrow(
      "cf zero-trust access applications failed: denied for <email>",
    );
    const garbled = fakeRunner(() => ({ stdout: "not json" }));
    expect(() => cfJson(garbled.runner, ["o11y"])).toThrow(/other than JSON/);
  });

  it("recognises Wrangler's answer for a missing Worker", () => {
    expect(workerMissing({ status: 1, stdout: "", stderr: 'Worker "x" not found.' })).toBe(true);
    expect(
      workerMissing({ status: 1, stdout: "", stderr: "Authentication error [code: 10000]" }),
    ).toBe(false);
  });
});

describe("queryWorkerLogs", () => {
  it("asks Workers Logs for the Worker's events, page by page", () => {
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({
        $metadata: { id: `e${from + i}` },
        timestamp: from + i,
      }));
    const { runner, calls } = fakeRunner((call) => {
      const body = JSON.parse(call.args[4] as string);
      return {
        stdout: JSON.stringify({
          result: { events: { events: body.offset ? page(3, 100) : page(100, 0) } },
        }),
      };
    });
    const events = queryWorkerLogs(runner, "cloudflare-omnigent", 1000.4, 2000.6);
    expect(events).toHaveLength(103);
    expect(calls.map((c) => c.args.slice(0, 4))).toEqual([
      ["o11y", "telemetry", "query", "--body"],
      ["o11y", "telemetry", "query", "--body"],
    ]);
    const first = JSON.parse(calls[0]?.args[4] as string);
    expect(first).toMatchObject({
      timeframe: { from: 1000, to: 2001 },
      view: "events",
      parameters: {
        filters: [
          {
            key: "$workers.scriptName",
            operation: "eq",
            type: "string",
            value: "cloudflare-omnigent",
          },
        ],
      },
    });
    expect(JSON.parse(calls[1]?.args[4] as string).offset).toBe("e99");
    const empty = fakeRunner(() => ({ stdout: "{}" }));
    expect(queryWorkerLogs(empty.runner, "w", 0, 1)).toEqual([]);
  });
});

describe("accountCloud: Wrangler with the installer's login", () => {
  it("lists secret names with a configuration that pins the account and the Worker", async () => {
    const plan = await accountPlan();
    const { runner, calls } = fakeRunner(() => ({
      stdout: '[{"name":"B","type":"secret_text"},{"name":"A","type":"secret_text"}]',
    }));
    const cloud = accountCloud(plan, { workerDir: WORKER, runner });
    expect(await cloud.secretNames(plan.platformWorker)).toEqual(["B", "A"]);
    const call = calls[0] as Call;
    expect(call.command).toBe(process.execPath);
    expect(wranglerArgs(call)).toEqual([
      "secret",
      "list",
      "--config",
      expect.any(String),
      "--name",
      plan.platformWorker,
      "--format",
      "json",
    ]);
    const config = call.files[call.args[5] as string];
    expect(JSON.parse(config?.text ?? "{}")).toEqual({
      name: plan.platformWorker,
      account_id: plan.accountId,
    });
    expect(existsSync(call.args[5] as string)).toBe(false);
    expect(call.options).toMatchObject({
      inherit: false,
      env: { WRANGLER_WRITE_LOGS: "false", WRANGLER_LOG_SANITIZE: "true" },
    });
  });

  it("answers null for a missing Worker, and fails on anything else", async () => {
    const plan = await accountPlan();
    const missing = fakeRunner(() => ({
      status: 1,
      stderr: 'Worker "cloudflare-omnigent" not found.',
    }));
    expect(
      await accountCloud(plan, { workerDir: WORKER, runner: missing.runner }).secretNames("x"),
    ).toBeNull();
    const broken = fakeRunner(() => ({ status: 1, stderr: "Authentication error" }));
    await expect(
      accountCloud(plan, { workerDir: WORKER, runner: broken.runner }).secretNames("x"),
    ).rejects.toThrow("wrangler secret list exited with 1");
  });

  it("deploys a rendered configuration, with the secrets only on descriptor 3", async () => {
    const plan = await accountPlan();
    const { runner, calls } = fakeRunner(() => ({}));
    const cloud = accountCloud(plan, { workerDir: WORKER, runner });
    const config = { name: plan.platformWorker, main: "src/index.ts" };
    await cloud.deployPlatform(plan, config, { [PASSWORD_SECRET]: OWNER_PASSWORD });
    const call = calls[0] as Call;
    const path = call.args[4] as string;
    // Next to the checked-in configurations, under a name unique to this run (review r1, F2).
    expect(path).toMatch(
      new RegExp(`^${WORKER}/\\.cfo-bootstrap\\.cloudflare-omnigent\\.[0-9a-f]{12}\\.jsonc$`),
    );
    expect(wranglerArgs(call)).toEqual(["deploy", "--config", path, "--secrets-file", "/dev/fd/3"]);
    expect(call.options).toMatchObject({ inherit: true, cwd: WORKER });
    expect(JSON.parse(call.fd3 ?? "{}")).toEqual({ [PASSWORD_SECRET]: OWNER_PASSWORD });
    expect(call.args.join(" ")).not.toContain(OWNER_PASSWORD);
    expect(call.files[path]).toEqual({ text: `${JSON.stringify(config, null, 2)}\n`, mode: 0o600 });
    expect(existsSync(path)).toBe(false);
    await cloud.deployWeb(plan, { name: plan.webWorker });
    const web = calls[1] as Call;
    expect(wranglerArgs(web)).toEqual([
      "deploy",
      "--config",
      expect.stringContaining(".cfo-bootstrap.cloudflare-omnigent-web."),
    ]);
    expect(web.options.fds).toBeUndefined();
  });

  it("gives every deploy its own rendered file, even for the same Worker name", async () => {
    const plan = await accountPlan();
    const { runner, calls } = fakeRunner(() => ({}));
    const cloud = accountCloud(plan, { workerDir: WORKER, runner });
    await cloud.deployWeb(plan, { name: "same" });
    await cloud.deployWeb(plan, { name: "same" });
    expect(calls[0]?.args[4]).not.toBe(calls[1]?.args[4]);
  });

  it("removes the rendered configuration when the deploy fails", async () => {
    const plan = await accountPlan();
    const { runner, calls } = fakeRunner(() => ({ status: 1 }));
    await expect(
      accountCloud(plan, { workerDir: WORKER, runner }).deployWeb(plan, { name: "w" }),
    ).rejects.toThrow("wrangler deploy exited with 1");
    expect(existsSync(calls[0]?.args[4] as string)).toBe(false);
  });

  it("releases with one cf workers secrets bulk, which fails for a missing Worker (review r1, F7)", async () => {
    const plan = await accountPlan();
    const { runner, calls } = fakeRunner(() => ({ stdout: "{}" }));
    await accountCloud(plan, { workerDir: WORKER, runner }).updateSecrets(
      plan.platformWorker,
      RELEASE_CHANGES,
    );
    const call = calls[0] as Call;
    expect([call.command, ...call.args]).toEqual([
      "cf",
      "workers",
      "secrets",
      "bulk",
      "--worker",
      plan.platformWorker,
      "--secrets",
      "@/dev/fd/3",
    ]);
    expect(JSON.parse(call.fd3 ?? "{}")).toEqual({
      [INITIALIZED_SECRET]: { name: INITIALIZED_SECRET, type: "secret_text", text: "true" },
      [PASSWORD_SECRET]: null,
    });
    const missing = fakeRunner(() => ({
      status: 1,
      stderr: "[10007] This Worker does not exist on your account.",
    }));
    await expect(
      accountCloud(plan, { workerDir: WORKER, runner: missing.runner }).updateSecrets(
        "w",
        RELEASE_CHANGES,
      ),
    ).rejects.toThrow("cf workers secrets bulk failed: [10007] This Worker does not exist");
    // A secret value set this way also reaches cf only on descriptor 3.
    const set = fakeRunner(() => ({ stdout: "{}" }));
    await accountCloud(plan, { workerDir: WORKER, runner: set.runner }).updateSecrets("w", {
      [PASSWORD_SECRET]: OWNER_PASSWORD,
    });
    expect(set.calls[0]?.args.join(" ")).not.toContain(OWNER_PASSWORD);
  });

  it("knows a Worker as this installation's by its active version's CFO_INSTALLATION_ID (r2-1)", async () => {
    const plan = await accountPlan();
    const deployments = { deployments: [{ versions: [{ version_id: "v7", percentage: 100 }] }] };
    const version = (text?: string) => ({
      bindings: [
        { type: "durable_object_namespace", name: "OMNIGENT" },
        ...(text === undefined
          ? []
          : [
              { type: "plain_text", name: "CFO_INSTALLATION_ID", text },
              // Its other plain-text variables come along (WP3.35); secrets never have text.
              { type: "plain_text", name: "CFO_PLATFORM_FEATURES", text: "key-service" },
              { type: "secret_text", name: "SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET" },
              { type: "plain_text", name: 7, text: "x" },
            ]),
      ],
    });
    const answers: Partial<CommandResult>[] = [
      { stdout: JSON.stringify(deployments) },
      { stdout: JSON.stringify({ result: version(plan.installationId) }) },
      { stdout: JSON.stringify(deployments) },
      { stdout: JSON.stringify(version()) },
      { status: 1, stderr: "│ [10007] This Worker does not exist on your account." },
      { stdout: JSON.stringify({ deployments: [] }) },
      { status: 1, stderr: "│ [10000] Authentication error" },
    ];
    const { runner, calls } = fakeRunner(() => answers.shift() ?? {});
    const cloud = accountCloud(plan, { workerDir: WORKER, runner });
    expect(await cloud.workerInstallation("w")).toEqual({
      exists: true,
      installationId: plan.installationId,
      vars: { CFO_INSTALLATION_ID: plan.installationId, CFO_PLATFORM_FEATURES: "key-service" },
    });
    expect(calls[1]?.args).toEqual(["workers", "versions", "get", "--worker-id", "w", "v7"]);
    expect(await cloud.workerInstallation("w")).toEqual({
      exists: true,
      installationId: undefined,
      vars: {},
    });
    expect(await cloud.workerInstallation("w")).toEqual({ exists: false });
    expect(await cloud.workerInstallation("w")).toEqual({
      exists: true,
      installationId: undefined,
    });
    await expect(cloud.workerInstallation("w")).rejects.toThrow(
      /cf workers deployments list failed/,
    );
  });

  it("does not send a release whose window has passed (r2-2)", async () => {
    const plan = await accountPlan();
    const { runner, calls } = fakeRunner(() => ({ stdout: "{}" }));
    const cloud = accountCloud(plan, { workerDir: WORKER, runner });
    expect(await cloud.updateSecrets("w", RELEASE_CHANGES, Date.now() - 1)).toBe("expired");
    expect(calls).toEqual([]);
    expect(await cloud.updateSecrets("w", RELEASE_CHANGES, Date.now() + 60_000)).toBe("sent");
    expect(await cloud.updateSecrets("w", RELEASE_CHANGES)).toBe("sent");
    expect(calls).toHaveLength(2);
  });

  it("reads the version serving all traffic from the newest deployment", async () => {
    const plan = await accountPlan();
    const answers: unknown[] = [
      {
        deployments: [
          { versions: [{ version_id: "v9", percentage: 100 }] },
          { versions: [{ version_id: "v1", percentage: 100 }] },
        ],
      },
      {
        result: {
          deployments: [
            {
              versions: [
                { version_id: "a", percentage: 60 },
                { version_id: "b", percentage: 40 },
              ],
            },
          ],
        },
      },
      { deployments: [] },
      { deployments: [{ versions: [{ version_id: "", percentage: 100 }] }] },
    ];
    const { runner, calls } = fakeRunner(() => ({ stdout: JSON.stringify(answers.shift()) }));
    const cloud = accountCloud(plan, { workerDir: WORKER, runner });
    expect(await cloud.activeVersion(plan.platformWorker)).toBe("v9");
    expect(await cloud.activeVersion(plan.platformWorker)).toBeUndefined();
    expect(await cloud.activeVersion(plan.platformWorker)).toBeUndefined();
    expect(await cloud.activeVersion(plan.platformWorker)).toBeUndefined();
    expect(calls[0]?.args).toEqual([
      "workers",
      "deployments",
      "list",
      "--worker",
      plan.platformWorker,
    ]);
  });

  it("reads Access and Workers Logs with cf, read-only", async () => {
    const plan = await accountPlan();
    const { runner, calls } = fakeRunner((call) => {
      if (call.args[0] === "o11y") return { stdout: '{"events":{"events":[]}}' };
      if (call.args[2] === "applications") {
        return {
          stdout: JSON.stringify([
            {
              id: "a",
              name: "omnigent",
              domain: plan.hostname,
              type: "self_hosted",
              aud: "b".repeat(64),
              same_site_cookie_attribute: "lax",
              policies: [{ decision: "allow", include: [{ email: { email: OWNER_EMAIL } }] }],
            },
          ]),
        };
      }
      return { stdout: '{"auth_domain":"team.cloudflareaccess.com"}' };
    });
    const cloud = accountCloud(plan, { workerDir: WORKER, runner });
    expect(await cloud.access(plan)).toEqual({
      teamDomain: "team.cloudflareaccess.com",
      aud: "b".repeat(64),
    });
    expect(await cloud.logs(plan.platformWorker, 0, 1)).toEqual([]);
    expect(calls.map((c) => [c.command, ...c.args.slice(0, 4)])).toEqual([
      ["cf", "zero-trust", "access", "applications", "list"],
      ["cf", "zero-trust", "organization", "get"],
      ["cf", "o11y", "telemetry", "query", "--body"],
    ]);
  });
});

describe("stagingCloud: through the guarded staging tool", () => {
  async function staging(
    answer: (
      args: readonly string[],
      input?: string,
    ) => { status: number; stdout: string } = () => ({ status: 0, stdout: "" }),
  ) {
    const plan = await stagingPlan();
    const tool: { args: readonly string[]; input?: string; files: Record<string, string> }[] = [];
    let apps: unknown[] = [];
    const { runner, calls } = fakeRunner((call) => {
      if (call.args[2] === "applications") return { stdout: JSON.stringify(apps) };
      if (call.args[0] === "zero-trust")
        return { stdout: '{"auth_domain":"team.cloudflareaccess.com"}' };
      return { stdout: '{"events":{"events":[]}}' };
    });
    const cloud = stagingCloud(plan, {
      root: `${WORKER}/..`,
      base: baseConfigs(),
      runner,
      stg: (args, input) => {
        const files: Record<string, string> = {};
        const config = args[args.indexOf("--config") + 1];
        if (args.includes("--config") && config && existsSync(config))
          files[config] = readFileSync(config, "utf8");
        tool.push({ args, ...(input === undefined ? {} : { input }), files });
        if (args[0] === "deploy" && args[2] === "wp24-web") {
          apps = [
            {
              id: "a",
              name: "cfo-stg-wp24-web",
              domain: plan.hostname,
              type: "self_hosted",
              aud: "c".repeat(64),
              same_site_cookie_attribute: "lax",
              policies: [{ decision: "allow", include: [{ email: { email: OWNER_EMAIL } }] }],
            },
          ];
        }
        return answer(args, input);
      },
    });
    return { plan, cloud, tool, calls };
  }

  it("deploys through stg deploy, with the secrets on stdin", async () => {
    const { plan, cloud, tool } = await staging();
    await cloud.deployPlatform(
      plan,
      { name: plan.platformWorker },
      { [PASSWORD_SECRET]: OWNER_PASSWORD },
    );
    const [deploy] = tool;
    const path = deploy?.args[6] as string;
    expect(path).toMatch(/\/worker\/\.cfo-bootstrap\.cfo-stg-wp24-platform\.[0-9a-f]{12}\.jsonc$/);
    expect(deploy?.args).toEqual([
      "deploy",
      "--suffix",
      "wp24-platform",
      "--owner",
      "WP2.4",
      "--config",
      path,
      "--days",
      "1",
      "--secrets-stdin",
    ]);
    expect(JSON.parse(deploy?.input ?? "{}")).toEqual({ [PASSWORD_SECRET]: OWNER_PASSWORD });
    expect(deploy?.args.join(" ")).not.toContain(OWNER_PASSWORD);
    expect(deploy?.files[path]).toContain(plan.platformWorker);
    expect(existsSync(path)).toBe(false);
    await cloud.deployWeb(plan, { name: plan.webWorker });
    expect(tool[1]?.args).not.toContain("--secrets-stdin");
    expect(tool[1]?.input).toBeUndefined();
  });

  it("creates the web Worker's Access with a first deploy that has no ingress variables", async () => {
    const { plan, cloud, tool } = await staging();
    expect(await cloud.access(plan)).toEqual({
      teamDomain: "team.cloudflareaccess.com",
      aud: "c".repeat(64),
    });
    expect(tool).toHaveLength(1);
    const rendered = JSON.parse(Object.values(tool[0]?.files ?? {})[0] ?? "{}");
    // No ingress variables yet (the Worker answers 503), but the installation's ID.
    expect(rendered.vars).toEqual({ CFO_INSTALLATION_ID: plan.installationId });
    expect(rendered.routes).toBeUndefined();
    expect(rendered.durable_objects.bindings[0].script_name).toBe(plan.platformWorker);
    // Once it exists, Access is only read.
    await cloud.access(plan);
    expect(tool).toHaveLength(1);
  });

  it("changes and lists secrets through the tool", async () => {
    const { plan, cloud, tool } = await staging((args) =>
      args[0] === "secret-names"
        ? { status: 0, stdout: 'note\n["A","B"]\n' }
        : { status: 0, stdout: "" },
    );
    expect(await cloud.secretNames(plan.platformWorker)).toEqual(["A", "B"]);
    await cloud.updateSecrets(plan.platformWorker, RELEASE_CHANGES);
    expect(tool[1]?.args).toEqual(["secrets", "--suffix", "wp24-platform", "--owner", "WP2.4"]);
    expect(JSON.parse(tool[1]?.input ?? "{}")).toEqual(RELEASE_CHANGES);
    expect(await cloud.logs(plan.platformWorker, 0, 1)).toEqual([]);
  });

  it("passes the release's window to the tool, and reads its 'window passed' exit as expired", async () => {
    const { plan, cloud, tool } = await staging((args) =>
      args[0] === "secrets"
        ? { status: args.includes("--not-after") ? 3 : 0, stdout: "" }
        : { status: 0, stdout: "" },
    );
    expect(await cloud.updateSecrets(plan.platformWorker, RELEASE_CHANGES, 1792670000000.6)).toBe(
      "expired",
    );
    expect(tool[0]?.args).toEqual([
      "secrets",
      "--suffix",
      "wp24-platform",
      "--owner",
      "WP2.4",
      "--not-after",
      "1792670000000",
    ]);
    expect(await cloud.updateSecrets(plan.platformWorker, RELEASE_CHANGES)).toBe("sent");
    expect(await cloud.workerInstallation(plan.webWorker)).toEqual({
      exists: true,
      installationId: undefined,
    });
  });

  it("answers null for no Worker, and fails on a refusal or an odd answer", async () => {
    const nothing = await staging(() => ({ status: 0, stdout: "null\n" }));
    expect(await nothing.cloud.secretNames(nothing.plan.platformWorker)).toBeNull();
    const odd = await staging(() => ({ status: 0, stdout: "[1]\n" }));
    await expect(odd.cloud.secretNames(odd.plan.platformWorker)).rejects.toThrow(/list of names/);
    const refused = await staging(() => ({ status: 1, stdout: "" }));
    await expect(
      refused.cloud.updateSecrets(refused.plan.platformWorker, RELEASE_CHANGES),
    ).rejects.toThrow("stg secrets exited with 1");
    await expect(refused.cloud.secretNames("cloudflare-omnigent")).rejects.toThrow(
      /not one of this installation's/,
    );
  });

  it("is only for a staging installation", async () => {
    const plan = await accountPlan();
    expect(() => stagingCloud(plan, { root: "/", base: baseConfigs() })).toThrow(
      "not a staging installation",
    );
  });

  it("runs the real staging tool as a child, the secrets only on its stdin", async () => {
    const root = mkdtempSync(join(tmpdir(), "cfo-bootstrap-root-"));
    try {
      mkdirSync(join(root, "scripts", "staging"), { recursive: true });
      mkdirSync(join(root, "worker"));
      // A stand-in for stg.ts that reports what it received.
      writeFileSync(
        join(root, "scripts", "staging", "stg.ts"),
        [
          'import { readFileSync, appendFileSync } from "node:fs";',
          "const args = process.argv.slice(2);",
          'const input = args.includes("--secrets-stdin") || args[0] === "secrets" ? readFileSync(0, "utf8") : null;',
          'appendFileSync(process.env.CFO_FAKE_STG_LOG, JSON.stringify({ args, input }) + "\\n");',
          'if (args[0] === "secret-names") console.log(JSON.stringify(["X"]));',
          'if (args[0] === "secrets" && JSON.parse(input).FAIL === null) process.exit(4);',
        ].join("\n"),
      );
      const log = join(root, "stg.log");
      process.env.CFO_FAKE_STG_LOG = log;
      const plan = await stagingPlan();
      const cloud = stagingCloud(plan, { root, base: baseConfigs() });
      expect(await cloud.secretNames(plan.platformWorker)).toEqual(["X"]);
      await cloud.deployPlatform(
        plan,
        { name: plan.platformWorker },
        { [PASSWORD_SECRET]: OWNER_PASSWORD },
      );
      await cloud.updateSecrets(plan.platformWorker, RELEASE_CHANGES);
      await expect(cloud.updateSecrets(plan.platformWorker, { FAIL: null })).rejects.toThrow(
        "stg secrets exited with 4",
      );
      const seen = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(seen.map((s: { args: string[] }) => s.args[0])).toEqual([
        "secret-names",
        "deploy",
        "secrets",
        "secrets",
      ]);
      expect(JSON.parse(seen[1].input)).toEqual({ [PASSWORD_SECRET]: OWNER_PASSWORD });
      expect(seen[1].args.join(" ")).not.toContain(OWNER_PASSWORD);
      expect(JSON.parse(seen[2].input)).toEqual(RELEASE_CHANGES);
    } finally {
      delete process.env.CFO_FAKE_STG_LOG;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
