// Writing a bump into the Dockerfiles (WP3.37): all or nothing. A bump that fails its checks,
// a write that fails part way, or a rename that fails leaves both files as they were. Also the
// pull request's title and body.

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyBump, body, type Files, title } from "../apply.ts";
import { type Bump, COMPUTER, SERVER } from "../pins.ts";
import { computerDockerfile, pyPin, serverDockerfile } from "./world.ts";

let root: string;
const realFiles: Files = {
  read: (p) => readFileSync(p, "utf8"),
  write: (p, t) => writeFileSync(p, t),
  rename: renameSync,
  remove: (p) => rmSync(p, { force: true }),
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cfo-tool-versions-apply-"));
  mkdirSync(join(root, "images/computer"), { recursive: true });
  mkdirSync(join(root, "images/server"), { recursive: true });
  writeFileSync(join(root, COMPUTER), computerDockerfile());
  writeFileSync(join(root, SERVER), serverDockerfile());
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const read = (path: string) => readFileSync(join(root, path), "utf8");
const UV = pyPin("uv", "0.13.6");
const BUMP: Bump = {
  schema: 1,
  changes: [
    { tool: "claude-code", from: "2.1.311", to: "2.1.312", link: "https://github.com/a" },
    { tool: "uv", from: "0.12.10", to: "0.13.6", link: "https://github.com/b" },
  ],
  args: { CLAUDE_CODE_VERSION: "2.1.312", UV_PIN: UV },
  warnings: [],
};

describe("applyBump", () => {
  it("writes the bump into both files and leaves no temporary file", () => {
    expect(applyBump(root, BUMP, realFiles)).toEqual([COMPUTER, SERVER]);
    expect(read(COMPUTER)).toBe(
      computerDockerfile({ CLAUDE_CODE_VERSION: "2.1.312", UV_PIN: `"${UV}"` }),
    );
    expect(read(SERVER)).toBe(serverDockerfile({ UV_PIN: `"${UV}"` }));
    expect(() => readFileSync(join(root, `${COMPUTER}.tool-versions.tmp`))).toThrow();
  });

  it("writes only the files that change", () => {
    const bump = { ...BUMP, args: { CLAUDE_CODE_VERSION: "2.1.312" } };
    expect(applyBump(root, bump, realFiles)).toEqual([COMPUTER]);
    expect(read(SERVER)).toBe(serverDockerfile());
  });

  it("changes nothing for an already current bump", () => {
    expect(applyBump(root, { ...BUMP, changes: [], args: {} }, realFiles)).toEqual([]);
    expect(read(COMPUTER)).toBe(computerDockerfile());
  });

  it("changes neither file when the server file fails the bump's checks", () => {
    writeFileSync(join(root, SERVER), serverDockerfile().replace(/^ARG UV_PIN=.*\n/m, ""));
    expect(() => applyBump(root, BUMP, realFiles)).toThrow(/UV_PIN/);
    expect(read(COMPUTER)).toBe(computerDockerfile());
  });

  it("changes neither file when writing the second fails part way", () => {
    const files: Files = {
      ...realFiles,
      write: (p, t) => {
        if (p.includes("server")) throw new Error("disk full");
        realFiles.write(p, t);
      },
    };
    expect(() => applyBump(root, BUMP, files)).toThrow(/disk full/);
    expect(read(COMPUTER)).toBe(computerDockerfile());
    expect(read(SERVER)).toBe(serverDockerfile());
    expect(() => readFileSync(join(root, `${COMPUTER}.tool-versions.tmp`))).toThrow();
  });

  it("puts the first file back when the second rename fails", () => {
    const files: Files = {
      ...realFiles,
      rename: (from, to) => {
        if (to.includes("server")) throw new Error("rename failed");
        realFiles.rename(from, to);
      },
    };
    expect(() => applyBump(root, BUMP, files)).toThrow(/rename failed/);
    expect(read(COMPUTER)).toBe(computerDockerfile());
    expect(read(SERVER)).toBe(serverDockerfile());
    expect(() => readFileSync(join(root, `${SERVER}.tool-versions.tmp`))).toThrow();
  });

  it("still throws the write error when a temporary file cannot be removed", () => {
    const files: Files = {
      ...realFiles,
      write: (p, t) => {
        if (p.includes("server")) throw new Error("disk full");
        realFiles.write(p, t);
      },
      remove: () => {
        throw new Error("busy");
      },
    };
    expect(() => applyBump(root, BUMP, files)).toThrow(/disk full/);
    expect(read(COMPUTER)).toBe(computerDockerfile());
  });
});

describe("title and body", () => {
  it("names each tool and its new version; images by name", () => {
    const bump: Bump = {
      ...BUMP,
      changes: [
        ...BUMP.changes,
        {
          tool: "node-image",
          from: "22.23.4 (a)",
          to: "22.23.4 (b)",
          link: "https://hub.docker.com/_/node",
        },
      ],
    };
    expect(title(bump)).toBe("Tool versions: Claude Code 2.1.312, uv 0.13.6, node:22-slim");
    const long = { ...BUMP, changes: Array(20).fill(BUMP.changes[0]) };
    expect(title(long)).toHaveLength(120);
    expect(title(long).endsWith("...")).toBe(true);
  });

  it("lists every change with its link, note and warnings, and the sign-in reminder for CLIs", () => {
    const text = body({
      ...BUMP,
      changes: [
        { ...(BUMP.changes[0] as Bump["changes"][number]), note: "Look at this." },
        { tool: "codex", from: "0.164.0", to: "0.164.0", link: "https://github.com/c" },
      ],
      warnings: ["uv: odd"],
    });
    expect(text).toContain(
      "- Claude Code 2.1.311 → 2.1.312 ([release notes](https://github.com/a)). Look at this.",
    );
    expect(text).toContain("- Codex 0.164.0 ([release notes](https://github.com/c))");
    expect(text).toContain("login_transcripts.json");
    expect(text).toContain("- uv: odd");
    expect(text).toContain("bootstrap.ts update");
    const plain = body({ ...BUMP, changes: [BUMP.changes[1] as Bump["changes"][number]] });
    expect(plain).not.toContain("login_transcripts");
    expect(plain).not.toContain("Also seen");
  });
});
