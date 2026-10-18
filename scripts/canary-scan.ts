/**
 * Canary scanner for release check RC-22: synthetic canary logins must never appear outside the
 * computer checkpoints, so logs, evidence, fixtures, snapshots and build artefacts are scanned.
 *
 *   node scripts/canary-scan.ts [--self-test] <paths...>
 *
 * Exit status: 0 clean; 1 a canary was found or the self-test failed; 2 usage error, or the scan
 * could not read everything it was asked to scan.
 *
 * A canary is any match of CANARY_PATTERN_SOURCE, or an exact value listed (comma-separated) in
 * the CFO_CANARY_VALUES environment variable. Directories are walked recursively. Below the given
 * paths, entries named in SKIPPED_NAMES, symbolic links and binary files are skipped; a path given
 * explicitly is always scanned, so `canary-scan.ts worker/dist` does scan the build output.
 * File and directory names are checked as well as contents. Reports give the path, line and
 * column and a masked form; a full canary value is never printed, even inside a path.
 *
 * Source files must never contain a literal canary: tests build them at run time.
 */
import { randomBytes } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CANARY_PATTERN_SOURCE = "CFO_CANARY_[A-Za-z0-9_]{8,}";
export const CANARY_VALUES_ENV = "CFO_CANARY_VALUES";
export const SKIPPED_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".wrangler",
  "dist",
  "coverage",
  ".venv",
]);
/** Like Git, a file with a NUL byte in its first 8000 bytes is treated as binary. */
const BINARY_SNIFF_BYTES = 8000;

const USAGE = "usage: node scripts/canary-scan.ts [--self-test] <paths...>";

export type CanaryKind = "pattern" | "value";

export interface TextFinding {
  /** 1-based. */
  readonly line: number;
  /** 1-based, in UTF-16 code units. */
  readonly column: number;
  readonly kind: CanaryKind;
  /** Safe to print: never the full value. */
  readonly masked: string;
}

export interface CanaryFinding extends TextFinding {
  /** The file, or for a canary in a name, the file or directory. Canaries in it are masked. */
  readonly path: string;
  /** Whether the canary is in the path's last component rather than in the file's contents. */
  readonly inName: boolean;
}

export interface ScanProblem {
  /** Canaries in it are masked. */
  readonly path: string;
  readonly message: string;
}

export interface ScanResult {
  readonly findings: CanaryFinding[];
  readonly filesScanned: number;
  readonly binarySkipped: number;
  readonly symlinksSkipped: number;
  /** Paths that could not be read. Any problem makes the scan incomplete. */
  readonly problems: ScanProblem[];
}

export interface ScanOptions {
  /** Exact canary values, in addition to the pattern. */
  readonly values?: readonly string[];
}

export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** Splits CFO_CANARY_VALUES: entries are trimmed, and empty entries and duplicates ignored. */
export function parseCanaryValues(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(values)];
}

/** Shows at most a quarter of the value, and never more than four characters, plus its length. */
export function maskCanary(value: string): string {
  const visible = Math.min(4, Math.floor(value.length / 4));
  return `${value.slice(0, visible)}***(${value.length} chars)`;
}

/** Replaces every canary in `text` with its masked form. */
export function redactCanaries(text: string, values: readonly string[] = []): string {
  let redacted = text;
  // Longest first, so a value that contains another value is masked whole.
  for (const value of [...values].sort((left, right) => right.length - left.length)) {
    if (value.length > 0) redacted = redacted.split(value).join(maskCanary(value));
  }
  return redacted.replace(new RegExp(CANARY_PATTERN_SOURCE, "g"), (match) => maskCanary(match));
}

/** Finds every canary occurrence in `text`, ordered by position. */
export function findCanariesInText(text: string, values: readonly string[] = []): TextFinding[] {
  const matches = new Map<string, { offset: number; kind: CanaryKind; value: string }>();
  for (const match of text.matchAll(new RegExp(CANARY_PATTERN_SOURCE, "g"))) {
    matches.set(`${match.index}:${match[0].length}`, {
      offset: match.index,
      kind: "pattern",
      value: match[0],
    });
  }
  for (const value of values) {
    if (value.length === 0) continue;
    for (
      let offset = text.indexOf(value);
      offset !== -1;
      offset = text.indexOf(value, offset + 1)
    ) {
      const key = `${offset}:${value.length}`;
      if (!matches.has(key)) matches.set(key, { offset, kind: "value", value });
    }
  }
  const lineStarts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    lineStarts.push(index + 1);
  }
  return [...matches.values()]
    .sort((left, right) => left.offset - right.offset)
    .map(({ offset, kind, value }) => {
      const lineIndex = lastLineStartAtOrBefore(lineStarts, offset);
      return {
        line: lineIndex + 1,
        column: offset - (lineStarts[lineIndex] ?? 0) + 1,
        kind,
        masked: maskCanary(value),
      };
    });
}

function lastLineStartAtOrBefore(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function isBinary(content: Uint8Array): boolean {
  return content.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** Scans files and directories. A path that does not exist is reported as a problem. */
export async function scanPaths(
  paths: readonly string[],
  options: ScanOptions = {},
): Promise<ScanResult> {
  const values = options.values ?? [];
  const findings: CanaryFinding[] = [];
  const problems: ScanProblem[] = [];
  let filesScanned = 0;
  let binarySkipped = 0;
  let symlinksSkipped = 0;
  const shown = (path: string): string => redactCanaries(path, values);

  const checkName = (path: string, name: string): void => {
    for (const finding of findCanariesInText(name, values)) {
      findings.push({ ...finding, path: shown(path), inName: true });
    }
  };

  const scanFile = async (path: string): Promise<void> => {
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch (error) {
      problems.push({ path: shown(path), message: describeError(error) });
      return;
    }
    if (isBinary(content)) {
      binarySkipped += 1;
      return;
    }
    filesScanned += 1;
    for (const finding of findCanariesInText(content.toString("utf8"), values)) {
      findings.push({ ...finding, path: shown(path), inName: false });
    }
  };

  const scanDirectory = async (path: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      problems.push({ path: shown(path), message: describeError(error) });
      return;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (SKIPPED_NAMES.has(entry.name)) continue;
      const child = join(path, entry.name);
      checkName(child, entry.name);
      if (entry.isSymbolicLink()) symlinksSkipped += 1;
      else if (entry.isDirectory()) await scanDirectory(child);
      else if (entry.isFile()) await scanFile(child);
    }
  };

  for (const path of paths) {
    checkName(path, path);
    let info: Stats;
    try {
      info = await stat(path);
    } catch (error) {
      problems.push({ path: shown(path), message: describeError(error) });
      continue;
    }
    if (info.isDirectory()) await scanDirectory(path);
    else if (info.isFile()) await scanFile(path);
    else problems.push({ path: shown(path), message: "not a regular file or directory" });
  }
  return { findings, filesScanned, binarySkipped, symlinksSkipped, problems };
}

function describeError(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

export function formatFinding(finding: CanaryFinding): string {
  const location = finding.inName
    ? `${finding.path} (name)`
    : `${finding.path}:${finding.line}:${finding.column}`;
  return `${location}: canary ${finding.masked} (${finding.kind})`;
}

/**
 * Plants canaries in a temporary directory and checks that the scan finds them without printing
 * them, and that a clean directory passes. Returns the failed checks; empty means it passed.
 */
export async function runSelfTest(): Promise<string[]> {
  const failures: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "cfo-canary-self-test-"));
  try {
    const planted = ["CFO", "CANARY", "SELFTEST", randomBytes(8).toString("hex")].join("_");
    const exactValue = `self-test-login-${randomBytes(12).toString("hex")}`;
    const dirty = join(root, "dirty");
    const clean = join(root, "clean");
    await mkdir(join(dirty, "logs"), { recursive: true });
    await mkdir(join(clean, "logs"), { recursive: true });
    await writeFile(join(dirty, "logs", "server.log"), `starting\nlogin token=${planted}\n`);
    await writeFile(join(dirty, "state.json"), JSON.stringify({ refresh_token: exactValue }));
    await writeFile(join(clean, "logs", "server.log"), "starting\nlogin token=[redacted]\n");
    await writeFile(join(clean, "state.json"), JSON.stringify({ refresh_token: null }));

    const options = { values: [exactValue] };
    const dirtyResult = await scanPaths([dirty], options);
    const found = (path: string, line: number, kind: CanaryKind): boolean =>
      dirtyResult.findings.some(
        (finding) => finding.path === path && finding.line === line && finding.kind === kind,
      );
    if (!found(join(dirty, "logs", "server.log"), 2, "pattern")) {
      failures.push("planted pattern canary not found");
    }
    if (!found(join(dirty, "state.json"), 1, "value")) {
      failures.push("planted exact-value canary not found");
    }
    const report = dirtyResult.findings.map(formatFinding).join("\n");
    if (report.includes(planted) || report.includes(exactValue)) {
      failures.push("report printed a full canary value");
    }

    const cleanResult = await scanPaths([clean], options);
    if (cleanResult.findings.length > 0) failures.push("clean directory reported a canary");
    if (cleanResult.filesScanned !== 2 || cleanResult.problems.length > 0) {
      failures.push("clean directory was not scanned completely");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return failures;
}

/** Runs the command line and returns its exit status. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let selfTest = false;
  let optionsEnded = false;
  const paths: string[] = [];
  for (const argument of argv) {
    if (optionsEnded || !argument.startsWith("-")) paths.push(argument);
    else if (argument === "--") optionsEnded = true;
    else if (argument === "--self-test") selfTest = true;
    else if (argument === "--help" || argument === "-h") {
      io.stdout(USAGE);
      return 0;
    } else {
      io.stderr(`canary-scan: unknown option ${argument}\n${USAGE}`);
      return 2;
    }
  }
  if (!selfTest && paths.length === 0) {
    io.stderr(`canary-scan: no paths given\n${USAGE}`);
    return 2;
  }

  if (selfTest) {
    const failures = await runSelfTest();
    for (const failure of failures) io.stderr(`canary-scan: self-test failed: ${failure}`);
    if (failures.length > 0) return 1;
    io.stdout("canary-scan: self-test passed");
    if (paths.length === 0) return 0;
  }

  const values = parseCanaryValues(io.env[CANARY_VALUES_ENV]);
  for (const path of paths) {
    try {
      await stat(path);
    } catch (error) {
      const shown = redactCanaries(path, values);
      io.stderr(`canary-scan: cannot scan ${shown}: ${describeError(error)}\n${USAGE}`);
      return 2;
    }
  }

  const result = await scanPaths(paths, { values });
  for (const finding of result.findings) io.stdout(formatFinding(finding));
  for (const problem of result.problems) {
    io.stderr(`canary-scan: could not read ${problem.path}: ${problem.message}`);
  }
  const files = new Set(result.findings.map((finding) => finding.path)).size;
  io.stdout(
    `canary-scan: ${result.findings.length} canary occurrence(s) in ${files} path(s); ` +
      `scanned ${result.filesScanned} file(s), skipped ${result.binarySkipped} binary ` +
      `and ${result.symlinksSkipped} symbolic link(s); ${values.length} exact value(s) configured`,
  );
  if (result.findings.length > 0) return 1;
  if (result.problems.length > 0) {
    io.stderr("canary-scan: scan incomplete");
    return 2;
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
}
