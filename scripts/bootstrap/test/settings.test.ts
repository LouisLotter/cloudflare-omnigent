import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InstallationId } from "../../../contracts/src/index.ts";
import {
  accessProblems,
  COOKIE_SECRET,
  containerEnvProblems,
  INITIALIZED_SECRET,
  installationProblems,
  newInstallationId,
  PASSWORD_SECRET,
  passwordProblem,
  platformVars,
  RELEASE_CHANGES,
  REPLICA_KEY_ID_SECRET,
  REPLICA_SECRET_KEY_SECRET,
  renderPlatformConfig,
  renderWebConfig,
  requiredSecretNames,
  secretsToAdd,
  usernameProblem,
  webVars,
} from "../settings.ts";
import { accountPlan, baseConfigs, OWNER_PASSWORD, stagingPlan } from "./fixtures.ts";

const BASE = baseConfigs();
const ACCESS = { teamDomain: "team.cloudflareaccess.com", aud: "a".repeat(64) };
const COOKIE = "c".repeat(64);
const SUPPLIED = {
  ownerPassword: OWNER_PASSWORD,
  replicaAccessKeyId: "cfo-canary-key-id",
  replicaSecretAccessKey: "cfo-canary-secret",
};

describe("installation IDs", () => {
  it("are ins_ and 26 Crockford base32 digits, from any random bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 26, maxLength: 26 }), (bytes) => {
        const id = newInstallationId(() => bytes);
        expect(InstallationId.safeParse(id).success).toBe(true);
      }),
    );
  });
});

describe("the owner's username and password", () => {
  it("follows Omnigent's username rule, and refuses root and local", () => {
    for (const ok of ["owner", "a", "ada.l", "x_y-z", "me@example.test", "0wner"]) {
      expect(usernameProblem(ok)).toBeUndefined();
    }
    for (const bad of ["", "Owner", "-owner", "o wner", "a".repeat(65), "me@x", "ünïcode"]) {
      expect(usernameProblem(bad)).toMatch(/lowercase letters/);
    }
    expect(usernameProblem("root")).toBe('the owner\'s username may not be "root"');
    expect(usernameProblem("local")).toBe('the owner\'s username may not be "local"');
  });

  it("needs a password of at least 8 characters, on one line, without outer spaces", () => {
    expect(passwordProblem(OWNER_PASSWORD)).toBeUndefined();
    expect(passwordProblem("1234567")).toMatch(/at least 8/);
    expect(passwordProblem(" padded password")).toMatch(/whitespace/);
    expect(passwordProblem("two\nlines!")).toMatch(/one line/);
  });
});

describe("installationProblems", () => {
  it("accepts the fixtures", async () => {
    expect(installationProblems(await accountPlan())).toEqual([]);
    expect(installationProblems(await stagingPlan())).toEqual([]);
  });

  it("names every bad field", async () => {
    const plan = await accountPlan();
    const problems = installationProblems({
      ...plan,
      installationId: "ins_bad",
      accountId: "xyz",
      platformWorker: "Bad_Name",
      webWorker: "Bad_Name",
      hostname: "Not A Host",
      ownerPin: "plain-email@example.test",
      ownerUsername: "root",
      replica: { url: "http://bucket/x", endpoint: "http://insecure.example.test" },
    });
    expect(problems).toEqual([
      "the installation ID is not ins_<26 base32 digits>",
      "the account ID must be 32 hex digits",
      "the platform Worker's name is not a valid Worker name",
      "the web Worker's name is not a valid Worker name",
      "the platform and web Workers need different names",
      "the hostname is not a lowercase DNS name",
      "the owner pin is not hmac-sha256:<salt>:<digest>",
      'the owner\'s username may not be "root"',
      "the replica URL must be s3://<bucket>/<path>",
      "the replica endpoint must be an https:// URL",
    ]);
  });

  it("allows a file replica only for a staging test installation", async () => {
    expect(
      installationProblems(await accountPlan({ replica: { url: "file:///replica" } })),
    ).toEqual(["a file:// replica is only for staging tests"]);
    expect(installationProblems(await stagingPlan({ replica: { url: "file:///" } }))).toEqual([
      "a file:// replica needs an absolute path",
    ]);
  });

  it("checks the replica URL's form", async () => {
    for (const url of ["s3://", "s3://bucket/x?y=1", "s3://user@bucket/x", "not a url"]) {
      expect(installationProblems(await accountPlan({ replica: { url } })).length).toBe(1);
    }
    expect(
      installationProblems(await accountPlan({ replica: { url: "s3://b/x", endpoint: "nope" } })),
    ).toEqual(["the replica endpoint must be an https:// URL"]);
  });

  it("keeps staging names with the staging tool, and the tool's names out of an account", async () => {
    expect(
      installationProblems(await accountPlan({ platformWorker: "cfo-stg-x-platform" })),
    ).toEqual(["cfo-stg-… names belong to the guarded staging tool"]);
    const staging = await stagingPlan();
    expect(
      installationProblems({
        ...staging,
        platformWorker: "cloudflare-omnigent",
        webWorker: "cfo-stg-wp24-web",
      }),
    ).toEqual([
      "a staging installation's Workers are named cfo-stg-…",
      "a staging installation's Workers carry its staging suffixes",
    ]);
    expect(
      installationProblems({
        ...staging,
        target: { ...(staging.target as object), days: 0 } as never,
      }),
    ).toEqual(["a staging installation lasts 1 to 30 days"]);
  });
});

describe("the platform Worker's settings and secrets", () => {
  it("puts plain settings in variables, and the replica's endpoint only when given", async () => {
    const plan = await accountPlan();
    expect(platformVars(plan)).toEqual({
      CFO_INSTALLATION_ID: plan.installationId,
      SERVER_ENV_OMNIGENT_ACCOUNTS_BASE_URL: "https://omnigent.example.test",
      SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME: "owner",
      SERVER_ENV_CFO_REPLICA_URL: "s3://cfo-canary-replica/omnigent",
      SERVER_ENV_CFO_REPLICA_ENDPOINT: "https://canary.r2.example.test",
    });
    expect(platformVars(await stagingPlan())).toMatchObject({
      SERVER_ENV_CFO_REPLICA_URL: "file:///replica",
      SERVER_ENV_CFO_ALLOW_FILE_REPLICA: "true",
    });
    expect(platformVars(await stagingPlan())).not.toHaveProperty("SERVER_ENV_CFO_REPLICA_ENDPOINT");
  });

  it("adds every missing secret, the initialized flag as false", async () => {
    const plan = await accountPlan();
    const add = secretsToAdd(plan, new Set(), SUPPLIED, { cookieSecret: COOKIE });
    expect(add).toEqual({
      [COOKIE_SECRET]: COOKIE,
      [INITIALIZED_SECRET]: "false",
      [PASSWORD_SECRET]: OWNER_PASSWORD,
      [REPLICA_KEY_ID_SECRET]: SUPPLIED.replicaAccessKeyId,
      [REPLICA_SECRET_KEY_SECRET]: SUPPLIED.replicaSecretAccessKey,
    });
    expect(Object.keys(add).sort()).toEqual(requiredSecretNames(plan).sort());
  });

  it("never overwrites a secret the Worker holds", async () => {
    const plan = await accountPlan();
    const present = new Set(requiredSecretNames(plan));
    expect(secretsToAdd(plan, present, {}, { cookieSecret: COOKIE })).toEqual({});
    // An installation that holds the flag keeps it, whatever its value.
    const add = secretsToAdd(plan, new Set([INITIALIZED_SECRET]), SUPPLIED, {
      cookieSecret: COOKIE,
    });
    expect(add).not.toHaveProperty(INITIALIZED_SECRET);
  });

  it("needs the replica's credentials only for an S3 replica", async () => {
    const staging = await stagingPlan();
    expect(
      Object.keys(
        secretsToAdd(
          staging,
          new Set(),
          { ownerPassword: OWNER_PASSWORD },
          { cookieSecret: COOKIE },
        ),
      ).sort(),
    ).toEqual([COOKIE_SECRET, INITIALIZED_SECRET, PASSWORD_SECRET].sort());
    expect(() =>
      secretsToAdd(staging, new Set(), { ownerPassword: OWNER_PASSWORD }, { cookieSecret: "" }),
    ).toThrow(`a cookie secret is needed (${COOKIE_SECRET})`);
  });

  it("releases in one change: the flag set, the password deleted", () => {
    expect(RELEASE_CHANGES).toEqual({ [INITIALIZED_SECRET]: "true", [PASSWORD_SECRET]: null });
    expect(Object.isFrozen(RELEASE_CHANGES)).toBe(true);
  });

  it("checks what the server container would receive (WP2.2's serverContainerEnv)", async () => {
    const plan = await accountPlan();
    const vars = platformVars(plan);
    const secrets = secretsToAdd(plan, new Set(), SUPPLIED, { cookieSecret: COOKIE });
    expect(containerEnvProblems(vars, secrets, plan)).toEqual([]);
    const { [REPLICA_KEY_ID_SECRET]: _gone, ...withoutKey } = secrets;
    expect(containerEnvProblems(vars, withoutKey, plan)).toEqual([
      "LITESTREAM_ACCESS_KEY_ID would be missing",
    ]);
    expect(containerEnvProblems({ ...vars, "SERVER_ENV_BAD-NAME": "x" }, secrets, plan)).toEqual([
      "SERVER_ENV_BAD-NAME would not reach the server: invalid name",
    ]);
  });
});

describe("the web Worker's settings", () => {
  it("are ingress's four variables", async () => {
    const plan = await accountPlan();
    expect(webVars(plan, ACCESS)).toEqual({
      ACCESS_TEAM_DOMAIN: ACCESS.teamDomain,
      ACCESS_AUD: ACCESS.aud,
      ALLOWED_HOSTNAMES: plan.hostname,
      OWNER_EMAIL_HASH: plan.ownerPin,
    });
    expect(accessProblems(plan, ACCESS)).toEqual([]);
  });

  it("are refused when ingress would not read them", async () => {
    const plan = await accountPlan();
    expect(accessProblems(plan, { teamDomain: "team.example.test", aud: "bad aud" })).toEqual([
      "the team domain is not <team>.cloudflareaccess.com",
      "the Access AUD tag is malformed",
    ]);
    expect(
      accessProblems({ ...plan, hostname: "UPPER.example.test", ownerPin: "x" }, ACCESS),
    ).toEqual(["ingress would not read the hostname", "the owner pin is malformed"]);
  });
});

describe("rendering the configurations", () => {
  it("adds name, account and variables to the platform configuration, and nothing else", async () => {
    const plan = await accountPlan();
    const rendered = renderPlatformConfig(BASE.platform, plan);
    const { name, account_id, vars, ...rest } = rendered;
    expect({ name, account_id, vars }).toEqual({
      name: plan.platformWorker,
      account_id: plan.accountId,
      vars: platformVars(plan),
    });
    const { name: _n, ...base } = BASE.platform;
    expect(rest).toEqual(base);
    expect(() => renderPlatformConfig({ ...BASE.platform, vars: {} }, plan)).toThrow(
      /already has variables/,
    );
  });

  it("binds the web Worker to this platform Worker, with a custom domain only in an account", async () => {
    const plan = await accountPlan();
    expect(renderWebConfig(BASE.web, plan, ACCESS)).toMatchObject({
      routes: [{ pattern: plan.hostname, custom_domain: true }],
      vars: { CFO_INSTALLATION_ID: plan.installationId, ...webVars(plan, ACCESS) },
    });
    const staging = await stagingPlan();
    const rendered = renderWebConfig(BASE.web, staging, undefined);
    expect(rendered).not.toHaveProperty("routes");
    expect(rendered.vars).toEqual({ CFO_INSTALLATION_ID: staging.installationId });
    expect(rendered.durable_objects).toEqual({
      bindings: [
        { name: "OMNIGENT", class_name: "OmnigentServer", script_name: staging.platformWorker },
      ],
    });
  });

  it("refuses a web configuration it cannot render safely", async () => {
    const plan = await accountPlan();
    expect(() => renderWebConfig({ ...BASE.web, routes: [] }, plan, ACCESS)).toThrow(/routes/);
    expect(() => renderWebConfig({ ...BASE.web, durable_objects: {} }, plan, ACCESS)).toThrow(
      /binds no Durable Object/,
    );
    expect(() =>
      renderWebConfig(
        { ...BASE.web, durable_objects: { bindings: [{ name: "X", class_name: "Y" }] } },
        plan,
        ACCESS,
      ),
    ).toThrow(/must name the platform Worker/);
  });
});
