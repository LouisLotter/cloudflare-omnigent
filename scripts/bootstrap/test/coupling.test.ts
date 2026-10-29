// Couplings the bootstrap depends on, checked against the other side's own code:
//   - the server image (WP2.3) reads the environment the bootstrap gives it, before and after the
//     release, with its own parser (images/server/cfo_server/config.py, standard library only);
//   - the bootstrap script never talks to the installation, and never touches Access or service
//     tokens; besides its deploys it creates only a missing R2 bucket of the plan, and the
//     installation's own R2 user API token, which it may also roll or delete (WP3.25).

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serverContainerEnv } from "../../../worker/src/server/server-env.ts";
import {
  type Installation,
  installationProblems,
  PASSWORD_SECRET,
  platformVars,
  RELEASE_CHANGES,
  secretsToAdd,
} from "../settings.ts";
import { accountPlan, OWNER_PASSWORD, ROOT, stagingPlan } from "./fixtures.ts";

const python = spawnSync("python3", ["--version"]).status === 0;

/** The image's own reading of an environment: what it would do at start, or its refusal. */
function imageReads(env: Record<string, string>): Record<string, unknown> {
  const code = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(join(ROOT, "images", "server"))})`,
    "from cfo_server import config",
    "env = json.load(sys.stdin)",
    "try:",
    "    c = config.load(env)",
    "    print(json.dumps({'initialized': c.installation_initialized, 'bootstrap': c.bootstrap_credentials,",
    "                      'replica': c.replica.url, 'base': c.base_url, 'id': c.installation_id,",
    "                      'artifacts': c.artifacts.uri}))",
    "except config.ConfigError as e:",
    "    print(json.dumps({'error': str(e)}))",
  ].join("\n");
  const child = spawnSync("python3", ["-I", "-c", code], {
    input: JSON.stringify(env),
    encoding: "utf8",
  });
  if (child.status !== 0) throw new Error(`python3 failed: ${child.stderr}`);
  return JSON.parse(child.stdout) as Record<string, unknown>;
}

/** The container's environment, as OmnigentServer computes it from the Worker's bindings. */
function containerEnv(plan: Installation, secrets: Record<string, string | null>) {
  const kept = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== null)) as Record<
    string,
    string
  >;
  const { vars, skipped } = serverContainerEnv({ ...platformVars(plan), ...kept });
  expect(skipped).toEqual([]);
  return vars;
}

describe.skipIf(!python)(
  "the server image reads what the bootstrap writes (WP2.3's config.py)",
  () => {
    const supplied = {
      ownerPassword: OWNER_PASSWORD,
      replicaAccessKeyId: "cfo-canary-key-id",
      replicaSecretAccessKey: "cfo-canary-secret",
    };

    it.each([
      ["an account installation", accountPlan],
      ["a staging test installation", stagingPlan],
    ])(
      "%s: a new installation before the release, an initialized one after",
      async (_name, make) => {
        const plan = await make();
        const before = secretsToAdd(plan, new Set(), supplied, { cookieSecret: "d".repeat(64) });
        expect(imageReads(containerEnv(plan, before))).toEqual({
          initialized: false,
          bootstrap: true,
          replica: plan.replica.url,
          base: `https://${plan.hostname}`,
          id: plan.installationId,
          artifacts: plan.artifacts?.url ?? null,
        });
        const after = { ...before, ...RELEASE_CHANGES };
        expect(after).not.toHaveProperty(PASSWORD_SECRET, OWNER_PASSWORD);
        // Initialized and without credentials: an empty replica, or one from before the owner, is
        // recovery mode, never setup (WP2.3's prepare_database, tested there with these values).
        expect(imageReads(containerEnv(plan, after))).toEqual({
          initialized: true,
          bootstrap: false,
          replica: plan.replica.url,
          base: `https://${plan.hostname}`,
          id: plan.installationId,
          artifacts: plan.artifacts?.url ?? null,
        });
      },
    );

    it("an installation without its artifact bucket is refused by the image (G2-DUR-001)", async () => {
      const plan = await accountPlan();
      const secrets = secretsToAdd(plan, new Set(), supplied, { cookieSecret: "d".repeat(64) });
      const released = { ...secrets, ...RELEASE_CHANGES };
      const { OMNIGENT_ARTIFACT_URI: _uri, ...env } = containerEnv(plan, released);
      expect(imageReads(env).error).toMatch(/^OMNIGENT_ARTIFACT_URI is required/);
      // The staging test switch is the bootstrap's only way to the container's disk.
      const staging = await stagingPlan();
      const stagingSecrets = secretsToAdd(staging, new Set(), supplied, {
        cookieSecret: "d".repeat(64),
      });
      const { CFO_ALLOW_LOCAL_ARTIFACTS: _switch, ...noSwitch } = containerEnv(
        staging,
        stagingSecrets,
      );
      expect(imageReads(noSwitch).error).toMatch(/^OMNIGENT_ARTIFACT_URI is required/);
    });

    it("every artifacts URL the bootstrap accepts, the image accepts (Codex G2-DUR-001 r1-2)", async () => {
      const corpus = [
        "s3://cfo-canary-artifacts",
        "s3://cfo-canary-artifacts/",
        "s3://cfo-canary-artifacts/omnigent/x",
        "S3://cfo-canary-artifacts",
        "s3://cfo-canary-artifacts?",
        "s3://cfo-canary-artifacts#x",
        "s3://cfo-canary-artifacts/x?y",
        "s3://cfo-canary-artifacts/a b",
        "s3://cfo-canary-artifacts/../x",
        "s3://user@cfo-canary-artifacts",
        "s3://cfo-canary-artifacts:9000",
        "s3://[broken",
        "s3://cfo.canary.artifacts",
        "s3://cfo-canary-artifacts/a\u200bb",
        "s3://cfo-canary-artifacts/a\u0085b",
        "s3://cfo-canary-artifacts/a\u202eb",
        "s3://cfo-canary-artifacts/a\u00a0b",
        "s3://cfo-canary-artifacts/é/ü",
      ];
      for (const url of corpus) {
        const plan = await accountPlan({ artifacts: { url } });
        const bootstrapOk = installationProblems(plan).length === 0;
        const secrets = secretsToAdd(plan, new Set(), supplied, { cookieSecret: "d".repeat(64) });
        const read = imageReads(containerEnv(plan, secrets));
        if (bootstrapOk) expect(read, url).toMatchObject({ artifacts: url });
        expect(bootstrapOk, url).toBe(
          [
            "s3://cfo-canary-artifacts",
            "s3://cfo-canary-artifacts/",
            "s3://cfo-canary-artifacts/omnigent/x",
            "s3://cfo-canary-artifacts/é/ü",
          ].includes(url),
        );
        // And what the bootstrap refuses, the image refuses (r2-2): one rule both ways, but for
        // bucket names S3 allows and R2 does not (dots), which only the bootstrap refuses.
        if (url !== "s3://cfo.canary.artifacts") expect("error" in read, url).toBe(!bootstrapOk);
      }
    });

    it("an account installation without the file-replica switch refuses a file replica", async () => {
      const plan = await stagingPlan();
      const secrets = secretsToAdd(plan, new Set(), supplied, { cookieSecret: "d".repeat(64) });
      const { CFO_ALLOW_FILE_REPLICA: _switch, ...env } = containerEnv(plan, secrets);
      expect(imageReads(env)).toEqual({
        error: "a file:// replica is for tests only (CFO_ALLOW_FILE_REPLICA)",
      });
    });
  },
);

describe("the bootstrap never talks to the installation, Access or service tokens", () => {
  const dir = join(ROOT, "scripts", "bootstrap");
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);

  it("has sources to check", () => {
    expect(sources.map(([f]) => f).sort()).toEqual([
      "access.ts",
      "bootstrap.ts",
      "cloud.ts",
      "events.ts",
      "github-app-command.ts",
      "github-app.ts",
      "machine.ts",
      "r2-token.ts",
      "remove.ts",
      "settings.ts",
      "staging.ts",
      "state.ts",
    ]);
  });

  // The GitHub App step (WP5.9) talks to GitHub alone: one request, to GitHub's manifest
  // conversion on api.github.com, and a page on 127.0.0.1 for the person's own browser
  // (node:http's server, which sends nothing). Those uses, and only those, are allowed.
  const githubOnly: Readonly<Record<string, readonly RegExp[]>> = {
    "github-app.ts": [/import \{ createServer, [^}]*\} from "node:http";/g],
    "github-app-command.ts": [/githubApi: \(url, init\) => fetch\(url, init\)/g],
  };

  it("lets the GitHub App step reach GitHub's API and nothing else", () => {
    const text = Object.fromEntries(sources)["github-app.ts"] ?? "";
    expect(text).toContain('const GITHUB_API = "https://api.github.com";');
    // Its one request: GitHub's manifest conversion.
    expect(text.match(/ports\.githubApi\(/g)).toHaveLength(1);
    expect(text).toMatch(/ports\.githubApi\(\s*`\$\{GITHUB_API\}\/app-manifests\//);
  });

  it.each(sources)("%s sends no request of its own and calls no setup", (file, text) => {
    const code = (githubOnly[file] ?? []).reduce(
      (rest, pattern) => rest.replace(pattern, ""),
      text.replace(/^\s*\/\/.*$/gm, ""),
    );
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/auth\/setup/);
    expect(code).not.toMatch(/node:https?\b|undici|XMLHttpRequest|WebSocket/);
  });

  it.each(sources)(
    "%s creates or changes no Access application, policy or service token",
    (_file, text) => {
      // The creations allowed: a missing R2 bucket of the plan, and the installation's own R2
      // user API token (cloud.ts's cfTokenApi), which may also be rolled and deleted.
      const allowed = [
        /"r2",\s*"buckets",\s*"create",\s*"--body"/g,
        /"user",\s*"tokens",\s*"(create|roll|delete)"/g,
      ];
      const code = allowed.reduce(
        (rest, pattern) => rest.replace(pattern, ""),
        text.replace(/^\s*\/\/.*$/gm, ""),
      );
      expect(code).not.toMatch(/service[-_]tokens?"/);
      expect(code).not.toMatch(/"(create|update|delete|rotate|edit)"/);
      expect(code).not.toMatch(/"policies"/);
      expect(code).not.toMatch(/"r2",\s*"(buckets|objects)",\s*"delete"/);
      expect(code).not.toMatch(/"(account|accounts)",\s*"tokens"/);
    },
  );

  it("touches user API tokens only in cloud.ts's adapter", () => {
    for (const [file, text] of sources) {
      const code = text.replace(/^\s*\/\/.*$/gm, "");
      const touches = /"user",\s*"tokens"/.test(code);
      expect([file, touches]).toEqual([file, file === "cloud.ts"]);
    }
  });
});
