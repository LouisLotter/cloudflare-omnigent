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
import { accountCloud, cfJson, queryWorkerLogs, workerMissing } from "../cloud.ts";
import { INITIALIZED_SECRET, PASSWORD_SECRET, RELEASE_CHANGES } from "../settings.ts";
import { stagingCloud } from "../staging.ts";
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
    const path = `${WORKER}/.cfo-bootstrap.cloudflare-omnigent.jsonc`;
    expect(wranglerArgs(call)).toEqual(["deploy", "--config", path, "--secrets-file", "/dev/fd/3"]);
    expect(call.options).toMatchObject({ inherit: true, cwd: WORKER });
    expect(JSON.parse(call.fd3 ?? "{}")).toEqual({ [PASSWORD_SECRET]: OWNER_PASSWORD });
    expect(call.args.join(" ")).not.toContain(OWNER_PASSWORD);
    expect(call.files[path]).toEqual({ text: `${JSON.stringify(config, null, 2)}\n`, mode: 0o600 });
    expect(existsSync(path)).toBe(false);
    await cloud.deployWeb(plan, { name: plan.webWorker });
    expect(wranglerArgs(calls[1] as Call)).toEqual([
      "deploy",
      "--config",
      `${WORKER}/.cfo-bootstrap.cloudflare-omnigent-web.jsonc`,
    ]);
    expect(calls[1]?.options.fds).toBeUndefined();
  });

  it("removes the rendered configuration when the deploy fails", async () => {
    const plan = await accountPlan();
    const { runner } = fakeRunner(() => ({ status: 1 }));
    await expect(
      accountCloud(plan, { workerDir: WORKER, runner }).deployWeb(plan, { name: "w" }),
    ).rejects.toThrow("wrangler deploy exited with 1");
    expect(existsSync(`${WORKER}/.cfo-bootstrap.w.jsonc`)).toBe(false);
  });

  it("releases in one wrangler secret bulk, the changes on descriptor 3", async () => {
    const plan = await accountPlan();
    const { runner, calls } = fakeRunner(() => ({}));
    await accountCloud(plan, { workerDir: WORKER, runner }).updateSecrets(
      plan.platformWorker,
      RELEASE_CHANGES,
    );
    const call = calls[0] as Call;
    expect(wranglerArgs(call)).toEqual([
      "secret",
      "bulk",
      "/dev/fd/3",
      "--config",
      expect.any(String),
      "--name",
      plan.platformWorker,
    ]);
    expect(JSON.parse(call.fd3 ?? "{}")).toEqual({
      [INITIALIZED_SECRET]: "true",
      [PASSWORD_SECRET]: null,
    });
    const failing = fakeRunner(() => ({ status: 2 }));
    await expect(
      accountCloud(plan, { workerDir: WORKER, runner: failing.runner }).updateSecrets(
        "w",
        RELEASE_CHANGES,
      ),
    ).rejects.toThrow("wrangler secret bulk exited with 2");
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
    const path = `${WORKER}/.cfo-bootstrap.cfo-stg-wp24-platform.jsonc`;
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
    expect(rendered.vars).toBeUndefined();
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
