// WP2.1 staging: writes the harness's configuration once the base deploy has created the
// owner-only Access application.
//
//   node worker/test/staging/ingress/config.ts
//
// Reads, read-only: the staging tool's config (zone and owner address), the Zero Trust team
// domain and this deployment's Access application. Writes, mode 600 and gitignored:
// generated/wrangler.staging.jsonc and generated/staging.json. The owner's address leaves this
// script only as the salted hash ingress pins (owner.ts), with a fresh random salt. Prints
// nothing identifying.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeOwnerPin } from "../../../src/ingress/owner.ts";

export const NAME = "cfo-stg-wp21-ingress";
export const HERE = dirname(fileURLToPath(import.meta.url));
export const GENERATED = join(HERE, "generated");
export const STATE = resolve(
  process.env.CFO_STAGING_DIR ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "cloudflare-omnigent",
      "staging",
    ),
);

export interface StagingConfig {
  readonly accountId: string;
  readonly zone: string;
  readonly ownerEmail: string;
}

export interface Generated {
  readonly hostname: string;
  readonly team: string;
  readonly aud: string;
}

export function stagingConfig(): StagingConfig {
  return JSON.parse(readFileSync(join(STATE, "config.json"), "utf8")) as StagingConfig;
}

export function generated(): Generated {
  return JSON.parse(readFileSync(join(GENERATED, "staging.json"), "utf8")) as Generated;
}

/** One `cf` call, its JSON answer without the `result` wrapper older versions add. */
export function cf(args: string[], accountId: string): unknown {
  const out = execFileSync("cf", args, {
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(out) as { result?: unknown };
  return parsed && typeof parsed === "object" && "result" in parsed ? parsed.result : parsed;
}

/** This deployment's Access application, exactly one, or an error. */
export function accessApp(config: StagingConfig, hostname: string): Record<string, unknown> {
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
  return mine[0];
}

/** Replaces the hostname, team domain and AUD tag in text meant for evidence. */
export function redact(text: string, g: Generated): string {
  return text
    .replaceAll(g.hostname, "<host>")
    .replaceAll(g.team, "<team>")
    .replaceAll(g.aud, "<aud>");
}

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
  const aud = accessApp(config, hostname).aud as string;
  const pin = await makeOwnerPin(config.ownerEmail, new Uint8Array(randomBytes(32)));
  const wrangler = {
    $schema: "../../../../node_modules/wrangler/config-schema.json",
    name: NAME,
    main: "../harness.ts",
    compatibility_date: "2026-10-01",
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: true },
    vars: {
      ACCESS_TEAM_DOMAIN: team,
      ACCESS_AUD: aud,
      ALLOWED_HOSTNAMES: hostname,
      OWNER_EMAIL_HASH: pin,
    },
  };
  mkdirSync(GENERATED, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(GENERATED, "wrangler.staging.jsonc"),
    `${JSON.stringify(wrangler, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(GENERATED, "staging.json"),
    `${JSON.stringify({ hostname, team, aud } satisfies Generated, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(
    `wrote generated/wrangler.staging.jsonc: team domain (${team.length} chars), AUD (${aud.length} chars), owner pinned by salted hash`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
