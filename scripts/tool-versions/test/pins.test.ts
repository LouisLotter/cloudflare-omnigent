// The pins the images carry and the bump file (WP3.37): the managed arguments, their shapes,
// the arguments both Dockerfiles must share, and a bump file read back with every field checked.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Bump,
  bumpTexts,
  checkShape,
  formatImage,
  formatPyPin,
  parseBump,
  parseImage,
  parsePyPin,
  readPins,
} from "../pins.ts";
import { CURRENT, computerDockerfile, PYTHON, pyPin, serverDockerfile, texts } from "./world.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const COMPUTER = "images/computer/Dockerfile";
const SERVER = "images/server/Dockerfile";

const bump = (over: Partial<Bump> = {}): Bump => ({
  schema: 1,
  changes: [{ tool: "claude-code", from: "2.1.311", to: "2.1.312", link: "https://github.com/x" }],
  args: { CLAUDE_CODE_VERSION: "2.1.312" },
  warnings: [],
  ...over,
});

describe("readPins", () => {
  it("reads every managed argument of the real Dockerfiles", () => {
    const pins = readPins({
      [COMPUTER]: readFileSync(join(ROOT, COMPUTER), "utf8"),
      [SERVER]: readFileSync(join(ROOT, SERVER), "utf8"),
    });
    expect(Object.keys(pins)).toHaveLength(14);
    expect(parseImage(pins.NODE_IMAGE).name).toBe("node");
  });

  it("refuses shared arguments that differ between the Dockerfiles", () => {
    const server = serverDockerfile({ PIP_PIN: `"${pyPin("pip", "26.2.3")}"` });
    expect(() => readPins({ [COMPUTER]: computerDockerfile(), [SERVER]: server })).toThrow(
      /PIP_PIN differs/,
    );
  });

  it("refuses a missing or malformed pin, naming the file", () => {
    const server = serverDockerfile().replace(/^ARG UV_PIN=.*$/m, "");
    expect(() => readPins({ ...texts(), [SERVER]: server })).toThrow(
      /images\/server\/Dockerfile: expected exactly one "ARG UV_PIN="/,
    );
    const computer = computerDockerfile({ GH_VERSION: "2.103.3-rc1" });
    expect(() => readPins({ ...texts(), [COMPUTER]: computer })).toThrow(/GH_VERSION: not a valid/);
  });
});

describe("shapes", () => {
  it("parses and formats images and requirements", () => {
    const ref = parseImage(`python:3.12-slim@sha256:${PYTHON.digest}`);
    expect(ref).toEqual({ name: "python", tag: "3.12-slim", digest: PYTHON.digest });
    expect(formatImage(ref)).toBe(`python:3.12-slim@sha256:${PYTHON.digest}`);
    const pin = parsePyPin(pyPin("uv", CURRENT.uv));
    expect(pin.hashes).toHaveLength(2);
    expect(formatPyPin(pin)).toBe(pyPin("uv", CURRENT.uv));
    expect(() => parseImage("python:3.12-slim")).toThrow(/pinned by digest/);
    expect(() => parsePyPin("uv==0.1")).toThrow(/hash-pinned/);
  });

  it("checks each managed argument's shape", () => {
    expect(() => checkShape("CODEX_VERSION", "0.165.0")).not.toThrow();
    expect(() => checkShape("CODEX_VERSION", "0.166.0-alpha.6")).toThrow();
    expect(() => checkShape("CODEX_TREE_SHA256", "A".repeat(64))).toThrow();
    expect(() => checkShape("NODE_IMAGE", "node:22-slim")).toThrow();
    expect(() => checkShape("PIP_PIN", "pip==26.2.2 --hash=md5:abc")).toThrow();
  });
});

describe("parseBump", () => {
  it("accepts a well-formed bump, and an empty one", () => {
    expect(parseBump(JSON.parse(JSON.stringify(bump())))).toEqual(bump());
    const withNote = bump({
      changes: [{ tool: "pip", from: "1.0", to: "1.1", link: "https://pip.pypa.io/x", note: "n" }],
    });
    expect(parseBump(withNote)).toEqual(withNote);
    expect(parseBump({ schema: 1, changes: [], args: {}, warnings: ["w"] }).warnings).toEqual([
      "w",
    ]);
  });

  it.each([
    ["not an object", []],
    ["schema", { ...bump(), schema: 2 }],
    ["unknown field", { ...bump(), extra: 1 }],
    ["changes must be a list", { ...bump(), changes: {} }],
    ["warnings must be a list", { ...bump(), warnings: "w" }],
    ["args must be an object", { ...bump(), args: [] }],
    ["a change is not an object", bump({ changes: [null as never] })],
    ["unknown change field", bump({ changes: [{ ...bump().changes[0], extra: 1 } as never] })],
    ["unknown tool", bump({ changes: [{ ...bump().changes[0], tool: "npm" } as never] })],
    ["bad to", bump({ changes: [{ ...bump().changes[0], to: "a\nb" } as never] })],
    ["bad link", bump({ changes: [{ ...bump().changes[0], link: "::" } as never] })],
    [
      "host not allowed",
      bump({ changes: [{ ...bump().changes[0], link: "https://evil.example/" } as never] }),
    ],
    [
      "host not allowed",
      bump({ changes: [{ ...bump().changes[0], link: "http://github.com/" } as never] }),
    ],
    ["bad note", bump({ changes: [{ ...bump().changes[0], note: 3 } as never] })],
    ["unmanaged argument", bump({ args: { OMNIGENT_COMMIT: "a".repeat(40) } as never })],
    ["not a string", bump({ args: { CODEX_VERSION: 1 } as never })],
    ["not a valid", bump({ args: { CLAUDE_CODE_TREE_SHA256: "zz" } })],
    ["bad warning", bump({ warnings: [1 as never] })],
    ["arguments without a change", bump({ changes: [] })],
  ])("refuses %s", (message, value) => {
    expect(() => parseBump(value)).toThrow(new RegExp(message));
  });
});

describe("bumpTexts", () => {
  it("writes each argument in its own files and changes nothing else", () => {
    const uv = pyPin("uv", "0.13.6");
    const out = bumpTexts(texts(), bump({ args: { CLAUDE_CODE_VERSION: "2.1.312", UV_PIN: uv } }));
    const before = texts();
    for (const path of [COMPUTER, SERVER] as const) {
      const [a, b] = [before[path].split("\n"), (out[path] as string).split("\n")];
      const changed = a.flatMap((line, i) => (line === b[i] ? [] : [b[i]]));
      expect(changed).toEqual(
        path === COMPUTER
          ? [`ARG UV_PIN="${uv}"`, "ARG CLAUDE_CODE_VERSION=2.1.312"]
          : [`ARG UV_PIN="${uv}"`],
      );
    }
  });

  it("returns no file when the bump changes nothing (already current)", () => {
    expect(bumpTexts(texts(), bump({ changes: [], args: {} }))).toEqual({});
    expect(bumpTexts(texts(), bump({ args: { CODEX_VERSION: CURRENT.codex } }))).toEqual({});
  });

  it("only writes the server file for a shared argument's change", () => {
    const digest = `python:3.12-slim@sha256:${"e".repeat(64)}`;
    const out = bumpTexts(texts(), bump({ args: { PYTHON_IMAGE: digest } }));
    expect(Object.keys(out).sort()).toEqual([COMPUTER, SERVER]);
  });

  it("refuses a new image name or tag, or another package", () => {
    const other = `python:3.13-slim@sha256:${"e".repeat(64)}`;
    expect(() => bumpTexts(texts(), bump({ args: { PYTHON_IMAGE: other } }))).toThrow(
      /keeps the image's name and tag/,
    );
    const pin = pyPin("pip", "26.3").replace("pip==", "pipx==");
    expect(() => bumpTexts(texts(), bump({ args: { PIP_PIN: pin } }))).toThrow(
      /keeps the requirement's package/,
    );
  });

  it("refuses, writing nothing, when the files are not as expected", () => {
    const broken = { ...texts(), [SERVER]: serverDockerfile().replace("ARG NODE_IMAGE", "#") };
    expect(() => bumpTexts(broken, bump())).toThrow(/NODE_IMAGE/);
  });
});
