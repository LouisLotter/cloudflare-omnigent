// Where newer releases are found, and how each download is checked against its publisher's own
// data (WP3.37). Every call goes through the injected `fetch`, so the tests replay recorded
// registry answers; nothing here writes a file or runs a process.
//
// What each check proves:
//   - npm: the version's `dist.integrity` (SHA-512) and registry signatures exist, and Codex's
//     provenance attestation is still published. npm itself checks every tarball against that
//     integrity value when it installs, and `npm audit signatures` (install_clis.sh, record
//     mode) verifies the registry's signatures and the provenance, in the image's own stage,
//     on packages that must then be the installed ones file for file; check.ts compares their
//     integrity values with the ones read here.
//   - GitHub release downloads (gh, ttyd): the file's SHA-256 equals the line for it in the
//     release's own checksum file (gh_<v>_checksums.txt, SHA256SUMS), and, where GitHub
//     records one, the asset's upload digest. That shows the bytes are the ones the release
//     published, not who built them.
//   - PyPI (certifi, pip, uv): the hashes are PyPI's own SHA-256 of each uploaded file, taken
//     from its JSON API; pip's --require-hashes then checks every download in the build.
//   - Docker Hub: the digest of the tag's current index, checked against the manifest's bytes.
//     It records which image the official tag pointed to; it says nothing about its contents.

import { createHash } from "node:crypto";
import { VERSION } from "./pins.ts";

export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

export interface SourcePorts {
  readonly fetch: Fetch;
  /** Sent to api.github.com only, for its rate limit. Never needed, never sent elsewhere. */
  readonly githubToken?: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Numeric dotted versions: negative, zero or positive as `a` is older, equal or newer. */
export function compareVersions(a: string, b: string): number {
  for (const v of [a, b]) if (!VERSION.test(v)) throw new Error(`not a release version: ${v}`);
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function get(ports: SourcePorts, url: string, headers: Record<string, string> = {}) {
  const auth =
    ports.githubToken && new URL(url).hostname === "api.github.com"
      ? { authorization: `Bearer ${ports.githubToken}` }
      : {};
  const response = await ports.fetch(url, { headers: { ...headers, ...auth } });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return response;
}

async function getJson(ports: SourcePorts, url: string, headers: Record<string, string> = {}) {
  return (await (await get(ports, url, headers)).json()) as unknown;
}

async function getBytes(
  ports: SourcePorts,
  url: string,
  headers: Record<string, string> = {},
): Promise<Uint8Array> {
  return new Uint8Array(await (await get(ports, url, headers)).arrayBuffer());
}

function field(o: unknown, ...path: string[]): unknown {
  let at = o;
  for (const key of path) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

function str(o: unknown, ...path: string[]): string {
  const v = field(o, ...path);
  if (typeof v !== "string" || v === "") throw new Error(`missing ${path.join(".")}`);
  return v;
}

// ── npm ──────────────────────────────────────────────────────────────────────────────────

const NPM = "https://registry.npmjs.org";

/** The `latest` dist-tag: the version npm installs by default. */
export async function npmLatest(ports: SourcePorts, pkg: string): Promise<string> {
  const doc = await getJson(ports, `${NPM}/${pkg}`, {
    accept: "application/vnd.npm.install-v1+json",
  });
  return str(doc, "dist-tags", "latest");
}

export interface NpmVersion {
  readonly integrity: string;
  readonly signed: boolean;
  readonly provenance: boolean;
  /** `bin` and the install-time scripts, to notice a change the image's install relies on. */
  readonly shape: string;
  /** The linux/x64 package npm installs with it (its native binary), if it names one. */
  readonly linuxX64?: { readonly name: string; readonly version: string };
}

export async function npmVersion(
  ports: SourcePorts,
  pkg: string,
  version: string,
): Promise<NpmVersion> {
  const doc = await getJson(ports, `${NPM}/${pkg}/${version}`);
  if (str(doc, "version") !== version) throw new Error(`${pkg}@${version}: the registry disagrees`);
  const integrity = str(doc, "dist", "integrity");
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
    throw new Error(`${pkg}@${version}: no SHA-512 integrity value`);
  }
  const signatures = field(doc, "dist", "signatures");
  const scripts = (field(doc, "scripts") ?? {}) as Record<string, unknown>;
  const install = Object.fromEntries(
    ["preinstall", "install", "postinstall"]
      .filter((k) => k in scripts)
      .map((k) => [k, scripts[k]]),
  );
  // `"<pkg>-linux-x64": "1.2.3"` or `"npm:<other>@1.2.3-linux-x64"` (an alias, as Codex's).
  const spec = field(doc, "optionalDependencies", `${pkg}-linux-x64`);
  let linuxX64: { name: string; version: string } | undefined;
  if (typeof spec === "string") {
    const alias = /^npm:(@?[^@]+)@(.+)$/.exec(spec);
    linuxX64 = alias
      ? { name: alias[1] as string, version: alias[2] as string }
      : { name: `${pkg}-linux-x64`, version: spec };
  }
  return {
    integrity,
    signed: Array.isArray(signatures) && signatures.length > 0,
    provenance: field(doc, "dist", "attestations", "provenance") !== undefined,
    shape: JSON.stringify({ bin: field(doc, "bin") ?? null, scripts: install }),
    ...(linuxX64 && { linuxX64 }),
  };
}

// ── GitHub releases ──────────────────────────────────────────────────────────────────────

export interface Release {
  readonly tag: string;
  readonly version: string;
  readonly url: string;
  /** Asset name → GitHub's SHA-256 of the upload, where GitHub records one. */
  readonly digests: ReadonlyMap<string, string | undefined>;
}

/** The latest release (never a draft or pre-release), or the release with `tag`. */
export async function githubRelease(
  ports: SourcePorts,
  repo: string,
  tag?: string,
): Promise<Release> {
  const which = tag === undefined ? "latest" : `tags/${encodeURIComponent(tag)}`;
  const doc = await getJson(ports, `https://api.github.com/repos/${repo}/releases/${which}`, {
    accept: "application/vnd.github+json",
  });
  if (field(doc, "draft") === true || field(doc, "prerelease") === true) {
    throw new Error(`${repo}: the latest release is a draft or a pre-release`);
  }
  const name = str(doc, "tag_name");
  if (tag !== undefined && name !== tag) throw new Error(`${repo}: asked for ${tag}, got ${name}`);
  const assets = field(doc, "assets");
  if (!Array.isArray(assets)) throw new Error(`${repo}: no assets`);
  const digests = new Map<string, string | undefined>();
  for (const a of assets) {
    const d = field(a, "digest");
    digests.set(str(a, "name"), typeof d === "string" ? d.replace(/^sha256:/, "") : undefined);
  }
  return { tag: name, version: name.replace(/^v/, ""), url: str(doc, "html_url"), digests };
}

/** The SHA-256 a checksum file (`<hex>  <name>` lines) gives for `name`: exactly one line. */
export function checksumFor(text: string, name: string): string {
  const hits = text
    .split("\n")
    .map((line) => /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null && m[2] === name);
  if (hits.length !== 1) throw new Error(`checksum file: ${hits.length} lines for ${name}`);
  return (hits[0] as RegExpExecArray)[1] as string;
}

/**
 * Downloads one release asset and returns its SHA-256, after checking it against the release's
 * checksum file and GitHub's own upload digest. Throws on any disagreement.
 */
export async function verifiedAsset(
  ports: SourcePorts,
  release: Release,
  repo: string,
  asset: string,
  checksums: string,
): Promise<string> {
  const base = `https://github.com/${repo}/releases/download/${release.tag}`;
  for (const name of [asset, checksums]) {
    if (!release.digests.has(name)) throw new Error(`${repo} ${release.tag}: no asset ${name}`);
  }
  const listed = checksumFor(
    new TextDecoder().decode(await getBytes(ports, `${base}/${checksums}`)),
    asset,
  );
  const got = sha256Hex(await getBytes(ports, `${base}/${asset}`));
  if (got !== listed) throw new Error(`${asset}: SHA-256 ${got}, but ${checksums} says ${listed}`);
  const uploaded = release.digests.get(asset);
  if (uploaded !== undefined && uploaded !== got) {
    throw new Error(`${asset}: SHA-256 ${got}, but GitHub recorded ${uploaded}`);
  }
  return got;
}

// ── PyPI ─────────────────────────────────────────────────────────────────────────────────

export async function pypiLatest(ports: SourcePorts, name: string): Promise<string> {
  return str(await getJson(ports, `https://pypi.org/pypi/${name}/json`), "info", "version");
}

/**
 * PyPI's SHA-256 of each file `version` must accept: one non-yanked file per pattern, in the
 * patterns' order. Throws if a pattern matches none, or more than one.
 */
export async function pypiHashes(
  ports: SourcePorts,
  name: string,
  version: string,
  patterns: readonly RegExp[],
): Promise<string[]> {
  const doc = await getJson(ports, `https://pypi.org/pypi/${name}/${version}/json`);
  const files = field(doc, "urls");
  if (!Array.isArray(files)) throw new Error(`${name} ${version}: no files`);
  return patterns.map((pattern) => {
    const hits = files.filter(
      (f) => pattern.test(str(f, "filename")) && field(f, "yanked") !== true,
    );
    if (hits.length !== 1) {
      throw new Error(`${name} ${version}: ${hits.length} files match ${pattern}`);
    }
    const hash = str(hits[0], "digests", "sha256");
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`${name} ${version}: bad SHA-256`);
    return hash;
  });
}

// ── Docker Hub ───────────────────────────────────────────────────────────────────────────

const INDEX_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
];
const MANIFEST_TYPES = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];

async function hubToken(ports: SourcePorts, repo: string): Promise<string> {
  const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`;
  return str(await getJson(ports, url), "token");
}

/** A manifest by tag or digest, checked: its bytes' SHA-256 is the digest it is served as. */
async function manifest(ports: SourcePorts, repo: string, ref: string, token: string) {
  const response = await get(ports, `https://registry-1.docker.io/v2/${repo}/manifests/${ref}`, {
    authorization: `Bearer ${token}`,
    accept: [...INDEX_TYPES, ...MANIFEST_TYPES].join(", "),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = sha256Hex(bytes);
  const served = response.headers.get("docker-content-digest");
  if (served !== `sha256:${digest}` || (ref.startsWith("sha256:") && ref !== served)) {
    throw new Error(`${repo}:${ref}: manifest bytes do not match digest ${served}`);
  }
  return { digest, doc: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
}

function amd64(index: unknown, what: string): string {
  if (!INDEX_TYPES.includes(String(field(index, "mediaType")))) {
    throw new Error(`${what}: not a multi-platform index`);
  }
  const list = field(index, "manifests");
  const hits = (Array.isArray(list) ? list : []).filter(
    (m) =>
      field(m, "platform", "os") === "linux" && field(m, "platform", "architecture") === "amd64",
  );
  if (hits.length !== 1) throw new Error(`${what}: ${hits.length} linux/amd64 images`);
  return str(hits[0], "digest");
}

/** The digest of the index a Docker Hub official image's tag points to now. */
export async function hubDigest(ports: SourcePorts, repo: string, tag: string): Promise<string> {
  const token = await hubToken(ports, repo);
  const { digest, doc } = await manifest(ports, repo, tag, token);
  amd64(doc, `${repo}:${tag}`);
  return digest;
}

/**
 * One variable of the linux/amd64 image's environment (PYTHON_VERSION, NODE_VERSION), read
 * through the index, the manifest and the configuration, each checked against its digest.
 */
export async function hubImageEnv(
  ports: SourcePorts,
  repo: string,
  digest: string,
  variable: string,
): Promise<string> {
  const token = await hubToken(ports, repo);
  const index = await manifest(ports, repo, `sha256:${digest}`, token);
  const image = await manifest(ports, repo, amd64(index.doc, `${repo}@${digest}`), token);
  const config = str(image.doc, "config", "digest");
  const blob = await getBytes(ports, `https://registry-1.docker.io/v2/${repo}/blobs/${config}`, {
    authorization: `Bearer ${token}`,
  });
  if (`sha256:${sha256Hex(blob)}` !== config) throw new Error(`${repo}: config blob digest`);
  const env = field(JSON.parse(new TextDecoder().decode(blob)), "config", "Env");
  const hit = (Array.isArray(env) ? env : []).find(
    (e): e is string => typeof e === "string" && e.startsWith(`${variable}=`),
  );
  if (hit === undefined) throw new Error(`${repo}@${digest}: no ${variable}`);
  return hit.slice(variable.length + 1);
}
