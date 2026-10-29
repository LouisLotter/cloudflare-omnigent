// install_clis.sh's record-mode comparison (WP3.37), run as `compare` on synthetic layouts:
// each CLI's global tree must be exactly the audited package and its linux-x64 part, every file
// and symbolic link, and nothing else. A CLI release whose global install held anything the
// audit did not cover would otherwise get its digest recorded unauthenticated.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "../../../images/computer/install_clis.sh");
let dir: string;
let audited: string;
let global: string;

function file(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** One CLI and its linux-x64 part, in an audited project's layout and the global one. */
function cli(name: string) {
  for (const [root, part] of [
    [join(audited, name), join(audited, `${name}-linux-x64`)],
    [join(global, name), join(global, name, "node_modules", `${name}-linux-x64`)],
  ] as const) {
    file(join(root, "package.json"), `{"name": "${name}"}`);
    file(join(root, "bin", "cli.js"), "console.log(1)\n");
    file(join(part, "package.json"), `{"name": "${name}-linux-x64"}`);
    file(join(part, "vendor", "bin", "native"), "\x7fELF native\n");
    mkdirSync(join(part, "links"), { recursive: true });
    symlinkSync("../vendor/bin/native", join(part, "links", "native"));
  }
}

function compare() {
  return spawnSync("sh", [SCRIPT, "compare", audited, global], { encoding: "utf8" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfo-install-clis-"));
  audited = join(dir, "project", "node_modules");
  global = join(dir, "lib", "node_modules");
  cli("@anthropic-ai/claude-code");
  cli("@openai/codex");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("install_clis.sh compare", () => {
  it("accepts a global install that is exactly the audited packages", () => {
    const r = compare();
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it.each([
    [
      "a changed byte in the native part",
      "@openai/codex/node_modules/@openai/codex-linux-x64/vendor/bin/native",
    ],
    ["a changed byte in the CLI", "@anthropic-ai/claude-code/bin/cli.js"],
  ])("refuses %s", (_what, path) => {
    file(join(global, path), "changed\n");
    expect(compare().status).toBe(1);
  });

  it.each([
    [
      "a file in the CLI's node_modules without a package.json",
      "@openai/codex/node_modules/extra/index.js",
    ],
    [
      "a package nested in the native part",
      "@openai/codex/node_modules/@openai/codex-linux-x64/node_modules/extra/index.js",
    ],
    ["a file in the CLI's node_modules/.bin", "@anthropic-ai/claude-code/node_modules/.bin/run"],
    ["a hidden file at the CLI's top", "@anthropic-ai/claude-code/.hook.js"],
    [
      "another package beside the native part",
      "@anthropic-ai/claude-code/node_modules/@anthropic-ai/other/package.json",
    ],
  ])("refuses %s", (_what, path) => {
    file(join(global, path), "unaudited\n");
    const r = compare();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/is not the audited/);
  });

  it("refuses a missing file and a symbolic link with another target", () => {
    rmSync(join(global, "@anthropic-ai/claude-code/bin/cli.js"));
    expect(compare().status).toBe(1);
    file(join(global, "@anthropic-ai/claude-code/bin/cli.js"), "console.log(1)\n");
    expect(compare().status).toBe(0);
    const link = join(global, "@openai/codex/node_modules/@openai/codex-linux-x64/links/native");
    rmSync(link);
    symlinkSync("/usr/bin/env", link);
    expect(compare().status).toBe(1);
  });

  it("refuses an audited project that is not the expected layout", () => {
    file(join(audited, "@openai/codex/node_modules/dep/package.json"), "{}");
    const r = compare();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not the audited layout/);
  });

  it("refuses a usage error", () => {
    expect(spawnSync("sh", [SCRIPT, "nonsense"], { encoding: "utf8" }).status).toBe(2);
  });
});
