// The daily check (WP3.37): which pinned tools have newer releases, and the new pins for them,
// every checksum computed from the publisher's own data (sources.ts) or, for Claude Code's and
// Codex's installed trees, by the image's own install stage (install_clis.sh, record mode).
//
// All or nothing: any failed lookup or check rejects the whole check, so a bump file holds
// either every update found or none. Never a downgrade: a release older than the pin is only
// reported. No minimum release age (the owner dropped the 7-day cooldown on 20 Oct 2026).
//
// `reproduce` runs the same code with each tool's current version as its target: every value
// it computes must equal the committed pin. It is how the rules are shown to give the pins the
// images already carry, before they are trusted for new versions.

import {
  type ArgName,
  type Bump,
  type Change,
  formatImage,
  formatPyPin,
  parseBump,
  parseImage,
  parsePyPin,
  readPins,
  SHA256,
  type Texts,
  TOOLS,
  type ToolId,
  VERSION,
} from "./pins.ts";
import {
  compareVersions,
  githubRelease,
  hubDigest,
  hubImageEnv,
  type NpmVersion,
  npmLatest,
  npmVersion,
  pypiHashes,
  pypiLatest,
  type SourcePorts,
  verifiedAsset,
} from "./sources.ts";

export const DIGEST_ARGS = [
  "CLAUDE_CODE_TREE_SHA256",
  "CLAUDE_CODE_INSTALLED_SHA256",
  "CODEX_TREE_SHA256",
] as const;
export type CliDigests = Record<(typeof DIGEST_ARGS)[number], string>;
/** The integrity values npm checked the audited packages against (install_clis.sh, record). */
export const INTEGRITY_KEYS = [
  "CLAUDE_CODE_INTEGRITY",
  "CLAUDE_CODE_LINUX_X64_INTEGRITY",
  "CODEX_INTEGRITY",
  "CODEX_LINUX_X64_INTEGRITY",
] as const;
export interface CliRecord {
  readonly digests: CliDigests;
  readonly integrity: Record<(typeof INTEGRITY_KEYS)[number], string>;
}
/** What the cli-digests stage is built from: the CLIs and everything in the stage under them. */
export const DIGEST_INPUTS = [
  "CLAUDE_CODE_VERSION",
  "CODEX_VERSION",
  "PYTHON_IMAGE",
  "NODE_IMAGE",
  "PIP_PIN",
] as const satisfies readonly ArgName[];

export interface CheckPorts extends SourcePorts {
  /** Builds the computer Dockerfile's cli-digests stage with these build arguments. */
  readonly recordCliDigests: (args: Readonly<Record<string, string>>) => Promise<CliRecord>;
  readonly log: (message: string) => void;
}

/**
 * The cli-digests stage's output (install_clis.sh, record mode): exactly the three digests, the
 * four integrity values and the two versions, each once. Throws on anything else, or on
 * versions other than requested.
 */
export function parseCliRecord(
  text: string,
  versions: { readonly claudeCode: string; readonly codex: string },
): CliRecord {
  const seen = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m || seen.has(m[1] as string)) throw new Error(`cli digests: unexpected line ${line}`);
    seen.set(m[1] as string, m[2] as string);
  }
  const want = [...DIGEST_ARGS, ...INTEGRITY_KEYS, "CLAUDE_CODE_VERSION", "CODEX_VERSION"];
  if (seen.size !== want.length || want.some((k) => !seen.has(k))) {
    throw new Error(`cli digests: expected ${want.join(", ")}`);
  }
  if (seen.get("CLAUDE_CODE_VERSION") !== versions.claudeCode) {
    throw new Error("cli digests: recorded for another Claude Code version");
  }
  if (seen.get("CODEX_VERSION") !== versions.codex) {
    throw new Error("cli digests: recorded for another Codex version");
  }
  const digests = {} as CliDigests;
  for (const k of DIGEST_ARGS) {
    const v = seen.get(k) as string;
    if (!SHA256.test(v)) throw new Error(`cli digests: ${k} is not a SHA-256`);
    digests[k] = v;
  }
  const integrity = {} as CliRecord["integrity"];
  for (const k of INTEGRITY_KEYS) {
    const v = seen.get(k) as string;
    if (!SRI_SHA512.test(v)) throw new Error(`cli digests: ${k} is not a SHA-512 integrity value`);
    integrity[k] = v;
  }
  return { digests, integrity };
}

/**
 * The registry's integrity values for the recorded versions, read here, independently of the
 * Docker build: the audited install must have been checked against exactly these.
 */
async function checkIntegrity(
  ports: SourcePorts,
  versions: { readonly claudeCode: string; readonly codex: string },
  recorded: CliRecord["integrity"],
): Promise<void> {
  const [claude, codex] = await Promise.all([
    npmVersion(ports, "@anthropic-ai/claude-code", versions.claudeCode),
    npmVersion(ports, "@openai/codex", versions.codex),
  ]);
  const parts = await Promise.all(
    [claude, codex].map((v) => {
      if (v.linuxX64 === undefined) throw new Error("no linux-x64 package");
      return npmVersion(ports, v.linuxX64.name, v.linuxX64.version);
    }),
  );
  const registry: CliRecord["integrity"] = {
    CLAUDE_CODE_INTEGRITY: claude.integrity,
    CLAUDE_CODE_LINUX_X64_INTEGRITY: (parts[0] as NpmVersion).integrity,
    CODEX_INTEGRITY: codex.integrity,
    CODEX_LINUX_X64_INTEGRITY: (parts[1] as NpmVersion).integrity,
  };
  for (const k of INTEGRITY_KEYS) {
    if (recorded[k] !== registry[k]) {
      throw new Error(
        `${k}: the audited install's ${recorded[k]} is not the registry's ${registry[k]}`,
      );
    }
  }
}

/** Release notes for a version of each CLI the image installs from npm. */
const NPM_LINKS = {
  "claude-code": (v: string) => `https://github.com/anthropics/claude-code/releases/tag/v${v}`,
  codex: (v: string) => `https://github.com/openai/codex/releases/tag/rust-v${v}`,
} as const;

interface Found {
  readonly args: Partial<Record<ArgName, string>>;
  readonly change?: Change;
  readonly warning?: string;
  /** What was checked, for the log. */
  readonly checked?: string;
}
const NOTHING: Found = { args: {} };

type Pins = Record<ArgName, string>;
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** The version to compute pins for: the current one when reproducing, else a newer release. */
function target(
  tool: ToolId,
  current: string,
  latest: string,
  reproduce: boolean,
): { version?: string; warning?: string } {
  if (reproduce) return { version: current };
  if (!VERSION.test(latest)) {
    const shown = latest.replace(/[^\x20-\x7e]/g, "?").slice(0, 40);
    return { warning: `${TOOLS[tool]}: the latest release, ${shown}, is not a plain version` };
  }
  const order = compareVersions(latest, current);
  if (order < 0) {
    return { warning: `${TOOLS[tool]}: the latest release, ${latest}, is older than ${current}` };
  }
  return order > 0 ? { version: latest } : {};
}

async function npmTool(
  ports: SourcePorts,
  pins: Pins,
  reproduce: boolean,
  tool: "claude-code" | "codex",
  pkg: string,
  arg: "CLAUDE_CODE_VERSION" | "CODEX_VERSION",
): Promise<Found> {
  const current = pins[arg];
  const t = target(tool, current, await npmLatest(ports, pkg), reproduce);
  if (t.version === undefined) return t.warning ? { args: {}, warning: t.warning } : NOTHING;
  const [was, now] = await Promise.all([
    npmVersion(ports, pkg, current),
    npmVersion(ports, pkg, t.version),
  ]);
  // The package and its linux/x64 part, which holds the native binary: each must be signed by
  // the registry, and keep the provenance attestation the pinned version's part had.
  if (now.linuxX64 === undefined) throw new Error(`${pkg}@${t.version}: no linux-x64 package`);
  const parts = await Promise.all(
    [was.linuxX64, now.linuxX64].map((part) =>
      part === undefined ? undefined : npmVersion(ports, part.name, part.version),
    ),
  );
  for (const [name, before, after] of [
    [`${pkg}@${t.version}`, was, now],
    [`${now.linuxX64.name}@${now.linuxX64.version}`, parts[0], parts[1] as NpmVersion],
  ] as const) {
    if (!after.signed) throw new Error(`${name}: no registry signatures`);
    if (before?.provenance && !after.provenance) {
      throw new Error(`${name}: no provenance attestation, which ${current}'s has`);
    }
  }
  const note =
    was.shape === now.shape
      ? undefined
      : "Its bin entry or install scripts changed: check that install_clis.sh still fits it.";
  return {
    checked: `${pkg}@${t.version} and ${now.linuxX64.name}@${now.linuxX64.version}: SHA-512 integrity, registry signatures${now.provenance ? ", provenance" : ""} published`,
    args: { [arg]: t.version },
    change: {
      tool,
      from: current,
      to: t.version,
      link: NPM_LINKS[tool](t.version),
      ...(note && { note }),
    },
  };
}

async function releaseTool(
  ports: SourcePorts,
  pins: Pins,
  reproduce: boolean,
  spec: {
    readonly tool: "gh" | "ttyd";
    readonly repo: string;
    readonly versionArg: "GH_VERSION" | "TTYD_VERSION";
    readonly shaArg: "GH_SHA256_AMD64" | "TTYD_SHA256";
    /** The release tag the Dockerfile's download URL builds from the version. */
    readonly tag: (v: string) => string;
    readonly asset: (v: string) => string;
    readonly checksums: (v: string) => string;
  },
): Promise<Found> {
  const current = pins[spec.versionArg];
  const latest = await githubRelease(ports, spec.repo);
  const t = target(spec.tool, current, latest.version, reproduce);
  if (t.version === undefined) return t.warning ? { args: {}, warning: t.warning } : NOTHING;
  // Reproducing reads the pinned version's own release, not the latest.
  const release =
    t.version === latest.version
      ? latest
      : await githubRelease(ports, spec.repo, spec.tag(t.version));
  if (release.tag !== spec.tag(t.version)) {
    throw new Error(`${spec.repo}: tag ${release.tag} is not ${spec.tag(t.version)}`);
  }
  const sha = await verifiedAsset(
    ports,
    release,
    spec.repo,
    spec.asset(t.version),
    spec.checksums(t.version),
  );
  return {
    checked: `${spec.asset(t.version)} ${t.version}: SHA-256 matches ${spec.checksums(t.version)}`,
    args: { [spec.versionArg]: t.version, [spec.shaArg]: sha },
    change: { tool: spec.tool, from: current, to: t.version, link: release.url },
  };
}

async function imageTool(
  ports: SourcePorts,
  pins: Pins,
  reproduce: boolean,
  tool: "python-image" | "node-image",
  arg: "PYTHON_IMAGE" | "NODE_IMAGE",
  variable: string,
  link: (was: string, now: string) => string,
): Promise<Found> {
  const ref = parseImage(pins[arg]);
  const repo = `library/${ref.name}`;
  const digest = reproduce ? ref.digest : await hubDigest(ports, repo, ref.tag);
  if (digest === ref.digest && !reproduce) return NOTHING;
  const [was, now] = await Promise.all([
    hubImageEnv(ports, repo, ref.digest, variable),
    hubImageEnv(ports, repo, digest, variable),
  ]);
  return {
    checked: `${ref.name}:${ref.tag}@sha256:${digest.slice(0, 12)}: index, manifest and config digests`,
    args: { [arg]: formatImage({ ...ref, digest }) },
    change: {
      tool,
      from: `${was} (sha256:${ref.digest.slice(0, 12)})`,
      to: `${now} (sha256:${digest.slice(0, 12)})`,
      link: link(was, now),
    },
  };
}

async function pypiTool(
  ports: SourcePorts,
  pins: Pins,
  reproduce: boolean,
  tool: "certifi" | "pip" | "uv",
  arg: "CERTIFI_PIN" | "PIP_PIN" | "UV_PIN",
  patterns: readonly RegExp[],
  link: (v: string) => string,
): Promise<Found> {
  const pin = parsePyPin(pins[arg]);
  if (pin.hashes.length !== patterns.length) {
    throw new Error(`${arg}: ${pin.hashes.length} hashes, but ${patterns.length} file patterns`);
  }
  const t = target(tool, pin.version, await pypiLatest(ports, pin.name), reproduce);
  if (t.version === undefined) return t.warning ? { args: {}, warning: t.warning } : NOTHING;
  const hashes = await pypiHashes(ports, pin.name, t.version, patterns);
  return {
    checked: `${pin.name} ${t.version}: PyPI's SHA-256 of ${hashes.length} file(s)`,
    args: { [arg]: formatPyPin({ name: pin.name, version: t.version, hashes }) },
    change: { tool, from: pin.version, to: t.version, link: link(t.version) },
  };
}

/** Every lookup, concurrently. Rejects if any of them fails. */
async function lookups(ports: SourcePorts, pins: Pins, reproduce: boolean): Promise<Found[]> {
  return Promise.all([
    npmTool(
      ports,
      pins,
      reproduce,
      "claude-code",
      "@anthropic-ai/claude-code",
      "CLAUDE_CODE_VERSION",
    ),
    npmTool(ports, pins, reproduce, "codex", "@openai/codex", "CODEX_VERSION"),
    releaseTool(ports, pins, reproduce, {
      tool: "gh",
      repo: "cli/cli",
      versionArg: "GH_VERSION",
      shaArg: "GH_SHA256_AMD64",
      tag: (v) => `v${v}`,
      asset: (v) => `gh_${v}_linux_amd64.tar.gz`,
      checksums: (v) => `gh_${v}_checksums.txt`,
    }),
    releaseTool(ports, pins, reproduce, {
      tool: "ttyd",
      repo: "tsl0922/ttyd",
      versionArg: "TTYD_VERSION",
      shaArg: "TTYD_SHA256",
      tag: (v) => v,
      asset: () => "ttyd.x86_64",
      checksums: () => "SHA256SUMS",
    }),
    imageTool(
      ports,
      pins,
      reproduce,
      "python-image",
      "PYTHON_IMAGE",
      "PYTHON_VERSION",
      () => "https://hub.docker.com/_/python",
    ),
    imageTool(ports, pins, reproduce, "node-image", "NODE_IMAGE", "NODE_VERSION", (was, now) =>
      was === now
        ? "https://hub.docker.com/_/node"
        : `https://github.com/nodejs/node/releases/tag/v${now}`,
    ),
    pypiTool(
      ports,
      pins,
      reproduce,
      "certifi",
      "CERTIFI_PIN",
      [/^certifi-[\d.]+-py3-none-any\.whl$/],
      (v) => `https://pypi.org/project/certifi/${v}/`,
    ),
    pypiTool(
      ports,
      pins,
      reproduce,
      "pip",
      "PIP_PIN",
      [/^pip-[\d.]+-py3-none-any\.whl$/],
      () => "https://pip.pypa.io/en/stable/news/",
    ),
    pypiTool(
      ports,
      pins,
      reproduce,
      "uv",
      "UV_PIN",
      [
        /^uv-[\d.]+-py3-none-manylinux[\w.]*_x86_64\.whl$/,
        /^uv-[\d.]+-py3-none-musllinux_\d+_\d+_x86_64\.whl$/,
      ],
      (v) => `https://github.com/astral-sh/uv/releases/tag/${v}`,
    ),
  ]);
}

/**
 * Finds newer releases of every managed tool and computes their pins. Returns the bump (no
 * changes when everything is current). With `reproduce`, recomputes the current pins instead
 * and throws unless every one comes out exactly as committed.
 */
export async function checkTools(
  texts: Texts,
  ports: CheckPorts,
  options: { readonly reproduce?: boolean } = {},
): Promise<Bump> {
  const reproduce = options.reproduce === true;
  const pins = readPins(texts);
  const found = await lookups(ports, pins, reproduce);
  const args: Partial<Record<ArgName, string>> = {};
  const changes: Change[] = [];
  const warnings: string[] = [];
  for (const f of found) {
    Object.assign(args, f.args);
    if (f.change) changes.push(f.change);
    if (f.warning) warnings.push(f.warning);
    if (f.checked) ports.log(f.checked);
  }
  if (reproduce || DIGEST_INPUTS.some((name) => args[name] !== undefined)) {
    const inputs = Object.fromEntries(
      DIGEST_INPUTS.map((name) => [name, args[name] ?? pins[name]]),
    );
    ports.log(
      `recording the CLIs' tree digests (${inputs.CLAUDE_CODE_VERSION}, ${inputs.CODEX_VERSION})`,
    );
    const record = await ports.recordCliDigests(inputs);
    await checkIntegrity(
      ports,
      { claudeCode: inputs.CLAUDE_CODE_VERSION as string, codex: inputs.CODEX_VERSION as string },
      record.integrity,
    );
    const digests = record.digests;
    for (const name of DIGEST_ARGS) args[name] = digests[name];
    for (const [tool, versionArg, names] of [
      [
        "claude-code",
        "CLAUDE_CODE_VERSION",
        ["CLAUDE_CODE_TREE_SHA256", "CLAUDE_CODE_INSTALLED_SHA256"],
      ],
      ["codex", "CODEX_VERSION", ["CODEX_TREE_SHA256"]],
    ] as const) {
      const moved = names.some((name) => digests[name] !== pins[name]);
      if (moved && args[versionArg] === undefined && !reproduce) {
        changes.push({
          tool,
          from: pins[versionArg],
          to: pins[versionArg],
          link: NPM_LINKS[tool](pins[versionArg]),
          note: "Same version, new installed-tree digest after the base image change: find out why before merging.",
        });
      }
    }
  }
  // Only values that differ from the pins stay in the bump.
  for (const name of Object.keys(args) as ArgName[]) {
    if (args[name] === pins[name]) delete args[name];
  }
  if (reproduce) {
    const differ = Object.keys(args);
    if (differ.length > 0) throw new Error(`reproduced pins differ: ${differ.join(", ")}`);
    return { schema: 1, changes: [], args: {}, warnings };
  }
  // The bump is checked here exactly as `apply` and `propose` will read it.
  return parseBump({ schema: 1, changes, args, warnings });
}
