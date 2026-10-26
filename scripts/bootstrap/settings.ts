// The installation's settings, as the bootstrap script writes them (WP2.4). Pure.
//
// An installation is planned once, on the installer's laptop, and the plan is kept in a state
// file there (state.ts). The plan holds no secret: the owner's address appears only as the salted
// pin ingress compares against (WP2.1's makeOwnerPin), and the passwords and keys are read when
// they are uploaded and never written to disk.
//
// What reaches Cloudflare:
//   - the platform Worker's variables: the installation ID, and the server container's settings
//     as `SERVER_ENV_<NAME>` (WP2.2 forwards them as `<NAME>`; WP2.3's image reads them);
//   - the platform Worker's secrets: Omnigent's cookie secret, the replica's credentials, the
//     artifact bucket's credentials (the same R2 token's values may serve both, under their own
//     names), the pre-provisioned owner's password, and `CFO_INSTALLATION_INITIALIZED`. The last one is not
//     secret, but held as a Worker secret so that the bootstrap can flip it and delete the
//     password in one atomic change (one bulk secrets request), one platform release (R-27), and
//     so that no later deploy of the plain configuration can reset it (Wrangler deletes
//     variables a configuration leaves out; it never deletes secrets);
//   - the web Worker's variables: ingress's team domain, AUD, hostname and owner pin (WP2.1).

import { InstallationId } from "../../contracts/src/index.ts";
import { issuerFor } from "../../worker/src/ingress/access.ts";
import { parseHostnames } from "../../worker/src/ingress/hosts.ts";
import { parseOwnerPin } from "../../worker/src/ingress/owner.ts";
import { serverContainerEnv } from "../../worker/src/server/server-env.ts";

export const SERVER_ENV = "SERVER_ENV_";

/** The variable that names the installation, on both Workers: how a Worker is known as ours. */
export const INSTALLATION_ID_VAR = "CFO_INSTALLATION_ID";

/** The bootstrap password, as the platform Worker holds it (WP2.2's BOOTSTRAP_PASSWORD_SECRET). */
export const PASSWORD_SECRET = `${SERVER_ENV}OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD`;
/** Whether the owner exists and is durable (WP2.3): "false" at first, "true" from the release. */
export const INITIALIZED_SECRET = `${SERVER_ENV}CFO_INSTALLATION_INITIALIZED`;
export const COOKIE_SECRET = `${SERVER_ENV}OMNIGENT_ACCOUNTS_COOKIE_SECRET`;
export const REPLICA_KEY_ID_SECRET = `${SERVER_ENV}LITESTREAM_ACCESS_KEY_ID`;
export const REPLICA_SECRET_KEY_SECRET = `${SERVER_ENV}LITESTREAM_SECRET_ACCESS_KEY`;
/**
 * The artifact bucket's credentials (G2-DUR-001): Omnigent's S3 artifact store reads them as
 * boto3 does, and the server image gives them to the app only, never to Litestream.
 */
export const ARTIFACTS_KEY_ID_SECRET = `${SERVER_ENV}AWS_ACCESS_KEY_ID`;
export const ARTIFACTS_SECRET_KEY_SECRET = `${SERVER_ENV}AWS_SECRET_ACCESS_KEY`;
/** R2's region for the S3 API. */
export const R2_REGION = "auto";

/** Omnigent's minimum password length at login (WP2.3's MIN_PASSWORD_LENGTH). */
export const MIN_PASSWORD_LENGTH = 8;
/** Omnigent's username rule (`accounts_bootstrap._USERNAME_RE`); anything else becomes "admin". */
const USERNAME = /^[a-z0-9][a-z0-9._-]{0,63}(@[a-z0-9.-]+\.[a-z]{2,})?$/;
/** Names Omnigent reserves, and the container's OS user, which the design rules out. */
const REFUSED_USERNAMES = new Set(["local", "root"]);
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/;
/** Ingress's own rule for the AUD tag (worker/src/ingress/index.ts, AUD_TAG). */
const AUD = /^[A-Za-z0-9_-]{1,256}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
/** An R2 bucket name: lowercase letters, digits and hyphens, 3 to 63, no hyphen at either end. */
const R2_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
const STAGING_PREFIX = "cfo-stg-";

/** Where the installation goes: the installer's own account, or a guarded staging deployment. */
export type Target =
  | { readonly kind: "account" }
  | {
      readonly kind: "staging";
      /** The staging tool's owner of both deployments, for example "WP2.4". */
      readonly owner: string;
      /** The deployments' suffixes: the platform's and the web Worker's. */
      readonly platformSuffix: string;
      readonly webSuffix: string;
      /** How long the staging tool keeps them, in days. */
      readonly days: number;
    };

export interface Replica {
  /** `s3://<bucket>/<path>`; `file:///<path>` only for a staging test installation. */
  readonly url: string;
  /** The S3 endpoint, `https://<account>.r2.cloudflarestorage.com` for R2. */
  readonly endpoint?: string;
}

/**
 * Where Omnigent keeps its artifacts (uploaded files, session resources, agent bundles): a bucket
 * of their own (design, Operations), because the container's disk is lost at every replacement
 * and every release's restart (G2-DUR-001).
 */
export interface Artifacts {
  /** `s3://<bucket>[/<prefix>]`. */
  readonly url: string;
  /** The S3 endpoint; the replica's when not given. */
  readonly endpoint?: string;
}

/** The plan: everything the bootstrap writes that is not a secret. Fixed once planned. */
export interface Installation {
  readonly installationId: string;
  readonly accountId: string;
  readonly platformWorker: string;
  readonly webWorker: string;
  /** The public hostname, served by the web Worker behind owner-only Access. */
  readonly hostname: string;
  /** The owner's address as ingress pins it (WP2.1's makeOwnerPin): salted, not the address. */
  readonly ownerPin: string;
  /** The pre-provisioned owner's Omnigent username, always explicit (design, Bootstrap). */
  readonly ownerUsername: string;
  readonly replica: Replica;
  /**
   * Required with an S3 replica. Only a staging test installation with a file replica may leave
   * it out: its server then keeps artifacts on the container's disk (the image's test switch).
   */
  readonly artifacts?: Artifacts;
  readonly target: Target;
  readonly plannedAt: string;
}

/** Access's settings for the hostname, read from Cloudflare and checked (cloud.ts). */
export interface AccessSettings {
  readonly teamDomain: string;
  readonly aud: string;
}

/** The secrets the installer supplies; each read only when it must be uploaded. */
export interface SuppliedSecrets {
  readonly ownerPassword?: string;
  readonly replicaAccessKeyId?: string;
  readonly replicaSecretAccessKey?: string;
  /** The artifact bucket's; when not given, the replica's (one R2 token covering both buckets). */
  readonly artifactsAccessKeyId?: string;
  readonly artifactsSecretAccessKey?: string;
}

/** The artifact bucket a plan gets unless the installer names one: `<platform Worker>-artifacts`. */
export function defaultArtifactsUrl(platformWorker: string): string {
  return `s3://${platformWorker}-artifacts`;
}

/** The bucket of an `s3://` URL, or undefined. */
export function bucketOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "s3:" && parsed.hostname !== "" ? parsed.hostname : undefined;
  } catch {
    return undefined;
  }
}

/** The R2 buckets an installation uses: the replica's (when on S3) and the artifacts'. */
export function bucketsOf(plan: Installation): string[] {
  const names = [bucketOf(plan.replica.url), plan.artifacts && artifactsBucket(plan.artifacts.url)];
  return [...new Set(names.filter((n): n is string => n !== undefined))];
}

/** A new installation ID: `ins_` and 26 Crockford base32 digits (130 random bits). */
export function newInstallationId(random: (n: number) => Uint8Array): string {
  const bytes = random(26);
  let id = "ins_";
  for (const byte of bytes) id += BASE32[byte & 31];
  return InstallationId.parse(id);
}

/** A problem with a planned value, or undefined. */
export function usernameProblem(username: string): string | undefined {
  if (!USERNAME.test(username)) {
    return "the owner's username must be lowercase letters, digits, '.', '_' or '-' (up to 64), optionally followed by @domain, as Omnigent requires";
  }
  if (REFUSED_USERNAMES.has(username)) return `the owner's username may not be "${username}"`;
  return undefined;
}

export function passwordProblem(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `the owner's password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password !== password.trim()) {
    return "the owner's password must not start or end with whitespace (the server image trims it)";
  }
  if (/[\0\r\n]/.test(password)) return "the owner's password must be one line";
  return undefined;
}

function httpsProblem(endpoint: string | undefined, what: string): string[] {
  if (endpoint === undefined) return [];
  let url: URL | undefined;
  try {
    url = new URL(endpoint);
  } catch {
    url = undefined;
  }
  return url?.protocol !== "https:" || url.username !== "" || url.password !== ""
    ? [`the ${what} endpoint must be an https:// URL`]
    : [];
}

/**
 * The bucket of an artifacts URL as Omnigent's own parser splits it (the literal `s3://`, then
 * the bucket up to the first `/`), when the server image would accept it: an R2 bucket name and
 * a plain prefix. Never through a URL parser, which reads `S3://` or a lone `?` differently.
 */
export function artifactsBucket(url: string): string | undefined {
  if (!url.startsWith("s3://")) return undefined;
  const rest = url.slice("s3://".length);
  const slash = rest.indexOf("/");
  const bucket = slash < 0 ? rest : rest.slice(0, slash);
  const prefix = slash < 0 ? "" : rest.slice(slash + 1);
  if (!R2_BUCKET.test(bucket)) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
  if (/[?#\\\s\x00-\x1f\x7f]/.test(prefix)) return undefined;
  if (prefix.split("/").some((s) => s === "." || s === "..")) return undefined;
  return bucket;
}

function artifactsProblems(plan: Installation): string[] {
  const artifacts = plan.artifacts;
  if (artifacts === undefined) {
    return plan.replica.url.startsWith("file:")
      ? []
      : [
          "the plan names no artifact bucket: uploaded files would be lost at every restart (plan the installation again; G2-DUR-001)",
        ];
  }
  const problems: string[] = [];
  const bucket = artifactsBucket(artifacts.url);
  if (bucket === undefined) {
    problems.push("the artifacts URL must be s3://<bucket>[/<prefix>], with an R2 bucket name");
  } else if (bucket === bucketOf(plan.replica.url)) {
    problems.push("the artifacts need a bucket of their own, not the replica's");
  }
  problems.push(...httpsProblem(artifacts.endpoint, "artifacts"));
  if (artifacts.endpoint === undefined && plan.replica.endpoint === undefined) {
    problems.push("the artifacts need an S3 endpoint: give --artifacts-endpoint or the replica's");
  }
  return problems;
}

function replicaProblems(replica: Replica, target: Target): string[] {
  const problems: string[] = [];
  let url: URL;
  try {
    url = new URL(replica.url);
  } catch {
    return ["the replica URL must be s3://<bucket>/<path>"];
  }
  if (url.protocol === "s3:") {
    if (url.hostname === "" || url.search !== "" || url.hash !== "" || url.username !== "") {
      problems.push("the replica URL must be s3://<bucket>/<path> with nothing else");
    }
  } else if (url.protocol === "file:") {
    // WP2.3's image accepts a file replica only with CFO_ALLOW_FILE_REPLICA, for tests. It lives
    // on the container's own disk and does not survive a replacement.
    if (target.kind !== "staging") problems.push("a file:// replica is only for staging tests");
    if (!url.pathname.startsWith("/") || url.pathname === "/") {
      problems.push("a file:// replica needs an absolute path");
    }
  } else {
    problems.push("the replica URL must be s3://<bucket>/<path>");
  }
  problems.push(...httpsProblem(replica.endpoint, "replica"));
  return problems;
}

/** Every problem with a plan; empty when it can be used. */
export function installationProblems(plan: Installation): string[] {
  const problems: string[] = [];
  if (!InstallationId.safeParse(plan.installationId).success) {
    problems.push("the installation ID is not ins_<26 base32 digits>");
  }
  if (!ACCOUNT_ID.test(plan.accountId)) problems.push("the account ID must be 32 hex digits");
  for (const [what, name] of [
    ["platform Worker", plan.platformWorker],
    ["web Worker", plan.webWorker],
  ] as const) {
    if (!WORKER_NAME.test(name)) problems.push(`the ${what}'s name is not a valid Worker name`);
  }
  if (plan.platformWorker === plan.webWorker) {
    problems.push("the platform and web Workers need different names");
  }
  if (!HOSTNAME.test(plan.hostname)) problems.push("the hostname is not a lowercase DNS name");
  if (parseOwnerPin(plan.ownerPin) === undefined) {
    problems.push("the owner pin is not hmac-sha256:<salt>:<digest>");
  }
  const username = usernameProblem(plan.ownerUsername);
  if (username) problems.push(username);
  problems.push(...replicaProblems(plan.replica, plan.target));
  problems.push(...artifactsProblems(plan));
  if (plan.target.kind === "staging") {
    for (const name of [plan.platformWorker, plan.webWorker]) {
      if (!name.startsWith(STAGING_PREFIX)) {
        problems.push(`a staging installation's Workers are named ${STAGING_PREFIX}…`);
      }
    }
    if (
      plan.platformWorker !== `${STAGING_PREFIX}${plan.target.platformSuffix}` ||
      plan.webWorker !== `${STAGING_PREFIX}${plan.target.webSuffix}`
    ) {
      problems.push("a staging installation's Workers carry its staging suffixes");
    }
    if (!(plan.target.days > 0 && plan.target.days <= 30)) {
      problems.push("a staging installation lasts 1 to 30 days");
    }
  } else if (
    plan.platformWorker.startsWith(STAGING_PREFIX) ||
    plan.webWorker.startsWith(STAGING_PREFIX)
  ) {
    problems.push(`${STAGING_PREFIX}… names belong to the guarded staging tool`);
  }
  return problems;
}

/** The platform Worker's variables: the installation ID and the server's plain settings. */
export function platformVars(plan: Installation): Record<string, string> {
  const vars: Record<string, string> = {
    [INSTALLATION_ID_VAR]: plan.installationId,
    [`${SERVER_ENV}OMNIGENT_ACCOUNTS_BASE_URL`]: `https://${plan.hostname}`,
    [`${SERVER_ENV}OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME`]: plan.ownerUsername,
    [`${SERVER_ENV}CFO_REPLICA_URL`]: plan.replica.url,
  };
  if (plan.replica.endpoint !== undefined) {
    vars[`${SERVER_ENV}CFO_REPLICA_ENDPOINT`] = plan.replica.endpoint;
  }
  if (plan.replica.url.startsWith("file:")) vars[`${SERVER_ENV}CFO_ALLOW_FILE_REPLICA`] = "true";
  if (plan.artifacts !== undefined) {
    vars[`${SERVER_ENV}OMNIGENT_ARTIFACT_URI`] = plan.artifacts.url;
    const endpoint = plan.artifacts.endpoint ?? plan.replica.endpoint;
    if (endpoint !== undefined) vars[`${SERVER_ENV}AWS_ENDPOINT_URL_S3`] = endpoint;
    vars[`${SERVER_ENV}AWS_REGION`] = R2_REGION;
  } else {
    // Only a staging test installation with a file replica (installationProblems).
    vars[`${SERVER_ENV}CFO_ALLOW_LOCAL_ARTIFACTS`] = "true";
  }
  return vars;
}

/** Whether the replica is reached over S3, and so needs the two credentials. */
export function needsReplicaCredentials(plan: Installation): boolean {
  return plan.replica.url.startsWith("s3:");
}

/** Whether the artifacts are in a bucket, and so need the two credentials. */
export function needsArtifactCredentials(plan: Installation): boolean {
  return plan.artifacts !== undefined;
}

/** The platform Worker's secrets, by name, that an installation holds before its release. */
export function requiredSecretNames(plan: Installation): string[] {
  return [
    COOKIE_SECRET,
    INITIALIZED_SECRET,
    PASSWORD_SECRET,
    ...(needsReplicaCredentials(plan) ? [REPLICA_KEY_ID_SECRET, REPLICA_SECRET_KEY_SECRET] : []),
    ...(needsArtifactCredentials(plan)
      ? [ARTIFACTS_KEY_ID_SECRET, ARTIFACTS_SECRET_KEY_SECRET]
      : []),
  ];
}

/**
 * The secrets the first platform deploy must add: each required one the Worker does not hold
 * yet. An existing secret is never overwritten: a cookie secret kept keeps sessions, and an
 * `INITIALIZED` already set is never reset. `generated` supplies the cookie secret, and
 * `supplied` the installer's values; a missing value is an error naming it, never its value.
 */
export function secretsToAdd(
  plan: Installation,
  present: ReadonlySet<string>,
  supplied: SuppliedSecrets,
  generated: { readonly cookieSecret: string },
): Record<string, string> {
  const add: Record<string, string> = {};
  const need = (name: string, value: string | undefined, what: string) => {
    if (present.has(name)) return;
    if (value === undefined || value === "") throw new Error(`${what} is needed (${name})`);
    add[name] = value;
  };
  need(COOKIE_SECRET, generated.cookieSecret, "a cookie secret");
  need(INITIALIZED_SECRET, "false", "the initialized flag");
  if (!present.has(PASSWORD_SECRET)) {
    const password = supplied.ownerPassword;
    const problem =
      password === undefined ? "the owner's password is needed" : passwordProblem(password);
    if (problem) throw new Error(problem);
    add[PASSWORD_SECRET] = password as string;
  }
  if (needsReplicaCredentials(plan)) {
    need(REPLICA_KEY_ID_SECRET, supplied.replicaAccessKeyId, "the replica's access key ID");
    need(REPLICA_SECRET_KEY_SECRET, supplied.replicaSecretAccessKey, "the replica's secret key");
  }
  if (needsArtifactCredentials(plan)) {
    // One R2 token may cover both buckets: the installer pastes its values once.
    need(
      ARTIFACTS_KEY_ID_SECRET,
      supplied.artifactsAccessKeyId ?? supplied.replicaAccessKeyId,
      "the artifact bucket's access key ID",
    );
    need(
      ARTIFACTS_SECRET_KEY_SECRET,
      supplied.artifactsSecretAccessKey ?? supplied.replicaSecretAccessKey,
      "the artifact bucket's secret key",
    );
  }
  return add;
}

/** The release (R-27): one change that marks the installation initialized and deletes the password. */
export const RELEASE_CHANGES: Readonly<Record<string, string | null>> = Object.freeze({
  [INITIALIZED_SECRET]: "true",
  [PASSWORD_SECRET]: null,
});

/**
 * What the server container would receive (WP2.2's serverContainerEnv) from these variables and
 * secrets, with every problem the platform would have with it. Secret values stand in as given.
 */
export function containerEnvProblems(
  vars: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string>>,
  plan: Installation,
): string[] {
  const { vars: env, skipped } = serverContainerEnv({ ...vars, ...secrets });
  const problems = skipped.map((s) => `${s.name} would not reach the server: ${s.reason}`);
  const required = [
    "CFO_INSTALLATION_ID",
    "CFO_INSTALLATION_INITIALIZED",
    "CFO_REPLICA_URL",
    "OMNIGENT_ACCOUNTS_BASE_URL",
    "OMNIGENT_ACCOUNTS_COOKIE_SECRET",
    "OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME",
    ...(needsReplicaCredentials(plan)
      ? ["LITESTREAM_ACCESS_KEY_ID", "LITESTREAM_SECRET_ACCESS_KEY"]
      : []),
    ...(needsArtifactCredentials(plan)
      ? ["OMNIGENT_ARTIFACT_URI", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
      : ["CFO_ALLOW_LOCAL_ARTIFACTS"]),
  ];
  for (const name of required) if (!(name in env)) problems.push(`${name} would be missing`);
  return problems;
}

/** The web Worker's variables: ingress's settings (WP2.1). */
export interface WebVars {
  readonly ACCESS_TEAM_DOMAIN: string;
  readonly ACCESS_AUD: string;
  readonly ALLOWED_HOSTNAMES: string;
  readonly OWNER_EMAIL_HASH: string;
}

export function webVars(plan: Installation, access: AccessSettings): WebVars {
  return {
    ACCESS_TEAM_DOMAIN: access.teamDomain,
    ACCESS_AUD: access.aud,
    ALLOWED_HOSTNAMES: plan.hostname,
    OWNER_EMAIL_HASH: plan.ownerPin,
  };
}

/**
 * Problems with the web Worker's variables, read as ingress reads them (WP2.1's parseIngressEnv:
 * the issuer from the team domain, the AUD tag, the hostnames, the pin). A Workers-runtime test
 * checks the rendered variables against parseIngressEnv itself.
 */
export function accessProblems(plan: Installation, access: AccessSettings): string[] {
  const vars = webVars(plan, access);
  const problems: string[] = [];
  if (issuerFor(vars.ACCESS_TEAM_DOMAIN) === undefined) {
    problems.push("the team domain is not <team>.cloudflareaccess.com");
  }
  if (!AUD.test(vars.ACCESS_AUD)) problems.push("the Access AUD tag is malformed");
  if (parseHostnames(vars.ALLOWED_HOSTNAMES)?.join(",") !== plan.hostname) {
    problems.push("ingress would not read the hostname");
  }
  if (parseOwnerPin(vars.OWNER_EMAIL_HASH) === undefined)
    problems.push("the owner pin is malformed");
  return problems;
}

type Raw = Readonly<Record<string, unknown>>;

/**
 * The platform Worker's configuration for this installation: the checked-in one
 * (worker/wrangler.jsonc) with its name, account and variables. Containers keep the names
 * Wrangler derives from the Worker's name.
 */
export function renderPlatformConfig(base: Raw, plan: Installation): Record<string, unknown> {
  if ("vars" in base) throw new Error("the platform configuration already has variables");
  return {
    ...base,
    name: plan.platformWorker,
    account_id: plan.accountId,
    workers_dev: false,
    preview_urls: false,
    vars: platformVars(plan),
  };
}

/**
 * The web Worker's configuration: the checked-in one (worker/wrangler.web.jsonc) bound to this
 * installation's platform Worker, with the installation's ID, ingress's variables once Access is
 * known and, in the installer's own account, the public hostname as a custom domain. The
 * staging tool adds the hostname itself.
 */
export function renderWebConfig(
  base: Raw,
  plan: Installation,
  access: AccessSettings | undefined,
): Record<string, unknown> {
  if ("vars" in base || "routes" in base) {
    throw new Error("the web configuration already has variables or routes");
  }
  const objects = (base.durable_objects as { bindings?: unknown } | undefined)?.bindings;
  if (!Array.isArray(objects)) throw new Error("the web configuration binds no Durable Object");
  const bindings = objects.map((binding: unknown) => {
    const b = binding as Record<string, unknown>;
    if (typeof b.script_name !== "string") {
      throw new Error("every web Durable Object binding must name the platform Worker");
    }
    return { ...b, script_name: plan.platformWorker };
  });
  return {
    ...base,
    name: plan.webWorker,
    account_id: plan.accountId,
    workers_dev: false,
    preview_urls: false,
    durable_objects: { ...(base.durable_objects as object), bindings },
    ...(plan.target.kind === "account"
      ? { routes: [{ pattern: plan.hostname, custom_domain: true }] }
      : {}),
    // The installation's ID always, so that this Worker is known as ours (machine.ts); ingress
    // reads only its own four variables, and answers 503 to everything until they are set.
    vars: {
      [INSTALLATION_ID_VAR]: plan.installationId,
      ...(access === undefined ? {} : webVars(plan, access)),
    },
  };
}
