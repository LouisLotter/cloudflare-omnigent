import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InstallationId } from "../../../contracts/src/index.ts";
import { recordKeysSecret } from "../../../worker/src/internal/key-service.ts";
import { serverContainerEnv } from "../../../worker/src/server/server-env.ts";
import { declaredResources, withStagingNames } from "../../staging/guard.ts";
import {
  ARTIFACTS_KEY_ID_SECRET,
  ARTIFACTS_SECRET_KEY_SECRET,
  accessProblems,
  bucketsOf,
  COOKIE_SECRET,
  CREDENTIAL_STORE_SECRETS,
  containerEnvProblems,
  credentialStoreToAdd,
  DEPLOY_ID_VAR,
  defaultArtifactsUrl,
  INITIALIZED_SECRET,
  installationProblems,
  KEY_SERVICE_KEY_ID_SECRET,
  KEY_SERVICE_KEY_SECRET,
  LAUNCHER_KEY_ID_SECRET,
  LAUNCHER_KEY_SECRET,
  launcherKeyToAdd,
  MCP_STATE_SECRET,
  newInstallationId,
  OWNER_PASSWORD_ON_PAGE_SECRET,
  offersPlatformFeature,
  PASSWORD_SECRET,
  PLATFORM_FEATURES,
  PLATFORM_FEATURES_VAR,
  passwordProblem,
  planConflicts,
  platformVars,
  RECORD_KEYS_SECRET,
  RELEASE_CHANGES,
  REPLICA_KEY_ID_SECRET,
  REPLICA_SECRET_KEY_SECRET,
  r2Endpoint,
  renderPlatformConfig,
  renderWebConfig,
  requiredSecretNames,
  SERVER_ENV,
  STAGING_INSTALLATION_VAR,
  secretsToAdd,
  usernameProblem,
  webVars,
} from "../settings.ts";
import { accountPlan, baseConfigs, OWNER_EMAIL, OWNER_PASSWORD, stagingPlan } from "./fixtures.ts";

const BASE = baseConfigs();
const ACCESS = { teamDomain: "team.cloudflareaccess.com", aud: "a".repeat(64) };
const COOKIE = "c".repeat(64);
/** What the run makes itself (synthetic). */
const GEN = {
  cookieSecret: COOKIE,
  ownerPassword: "cfo-canary-generated-owner-password-0000000",
  launcherKey: "cfo-canary-launcher-key-generated-0000000000000000000000000000000",
  launcherKeyId: "k-20261029",
  keyServiceKey: "cfo-canary-key-service-signing-key-000000000000000000000000000000",
  keyServiceKeyId: "ks-0a0b0c0d",
  recordKeysRoot: new Uint8Array(32).fill(7),
  mcpStateSecret: "cfo-canary-mcp-oauth-state-secret-00000000000000000000000000000000",
};
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
      installationProblems(
        await accountPlan({
          replica: { url: "file:///replica" },
          artifacts: { url: "s3://cfo-canary-artifacts", endpoint: "https://r2.example.test" },
        }),
      ),
    ).toEqual(["a file:// replica is only for staging tests"]);
    expect(installationProblems(await stagingPlan({ replica: { url: "file:///" } }))).toEqual([
      "a file:// replica needs an absolute path",
    ]);
  });

  it("checks the replica URL's form", async () => {
    for (const url of ["s3://", "s3://bucket/x?y=1", "s3://user@bucket/x", "not a url"]) {
      expect(installationProblems(await accountPlan({ replica: { url } }))).toContain(
        url === "not a url"
          ? "the replica URL must be s3://<bucket>/<path>"
          : "the replica URL must be s3://<bucket>/<path> with nothing else",
      );
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
      CFO_PLATFORM_FEATURES: "key-service github-setup mcp-services",
      SERVER_ENV_OMNIGENT_ACCOUNTS_BASE_URL: "https://omnigent.example.test",
      SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME: "owner",
      SERVER_ENV_CFO_REPLICA_URL: "s3://cfo-canary-replica/omnigent",
      SERVER_ENV_CFO_REPLICA_ENDPOINT: "https://canary.r2.example.test",
      SERVER_ENV_OMNIGENT_ARTIFACT_URI: "s3://cfo-canary-artifacts",
      SERVER_ENV_AWS_ENDPOINT_URL_S3: "https://canary.r2.example.test",
      SERVER_ENV_AWS_REGION: "auto",
    });
    expect(platformVars(await stagingPlan())).toMatchObject({
      SERVER_ENV_CFO_REPLICA_URL: "file:///replica",
      SERVER_ENV_CFO_ALLOW_FILE_REPLICA: "true",
      SERVER_ENV_CFO_ALLOW_LOCAL_ARTIFACTS: "true",
    });
    expect(platformVars(await stagingPlan())).not.toHaveProperty(
      "SERVER_ENV_OMNIGENT_ARTIFACT_URI",
    );
    expect(platformVars(await stagingPlan())).not.toHaveProperty("SERVER_ENV_CFO_REPLICA_ENDPOINT");
  });

  it("names the platform's features on every platform Worker, never to the server (WP3.35)", async () => {
    for (const plan of [await accountPlan(), await stagingPlan()]) {
      const vars = platformVars(plan);
      expect(vars[PLATFORM_FEATURES_VAR]).toBe(PLATFORM_FEATURES.join(" "));
      expect(offersPlatformFeature(vars, "key-service")).toBe(true);
      expect(offersPlatformFeature(vars, "github-setup")).toBe(true);
      expect(renderPlatformConfig(BASE.platform, plan).vars).toMatchObject({
        [PLATFORM_FEATURES_VAR]: "key-service github-setup mcp-services",
      });
    }
    expect(PLATFORM_FEATURES_VAR.startsWith(SERVER_ENV)).toBe(false);
    expect(offersPlatformFeature(undefined, "key-service")).toBe(false);
    expect(offersPlatformFeature({}, "key-service")).toBe(false);
    expect(
      offersPlatformFeature({ [PLATFORM_FEATURES_VAR]: "a key-service b" }, "key-service"),
    ).toBe(true);
    expect(offersPlatformFeature({ [PLATFORM_FEATURES_VAR]: "key-services" }, "key-service")).toBe(
      false,
    );
    // The update's deploy ID reaches the server: that is its purpose.
    expect(DEPLOY_ID_VAR).toBe("SERVER_ENV_CFO_DEPLOY_ID");
  });

  it("marks a staging installation for the RC-53 switch (WP3.23), and never production", async () => {
    const staging = await stagingPlan();
    expect(platformVars(staging)[STAGING_INSTALLATION_VAR]).toBe(staging.platformWorker);
    expect(staging.platformWorker.startsWith("cfo-stg-")).toBe(true);
    expect(platformVars(await accountPlan())).not.toHaveProperty(STAGING_INSTALLATION_VAR);
  });

  it("adds every missing secret, the initialized flag as false", async () => {
    const plan = await accountPlan();
    const add = secretsToAdd(plan, new Set(), SUPPLIED, GEN);
    expect(add).toEqual({
      [COOKIE_SECRET]: COOKIE,
      [INITIALIZED_SECRET]: "false",
      [PASSWORD_SECRET]: OWNER_PASSWORD,
      [LAUNCHER_KEY_SECRET]: GEN.launcherKey,
      [LAUNCHER_KEY_ID_SECRET]: GEN.launcherKeyId,
      // The credential store's keys and the MCP state secret (WP5.10).
      [KEY_SERVICE_KEY_SECRET]: GEN.keyServiceKey,
      [KEY_SERVICE_KEY_ID_SECRET]: GEN.keyServiceKeyId,
      [RECORD_KEYS_SECRET]: recordKeysSecret(`${plan.installationId}.records`, GEN.recordKeysRoot),
      [MCP_STATE_SECRET]: GEN.mcpStateSecret,
      [REPLICA_KEY_ID_SECRET]: SUPPLIED.replicaAccessKeyId,
      [REPLICA_SECRET_KEY_SECRET]: SUPPLIED.replicaSecretAccessKey,
      // One R2 token for both buckets: its values, set again under the artifacts' own names.
      [ARTIFACTS_KEY_ID_SECRET]: SUPPLIED.replicaAccessKeyId,
      [ARTIFACTS_SECRET_KEY_SECRET]: SUPPLIED.replicaSecretAccessKey,
    });
    expect(Object.keys(add).sort()).toEqual(requiredSecretNames(plan).sort());
    expect(ARTIFACTS_KEY_ID_SECRET).toBe("SERVER_ENV_AWS_ACCESS_KEY_ID");
    expect(ARTIFACTS_SECRET_KEY_SECRET).toBe("SERVER_ENV_AWS_SECRET_ACCESS_KEY");
  });

  it("takes a second token's values for the artifacts when the installer gives them", async () => {
    const plan = await accountPlan();
    const add = secretsToAdd(
      plan,
      new Set(),
      {
        ...SUPPLIED,
        artifactsAccessKeyId: "cfo-canary-artifacts-id",
        artifactsSecretAccessKey: "cfo-canary-artifacts-secret",
      },
      GEN,
    );
    expect(add[ARTIFACTS_KEY_ID_SECRET]).toBe("cfo-canary-artifacts-id");
    expect(add[ARTIFACTS_SECRET_KEY_SECRET]).toBe("cfo-canary-artifacts-secret");
    expect(add[REPLICA_KEY_ID_SECRET]).toBe(SUPPLIED.replicaAccessKeyId);
    // A Worker holding a whole pair keeps it; an incomplete pair is replaced whole, never
    // completed with another key's half (Codex WP3.25 r1-5).
    const present = new Set(requiredSecretNames(plan).filter((n) => n !== ARTIFACTS_KEY_ID_SECRET));
    expect(secretsToAdd(plan, present, SUPPLIED, GEN)).toEqual({
      [ARTIFACTS_KEY_ID_SECRET]: SUPPLIED.replicaAccessKeyId,
      [ARTIFACTS_SECRET_KEY_SECRET]: SUPPLIED.replicaSecretAccessKey,
    });
    expect(() => secretsToAdd(plan, present, { ownerPassword: OWNER_PASSWORD }, GEN)).toThrow(
      `the artifact bucket's access key ID is needed (${ARTIFACTS_KEY_ID_SECRET})`,
    );
    const halfReplica = new Set(
      requiredSecretNames(plan).filter((n) => n !== REPLICA_SECRET_KEY_SECRET),
    );
    expect(secretsToAdd(plan, halfReplica, SUPPLIED, GEN)).toEqual({
      [REPLICA_KEY_ID_SECRET]: SUPPLIED.replicaAccessKeyId,
      [REPLICA_SECRET_KEY_SECRET]: SUPPLIED.replicaSecretAccessKey,
    });
  });

  it("never overwrites a secret the Worker holds", async () => {
    const plan = await accountPlan();
    const present = new Set(requiredSecretNames(plan));
    expect(secretsToAdd(plan, present, {}, GEN)).toEqual({});
    // An installation that holds the flag keeps it, whatever its value.
    const add = secretsToAdd(plan, new Set([INITIALIZED_SECRET]), SUPPLIED, GEN);
    expect(add).not.toHaveProperty(INITIALIZED_SECRET);
  });

  it("uploads the run's own password with the page marker when the installer chose none (WP3.34)", async () => {
    const plan = await accountPlan();
    const { ownerPassword: _none, ...withoutPassword } = SUPPLIED;
    const add = secretsToAdd(plan, new Set(), withoutPassword, GEN);
    expect(add[PASSWORD_SECRET]).toBe(GEN.ownerPassword);
    expect(add[OWNER_PASSWORD_ON_PAGE_SECRET]).toBe("true");
    expect(OWNER_PASSWORD_ON_PAGE_SECRET.startsWith("SERVER_ENV_")).toBe(false);
    // A chosen one: no marker.
    expect(secretsToAdd(plan, new Set(), SUPPLIED, GEN)).not.toHaveProperty(
      OWNER_PASSWORD_ON_PAGE_SECRET,
    );
    // Uploaded once: a Worker that holds a password gets neither again.
    const held = secretsToAdd(plan, new Set([PASSWORD_SECRET]), withoutPassword, GEN);
    expect(held).not.toHaveProperty(PASSWORD_SECRET);
    expect(held).not.toHaveProperty(OWNER_PASSWORD_ON_PAGE_SECRET);
    // The marker never reaches the server, and changes nothing it starts with.
    const vars = platformVars(plan);
    expect(containerEnvProblems(vars, add, plan)).toEqual([]);
    expect(Object.keys(serverContainerEnv({ ...vars, ...add }).vars)).not.toContain(
      "CFO_OWNER_PASSWORD_ON_PAGE",
    );
    expect(() =>
      secretsToAdd(plan, new Set(), withoutPassword, { ...GEN, ownerPassword: "short" }),
    ).toThrow(/the generated password/);
  });

  it("adds the launcher's key pair when the Worker lacks either half, and only then", async () => {
    const plan = await accountPlan();
    expect(launcherKeyToAdd(new Set(), GEN)).toEqual({
      [LAUNCHER_KEY_SECRET]: GEN.launcherKey,
      [LAUNCHER_KEY_ID_SECRET]: GEN.launcherKeyId,
    });
    expect(launcherKeyToAdd(new Set([LAUNCHER_KEY_ID_SECRET]), GEN)).toEqual({
      [LAUNCHER_KEY_SECRET]: GEN.launcherKey,
      [LAUNCHER_KEY_ID_SECRET]: GEN.launcherKeyId,
    });
    expect(launcherKeyToAdd(new Set([LAUNCHER_KEY_SECRET, LAUNCHER_KEY_ID_SECRET]), GEN)).toEqual(
      {},
    );
    // The server must have it: an installation without it cannot start a cloud computer.
    const vars = platformVars(plan);
    const all = secretsToAdd(plan, new Set(), SUPPLIED, GEN);
    const { [LAUNCHER_KEY_SECRET]: _key, ...withoutKey } = all;
    expect(containerEnvProblems(vars, withoutKey, plan)).toEqual([
      "CFO_LAUNCHER_SIGNING_KEY would be missing",
    ]);
  });

  it("adds the credential store's keys and the MCP state secret, replacing none (WP5.10)", async () => {
    const plan = await accountPlan();
    const all = credentialStoreToAdd(plan, new Set(), GEN);
    expect(Object.keys(all).sort()).toEqual([...CREDENTIAL_STORE_SECRETS].sort());
    expect(KEY_SERVICE_KEY_SECRET).toBe("SERVER_ENV_OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY");
    expect(MCP_STATE_SECRET).toBe("SERVER_ENV_OMNIGENT_MCP_OAUTH_STATE_SECRET");
    // The record keys never reach the server: a Worker-only name.
    expect(RECORD_KEYS_SECRET.startsWith("SERVER_ENV_")).toBe(false);
    expect(JSON.parse(all[RECORD_KEYS_SECRET] ?? "")).toMatchObject({
      keyId: `${plan.installationId}.records`,
      current: 1,
    });
    // Held ones are kept: a github-app run's keys stay, and so do sealed records' keys.
    expect(credentialStoreToAdd(plan, new Set(CREDENTIAL_STORE_SECRETS), GEN)).toEqual({});
    expect(
      Object.keys(credentialStoreToAdd(plan, new Set([RECORD_KEYS_SECRET]), GEN)).sort(),
    ).toEqual([KEY_SERVICE_KEY_ID_SECRET, KEY_SERVICE_KEY_SECRET, MCP_STATE_SECRET].sort());
    // Half a signing pair: left here (update refuses it) ...
    expect(credentialStoreToAdd(plan, new Set([KEY_SERVICE_KEY_SECRET]), GEN)).not.toHaveProperty(
      KEY_SERVICE_KEY_ID_SECRET,
    );
    // ... and replaced whole by the first deploy, before anything signed with it.
    const first = secretsToAdd(plan, new Set([KEY_SERVICE_KEY_ID_SECRET]), SUPPLIED, GEN);
    expect(first[KEY_SERVICE_KEY_ID_SECRET]).toBe(GEN.keyServiceKeyId);
    expect(first[KEY_SERVICE_KEY_SECRET]).toBe(GEN.keyServiceKey);
    // The server needs the pair and the state secret.
    const vars = platformVars(plan);
    const secrets = secretsToAdd(plan, new Set(), SUPPLIED, GEN);
    const { [MCP_STATE_SECRET]: _state, [KEY_SERVICE_KEY_SECRET]: _key, ...without } = secrets;
    expect(containerEnvProblems(vars, without, plan)).toEqual([
      "OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY would be missing",
      "OMNIGENT_MCP_OAUTH_STATE_SECRET would be missing",
    ]);
  });

  it("needs the replica's credentials only for an S3 replica", async () => {
    const staging = await stagingPlan();
    expect(
      Object.keys(secretsToAdd(staging, new Set(), { ownerPassword: OWNER_PASSWORD }, GEN)).sort(),
    ).toEqual(
      [
        COOKIE_SECRET,
        INITIALIZED_SECRET,
        PASSWORD_SECRET,
        LAUNCHER_KEY_SECRET,
        LAUNCHER_KEY_ID_SECRET,
        ...CREDENTIAL_STORE_SECRETS,
      ].sort(),
    );
    expect(() =>
      secretsToAdd(
        staging,
        new Set(),
        { ownerPassword: OWNER_PASSWORD },
        { ...GEN, cookieSecret: "" },
      ),
    ).toThrow(`a cookie secret is needed (${COOKIE_SECRET})`);
  });

  it("releases in one change: the flag set, the password deleted", () => {
    expect(RELEASE_CHANGES).toEqual({ [INITIALIZED_SECRET]: "true", [PASSWORD_SECRET]: null });
    expect(Object.isFrozen(RELEASE_CHANGES)).toBe(true);
  });

  it("checks what the server container would receive (WP2.2's serverContainerEnv)", async () => {
    const plan = await accountPlan();
    const vars = platformVars(plan);
    const secrets = secretsToAdd(plan, new Set(), SUPPLIED, GEN);
    expect(containerEnvProblems(vars, secrets, plan)).toEqual([]);
    const { [REPLICA_KEY_ID_SECRET]: _gone, ...withoutKey } = secrets;
    expect(containerEnvProblems(vars, withoutKey, plan)).toEqual([
      "LITESTREAM_ACCESS_KEY_ID would be missing",
    ]);
    const { [ARTIFACTS_SECRET_KEY_SECRET]: _alsoGone, ...withoutArtifactsKey } = secrets;
    expect(containerEnvProblems(vars, withoutArtifactsKey, plan)).toEqual([
      "AWS_SECRET_ACCESS_KEY would be missing",
    ]);
    const { SERVER_ENV_OMNIGENT_ARTIFACT_URI: _uri, ...withoutUri } = vars;
    expect(containerEnvProblems(withoutUri, secrets, plan)).toEqual([
      "OMNIGENT_ARTIFACT_URI would be missing",
    ]);
    const staging = await stagingPlan();
    const { SERVER_ENV_CFO_ALLOW_LOCAL_ARTIFACTS: _switch, ...withoutSwitch } =
      platformVars(staging);
    expect(
      containerEnvProblems(withoutSwitch, secretsToAdd(staging, new Set(), SUPPLIED, GEN), staging),
    ).toEqual(["CFO_ALLOW_LOCAL_ARTIFACTS would be missing"]);
    expect(containerEnvProblems({ ...vars, "SERVER_ENV_BAD-NAME": "x" }, secrets, plan)).toEqual([
      "SERVER_ENV_BAD-NAME would not reach the server: invalid name",
    ]);
  });
});

describe("the artifact bucket (G2-DUR-001)", () => {
  it("is required beside an S3 replica: the container's disk loses files at every restart", async () => {
    const { artifacts: _none, ...plan } = await accountPlan();
    expect(installationProblems(plan)).toEqual([
      "the plan names no artifact bucket: uploaded files would be lost at every restart (plan the installation again; G2-DUR-001)",
    ]);
    // A staging test installation with a file replica may keep them on the disk.
    expect(installationProblems(await stagingPlan())).toEqual([]);
  });

  it("is a bucket of its own, at an https endpoint", async () => {
    const problems = async (artifacts: { url: string; endpoint?: string }) =>
      installationProblems(await accountPlan({ artifacts }));
    expect(await problems({ url: "s3://cfo-canary-artifacts/omnigent" })).toEqual([]);
    for (const url of [
      "s3://",
      "gs://cfo-canary-artifacts",
      "s3://Cfo-Artifacts",
      "s3://cfo_artifacts",
      "s3://ab",
      `s3://${"a".repeat(64)}`,
      "s3://cfo-canary-artifacts?x=1",
      "s3://cfo-canary-artifacts#x",
      "s3://user@cfo-canary-artifacts",
      "s3://cfo-canary-artifacts:9000",
      "s3://cfo-canary-artifacts/a/../b",
      "s3://cfo-canary-artifacts/./b",
      "not a url",
      // Codex G2-DUR-001 r1-2: what a URL parser accepts and Omnigent's own parser does not.
      "S3://cfo-canary-artifacts",
      "s3://cfo-canary-artifacts?",
      "s3://cfo-canary-artifacts/x?y",
      "s3://cfo-canary-artifacts/x#",
      "s3://cfo-canary-artifacts/a b",
      "s3://cfo-canary-artifacts/a\\b",
      "s3://[broken",
      "s3:/cfo-canary-artifacts",
      // Codex G2-DUR-001 r2-2: invisible characters the image refuses (Python's isprintable).
      "s3://cfo-canary-artifacts/a\u200bb",
      "s3://cfo-canary-artifacts/a\u0085b",
      "s3://cfo-canary-artifacts/a\u202eb",
      "s3://cfo-canary-artifacts/a\u00a0b",
      "s3://cfo-canary-artifacts/a\u2028b",
    ]) {
      expect(await problems({ url }), url).toEqual([
        "the artifacts URL must be s3://<bucket>[/<prefix>], with an R2 bucket name",
      ]);
    }
    expect(await problems({ url: "s3://cfo-canary-replica/artifacts" })).toEqual([
      "the artifacts need a bucket of their own, not the replica's",
    ]);
    expect(
      await problems({ url: "s3://cfo-canary-artifacts", endpoint: "http://r2.example.test" }),
    ).toEqual(["the artifacts endpoint must be an https:// URL"]);
    const noEndpoint = await accountPlan({
      replica: { url: "s3://cfo-canary-replica/omnigent" },
    });
    expect(installationProblems(noEndpoint)).toEqual([
      "the artifacts need an S3 endpoint: give --artifacts-endpoint or the replica's",
    ]);
  });

  it("takes its own endpoint when given, and names the plan's buckets", async () => {
    const plan = await accountPlan({
      artifacts: { url: "s3://cfo-canary-artifacts/x", endpoint: "https://other.example.test" },
    });
    expect(platformVars(plan)).toMatchObject({
      SERVER_ENV_OMNIGENT_ARTIFACT_URI: "s3://cfo-canary-artifacts/x",
      SERVER_ENV_AWS_ENDPOINT_URL_S3: "https://other.example.test",
    });
    expect(bucketsOf(plan)).toEqual(["cfo-canary-replica", "cfo-canary-artifacts"]);
    expect(bucketsOf(await stagingPlan())).toEqual([]);
    // A plan from before D33 (no tag): the untagged default.
    expect(defaultArtifactsUrl({ platformWorker: "cloudflare-omnigent" })).toBe(
      "s3://cloudflare-omnigent-artifacts",
    );
    // The replica's endpoint unless named: the account's own R2 endpoint (WP3.25).
    expect(r2Endpoint("1".repeat(32))).toBe(`https://${"1".repeat(32)}.r2.cloudflarestorage.com`);
    expect(
      installationProblems(
        await accountPlan({
          replica: {
            url: "s3://cfo-canary-replica/omnigent",
            endpoint: r2Endpoint("1".repeat(32)),
          },
        }),
      ),
    ).toEqual([]);
    expect(
      installationProblems(
        await accountPlan({ artifacts: { url: defaultArtifactsUrl({ platformWorker: "x" }) } }),
      ),
    ).toEqual([]);
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
    const { name, account_id, vars, r2_buckets, ...rest } = rendered;
    expect({ name, account_id, vars }).toEqual({
      name: plan.platformWorker,
      account_id: plan.accountId,
      vars: platformVars(plan),
    });
    // The checkpoint bucket is named after this installation's platform Worker (WP3.18).
    expect(r2_buckets).toEqual([
      { binding: "CHECKPOINTS", bucket_name: `${plan.platformWorker}-checkpoints` },
    ]);
    const { name: _n, r2_buckets: _b, ...base } = BASE.platform;
    expect(rest).toEqual(base);
    expect(() => renderPlatformConfig({ ...BASE.platform, vars: {} }, plan)).toThrow(
      /already has variables/,
    );
  });

  it("keeps the server and the computers under the durable_object policy, their repositories declared (WP3.19)", async () => {
    const staging = await stagingPlan();
    const rendered = renderPlatformConfig(BASE.platform, staging);
    const containers = rendered.containers as Record<string, unknown>[];
    expect(containers.map((c) => [c.class_name, c.scheduling_policy])).toEqual([
      ["OmnigentServer", "durable_object"],
      ["WorkspaceDO", "durable_object"],
    ]);
    // The server's container output is logged; a computer's is not (WP3.19).
    expect(containers.map((c) => c.observability)).toEqual([
      { logs: { enabled: true } },
      { logs: { enabled: false } },
    ]);
    // No size or count in the configuration: the server's size is a start option.
    for (const c of containers) {
      expect(c).not.toHaveProperty("instance_type");
      expect(c).not.toHaveProperty("max_instances");
    }
    // What the staging tool records for teardown: Wrangler's <worker>-<class>-<image>.
    const name = staging.platformWorker;
    expect(declaredResources(withStagingNames(rendered, name), name).repositories).toEqual([
      `${name}-omnigentserver-server`,
      `${name}-workspacedo-computer`,
    ]);
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
    expect(rendered.vars).toEqual({
      CFO_INSTALLATION_ID: staging.installationId,
      CFO_WEB_FEATURES: "github-setup",
    });
    expect(rendered.durable_objects).toEqual({
      bindings: [
        { name: "OMNIGENT", class_name: "OmnigentServer", script_name: staging.platformWorker },
        // The platform pages' bindings (WP3.5): every one goes to this installation's platform.
        { name: "WORKSPACE", class_name: "WorkspaceDO", script_name: staging.platformWorker },
        { name: "CONTROL", class_name: "ControlDO", script_name: staging.platformWorker },
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

describe("planConflicts: install continuing a plan (Codex WP3.31 r1-3)", () => {
  const same = {
    hostname: "omnigent.example.test",
    ownerEmail: OWNER_EMAIL,
    ownerUsername: "owner",
  };

  it("finds none for the same installation, however the address is written, and compares only what was given", async () => {
    const plan = await accountPlan();
    expect(await planConflicts(plan, same)).toEqual([]);
    expect(
      await planConflicts(plan, {
        ...same,
        ownerEmail: ` ${OWNER_EMAIL.toUpperCase()}`,
        accountId: plan.accountId,
        platformWorker: plan.platformWorker,
        webWorker: plan.webWorker,
        replicaUrl: plan.replica.url,
        replicaEndpoint: plan.replica.endpoint,
        artifactsUrl: plan.artifacts?.url,
      }),
    ).toEqual([]);
  });

  it("names every option given that the plan does not hold", async () => {
    const plan = await accountPlan();
    expect(
      await planConflicts(plan, {
        hostname: "other.example.test",
        ownerEmail: "someone-else@example.test",
        ownerUsername: "admin",
        accountId: "2".repeat(32),
        platformWorker: "another",
        webWorker: "another-web",
        replicaUrl: "s3://cfo-canary-other/omnigent",
        replicaEndpoint: "https://other.example.test",
        artifactsUrl: "s3://cfo-canary-other-artifacts",
        artifactsEndpoint: "https://other.example.test",
      }),
    ).toEqual([
      "the hostname",
      "the owner's username",
      "the account",
      "the platform Worker",
      "the web Worker",
      "the replica URL",
      "the replica endpoint",
      "the artifacts URL",
      "the artifacts endpoint",
      "the owner's address",
    ]);
    expect(await planConflicts({ ...plan, ownerPin: "broken" }, same)).toEqual([
      "the owner's address",
    ]);
  });
});
