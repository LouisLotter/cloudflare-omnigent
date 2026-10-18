// Spike S5: writes the staging Wrangler configuration, after the base deploy has created the
// owner-only Access application.
//
//   pnpm stg deploy --suffix s5-access --owner S5 --config spikes/s5/wrangler.jsonc --days 1
//   node spikes/s5/scripts/staging-config.ts
//   pnpm stg deploy --suffix s5-access --owner S5 --config spikes/s5/generated/wrangler.staging.jsonc --days 1
//
// Reads, read-only: the staging config (account, zone, owner email), the Zero Trust team domain,
// and the AUD tag of this deployment's Access application. Writes, mode 600 and gitignored:
// generated/wrangler.staging.jsonc and generated/staging.json. Prints nothing identifying.
//
// Spike-only shortcut: the staging tool does not manage Worker secrets, so the synthetic
// bootstrap password, Omnigent cookie secret and sealing key are generated here and passed as
// variables. They exist only for this deployment and go with it at teardown. The product keeps
// them in Worker secrets (docs/secrets.md).

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SPIKE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = join(SPIKE, "generated");
const NAME = "cfo-stg-s5-access";
const STATE =
  process.env.CFO_STAGING_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cloudflare-omnigent", "staging");

interface StagingConfig {
  accountId: string;
  zone: string;
  ownerEmail: string;
}

function cf(args: string[], accountId: string): unknown {
  const out = execFileSync("cf", args, {
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(out) as { result?: unknown };
  return parsed && typeof parsed === "object" && "result" in parsed ? parsed.result : parsed;
}

const b64url = (bytes: Buffer) => bytes.toString("base64url");

function main(): void {
  const config = JSON.parse(readFileSync(join(STATE, "config.json"), "utf8")) as StagingConfig;
  const hostname = `${NAME}.${config.zone}`;
  const org = cf(["zero-trust", "organization", "get"], config.accountId) as {
    auth_domain?: unknown;
  };
  const team = org.auth_domain;
  if (typeof team !== "string" || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) {
    throw new Error("could not read the team domain");
  }
  const apps = cf(
    ["zero-trust", "access", "applications", "list", "--domain", hostname, "--exact"],
    config.accountId,
  ) as { name?: string; domain?: string; aud?: string }[];
  const mine = apps.filter((a) => a.domain === hostname);
  if (mine.length !== 1 || mine[0]?.name !== NAME || typeof mine[0]?.aud !== "string") {
    throw new Error(
      "expected exactly one Access application for this deployment; deploy the base config first",
    );
  }
  const aud = mine[0].aud;
  const ownerHash = createHash("sha256")
    .update(config.ownerEmail.trim().toLowerCase())
    .digest("hex");

  const wrangler = {
    $schema: "../../../worker/node_modules/wrangler/config-schema.json",
    name: NAME,
    main: "../src/worker.ts",
    compatibility_date: "2026-10-01",
    workers_dev: false,
    preview_urls: false,
    durable_objects: {
      bindings: [
        { name: "PLATFORM_LOGIN", class_name: "PlatformLoginDO" },
        { name: "OMNIGENT_SERVER", class_name: "OmnigentServerDO" },
      ],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["PlatformLoginDO", "OmnigentServerDO"] }],
    containers: [
      {
        name: `${NAME}-omnigent`,
        class_name: "OmnigentServerDO",
        image: "../omnigent-image/Dockerfile",
        max_instances: 1,
        instance_type: "basic",
      },
    ],
    observability: { enabled: true },
    vars: {
      ACCESS_TEAM_DOMAIN: team,
      ACCESS_AUD: aud,
      ALLOWED_HOSTNAMES: hostname,
      OWNER_EMAIL_SHA256: ownerHash,
      OTHER_APP_AUD: randomBytes(32).toString("hex"),
      OMNIGENT_USERNAME: "owner",
      OMNIGENT_BASE_URL: `https://${hostname}`,
      GRANT_LIFETIME_DAYS: "1",
      S5_FAULTS: "1",
      OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD: b64url(randomBytes(18)),
      OMNIGENT_COOKIE_SECRET: randomBytes(32).toString("hex"),
      PLATFORM_LOGIN_KEY: b64url(randomBytes(32)),
    },
  };
  mkdirSync(GENERATED, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(GENERATED, "wrangler.staging.jsonc"),
    `${JSON.stringify(wrangler, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  writeFileSync(
    join(GENERATED, "staging.json"),
    `${JSON.stringify({ hostname, team, aud }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  console.log(
    `wrote generated/wrangler.staging.jsonc: team domain read (${team.length} chars), AUD read (${aud.length} chars), owner pinned by hash`,
  );
}

main();
