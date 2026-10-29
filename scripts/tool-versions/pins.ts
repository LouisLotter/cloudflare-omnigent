// The tool pins the images carry, and the bump file that proposes new ones (WP3.37).
//
// Every build argument the daily check may change is listed in MANAGED, with the Dockerfiles
// that hold it and the shape its value must have. Arguments held by both Dockerfiles (the base
// images and the hash-pinned Python tools) must be equal in both, before and after a bump.
// Nothing else in either file is ever written.

import { argValue, setArgs } from "./dockerfile.ts";

export const COMPUTER = "images/computer/Dockerfile";
export const SERVER = "images/server/Dockerfile";
export type DockerfilePath = typeof COMPUTER | typeof SERVER;
export const DOCKERFILES: readonly DockerfilePath[] = [COMPUTER, SERVER];

/** A release version: numbers and dots only, so pre-releases never match. */
export const VERSION = /^\d+(?:\.\d+){1,3}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
/** `name:tag@sha256:digest`, a Docker Hub official image pinned by its index digest. */
const IMAGE = /^([a-z0-9]+(?:[._-][a-z0-9]+)*):([A-Za-z0-9._-]+)@sha256:([0-9a-f]{64})$/;
/** `name==version --hash=sha256:…` with one hash per accepted file. */
const PY_PIN = /^([a-z0-9-]+)==(\d+(?:\.\d+)+)((?: --hash=sha256:[0-9a-f]{64})+)$/;

type Shape = "version" | "sha256" | "image" | "py-pin";

export const MANAGED = {
  CLAUDE_CODE_VERSION: { files: [COMPUTER], shape: "version" },
  CLAUDE_CODE_TREE_SHA256: { files: [COMPUTER], shape: "sha256" },
  CLAUDE_CODE_INSTALLED_SHA256: { files: [COMPUTER], shape: "sha256" },
  CODEX_VERSION: { files: [COMPUTER], shape: "version" },
  CODEX_TREE_SHA256: { files: [COMPUTER], shape: "sha256" },
  GH_VERSION: { files: [COMPUTER], shape: "version" },
  GH_SHA256_AMD64: { files: [COMPUTER], shape: "sha256" },
  TTYD_VERSION: { files: [COMPUTER], shape: "version" },
  TTYD_SHA256: { files: [COMPUTER], shape: "sha256" },
  PYTHON_IMAGE: { files: [COMPUTER, SERVER], shape: "image" },
  NODE_IMAGE: { files: [COMPUTER, SERVER], shape: "image" },
  CERTIFI_PIN: { files: [COMPUTER, SERVER], shape: "py-pin" },
  PIP_PIN: { files: [COMPUTER, SERVER], shape: "py-pin" },
  UV_PIN: { files: [COMPUTER, SERVER], shape: "py-pin" },
} as const satisfies Record<string, { files: readonly DockerfilePath[]; shape: Shape }>;
export type ArgName = keyof typeof MANAGED;
export const ARG_NAMES = Object.keys(MANAGED) as ArgName[];

export interface ImageRef {
  readonly name: string;
  readonly tag: string;
  readonly digest: string;
}
export interface PyPin {
  readonly name: string;
  readonly version: string;
  readonly hashes: readonly string[];
}

export function parseImage(value: string): ImageRef {
  const m = IMAGE.exec(value);
  if (!m) throw new Error(`not an image pinned by digest: ${value}`);
  return { name: m[1] as string, tag: m[2] as string, digest: m[3] as string };
}

export function formatImage(ref: ImageRef): string {
  return `${ref.name}:${ref.tag}@sha256:${ref.digest}`;
}

export function parsePyPin(value: string): PyPin {
  const m = PY_PIN.exec(value);
  if (!m) throw new Error(`not a hash-pinned requirement: ${value}`);
  const hashes = (m[3] as string)
    .trim()
    .split(" ")
    .map((h) => h.slice("--hash=sha256:".length));
  return { name: m[1] as string, version: m[2] as string, hashes };
}

export function formatPyPin(pin: PyPin): string {
  return [`${pin.name}==${pin.version}`, ...pin.hashes.map((h) => `--hash=sha256:${h}`)].join(" ");
}

/** Throws unless `value` has the shape `name`'s argument must have. */
export function checkShape(name: ArgName, value: string): void {
  const shape: Shape = MANAGED[name].shape;
  const ok =
    shape === "version"
      ? VERSION.test(value)
      : shape === "sha256"
        ? SHA256.test(value)
        : shape === "image"
          ? IMAGE.test(value)
          : PY_PIN.test(value);
  if (!ok) throw new Error(`${name}: not a valid ${shape}: ${JSON.stringify(value)}`);
}

export type Texts = Readonly<Record<DockerfilePath, string>>;

/**
 * Every managed argument's current value. Throws if one is missing, malformed, or differs between
 * the two Dockerfiles.
 */
export function readPins(texts: Texts): Record<ArgName, string> {
  const pins = {} as Record<ArgName, string>;
  for (const name of ARG_NAMES) {
    const values = MANAGED[name].files.map((file) => {
      try {
        return argValue(texts[file], name);
      } catch (error) {
        throw new Error(`${file}: ${(error as Error).message}`);
      }
    });
    const first = values[0] as string;
    if (values.some((v) => v !== first)) {
      throw new Error(`${name} differs between ${MANAGED[name].files.join(" and ")}`);
    }
    checkShape(name, first);
    pins[name] = first;
  }
  return pins;
}

/** One tool's proposed update, as the pull request lists it. */
export interface Change {
  readonly tool: ToolId;
  readonly from: string;
  readonly to: string;
  readonly link: string;
  /** Something the reviewer should look at, in one sentence. */
  readonly note?: string;
}

export const TOOLS = {
  "claude-code": "Claude Code",
  codex: "Codex",
  gh: "gh",
  ttyd: "ttyd",
  "python-image": "python:3.12-slim",
  "node-image": "node:22-slim",
  certifi: "certifi",
  pip: "pip",
  uv: "uv",
} as const;
export type ToolId = keyof typeof TOOLS;

/** The result of a check, which `apply` writes into the Dockerfiles. */
export interface Bump {
  readonly schema: 1;
  readonly changes: readonly Change[];
  /** Only the arguments whose value changes. */
  readonly args: Readonly<Partial<Record<ArgName, string>>>;
  /** Things the check saw but did not act on, such as a release older than the pin. */
  readonly warnings: readonly string[];
}

const LINK_HOSTS = new Set(["github.com", "hub.docker.com", "pypi.org", "pip.pypa.io"]);
const TEXT = /^[\x20-\x7e]{1,300}$/;

/** A bump file read back: every field checked, so a malformed or hostile file changes nothing. */
export function parseBump(json: unknown): Bump {
  const fail = (what: string): never => {
    throw new Error(`bump file: ${what}`);
  };
  if (typeof json !== "object" || json === null || Array.isArray(json)) fail("not an object");
  const o = json as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!["schema", "changes", "args", "warnings"].includes(key)) fail(`unknown field ${key}`);
  }
  if (o.schema !== 1) fail("schema must be 1");
  if (!Array.isArray(o.changes)) fail("changes must be a list");
  if (!Array.isArray(o.warnings)) fail("warnings must be a list");
  if (typeof o.args !== "object" || o.args === null || Array.isArray(o.args)) {
    fail("args must be an object");
  }
  const changes = (o.changes as unknown[]).map((c): Change => {
    if (typeof c !== "object" || c === null) return fail("a change is not an object");
    const r = c as Record<string, unknown>;
    for (const key of Object.keys(r)) {
      if (!["tool", "from", "to", "link", "note"].includes(key))
        fail(`unknown change field ${key}`);
    }
    if (typeof r.tool !== "string" || !Object.hasOwn(TOOLS, r.tool)) fail("unknown tool");
    for (const key of ["from", "to"] as const) {
      if (typeof r[key] !== "string" || !TEXT.test(r[key] as string)) fail(`bad ${key}`);
    }
    let url: URL | undefined;
    try {
      url = new URL(String(r.link));
    } catch {
      fail("bad link");
    }
    if (url?.protocol !== "https:" || !LINK_HOSTS.has(url.hostname)) fail("link host not allowed");
    if (r.note !== undefined && (typeof r.note !== "string" || !TEXT.test(r.note))) {
      fail("bad note");
    }
    return {
      tool: r.tool as ToolId,
      from: r.from as string,
      to: r.to as string,
      link: url?.href as string,
      ...(r.note === undefined ? {} : { note: r.note as string }),
    };
  });
  const args: Partial<Record<ArgName, string>> = {};
  for (const [name, value] of Object.entries(o.args as Record<string, unknown>)) {
    if (!Object.hasOwn(MANAGED, name)) fail(`unmanaged argument ${name}`);
    if (typeof value !== "string") fail(`${name} is not a string`);
    checkShape(name as ArgName, value as string);
    args[name as ArgName] = value as string;
  }
  const warnings = (o.warnings as unknown[]).map((w) =>
    typeof w === "string" && TEXT.test(w) ? w : fail("bad warning"),
  );
  if (changes.length === 0 && Object.keys(args).length > 0) fail("arguments without a change");
  return { schema: 1, changes, args, warnings };
}

/**
 * The Dockerfiles with the bump's arguments written in, checked: an image keeps its name and
 * tag, a requirement its package, and the shared arguments stay equal. Throws, changing
 * nothing, if any of that fails. Returns only the files whose text changes.
 */
export function bumpTexts(texts: Texts, bump: Bump): Partial<Record<DockerfilePath, string>> {
  const current = readPins(texts);
  for (const [name, value] of Object.entries(bump.args) as [ArgName, string][]) {
    const shape = MANAGED[name].shape;
    if (shape === "image") {
      const [was, now] = [parseImage(current[name]), parseImage(value)];
      if (was.name !== now.name || was.tag !== now.tag) {
        throw new Error(`${name}: a bump keeps the image's name and tag (${was.name}:${was.tag})`);
      }
    }
    if (shape === "py-pin" && parsePyPin(current[name]).name !== parsePyPin(value).name) {
      throw new Error(`${name}: a bump keeps the requirement's package`);
    }
  }
  const out: Partial<Record<DockerfilePath, string>> = {};
  for (const file of DOCKERFILES) {
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(bump.args) as [ArgName, string][]) {
      if ((MANAGED[name].files as readonly string[]).includes(file)) values[name] = value;
    }
    const text = setArgs(texts[file], values);
    if (text !== texts[file]) out[file] = text;
  }
  readPins({ ...texts, ...out });
  return out;
}
