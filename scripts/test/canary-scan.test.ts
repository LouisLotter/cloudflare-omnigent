import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CliIo,
  findCanariesInText,
  formatFinding,
  main,
  maskCanary,
  parseCanaryValues,
  redactCanaries,
  runSelfTest,
  SKIPPED_NAMES,
  scanPaths,
} from "../canary-scan.ts";

// Canaries are assembled at run time so this file never contains one: CI scans the repository.
const canary = (suffix: string): string => ["CFO", "CANARY", suffix].join("_");
const SCRIPT = join(import.meta.dirname, "..", "canary-scan.ts");
const REPOSITORY = join(import.meta.dirname, "..", "..");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cfo-canary-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(relativePath: string, content: string | Uint8Array): Promise<string> {
  const path = join(root, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  return path;
}

function captureIo(env: Record<string, string | undefined> = {}): CliIo & {
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return { env, out, err, stdout: (line) => out.push(line), stderr: (line) => err.push(line) };
}

describe("maskCanary", () => {
  it("never shows more than a quarter of the value, nor more than four characters", () => {
    const value = canary("ABCDEFGHIJKLMNOP");
    expect(maskCanary(value)).toBe(`CFO_***(${value.length} chars)`);
    expect(maskCanary("abcdefgh")).toBe("ab***(8 chars)");
    expect(maskCanary("abc")).toBe("***(3 chars)");
  });
});

describe("parseCanaryValues", () => {
  it("ignores an unset or empty variable and empty entries", () => {
    expect(parseCanaryValues(undefined)).toEqual([]);
    expect(parseCanaryValues("")).toEqual([]);
    expect(parseCanaryValues(" , ,")).toEqual([]);
    expect(parseCanaryValues(" first-value ,, second-value,first-value ")).toEqual([
      "first-value",
      "second-value",
    ]);
  });
});

describe("findCanariesInText", () => {
  it("finds pattern canaries with 1-based line and column", () => {
    const text = `one\ntwo ${canary("ABCDEFGH")} and ${canary("x_y_z_12")}\r\n${canary("12345678")}`;
    expect(findCanariesInText(text)).toEqual([
      { line: 2, column: 5, kind: "pattern", masked: maskCanary(canary("ABCDEFGH")) },
      { line: 2, column: 29, kind: "pattern", masked: maskCanary(canary("x_y_z_12")) },
      { line: 3, column: 1, kind: "pattern", masked: maskCanary(canary("12345678")) },
    ]);
  });

  it("needs at least eight characters after the prefix", () => {
    expect(findCanariesInText(canary("ABCDEFG"))).toEqual([]);
    expect(findCanariesInText(`${canary("ABCDEFG")}-`)).toEqual([]);
    expect(findCanariesInText(canary("ABCDEFGH"))).toHaveLength(1);
  });

  it("finds every occurrence of an exact value, including overlapping ones", () => {
    expect(findCanariesInText("xx secret-login yy secret-login", ["secret-login"])).toEqual([
      { line: 1, column: 4, kind: "value", masked: maskCanary("secret-login") },
      { line: 1, column: 20, kind: "value", masked: maskCanary("secret-login") },
    ]);
    expect(findCanariesInText("aaaa", ["aaa"]).map((finding) => finding.column)).toEqual([1, 2]);
  });

  it("reports a value that is also a pattern match once", () => {
    const value = canary("BOTHKINDS1");
    expect(findCanariesInText(value, [value])).toEqual([
      { line: 1, column: 1, kind: "pattern", masked: maskCanary(value) },
    ]);
  });
});

describe("redactCanaries", () => {
  it("masks pattern canaries and exact values", () => {
    const pattern = canary("REDACTME1");
    const redacted = redactCanaries(`/tmp/${pattern}/a-secret-login.txt`, ["a-secret-login"]);
    expect(redacted).not.toContain(pattern);
    expect(redacted).not.toContain("a-secret-login");
    expect(redacted).toBe(`/tmp/${maskCanary(pattern)}/${maskCanary("a-secret-login")}.txt`);
  });
});

describe("scanPaths", () => {
  it("walks directories recursively and reports file, line and column", async () => {
    const log = await put("logs/2026/server.log", `ok\nlogin=${canary("NESTEDLOG")}\n`);
    const state = await put("state.json", '{"token": "exact-login-value"}');
    await put("clean.txt", "nothing here\n");

    const result = await scanPaths([root], { values: ["exact-login-value"] });

    expect(result.findings).toEqual([
      {
        path: log,
        line: 2,
        column: 7,
        kind: "pattern",
        masked: maskCanary(canary("NESTEDLOG")),
        inName: false,
      },
      {
        path: state,
        line: 1,
        column: 12,
        kind: "value",
        masked: maskCanary("exact-login-value"),
        inName: false,
      },
    ]);
    expect(result.filesScanned).toBe(3);
    expect(result.problems).toEqual([]);
  });

  it.each([...SKIPPED_NAMES])("skips %s below the given paths", async (name) => {
    await put(`${name}/inner/file.txt`, canary("SKIPPEDDIR"));
    await put(`package/${name}/file.txt`, canary("SKIPPEDDIR"));
    await put("package/file.txt", "clean\n");

    const result = await scanPaths([root]);

    expect(result.findings).toEqual([]);
    expect(result.filesScanned).toBe(1);
  });

  it("scans a skipped name when it is given explicitly", async () => {
    const artefact = await put("dist/worker.js", `const login = "${canary("BUILDOUTPUT")}";`);

    const result = await scanPaths([join(root, "dist")]);

    expect(result.findings.map((finding) => finding.path)).toEqual([artefact]);
  });

  it("skips binary files", async () => {
    await put(
      "image.bin",
      Buffer.concat([Buffer.from([0x89, 0x50, 0x00]), Buffer.from(canary("INBINARY1"))]),
    );

    const result = await scanPaths([root]);

    expect(result.findings).toEqual([]);
    expect(result.binarySkipped).toBe(1);
    expect(result.filesScanned).toBe(0);
  });

  it("does not follow symbolic links", async () => {
    const outside = await mkdtemp(join(tmpdir(), "cfo-canary-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), canary("BEHINDLINK"));
      await mkdir(join(root, "tree"));
      await symlink(outside, join(root, "tree", "linked-directory"));
      await symlink(join(outside, "secret.txt"), join(root, "tree", "linked-file.txt"));

      const result = await scanPaths([join(root, "tree")]);

      expect(result.findings).toEqual([]);
      expect(result.symlinksSkipped).toBe(2);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("detects canaries in file and directory names and masks them in every path", async () => {
    const name = canary("INFILENAME");
    await put(`${name}/notes.txt`, `again: ${name}\n`);

    const result = await scanPaths([root]);

    const reports = result.findings.map(formatFinding);
    expect(result.findings.map((finding) => [finding.inName, finding.line])).toEqual([
      [true, 1],
      [false, 1],
    ]);
    for (const report of reports) expect(report).not.toContain(name);
    expect(reports[0]).toBe(
      `${join(root, maskCanary(name))} (name): canary ${maskCanary(name)} (pattern)`,
    );
  });

  it("reports missing paths and unreadable files as problems", async () => {
    const unreadable = await put("locked.txt", "clean\n");
    await chmod(unreadable, 0o000);
    const missing = join(root, "missing");

    const result = await scanPaths([root, missing]);

    if (process.getuid?.() !== 0) {
      expect(result.problems).toContainEqual({ path: unreadable, message: "EACCES" });
    }
    expect(result.problems).toContainEqual({ path: missing, message: "ENOENT" });
  });
});

describe("main", () => {
  it("exits 0 for a clean tree", async () => {
    await put("clean.txt", "nothing here\n");
    const io = captureIo();

    expect(await main([root], io)).toBe(0);
    expect(io.err).toEqual([]);
    expect(io.out.at(-1)).toMatch(
      /^canary-scan: 0 canary occurrence\(s\) in 0 path\(s\); scanned 1 file/,
    );
  });

  it("exits 1 and prints only masked values when a canary is found", async () => {
    const value = canary("PRINTEDNOT");
    const file = await put("evidence/run.log", `line\n${value}\n`);
    const io = captureIo();

    expect(await main([root], io)).toBe(1);
    expect(io.out[0]).toBe(`${file}:2:1: canary ${maskCanary(value)} (pattern)`);
    expect([...io.out, ...io.err].join("\n")).not.toContain(value);
  });

  it("reads exact values from CFO_CANARY_VALUES and ignores an empty variable", async () => {
    await put("state.json", '{"refresh": "env-supplied-login"}');

    expect(await main([root], captureIo({ CFO_CANARY_VALUES: "" }))).toBe(0);
    const io = captureIo({ CFO_CANARY_VALUES: "unused-value, env-supplied-login" });
    expect(await main([root], io)).toBe(1);
    expect(io.out.join("\n")).not.toContain("env-supplied-login");
  });

  it("exits 2 on usage errors", async () => {
    const noPaths = captureIo();
    expect(await main([], noPaths)).toBe(2);
    expect(noPaths.err.join("\n")).toContain("usage:");
    expect(await main(["--unknown", root], captureIo())).toBe(2);
    expect(await main([join(root, "missing")], captureIo())).toBe(2);
  });

  it("treats arguments after -- as paths", async () => {
    const io = captureIo();

    expect(await main(["--", "--self-test"], io)).toBe(2);
    expect(io.err[0]).toMatch(/^canary-scan: cannot scan --self-test: ENOENT\n/);
  });

  it("exits 2 when part of the scan could not be read", async () => {
    if (process.getuid?.() === 0) return;
    await chmod(await put("locked.txt", "clean\n"), 0o000);
    const io = captureIo();

    expect(await main([root], io)).toBe(2);
    expect(io.err).toContain("canary-scan: scan incomplete");
  });

  it("runs the self-test alone or before a scan", async () => {
    const alone = captureIo();
    expect(await main(["--self-test"], alone)).toBe(0);
    expect(alone.out).toEqual(["canary-scan: self-test passed"]);

    await put("found.txt", canary("AFTERSELFTEST"));
    expect(await main(["--self-test", root], captureIo())).toBe(1);
  });
});

describe("runSelfTest", () => {
  it("passes against the real scanner", async () => {
    expect(await runSelfTest()).toEqual([]);
  });
});

describe("command line", () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", ...env },
    });

  it("follows the exit status contract", async () => {
    await put("clean/file.txt", "clean\n");
    await put("dirty/file.txt", canary("VIATHECLI1"));

    expect(run([join(root, "clean")]).status).toBe(0);
    const dirty = run([join(root, "dirty")]);
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).not.toContain(canary("VIATHECLI1"));
    expect(run([]).status).toBe(2);
    expect(run(["--self-test"]).status).toBe(0);
  });

  it("reads CFO_CANARY_VALUES from the environment", async () => {
    await put("file.txt", "the-env-login-value\n");

    expect(run([root], { CFO_CANARY_VALUES: "the-env-login-value" }).status).toBe(1);
  });
});

describe("this repository", () => {
  it("has no canaries in the harness sources", async () => {
    const result = await scanPaths([
      join(REPOSITORY, "scripts"),
      join(REPOSITORY, "worker", "test"),
    ]);

    expect(result.findings).toEqual([]);
    expect(result.problems).toEqual([]);
  });
});
