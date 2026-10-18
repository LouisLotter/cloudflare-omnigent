import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync, zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CliIo,
  DEFAULT_LIMITS,
  detectFormat,
  EXIT_CLEAN,
  EXIT_FOUND,
  EXIT_INCOMPLETE,
  EXIT_USAGE,
  exitCodeFor,
  findCanaries,
  findCanariesInText,
  formatFinding,
  main,
  maskCanary,
  parseCanaryValues,
  redactCanaries,
  runSelfTest,
  SKIPPED_NAMES,
  scanPaths,
  tarArchive,
  tarMembers,
  zipArchive,
} from "../canary-scan.ts";

// Canaries are assembled at run time so this file never contains one: CI scans the repository.
const canary = (suffix: string): string => ["CFO", "CANARY", suffix].join("_");
const SCRIPT = join(import.meta.dirname, "..", "canary-scan.ts");
const REPOSITORY = join(import.meta.dirname, "..", "..");
const isRoot = process.getuid?.() === 0;

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

/** Bytes shaped like an SQLite database, with `embedded` inside binary pages. */
function sqliteLike(embedded: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from("SQLite format 3\u0000", "latin1"),
    Buffer.from([0x10, 0x00, 0x01, 0x01, 0x00, 0x40, 0x20, 0x20]),
    Buffer.alloc(200),
    Buffer.from(embedded),
    Buffer.alloc(300, 0xff),
  ]);
}

const text = (finding: { line: number | null; column: number | null }) => [
  finding.line,
  finding.column,
];

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
      {
        offset: 8,
        line: 2,
        column: 5,
        kind: "pattern",
        encoding: "utf8",
        masked: maskCanary(canary("ABCDEFGH")),
      },
      {
        offset: 32,
        line: 2,
        column: 29,
        kind: "pattern",
        encoding: "utf8",
        masked: maskCanary(canary("x_y_z_12")),
      },
      {
        offset: 53,
        line: 3,
        column: 1,
        kind: "pattern",
        encoding: "utf8",
        masked: maskCanary(canary("12345678")),
      },
    ]);
  });

  it("counts columns in characters, not bytes", () => {
    const [finding] = findCanariesInText(`héllo wörld ${canary("AFTERUTF8")}`);
    expect(finding).toMatchObject({ offset: 14, line: 1, column: 13 });
  });

  it("needs at least eight characters after the prefix", () => {
    expect(findCanariesInText(canary("ABCDEFG"))).toEqual([]);
    expect(findCanariesInText(`${canary("ABCDEFG")}-`)).toEqual([]);
    expect(findCanariesInText(canary("ABCDEFGH"))).toHaveLength(1);
  });

  it("finds every occurrence of an exact value, including overlapping ones", () => {
    const findings = findCanariesInText("xx secret-login yy secret-login", ["secret-login"]);
    expect(findings.map((finding) => [finding.column, finding.kind])).toEqual([
      [4, "value"],
      [20, "value"],
    ]);
    expect(findCanariesInText("aaaa", ["aaa"]).map((finding) => finding.column)).toEqual([1, 2]);
  });

  it("reports a value that is also a pattern match once", () => {
    const value = canary("BOTHKINDS1");
    expect(findCanariesInText(value, [value])).toMatchObject([{ offset: 0, kind: "pattern" }]);
  });
});

describe("findCanaries in raw bytes", () => {
  it("finds a canary after NUL bytes and reports its byte offset", () => {
    const data = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`x ${canary("AFTERNUL1")}`)]);
    expect(findCanaries(data)).toEqual([
      {
        offset: 5,
        line: null,
        column: null,
        kind: "pattern",
        encoding: "utf8",
        masked: maskCanary(canary("AFTERNUL1")),
      },
    ]);
  });

  it("finds UTF-16LE canaries at even and odd offsets", () => {
    const value = canary("WIDECHARS1");
    for (const padding of [0, 1, 2, 3]) {
      const data = Buffer.concat([Buffer.alloc(padding, 0xee), Buffer.from(value, "utf16le")]);
      expect(findCanaries(data)).toEqual([
        {
          offset: padding,
          line: null,
          column: null,
          kind: "pattern",
          encoding: "utf16le",
          masked: maskCanary(value),
        },
      ]);
    }
    expect(findCanaries(Buffer.from(canary("SEVEN77"), "utf16le"))).toEqual([]);
  });

  it("finds exact values as UTF-8, UTF-16LE and latin1", () => {
    const value = "pässwörd-login";
    const data = Buffer.concat([
      Buffer.from(value, "utf8"),
      Buffer.from([0]),
      Buffer.from(value, "utf16le"),
      Buffer.from([0]),
      Buffer.from(value, "latin1"),
    ]);
    expect(findCanaries(data, [value]).map((finding) => finding.encoding)).toEqual([
      "utf8",
      "utf16le",
      "latin1",
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

describe("detectFormat", () => {
  const cases: [string, Uint8Array, object, string?][] = [
    ["gzip", gzipSync("x"), { kind: "compressed", codec: "gzip" }],
    ["zstd", zstdCompressSync("x"), { kind: "compressed", codec: "zstd" }],
    ["brotli by name", Buffer.from("anything"), { kind: "compressed", codec: "brotli" }, "a.br"],
    ["tar", tarArchive([{ name: "a", data: Buffer.from("x") }]), { kind: "tar" }],
    ["zip", zipArchive("a.txt", Buffer.from("x")), { kind: "unsupported", format: "zip" }],
    ["xz", Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 1]), { format: "xz" }],
    ["bzip2", Buffer.from("BZh91AY&SY"), { kind: "unsupported", format: "bzip2" }],
    ["7z", Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0]), { format: "7z" }],
    ["PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { format: "PNG" }],
    ["PDF", Buffer.from("%PDF-1.7\n"), { kind: "unsupported", format: "PDF" }],
    ["plain text", Buffer.from("BZh is not bzip2 without a level"), { kind: "plain" }],
    ["binary", sqliteLike(Buffer.from("x")), { kind: "plain" }],
  ];
  it.each(cases)("recognises %s", (_label, data, expected, name = "file") => {
    expect(detectFormat(data, name)).toMatchObject(expected);
  });
});

describe("tarMembers", () => {
  it("lists regular files with their contents", () => {
    const archive = tarArchive([
      { name: "logs/a.log", data: Buffer.from("first") },
      { name: "b.bin", data: Buffer.alloc(700, 7) },
    ]);
    expect(tarMembers(archive)?.map((member) => [member.name, member.data.length])).toEqual([
      ["logs/a.log", 5],
      ["b.bin", 700],
    ]);
  });

  it("returns null for a bad checksum or a truncated member", () => {
    const archive = tarArchive([{ name: "a.log", data: Buffer.alloc(600, 1) }]);
    const corrupted = Buffer.from(archive);
    corrupted[0] = 0x42;
    expect(tarMembers(corrupted)).toBeNull();
    expect(tarMembers(archive.subarray(0, 700))).toBeNull();
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
        inName: false,
        layers: [],
        offset: 9,
        line: 2,
        column: 7,
        kind: "pattern",
        encoding: "utf8",
        masked: maskCanary(canary("NESTEDLOG")),
      },
      {
        path: state,
        inName: false,
        layers: [],
        offset: 11,
        line: 1,
        column: 12,
        kind: "value",
        encoding: "utf8",
        masked: maskCanary("exact-login-value"),
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

  it("scans files that contain NUL bytes instead of skipping them", async () => {
    const log = await put(
      "nul-prefixed.log",
      Buffer.concat([Buffer.from([0]), Buffer.from(`boot\n${canary("NULPREFIX1")}\n`)]),
    );
    const database = await put(
      "state.sqlite",
      sqliteLike(Buffer.from(`refresh=${canary("INDATABASE")}`, "utf16le")),
    );

    const result = await scanPaths([log, database]);

    expect(
      result.findings.map((finding) => [finding.path, finding.offset, finding.encoding]),
    ).toEqual([
      [log, 6, "utf8"],
      [database, 224 + 16, "utf16le"],
    ]);
    expect(result.problems).toEqual([]);
  });

  it("decodes gzip, zstd and brotli data and reports where the canary was", async () => {
    const log = `ok\nlogin=${canary("COMPRESSED")}\n`;
    const gzip = await put("server.log.gz", gzipSync(log));
    const zstd = await put("server.log.zst", zstdCompressSync(log));
    const brotli = await put("server.log.br", brotliCompressSync(log));
    const twice = await put("twice.gz", gzipSync(gzipSync(log)));

    const result = await scanPaths([root]);

    // Small inputs may also be stored as literals, visible in the compressed bytes themselves;
    // those raw findings (no layers) are correct too, so only the decoded ones are compared.
    const decoded = result.findings.filter((finding) => finding.layers.length > 0);
    expect(decoded.map((finding) => [finding.path, finding.layers, ...text(finding)])).toEqual([
      [brotli, ["brotli"], 2, 7],
      [gzip, ["gzip"], 2, 7],
      [zstd, ["zstd"], 2, 7],
      [twice, ["gzip", "gzip"], 2, 7],
    ]);
    expect(result.layersDecoded).toBe(5);
    expect(result.problems).toEqual([]);
    expect(formatFinding(decoded[0] ?? expect.unreachable())).toBe(
      `${brotli} [brotli]:2:7: canary ${maskCanary(canary("COMPRESSED"))} (pattern)`,
    );
  });

  it("scans tar archives whole and decodes their compressed members", async () => {
    const plain = await put(
      "plain.tar",
      tarArchive([
        { name: "ok.txt", data: Buffer.from("clean") },
        { name: "leak.txt", data: Buffer.from(canary("INTARPLAIN")) },
      ]),
    );
    const nested = await put(
      "logs.tar.gz",
      gzipSync(tarArchive([{ name: "app/server.log.gz", data: gzipSync(canary("INTARGZIP1")) }])),
    );

    const result = await scanPaths([plain, nested]);

    expect(
      result.findings.map((finding) => [finding.path, finding.layers, finding.offset]),
    ).toEqual([
      [plain, [], 1536],
      [nested, ["gzip", "tar member app/server.log.gz", "gzip"], 0],
    ]);
    expect(result.problems).toEqual([]);
  });

  it("masks canaries in archive member names", async () => {
    const name = canary("MEMBERNAME");
    await put("named.tar", tarArchive([{ name: `${name}.gz`, data: gzipSync("clean") }]));
    await put(
      "bad.tar",
      tarArchive([{ name: `${name}.zip`, data: zipArchive("a", Buffer.from("x")) }]),
    );

    const result = await scanPaths([root]);

    const reports = [
      ...result.findings.map(formatFinding),
      ...result.problems.map((problem) => problem.message),
    ];
    expect(reports.join("\n")).not.toContain(name);
    expect(result.problems).toEqual([
      {
        path: join(root, "bad.tar"),
        message: `cannot decode zip data (in tar member ${maskCanary(name)}.zip)`,
      },
    ]);
  });

  it("reports formats it cannot decode as problems, not as clean", async () => {
    const zip = await put("logs.zip", zipArchive("server.log", Buffer.from("x".repeat(500))));
    const xz = await put("logs.xz", Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0, 1]));
    const bzip2 = await put("logs.bz2", Buffer.from("BZh91AY&SY\u0001\u0002"));
    const corrupt = await put("broken.gz", Buffer.from([0x1f, 0x8b, 0x08, 0, 1, 2, 3]));
    const malformed = await put(
      "bad.tar",
      Buffer.concat([Buffer.alloc(257), Buffer.from("ustar"), Buffer.alloc(250)]),
    );

    const result = await scanPaths([zip, xz, bzip2, corrupt, malformed]);

    expect(result.findings).toEqual([]);
    expect(result.problems).toEqual([
      { path: zip, message: "cannot decode zip data" },
      { path: xz, message: "cannot decode xz data" },
      { path: bzip2, message: "cannot decode bzip2 data" },
      { path: corrupt, message: "corrupt gzip data" },
      { path: malformed, message: "malformed tar archive" },
    ]);
    expect(exitCodeFor(result)).toBe(EXIT_INCOMPLETE);
  });

  it("still reports a canary visible in data it cannot decode", async () => {
    const stored = await put(
      "stored.zip",
      Buffer.concat([zipArchive("a", Buffer.from("x")), Buffer.from(canary("ZIPCOMMENT"))]),
    );

    const result = await scanPaths([stored]);

    expect(result.findings.map((finding) => finding.path)).toEqual([stored]);
    expect(result.problems).toHaveLength(1);
    expect(exitCodeFor(result)).toBe(EXIT_FOUND);
  });

  it("bounds the decoded size, the nesting depth and the file size", async () => {
    const bomb = await put("bomb.gz", gzipSync(Buffer.alloc(10_000)));
    let layered: Buffer = Buffer.from("deep");
    for (let layer = 0; layer < 4; layer += 1) layered = gzipSync(layered);
    const deep = await put("deep.gz", layered);
    const large = await put("large.log", "x".repeat(2_000));
    const limits = { maxDecodedBytes: 5_000, maxDepth: 3, maxFileBytes: 1_000 };

    const result = await scanPaths([bomb, deep, large], { limits });

    expect(result.problems).toEqual([
      { path: bomb, message: "decoded data exceeds the 5000-byte bound" },
      { path: deep, message: "nested more than 3 layers deep (in gzip > gzip > gzip)" },
      { path: large, message: "larger than the 1000-byte file bound" },
    ]);
    expect(DEFAULT_LIMITS.maxDecodedBytes).toBeGreaterThan(limits.maxDecodedBytes);
  });

  it("treats a given path with no files as a problem", async () => {
    await mkdir(join(root, "empty"));
    await put("only-skipped/node_modules/x.js", "clean");

    const result = await scanPaths([join(root, "empty"), join(root, "only-skipped")]);

    expect(result.problems).toEqual([
      { path: join(root, "empty"), message: "no files to scan" },
      { path: join(root, "only-skipped"), message: "no files to scan" },
    ]);
    expect(exitCodeFor(result)).toBe(EXIT_INCOMPLETE);
  });

  it("does not follow symbolic links", async () => {
    const outside = await mkdtemp(join(tmpdir(), "cfo-canary-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), canary("BEHINDLINK"));
      await put("tree/clean.txt", "clean");
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

    if (!isRoot) expect(result.problems).toContainEqual({ path: unreadable, message: "EACCES" });
    expect(result.problems).toContainEqual({ path: missing, message: "ENOENT" });
  });
});

describe("main", () => {
  it("exits 0 for a clean tree", async () => {
    await put("clean.txt", "nothing here\n");
    const io = captureIo();

    expect(await main([root], io)).toBe(EXIT_CLEAN);
    expect(io.err).toEqual([]);
    expect(io.out.at(-1)).toMatch(
      /^canary-scan: 0 canary occurrence\(s\) in 0 path\(s\); scanned 1 file/,
    );
  });

  it("exits 1 and prints only masked values when a canary is found", async () => {
    const value = canary("PRINTEDNOT");
    const file = await put("evidence/run.log", `line\n${value}\n`);
    const io = captureIo();

    expect(await main([root], io)).toBe(EXIT_FOUND);
    expect(io.out[0]).toBe(`${file}:2:1: canary ${maskCanary(value)} (pattern)`);
    expect([...io.out, ...io.err].join("\n")).not.toContain(value);
  });

  it("prints binary findings by byte offset and encoding", async () => {
    const value = canary("BINARYOUT1");
    const file = await put(
      "blob.bin",
      Buffer.concat([Buffer.alloc(4), Buffer.from(value, "utf16le")]),
    );
    const io = captureIo();

    expect(await main([file], io)).toBe(EXIT_FOUND);
    expect(io.out[0]).toBe(`${file}: byte 4: canary ${maskCanary(value)} (pattern, utf16le)`);
  });

  it("reads exact values from CFO_CANARY_VALUES and ignores an empty variable", async () => {
    await put("state.json", '{"refresh": "env-supplied-login"}');

    expect(await main([root], captureIo({ CFO_CANARY_VALUES: "" }))).toBe(EXIT_CLEAN);
    const io = captureIo({ CFO_CANARY_VALUES: "unused-value, env-supplied-login" });
    expect(await main([root], io)).toBe(EXIT_FOUND);
    expect(io.out.join("\n")).not.toContain("env-supplied-login");
  });

  it("exits 2 on usage errors", async () => {
    const noPaths = captureIo();
    expect(await main([], noPaths)).toBe(EXIT_USAGE);
    expect(noPaths.err.join("\n")).toContain("usage:");
    expect(await main(["--unknown", root], captureIo())).toBe(EXIT_USAGE);
    expect(await main([join(root, "missing")], captureIo())).toBe(EXIT_USAGE);
  });

  it("treats arguments after -- as paths", async () => {
    const io = captureIo();

    expect(await main(["--", "--self-test"], io)).toBe(EXIT_USAGE);
    expect(io.err[0]).toMatch(/^canary-scan: cannot scan --self-test: ENOENT\n/);
  });

  it("exits 3 when the scan is incomplete, and says so", async () => {
    await put("archive.zip", zipArchive("a.log", Buffer.from("y".repeat(300))));
    const io = captureIo();

    expect(await main([root], io)).toBe(EXIT_INCOMPLETE);
    expect(io.err).toEqual([
      `canary-scan: not scanned completely: ${join(root, "archive.zip")}: cannot decode zip data`,
      "canary-scan: scan incomplete: this run is no evidence that the input is clean",
    ]);
  });

  it("exits 3 for an unreadable file", async () => {
    if (isRoot) return;
    await chmod(await put("locked.txt", "clean\n"), 0o000);

    expect(await main([root], captureIo())).toBe(EXIT_INCOMPLETE);
  });

  it("runs the self-test alone or before a scan", async () => {
    const alone = captureIo();
    expect(await main(["--self-test"], alone)).toBe(EXIT_CLEAN);
    expect(alone.out).toEqual(["canary-scan: self-test passed"]);

    await put("found.txt", canary("AFTERSELFTEST"));
    expect(await main(["--self-test", root], captureIo())).toBe(EXIT_FOUND);
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

  // IR-003's required negative fixtures, each passed to the real command explicitly.
  it.each([
    [
      "a NUL-prefixed log with a canary",
      () => Buffer.concat([Buffer.from([0]), Buffer.from(`log\n${canary("CLINULLOG1")}\n`)]),
      EXIT_FOUND,
    ],
    [
      "an SQLite-like binary with a canary",
      () => sqliteLike(Buffer.from(`token=${canary("CLIDATABASE")}`)),
      EXIT_FOUND,
    ],
    [
      "a UTF-16LE binary with a canary",
      () => sqliteLike(Buffer.from(`token=${canary("CLIWIDE001")}`, "utf16le")),
      EXIT_FOUND,
    ],
    ["a gzip file with a canary", () => gzipSync(`log\n${canary("CLIGZIP001")}\n`), EXIT_FOUND],
    [
      "a zip artefact",
      () => zipArchive("server.log", Buffer.from(`${canary("CLIZIPPED1")}\n`.repeat(20))),
      EXIT_INCOMPLETE,
    ],
    ["clean text", () => Buffer.from("starting\nall good\n"), EXIT_CLEAN],
  ])("exits correctly for %s", async (_label, content, expected) => {
    const file = await put("artefact", content());

    const result = run([file]);

    expect(result.status).toBe(expected);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(
      new RegExp(`${"CFO"}_CANARY_[A-Z0-9]{8,}`),
    );
  });

  it("exits 3 for an empty directory and 2 for usage errors", async () => {
    await mkdir(join(root, "empty"));

    expect(run([join(root, "empty")]).status).toBe(EXIT_INCOMPLETE);
    expect(run([]).status).toBe(EXIT_USAGE);
    expect(run([join(root, "missing")]).status).toBe(EXIT_USAGE);
  });

  it("passes its self-test without paths, as CI runs it", () => {
    const result = run(["--self-test"]);

    expect(result.status).toBe(EXIT_CLEAN);
    expect(result.stdout).toBe("canary-scan: self-test passed\n");
  });

  it("reads CFO_CANARY_VALUES from the environment", async () => {
    await put("file.txt", "the-env-login-value\n");

    expect(run([root], { CFO_CANARY_VALUES: "the-env-login-value" }).status).toBe(EXIT_FOUND);
  });
});

describe("this repository", () => {
  it("has no canaries in the harness sources, and they scan completely", async () => {
    const result = await scanPaths([
      join(REPOSITORY, "scripts"),
      join(REPOSITORY, "worker", "test"),
    ]);

    expect(result.findings).toEqual([]);
    expect(result.problems).toEqual([]);
  });
});
