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
        ...(text === undefined ? [] : [{ type: "plain_text", name: "CFO_INSTALLATION_ID", text }]),
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
    });
    expect(calls[1]?.args).toEqual(["workers", "versions", "get", "--worker-id", "w", "v7"]);
    expect(await cloud.workerInstallation("w")).toEqual({
      exists: true,
      installationId: undefined,
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
