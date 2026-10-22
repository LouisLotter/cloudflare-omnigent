// Couplings the bootstrap depends on, checked against the other side's own code:
//   - the server image (WP2.3) reads the environment the bootstrap gives it, before and after the
//     release, with its own parser (images/server/cfo_server/config.py, standard library only);
//   - the bootstrap script never talks to the installation, and never touches Access or tokens.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serverContainerEnv } from "../../../worker/src/server/server-env.ts";
import {
  type Installation,
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
    "                      'replica': c.replica.url, 'base': c.base_url, 'id': c.installation_id}))",
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
        });
      },
    );

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
      const code = text.replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/service[-_]tokens?"/);
      expect(code).not.toMatch(/"(create|update|delete|rotate|edit)"/);
      expect(code).not.toMatch(/"policies"/);
    },
  );
});
