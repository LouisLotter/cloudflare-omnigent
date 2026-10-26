// Couplings the bootstrap depends on, checked against the other side's own code:
//   - the server image (WP2.3) reads the environment the bootstrap gives it, before and after the
//     release, with its own parser (images/server/cfo_server/config.py, standard library only);
//   - the bootstrap script never talks to the installation, and never touches Access or tokens;
//     the only thing it creates besides its deploys is a missing R2 bucket of the plan.

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
          ].includes(url),
        );
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

describe("the bootstrap never talks to the installation, Access or tokens", () => {
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
      "machine.ts",
      "settings.ts",
      "staging.ts",
      "state.ts",
    ]);
  });

  it.each(sources)("%s sends no request of its own and calls no setup", (_file, text) => {
    const code = text.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/auth\/setup/);
    expect(code).not.toMatch(/node:https?\b|undici|XMLHttpRequest|WebSocket/);
  });

  it.each(sources)(
    "%s creates or changes no Access application, policy or service token",
    (_file, text) => {
      // The one creation allowed: a missing R2 bucket of the plan (`bootstrap.ts buckets`).
      const bucketCreate = /"r2",\s*"buckets",\s*"create",\s*"--body"/g;
      const code = text.replace(/^\s*\/\/.*$/gm, "").replace(bucketCreate, "");
      expect(code).not.toMatch(/service[-_]tokens?"/);
      expect(code).not.toMatch(/"(create|update|delete|rotate|edit)"/);
      expect(code).not.toMatch(/"policies"/);
      expect(code).not.toMatch(/"r2",\s*"(buckets|objects)",\s*"delete"/);
    },
  );
});
