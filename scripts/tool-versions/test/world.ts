// A fake of every registry the tool version check reads (npm, GitHub releases, PyPI, Docker
// Hub), serving consistent answers built from a few versions, and two synthetic Dockerfiles
// that pin the "current" ones. Tests change the world's latest versions and break its answers.

import { createHash } from "node:crypto";
import type { Fetch } from "../sources.ts";

export const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
export const integrity = (data: string) =>
  `sha512-${createHash("sha512").update(data).digest("base64")}`;

export const CURRENT = {
  claude: "2.1.311",
  codex: "0.164.0",
  gh: "2.103.3",
  ttyd: "1.7.7",
  certifi: "2026.10.23",
  pip: "26.2.2",
  uv: "0.12.10",
  python: "3.12.15",
  node: "22.23.4",
} as const;

/** The integrity values the world's registry gives the CLIs' packages and linux-x64 parts. */
export const integrities = (claude: string, codex: string) => ({
  CLAUDE_CODE_INTEGRITY: integrity(`@anthropic-ai/claude-code@${claude}`),
  CLAUDE_CODE_LINUX_X64_INTEGRITY: integrity(`@anthropic-ai/claude-code-linux-x64@${claude}`),
  CODEX_INTEGRITY: integrity(`@openai/codex@${codex}`),
  CODEX_LINUX_X64_INTEGRITY: integrity(`@openai/codex@${codex}-linux-x64`),
});

export const DIGESTS = {
  CLAUDE_CODE_TREE_SHA256: "a".repeat(64),
  CLAUDE_CODE_INSTALLED_SHA256: "b".repeat(64),
  CODEX_TREE_SHA256: "c".repeat(64),
} as const;

/** The bytes a release asset or wheel has, so every checksum can be computed from them. */
export const bytesOf = (name: string, version: string) => `${name} ${version} bytes`;
export const ghSha = (v: string) => sha256(bytesOf("gh", v));
export const ttydSha = (v: string) => sha256(bytesOf("ttyd", v));
export const wheelSha = (file: string) => sha256(bytesOf("wheel", file));

export const pyFiles = {
  certifi: (v: string) => [`certifi-${v}-py3-none-any.whl`],
  pip: (v: string) => [`pip-${v}-py3-none-any.whl`],
  uv: (v: string) => [
    `uv-${v}-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl`,
    `uv-${v}-py3-none-musllinux_1_1_x86_64.whl`,
  ],
} as const;

export const pyPin = (name: keyof typeof pyFiles, v: string) =>
  [`${name}==${v}`, ...pyFiles[name](v).map((f) => `--hash=sha256:${wheelSha(f)}`)].join(" ");

/** A Docker Hub image: its index, linux/amd64 manifest and config, all content-addressed. */
export function image(name: string, variable: string, version: string, salt = "") {
  const config = JSON.stringify({
    config: { Env: ["PATH=/usr/bin", `${variable}=${version}`] },
    salt,
  });
  const manifest = JSON.stringify({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: `sha256:${sha256(config)}` },
  });
  const index = JSON.stringify({
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      { digest: `sha256:${sha256(manifest)}`, platform: { os: "linux", architecture: "amd64" } },
      { digest: `sha256:${"0".repeat(64)}`, platform: { os: "linux", architecture: "arm64" } },
    ],
  });
  return { name, config, manifest, index, digest: sha256(index) };
}

export const PYTHON = image("python", "PYTHON_VERSION", CURRENT.python);
export const NODE = image("node", "NODE_VERSION", CURRENT.node);

/** The computer Dockerfile's managed lines, among others that must never change. */
export function computerDockerfile(pins: Partial<Record<string, string>> = {}): string {
  const v = {
    PYTHON_IMAGE: `python:3.12-slim@sha256:${PYTHON.digest}`,
    NODE_IMAGE: `node:22-slim@sha256:${NODE.digest}`,
    CERTIFI_PIN: `"${pyPin("certifi", CURRENT.certifi)}"`,
    PIP_PIN: `"${pyPin("pip", CURRENT.pip)}"`,
    UV_PIN: `"${pyPin("uv", CURRENT.uv)}"`,
    CLAUDE_CODE_VERSION: CURRENT.claude,
    CODEX_VERSION: CURRENT.codex,
    ...DIGESTS,
    GH_VERSION: CURRENT.gh,
    GH_SHA256_AMD64: ghSha(CURRENT.gh),
    TTYD_VERSION: CURRENT.ttyd,
    TTYD_SHA256: ttydSha(CURRENT.ttyd),
    ...pins,
  };
  return [
    "# syntax=docker/dockerfile:1.17",
    "ARG OMNIGENT_COMMIT=3d7f7d08c99344a5835516e059d5c15b8b78f37f",
    `ARG PYTHON_IMAGE=${v.PYTHON_IMAGE}`,
    `ARG NODE_IMAGE=${v.NODE_IMAGE}`,
    "# Trust pins over the fork's lock, hash-checked.",
    `ARG CERTIFI_PIN=${v.CERTIFI_PIN}`,
    `ARG PIP_PIN=${v.PIP_PIN}`,
    `ARG UV_PIN=${v.UV_PIN}`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a Dockerfile's own expansion
    "FROM ${PYTHON_IMAGE} AS runtime-base",
    "ARG LIBNSS_MYHOSTNAME_VERSION=257.13-1~deb13u1",
    'RUN echo "ARG CLAUDE_CODE_VERSION=not-this-one"',
    "FROM runtime-base AS cli-digests-record",
    "ARG CLAUDE_CODE_VERSION",
    "ARG CODEX_VERSION",
    "FROM runtime-base AS runtime",
    `ARG CLAUDE_CODE_VERSION=${v.CLAUDE_CODE_VERSION}`,
    `ARG CODEX_VERSION=${v.CODEX_VERSION}`,
    `ARG CLAUDE_CODE_TREE_SHA256=${v.CLAUDE_CODE_TREE_SHA256}`,
    `ARG CLAUDE_CODE_INSTALLED_SHA256=${v.CLAUDE_CODE_INSTALLED_SHA256}`,
    `ARG CODEX_TREE_SHA256=${v.CODEX_TREE_SHA256}`,
    `ARG GH_VERSION=${v.GH_VERSION}`,
    `ARG GH_SHA256_AMD64=${v.GH_SHA256_AMD64}`,
    `ARG TTYD_VERSION=${v.TTYD_VERSION}`,
    `ARG TTYD_SHA256=${v.TTYD_SHA256}`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a Dockerfile's own expansion
    'LABEL cloudflare-omnigent.claude-code="${CLAUDE_CODE_VERSION}"',
    "ARG TMUX_VERSION=3.5a",
    "",
  ].join("\n");
}

export function serverDockerfile(pins: Partial<Record<string, string>> = {}): string {
  const v = {
    PYTHON_IMAGE: `python:3.12-slim@sha256:${PYTHON.digest}`,
    NODE_IMAGE: `node:22-slim@sha256:${NODE.digest}`,
    CERTIFI_PIN: `"${pyPin("certifi", CURRENT.certifi)}"`,
    PIP_PIN: `"${pyPin("pip", CURRENT.pip)}"`,
    UV_PIN: `"${pyPin("uv", CURRENT.uv)}"`,
    ...pins,
  };
  return [
    "# The server image.",
    `ARG PYTHON_IMAGE=${v.PYTHON_IMAGE}`,
    `ARG NODE_IMAGE=${v.NODE_IMAGE}`,
    `ARG CERTIFI_PIN=${v.CERTIFI_PIN}`,
    `ARG PIP_PIN=${v.PIP_PIN}`,
    `ARG UV_PIN=${v.UV_PIN}`,
    "ARG LITESTREAM_VERSION=0.5.17",
    "",
  ].join("\n");
}

export const texts = () => ({
  "images/computer/Dockerfile": computerDockerfile(),
  "images/server/Dockerfile": serverDockerfile(),
});

/** The registries' state: what each "latest" is, and what each answer looks like. */
export class World {
  latest: { -readonly [K in keyof typeof CURRENT]: string } = { ...CURRENT };
  python = PYTHON;
  node = NODE;
  /** Versions whose npm metadata has provenance (Codex publishes it, for its parts too). */
  provenance = new Set([
    `@openai/codex@${CURRENT.codex}`,
    `@openai/codex@${CURRENT.codex}-linux-x64`,
  ]);
  /** Main package versions published without a linux/x64 part. */
  noLinuxPart = new Set<string>();

  /** Codex `version`, published with provenance for the package and its linux/x64 part. */
  codexWithProvenance(version: string): void {
    this.latest.codex = version;
    this.provenance.add(`@openai/codex@${version}`);
    this.provenance.add(`@openai/codex@${version}-linux-x64`);
  }
  unsigned = new Set<string>();
  npmShape: Record<string, unknown> = {};
  /** URL substrings that answer 500. */
  broken: string[] = [];
  /** A release asset's GitHub digest, overridden. */
  uploadDigest: Record<string, string> = {};
  /** Checksum-file text overridden per URL substring. */
  checksumText: Record<string, string> = {};
  yanked = new Set<string>();
  requests: { url: string; headers: Record<string, string> }[] = [];

  readonly fetch: Fetch = async (url, init) => {
    this.requests.push({ url, headers: init?.headers ?? {} });
    if (this.broken.some((b) => url.includes(b))) return new Response("nope", { status: 500 });
    const answer = this.answer(new URL(url));
    if (answer === undefined) return new Response("not found", { status: 404 });
    return answer;
  };

  private json(o: unknown) {
    return new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
  }

  private release(repo: string, tag: string, version: string) {
    const assets =
      repo === "cli/cli"
        ? [`gh_${version}_linux_amd64.tar.gz`, `gh_${version}_checksums.txt`]
        : ["ttyd.x86_64", "SHA256SUMS"];
    return this.json({
      tag_name: tag,
      html_url: `https://github.com/${repo}/releases/tag/${tag}`,
      draft: false,
      prerelease: false,
      assets: assets.map((name) => ({
        name,
        digest:
          this.uploadDigest[name] ??
          (name.endsWith(".txt") || name === "SHA256SUMS"
            ? null
            : `sha256:${sha256(bytesOf(repo === "cli/cli" ? "gh" : "ttyd", version))}`),
      })),
    });
  }

  private answer(u: URL): Response | undefined {
    const path = decodeURIComponent(u.pathname);
    if (u.hostname === "registry.npmjs.org") {
      const m = /^\/(@[^/]+\/[^/]+)(?:\/(.+))?$/.exec(path);
      if (!m) return undefined;
      const [, pkg = "", version] = m;
      const key = pkg === "@openai/codex" ? "codex" : "claude";
      if (version === undefined) return this.json({ "dist-tags": { latest: this.latest[key] } });
      const id = `${pkg}@${version}`;
      const main = !pkg.endsWith("-linux-x64") && !version.endsWith("-linux-x64");
      const part =
        key === "codex"
          ? { "@openai/codex-linux-x64": `npm:@openai/codex@${version}-linux-x64` }
          : { "@anthropic-ai/claude-code-linux-x64": version };
      return this.json({
        version,
        ...(main && !this.noLinuxPart.has(id)
          ? { optionalDependencies: { ...part, [`${pkg}-darwin-arm64`]: version } }
          : {}),
        bin: this.npmShape[id] ?? { [key]: "bin/x" },
        scripts: { postinstall: "node install.cjs", test: "x" },
        dist: {
          integrity: integrity(id),
          signatures: this.unsigned.has(id) ? [] : [{ keyid: "k", sig: "s" }],
          ...(this.provenance.has(id)
            ? { attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } } }
            : {}),
        },
      });
    }
    if (u.hostname === "api.github.com") {
      const m = /^\/repos\/([^/]+\/[^/]+)\/releases\/(latest|tags\/(.+))$/.exec(path);
      if (!m) return undefined;
      const repo = m[1] as string;
      const gh = repo === "cli/cli";
      const version = m[3] ? (m[3] as string).replace(/^v/, "") : this.latest[gh ? "gh" : "ttyd"];
      return this.release(repo, gh ? `v${version}` : version, version);
    }
    if (u.hostname === "github.com") {
      const m = /^\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(path);
      if (!m) return undefined;
      const [, repo, tag = "", name = ""] = m;
      const tool = repo === "cli/cli" ? "gh" : "ttyd";
      const version = tag.replace(/^v/, "");
      const asset = tool === "gh" ? `gh_${version}_linux_amd64.tar.gz` : "ttyd.x86_64";
      if (name === asset) return new Response(bytesOf(tool, version));
      const override = Object.entries(this.checksumText).find(([k]) => u.href.includes(k));
      if (override) return new Response(override[1]);
      if (name.endsWith("checksums.txt") || name === "SHA256SUMS") {
        const sum = sha256(bytesOf(tool, version));
        return new Response(`${"9".repeat(64)}  other.tar.gz\n${sum}  ${asset}\n`);
      }
      return undefined;
    }
    if (u.hostname === "pypi.org") {
      const m = /^\/pypi\/([^/]+)\/(?:([^/]+)\/)?json$/.exec(path);
      if (!m) return undefined;
      const name = m[1] as keyof typeof pyFiles;
      if (m[2] === undefined) return this.json({ info: { version: this.latest[name] } });
      const files = [...pyFiles[name](m[2]), `${name}-${m[2]}.tar.gz`];
      return this.json({
        urls: files.map((filename) => ({
          filename,
          digests: { sha256: wheelSha(filename) },
          yanked: this.yanked.has(filename),
        })),
      });
    }
    if (u.hostname === "auth.docker.io") return this.json({ token: "registry-token" });
    if (u.hostname === "registry-1.docker.io") {
      const m = /^\/v2\/library\/([^/]+)\/(manifests|blobs)\/(.+)$/.exec(path);
      if (!m) return undefined;
      const [, name, kind, ref = ""] = m;
      const images = name === "python" ? [PYTHON, this.python] : [NODE, this.node];
      const pick = (body: string) =>
        new Response(body, { headers: { "docker-content-digest": `sha256:${sha256(body)}` } });
      if (kind === "manifests") {
        if (ref === "3.12-slim" || ref === "22-slim")
          return pick((images[1] ?? images[0])?.index as string);
        for (const img of images) {
          if (ref === `sha256:${img.digest}`) return pick(img.index);
          if (ref === `sha256:${sha256(img.manifest)}`) return pick(img.manifest);
        }
        return undefined;
      }
      for (const img of images) {
        if (ref === `sha256:${sha256(img.config)}`) return new Response(img.config);
      }
    }
    return undefined;
  }
}
