// WP2.2 staging, part B: gives the web harness the ingress variables (WP2.1) once the base
// deploy has created its owner-only Access application, as WP2.1's own config.ts does for its
// harness.
//
//   node worker/test/staging/wp22/config-web.ts
//
// Reads, read-only: the staging tool's config, the Zero Trust team domain and this deployment's
// Access application. Writes, mode 600 and gitignored: generated/wrangler.web.staging.jsonc.
// The owner's address leaves this script only as the salted hash ingress pins. Prints nothing
// identifying.

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeOwnerPin } from "../../../src/ingress/owner.ts";
import { cf, run, stagingConfig } from "../ingress/config.ts";

const NAME = "cfo-stg-wp22-web";
const PLATFORM = "cfo-stg-wp22-platform";
const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED = join(HERE, "generated");

async function main(): Promise<void> {
  const config = stagingConfig();
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
  ) as Record<string, unknown>[];
  const mine = apps.filter((a) => a.domain === hostname);
  const name = mine[0]?.name;
  const ours = name === NAME || (typeof name === "string" && name.startsWith(`${NAME}--`));
  if (mine.length !== 1 || !ours || typeof mine[0]?.aud !== "string") {
    throw new Error("expected exactly one Access application for this deployment");
  }
  const pin = await makeOwnerPin(config.ownerEmail, new Uint8Array(randomBytes(32)));
  const wrangler = {
    $schema: "../../../../node_modules/wrangler/config-schema.json",
    name: NAME,
    main: "../../../../src/web.ts",
    compatibility_date: "2026-10-01",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    observability: {
      enabled: true,
      head_sampling_rate: 1,
      logs: { enabled: true, invocation_logs: false },
    },
    durable_objects: {
      bindings: [{ name: "OMNIGENT", class_name: "OmnigentServer", script_name: PLATFORM }],
    },
    vars: {
      ACCESS_TEAM_DOMAIN: team,
      ACCESS_AUD: mine[0]?.aud,
      ALLOWED_HOSTNAMES: hostname,
      OWNER_EMAIL_HASH: pin,
    },
  };
  mkdirSync(GENERATED, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(GENERATED, "wrangler.web.staging.jsonc"),
    `${JSON.stringify(wrangler, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(
    "wrote generated/wrangler.web.staging.jsonc: team domain, AUD, owner pinned by salted hash",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await run(main);
