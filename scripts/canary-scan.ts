/**
 * Canary scanner for release check RC-22: synthetic canary logins must never appear outside the
 * computer checkpoints, so logs, evidence, fixtures, snapshots and build artefacts are scanned.
 *
 *   node scripts/canary-scan.ts [--self-test] <paths...>
 *
 * Exit status
 *   0  Clean: every given path held at least one file, every file was scanned completely, and no
 *      canary was found.
 *   1  A canary was found (whether or not the scan was also incomplete), or the self-test failed.
 *   2  Usage error: an unknown option, no paths without --self-test, or a path that does not exist.
 *   3  Incomplete: no canary was found, but part of the input could not be scanned, so the run is
 *      no evidence that the input is clean. Causes: a given path with no files in it; a file that
 *      cannot be read or is larger than the file bound; data in a format whose compressed content
 *      the scanner cannot decode (zip and zip-based formats, xz, bzip2, 7z, rar, lz4, lzip, Unix
 *      compress, PNG, PDF, WOFF, WOFF2); corrupt gzip, zstd or brotli data; decoded data beyond
 *      the decoded-size bound or nested beyond the depth bound; a malformed tar archive. The
 *      bounds are in DEFAULT_LIMITS.
 *
 * Canaries: any match of CANARY_PATTERN_SOURCE, and each exact value listed (comma-separated) in
 * the CFO_CANARY_VALUES environment variable.
 *
 * Reading. Every file is scanned as raw bytes, whatever it contains: no file is exempt because it
 * looks binary. Canaries are looked for as UTF-8 (which covers ASCII) and as UTF-16LE, and exact
 * values also as latin1. gzip and zstd data (recognised by signature) and brotli data (recognised
 * by a .br name, as brotli has no signature) are decoded and the result scanned in the same way,
 * recursively. A tar archive is scanned whole, and each member that is itself compressed or an
 * archive is decoded or reported. Data without NUL bytes is reported by line and column, other
 * data by byte offset.
 *
 * Paths. Directories are walked recursively. Below the given paths, entries named in
 * SKIPPED_NAMES and symbolic links are skipped; a path given explicitly is always scanned, so
 * `canary-scan.ts worker/dist` does scan the build output. Names are checked as well as contents.
 *
 * Reports never print a full canary value, even inside a path or an archive member's name.
 *
 * Not detected: canaries in UTF-16BE or other encodings, and canaries that are split up or
 * transformed (for example base64-encoded) inside a file.
 *
 * Source files must never contain a literal canary: tests build them at run time.
 */
import { randomBytes } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  brotliCompressSync,
  brotliDecompressSync,
  crc32,
  deflateRawSync,
  gunzipSync,
  gzipSync,
  zstdDecompressSync,
} from "node:zlib";

export const CANARY_PREFIX = "CFO_CANARY_";
export const CANARY_PATTERN_SOURCE = `${CANARY_PREFIX}[A-Za-z0-9_]{8,}`;
/** The same pattern in UTF-16LE: every ASCII character is followed by a NUL byte. */
const UTF16LE_PATTERN_SOURCE = `${[...CANARY_PREFIX].map((character) => `${character}\\x00`).join("")}(?:[A-Za-z0-9_]\\x00){8,}`;
export const CANARY_VALUES_ENV = "CFO_CANARY_VALUES";
export const SKIPPED_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".wrangler",
  "dist",
  "coverage",
  ".venv",
]);

export const EXIT_CLEAN = 0;
export const EXIT_FOUND = 1;
export const EXIT_USAGE = 2;
export const EXIT_INCOMPLETE = 3;

export interface ScanLimits {
  /** Larger files are not read: the scan is incomplete. */
  readonly maxFileBytes: number;
  /** Total decoded bytes per file, across all its compressed layers. */
  readonly maxDecodedBytes: number;
  /** How many layers (compression or archive members) deep the scan follows. */
  readonly maxDepth: number;
}

export const DEFAULT_LIMITS: ScanLimits = {
  maxFileBytes: 256 * 1024 * 1024,
  maxDecodedBytes: 256 * 1024 * 1024,
  maxDepth: 8,
};

const USAGE = "usage: node scripts/canary-scan.ts [--self-test] <paths...>";

export type CanaryKind = "pattern" | "value";
export type CanaryEncoding = "utf8" | "latin1" | "utf16le";

export interface DataFinding {
  /** Byte offset in the scanned data. */
  readonly offset: number;
  /** 1-based line and column (in UTF-16 code units) when the data has no NUL byte, else null. */
  readonly line: number | null;
  readonly column: number | null;
  readonly kind: CanaryKind;
  readonly encoding: CanaryEncoding;
  /** Safe to print: never the full value. */
  readonly masked: string;
}

export interface CanaryFinding extends DataFinding {
  /** The file, or for a canary in a name, the file or directory. Canaries in it are masked. */
  readonly path: string;
  /** Whether the canary is in the path's last component rather than in the contents. */
  readonly inName: boolean;
  /** How the data was reached from the file, for example ["gzip", "tar member a.log"]. Masked. */
  readonly layers: readonly string[];
}

export interface ScanProblem {
  /** Canaries in it are masked. */
  readonly path: string;
  readonly message: string;
}

export interface ScanResult {
  readonly findings: CanaryFinding[];
  /** Anything that makes the scan incomplete. */
  readonly problems: ScanProblem[];
  readonly filesScanned: number;
  readonly layersDecoded: number;
  readonly symlinksSkipped: number;
}

export interface ScanOptions {
  /** Exact canary values, in addition to the pattern. */
  readonly values?: readonly string[];
  readonly limits?: Partial<ScanLimits>;
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

/** The byte sequences an exact value is looked for as. */
function valueEncodings(value: string): [CanaryEncoding, Buffer][] {
  const encodings: [CanaryEncoding, Buffer][] = [
    ["utf8", Buffer.from(value, "utf8")],
    ["utf16le", Buffer.from(value, "utf16le")],
  ];
  const codes = [...value].map((character) => character.codePointAt(0) ?? 0);
  if (codes.some((code) => code > 0x7f) && codes.every((code) => code <= 0xff)) {
    encodings.push(["latin1", Buffer.from(value, "latin1")]);
  }
  return encodings;
}

/** Finds every canary occurrence in raw bytes, ordered by offset. */
export function findCanaries(data: Uint8Array, values: readonly string[] = []): DataFinding[] {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  // latin1 maps each byte to one character, so string offsets are byte offsets.
  const latin1 = bytes.toString("latin1");
  const matches = new Map<
    string,
    { offset: number; kind: CanaryKind; encoding: CanaryEncoding; value: string }
  >();
  const add = (
    offset: number,
    length: number,
    kind: CanaryKind,
    encoding: CanaryEncoding,
    value: string,
  ): void => {
    const key = `${offset}:${length}`;
    if (!matches.has(key)) matches.set(key, { offset, kind, encoding, value });
  };
  for (const match of latin1.matchAll(new RegExp(CANARY_PATTERN_SOURCE, "g"))) {
    add(match.index, match[0].length, "pattern", "utf8", match[0]);
  }
  for (const match of latin1.matchAll(new RegExp(UTF16LE_PATTERN_SOURCE, "g"))) {
    add(match.index, match[0].length, "pattern", "utf16le", match[0].replaceAll("\u0000", ""));
  }
  for (const value of values) {
    if (value.length === 0) continue;
    for (const [encoding, needle] of valueEncodings(value)) {
      for (
        let offset = bytes.indexOf(needle);
        offset !== -1;
        offset = bytes.indexOf(needle, offset + 1)
      ) {
        add(offset, needle.length, "value", encoding, value);
      }
    }
  }

  const isText = !bytes.includes(0);
  const lineStarts = [0];
  if (isText) {
    for (let index = bytes.indexOf(0x0a); index !== -1; index = bytes.indexOf(0x0a, index + 1)) {
      lineStarts.push(index + 1);
    }
  }
  return [...matches.values()]
    .sort((left, right) => left.offset - right.offset)
    .map(({ offset, kind, encoding, value }) => {
      let line: number | null = null;
      let column: number | null = null;
      if (isText) {
        const lineIndex = lastAtOrBefore(lineStarts, offset);
        const lineStart = lineStarts[lineIndex] ?? 0;
        line = lineIndex + 1;
        column = bytes.subarray(lineStart, offset).toString("utf8").length + 1;
      }
      return { offset, line, column, kind, encoding, masked: maskCanary(value) };
    });
}

/** Finds canaries in a string, as its UTF-8 bytes. */
export function findCanariesInText(text: string, values: readonly string[] = []): DataFinding[] {
  return findCanaries(Buffer.from(text, "utf8"), values);
}

function lastAtOrBefore(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((sorted[middle] ?? 0) <= value) low = middle;
    else high = middle - 1;
  }
  return low;
}

type Codec = "gzip" | "zstd" | "brotli";

export type DataFormat =
  | { readonly kind: "plain" }
  | { readonly kind: "compressed"; readonly codec: Codec }
  | { readonly kind: "tar" }
  | { readonly kind: "unsupported"; readonly format: string };

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

/** Signatures of formats whose compressed content this scanner cannot decode. */
const UNSUPPORTED_SIGNATURES: readonly (readonly [string, readonly number[]])[] = [
  ["zip", [0x50, 0x4b, 0x03, 0x04]],
  ["zip", [0x50, 0x4b, 0x05, 0x06]],
  ["zip", [0x50, 0x4b, 0x07, 0x08]],
  ["xz", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
  ["7z", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
  ["rar", [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]],
  ["lz4", [0x04, 0x22, 0x4d, 0x18]],
  ["lzip", ascii("LZIP")],
  ["Unix compress", [0x1f, 0x9d]],
  ["PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["PDF", ascii("%PDF-")],
  ["WOFF", ascii("wOFF")],
  ["WOFF2", ascii("wOF2")],
];

function startsWith(data: Uint8Array, signature: readonly number[], at = 0): boolean {
  return signature.every((byte, index) => data[at + index] === byte);
}

/** Recognises compressed data and archives by signature (brotli by a .br name). */
export function detectFormat(data: Uint8Array, name: string): DataFormat {
  if (startsWith(data, [0x1f, 0x8b, 0x08])) return { kind: "compressed", codec: "gzip" };
  if (startsWith(data, [0x28, 0xb5, 0x2f, 0xfd])) return { kind: "compressed", codec: "zstd" };
  for (const [format, signature] of UNSUPPORTED_SIGNATURES) {
    if (startsWith(data, signature)) return { kind: "unsupported", format };
  }
  const level = data[3] ?? 0;
  if (startsWith(data, ascii("BZh")) && level >= 0x31 && level <= 0x39) {
    return { kind: "unsupported", format: "bzip2" };
  }
  if (data.length >= 512 && startsWith(data, ascii("ustar"), 257)) return { kind: "tar" };
  if (/\.br$/i.test(name)) return { kind: "compressed", codec: "brotli" };
  return { kind: "plain" };
}

function decode(codec: Codec, data: Buffer, maxOutputLength: number): Buffer {
  if (codec === "gzip") return gunzipSync(data, { maxOutputLength });
  if (codec === "zstd") return zstdDecompressSync(data, { maxOutputLength });
  return brotliDecompressSync(data, { maxOutputLength });
}

export interface TarMember {
  /** The full name, from a GNU long-name or pax `path` record when there is one. */
  readonly name: string;
  readonly data: Buffer;
}

/** A tar archive's regular files, or why they cannot all be listed. */
export type TarListing = { readonly members: TarMember[] } | { readonly error: string };

const MALFORMED_TAR = { error: "malformed tar archive" } as const;

/**
 * Entry types skipped on purpose, with the reason. They carry no file content of their own;
 * whatever bytes they hold are still covered by the raw scan of the whole archive.
 */
const TAR_ENTRIES_WITHOUT_CONTENT: Readonly<Record<string, string>> = {
  "1": "hard link: its content belongs to another entry",
  "2": "symbolic link",
  "3": "character device",
  "4": "block device",
  "5": "directory",
  "6": "FIFO",
  V: "GNU volume label",
  D: "GNU directory dump: a list of names",
};

/**
 * The regular files in a ustar, GNU or pax tar archive. GNU long names ('L') and pax `path` and
 * `size` records apply to the entry that follows them; a GNU long link name ('K') and other pax
 * records (times, ownership, link targets, comments, character sets, extended attributes) do
 * not affect what is scanned and are skipped. Anything else, such as a sparse file ('S' or
 * `GNU.sparse.*`), a multi-volume part ('M'), a global pax `path` or `size`, or an unknown type,
 * makes the listing fail rather than fall back to a truncated name or a wrong length.
 */
export function tarMembers(data: Buffer): TarListing {
  const members: TarMember[] = [];
  let next: { name?: string; size?: number } = {};
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const headerSize = tarNumber(header.subarray(124, 136));
    if (headerSize === null || !tarChecksumMatches(header)) return MALFORMED_TAR;
    const type = String.fromCharCode(header[156] ?? 0);
    const isExtension = type === "L" || type === "K" || type === "x" || type === "g";
    const size = isExtension ? headerSize : (next.size ?? headerSize);
    const start = offset + 512;
    if (start + size > data.length) return MALFORMED_TAR;
    const content = data.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;

    if (type === "L") {
      next = { ...next, name: tarString(content) };
    } else if (type === "x" || type === "g") {
      const records = paxRecordsIn(content);
      if (records === null) return MALFORMED_TAR;
      const applied = applyPaxRecords(records, type === "g", next);
      if ("error" in applied) return applied;
      next = applied;
    } else if (type === "K") {
      // The long name of a link target: not content, and it does not rename the next entry.
    } else {
      if (type === "0" || type === "\u0000" || type === "7") {
        members.push({ name: next.name ?? tarHeaderName(header), data: content });
      } else if (TAR_ENTRIES_WITHOUT_CONTENT[type] === undefined) {
        return { error: `unsupported tar entry type ${JSON.stringify(type)}` };
      }
      next = {};
    }
  }
  return { members };
}

/** The name in a ustar header, joined to its prefix field in POSIX ustar (not old GNU) format. */
function tarHeaderName(header: Buffer): string {
  const name = tarString(header.subarray(0, 100));
  const posix = header.subarray(257, 263).toString("latin1") === "ustar\u0000";
  const prefix = posix ? tarString(header.subarray(345, 500)) : "";
  return prefix === "" ? name : `${prefix}/${name}`;
}

/** Parses pax extended-header records, `<length> <key>=<value>\n`; null if malformed. */
function paxRecordsIn(content: Buffer): Map<string, string> | null {
  const records = new Map<string, string>();
  let position = 0;
  while (position < content.length) {
    const space = content.indexOf(0x20, position);
    const lengthText = content.subarray(position, Math.max(space, position)).toString("latin1");
    if (space === -1 || !/^[0-9]+$/.test(lengthText)) return null;
    const end = position + Number(lengthText);
    if (end <= space + 1 || end > content.length || content[end - 1] !== 0x0a) return null;
    const record = content.subarray(space + 1, end - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) return null;
    records.set(record.slice(0, equals), record.slice(equals + 1));
    position = end;
  }
  return records;
}

function applyPaxRecords(
  records: ReadonlyMap<string, string>,
  global: boolean,
  next: { name?: string; size?: number },
): { name?: string; size?: number } | { error: string } {
  let applied = next;
  for (const [key, value] of records) {
    if (key.startsWith("GNU.sparse.")) return { error: "tar archive holds a GNU sparse file" };
    if (key !== "path" && key !== "size") continue;
    if (global) return { error: `tar archive has a global pax ${key} record` };
    if (value === "") {
      // POSIX: an empty value deletes the override, so the header's own field applies again.
      const { name, size } = applied;
      applied =
        key === "path"
          ? { ...(size === undefined ? {} : { size }) }
          : { ...(name === undefined ? {} : { name }) };
    } else if (key === "path") applied = { ...applied, name: value };
    else if (/^[0-9]+$/.test(value)) applied = { ...applied, size: Number(value) };
    else return MALFORMED_TAR;
  }
  return applied;
}

function tarString(field: Buffer): string {
  return field.toString("utf8").split("\u0000")[0] ?? "";
}

/** An octal tar number; null for anything else, including the base-256 form of huge sizes. */
function tarNumber(field: Buffer): number | null {
  const text = (field.toString("latin1").split("\u0000")[0] ?? "").trim();
  if (text === "") return 0;
  return /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : null;
}

function tarChecksumMatches(header: Buffer): boolean {
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  return tarNumber(header.subarray(148, 156)) === sum;
}

function describeError(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

function isOverBound(error: unknown): boolean {
  return error instanceof RangeError && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE";
}

/** Scans files and directories. Paths that do not exist are reported as problems. */
export async function scanPaths(
  paths: readonly string[],
  options: ScanOptions = {},
): Promise<ScanResult> {
  const values = options.values ?? [];
  const limits: ScanLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const findings: CanaryFinding[] = [];
  const problems: ScanProblem[] = [];
  let filesFound = 0;
  let filesScanned = 0;
  let layersDecoded = 0;
  let symlinksSkipped = 0;
  const shown = (text: string): string => redactCanaries(text, values);

  const checkName = (path: string, name: string): void => {
    for (const finding of findCanariesInText(name, values)) {
      findings.push({ ...finding, path: shown(path), inName: true, layers: [] });
    }
  };

  const scanData = (
    data: Buffer,
    file: string,
    layers: readonly string[],
    name: string,
    depth: number,
    rawScanned: boolean,
    budget: { left: number },
  ): void => {
    if (!rawScanned) {
      for (const finding of findCanaries(data, values)) {
        findings.push({ ...finding, path: shown(file), inName: false, layers });
      }
    }
    const problem = (message: string): void => {
      const where = layers.length > 0 ? ` (in ${layers.join(" > ")})` : "";
      problems.push({ path: shown(file), message: `${message}${where}` });
    };
    const format = detectFormat(data, name);
    if (format.kind === "plain") return;
    if (format.kind === "unsupported") {
      problem(`cannot decode ${format.format} data`);
      return;
    }
    if (depth >= limits.maxDepth) {
      problem(`nested more than ${limits.maxDepth} layers deep`);
      return;
    }
    if (format.kind === "tar") {
      const listing = tarMembers(data);
      if ("error" in listing) {
        problem(listing.error);
        return;
      }
      // The whole archive was scanned above; only members that need decoding go further.
      for (const member of listing.members) {
        if (detectFormat(member.data, member.name).kind === "plain") continue;
        const layer = `tar member ${shown(member.name)}`;
        scanData(member.data, file, [...layers, layer], member.name, depth + 1, true, budget);
      }
      return;
    }
    let decoded: Buffer;
    try {
      if (budget.left <= 0) throw new RangeError("no decoding budget left");
      decoded = decode(format.codec, data, budget.left);
    } catch (error) {
      problem(
        isOverBound(error) || budget.left <= 0
          ? `decoded data exceeds the ${limits.maxDecodedBytes}-byte bound`
          : `corrupt ${format.codec} data`,
      );
      return;
    }
    budget.left -= decoded.length;
    layersDecoded += 1;
    const innerName = name.replace(/\.(gz|tgz|zst|br)$/i, "");
    scanData(decoded, file, [...layers, format.codec], innerName, depth + 1, false, budget);
  };

  const scanFile = async (path: string, size: number): Promise<void> => {
    filesFound += 1;
    if (size > limits.maxFileBytes) {
      problems.push({
        path: shown(path),
        message: `larger than the ${limits.maxFileBytes}-byte file bound`,
      });
      return;
    }
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch (error) {
      problems.push({ path: shown(path), message: describeError(error) });
      return;
    }
    filesScanned += 1;
    scanData(content, path, [], basename(path), 0, false, { left: limits.maxDecodedBytes });
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
      else if (entry.isFile()) await scanPath(child);
    }
  };

  const scanPath = async (path: string): Promise<void> => {
    let info: Stats;
    try {
      info = await stat(path);
    } catch (error) {
      problems.push({ path: shown(path), message: describeError(error) });
      return;
    }
    if (info.isDirectory()) await scanDirectory(path);
    else if (info.isFile()) await scanFile(path, info.size);
    else problems.push({ path: shown(path), message: "not a regular file or directory" });
  };

  for (const path of paths) {
    checkName(path, path);
    const before = filesFound;
    await scanPath(path);
    // Scanning nothing is no evidence of a clean path.
    if (filesFound === before) problems.push({ path: shown(path), message: "no files to scan" });
  }
  return { findings, problems, filesScanned, layersDecoded, symlinksSkipped };
}

/** 1 if a canary was found, else 3 if the scan was incomplete, else 0. */
export function exitCodeFor(result: ScanResult): number {
  if (result.findings.length > 0) return EXIT_FOUND;
  if (result.problems.length > 0) return EXIT_INCOMPLETE;
  return EXIT_CLEAN;
}

export function formatFinding(finding: CanaryFinding): string {
  const layers = finding.layers.length > 0 ? ` [${finding.layers.join(" > ")}]` : "";
  let location: string;
  if (finding.inName) location = `${finding.path} (name)`;
  else if (finding.line !== null) {
    location = `${finding.path}${layers}:${finding.line}:${finding.column}`;
  } else location = `${finding.path}${layers}: byte ${finding.offset}`;
  const detail =
    finding.encoding === "utf8" ? finding.kind : `${finding.kind}, ${finding.encoding}`;
  return `${location}: canary ${finding.masked} (${detail})`;
}

export interface TarEntry {
  /** Written to the 100-byte name field, so longer names are cut short, as real writers do. */
  readonly name: string;
  readonly data: Uint8Array;
  /** The type flag; "0", a regular file, by default. */
  readonly type?: string;
  /** The header's size field, if it should differ from the data's length. */
  readonly headerSize?: number;
}

/** A tar archive of the given entries, in POSIX ustar or old GNU format, for tests. */
export function tarArchive(
  entries: readonly TarEntry[],
  format: "ustar" | "gnu" = "ustar",
): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, data, type = "0", headerSize = data.length } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\u0000", 100, "latin1");
    header.write("0000000\u0000", 108, "latin1");
    header.write("0000000\u0000", 116, "latin1");
    header.write(`${headerSize.toString(8).padStart(11, "0")}\u0000`, 124, "latin1");
    header.write("00000000000\u0000", 136, "latin1");
    header.write(" ".repeat(8), 148, "latin1");
    header.write(type, 156, "latin1");
    header.write(format === "gnu" ? "ustar  \u0000" : "ustar\u000000", 257, "latin1");
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, "latin1");
    blocks.push(header, Buffer.from(data), Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** Pax extended-header records, `<length> <key>=<value>\n`, for tests. */
export function paxRecords(records: Readonly<Record<string, string>>): Buffer {
  return Buffer.concat(
    Object.entries(records).map(([key, value]) => {
      const body = ` ${key}=${value}\n`;
      const bodyLength = Buffer.byteLength(body);
      // The length counts its own digits.
      let length = bodyLength;
      while (String(length).length + bodyLength !== length) {
        length = String(length).length + bodyLength;
      }
      return Buffer.from(`${length}${body}`);
    }),
  );
}

/** A zip archive holding one deflated file, for the self-test and tests. */
export function zipArchive(name: string, content: Uint8Array): Buffer {
  const fileName = Buffer.from(name, "utf8");
  const compressed = deflateRawSync(content);
  const checksum = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const entries = Buffer.concat([local, fileName, compressed]);
  const directory = Buffer.concat([central, fileName]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(entries.length, 16);
  return Buffer.concat([entries, directory, end]);
}

/**
 * Plants canaries in a temporary directory, in text, binary, compressed and archived forms, and
 * checks the exit status the scan would give for each, that reports never print a canary, and
 * that unsupported input, an empty directory and clean text give the right status. Returns the
 * failed checks; empty means it passed.
 */
export async function runSelfTest(): Promise<string[]> {
  const failures: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "cfo-canary-self-test-"));
  try {
    const planted = ["CFO", "CANARY", "SELFTEST", randomBytes(8).toString("hex")].join("_");
    const exactValue = `self-test-login-${randomBytes(12).toString("hex")}`;
    const values = [exactValue];
    const log = `starting\nlogin token=${planted}\n`;
    const longName = `artifacts/${"long-directory-name/".repeat(6)}server.log`;
    const cases: [string, Uint8Array | null, number][] = [
      ["server.log", Buffer.from(log), EXIT_FOUND],
      ["state.json", Buffer.from(JSON.stringify({ refresh_token: exactValue })), EXIT_FOUND],
      ["nul-prefixed.log", Buffer.concat([Buffer.from([0]), Buffer.from(log)]), EXIT_FOUND],
      [
        "state.sqlite",
        Buffer.concat([
          Buffer.from("SQLite format 3\u0000", "latin1"),
          Buffer.alloc(84),
          randomBytes(64),
          Buffer.from(`token=${planted}`, "utf16le"),
          Buffer.alloc(32),
        ]),
        EXIT_FOUND,
      ],
      ["server.log.gz", gzipSync(log), EXIT_FOUND],
      [
        "logs.tar.gz",
        gzipSync(tarArchive([{ name: "logs/app.log.gz", data: gzipSync(log) }])),
        EXIT_FOUND,
      ],
      // A brotli member recognisable only by the .br at the end of its pax long name.
      [
        "long-name.tar",
        tarArchive([
          { name: "PaxHeader", type: "x", data: paxRecords({ path: `${longName}.br` }) },
          { name: longName, data: brotliCompressSync(log.repeat(20)) },
        ]),
        EXIT_FOUND,
      ],
      ["logs.zip", zipArchive("server.log", Buffer.from(log.repeat(4))), EXIT_INCOMPLETE],
      ["empty", null, EXIT_INCOMPLETE],
      ["clean.log", Buffer.from("starting\nlogin token=[redacted]\n"), EXIT_CLEAN],
    ];
    for (const [name, content, expected] of cases) {
      const path = join(root, name);
      if (content === null) await mkdir(path);
      else await writeFile(path, content);
      const result = await scanPaths([path], { values });
      const status = exitCodeFor(result);
      if (status !== expected)
        failures.push(`${name}: exit status ${status}, expected ${expected}`);
      if (name === "long-name.tar" && !result.findings.some((f) => f.layers.includes("brotli"))) {
        failures.push(`${name}: the brotli member was not decoded`);
      }
      const report = [
        ...result.findings.map(formatFinding),
        ...result.problems.map((problem) => problem.message),
      ].join("\n");
      if (report.includes(planted) || report.includes(exactValue)) {
        failures.push(`${name}: the report printed a full canary value`);
      }
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
      return EXIT_CLEAN;
    } else {
      io.stderr(`canary-scan: unknown option ${argument}\n${USAGE}`);
      return EXIT_USAGE;
    }
  }
  if (!selfTest && paths.length === 0) {
    io.stderr(`canary-scan: no paths given\n${USAGE}`);
    return EXIT_USAGE;
  }

  if (selfTest) {
    const failures = await runSelfTest();
    for (const failure of failures) io.stderr(`canary-scan: self-test failed: ${failure}`);
    if (failures.length > 0) return EXIT_FOUND;
    io.stdout("canary-scan: self-test passed");
    if (paths.length === 0) return EXIT_CLEAN;
  }

  const values = parseCanaryValues(io.env[CANARY_VALUES_ENV]);
  for (const path of paths) {
    try {
      await stat(path);
    } catch (error) {
      const shown = redactCanaries(path, values);
      io.stderr(`canary-scan: cannot scan ${shown}: ${describeError(error)}\n${USAGE}`);
      return EXIT_USAGE;
    }
  }

  const result = await scanPaths(paths, { values });
  for (const finding of result.findings) io.stdout(formatFinding(finding));
  for (const problem of result.problems) {
    io.stderr(`canary-scan: not scanned completely: ${problem.path}: ${problem.message}`);
  }
  const files = new Set(result.findings.map((finding) => finding.path)).size;
  io.stdout(
    `canary-scan: ${result.findings.length} canary occurrence(s) in ${files} path(s); ` +
      `scanned ${result.filesScanned} file(s), decoded ${result.layersDecoded} compressed ` +
      `layer(s), skipped ${result.symlinksSkipped} symbolic link(s); ` +
      `${result.problems.length} problem(s); ${values.length} exact value(s) configured`,
  );
  const status = exitCodeFor(result);
  if (status === EXIT_INCOMPLETE) {
    io.stderr("canary-scan: scan incomplete: this run is no evidence that the input is clean");
  }
  return status;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
}
