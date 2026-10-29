// `run.sh scan` (WP3.5's log checks, extended by WP3.33): one Worker's Workers Logs, read-only, as
// counts, event names, numbers and positions. Never a value. Laptop only, test tooling.
//
//   node worker/test/staging/wp318/logs.ts <worker> <from> <to> --raw |
//     node worker/test/staging/wp318/scan.ts <worker> [--value-file <label>=<path>]...
//
// Reads one event per line (logs.ts's raw events, or its reduced lines, or a collected
// logs.jsonl) and prints one JSON line:
//   - `canaryHits`, `capabilityHits`: WP3.5's terminal canary and capability prefix (RC-22);
//   - `tokens`: a count per token shape, over every string in every event (Claude's `sk-ant-…`,
//     OpenAI's `sk-…`, GitHub's `gh?_…` and `github_pat_…`, JWTs (ChatGPT's tokens, Omnigent's
//     delegated owner tokens, an Access assertion), 64 hex characters (an R2 secret access key, or
//     any other 256-bit hex secret), and 43 base64url characters with upper case, lower case and
//     digits (Omnigent's launch and runner binding tokens, a terminal capability)); and per
//     `--value-file`, the count of that exact value (the R2 token's ID, which is its access key
//     ID). `tokenPositions` says where each hit is: the line, its time, its event and the field's
//     path. Never the matched text;
//   - `events`: the terminal's and the pages' events, with their close codes (`code`, the
//     browser's; `computerCode`, the computer side's), `clean` flags and instance IDs;
//   - `terminal`: per terminal window, the count of each terminal event and of each close code,
//     with the computer where its instance's `instance_started` names it; and the totals of
//     `terminal_reattached`, `terminal_taken_over` and `terminal_session_gone`;
//   - `instances`: every `instance_started`, with its class, instance ID, computer and version.
// A shape can match something harmless (a 64-hex intent token, say): the positions let the lead
// check each hit without seeing it.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

type Json = unknown;

/** The token shapes, in priority order: a later shape's hit inside an earlier one's is dropped. */
export const TOKEN_SHAPES: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  { kind: "claude", pattern: /sk-ant-[A-Za-z0-9]{2,10}-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai", pattern: /(?<![A-Za-z0-9_-])sk-(?!ant-)[A-Za-z0-9_-]{20,}/g },
  {
    kind: "github",
    pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{22,255})/g,
  },
  { kind: "jwt", pattern: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "hex64", pattern: /(?<![0-9A-Fa-f])(?<!sha256:)[0-9a-f]{64}(?![0-9A-Fa-f])/g },
  { kind: "urlsafe256", pattern: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g },
];

/** A 43-character run counts as a token only if it looks random: upper, lower and digits. */
function looksRandom(text: string): boolean {
  return /[A-Z]/.test(text) && /[a-z]/.test(text) && /[0-9]/.test(text);
}

/** The token shapes in a string: kinds and offsets only. */
export function tokenHits(text: string): { readonly kind: string; readonly index: number }[] {
  const spans: { kind: string; start: number; end: number }[] = [];
  for (const { kind, pattern } of TOKEN_SHAPES) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (kind === "urlsafe256" && !looksRandom(match[0])) continue;
      if (spans.some((s) => start < s.end && end > s.start)) continue;
      spans.push({ kind, start, end });
    }
  }
  return spans.sort((a, b) => a.start - b.start).map((s) => ({ kind: s.kind, index: s.start }));
}

/**
 * A path segment as printed: a key only if it looks like a field name (an identifier of at most
 * 40 characters with no token shape in it), else `<key>`. A key that held a value must never
 * reach the report through the path of what is under it.
 */
export function segment(key: string): string {
  return /^[$A-Za-z_][A-Za-z0-9_]{0,39}$/.test(key) && tokenHits(key).length === 0 ? key : "<key>";
}

/** Every string in a JSON value, with its path (keys too: a key could hold a value). */
function* strings(value: Json, path: string): Generator<{ path: string; text: string }> {
  if (typeof value === "string") {
    // Workers Logs may keep a structured line as a string: read inside it too.
    if (value.startsWith("{")) {
      try {
        yield* strings(JSON.parse(value) as Json, `${path}{}`);
        return;
      } catch {
        // a plain string
      }
    }
    yield { path, text: value };
  } else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) yield* strings(item, `${path}[${i}]`);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      yield { path: `${path}.<key>`, text: key };
      yield* strings(item, path === "" ? segment(key) : `${path}.${segment(key)}`);
    }
  }
}

function sourceOf(event: Json): Record<string, unknown> | null {
  const source = (event as { source?: unknown } | null)?.source;
  if (typeof source === "object" && source !== null) return source as Record<string, unknown>;
  if (typeof source === "string") {
    try {
      const parsed = JSON.parse(source) as unknown;
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function timeOf(event: Json): number | null {
  const e = event as { timestamp?: unknown } | null;
  return typeof e?.timestamp === "number" ? e.timestamp : null;
}

function versionOf(event: Json): string | null {
  const e = event as {
    version?: unknown;
    $workers?: { scriptVersion?: { id?: unknown } };
  } | null;
  const id = e?.version ?? e?.$workers?.scriptVersion?.id;
  return typeof id === "string" ? id.slice(0, 13) : null;
}

const TERMINAL_COUNTED = ["terminal_reattached", "terminal_taken_over", "terminal_session_gone"];

export interface ScanReport {
  readonly worker: string;
  readonly lines: number;
  readonly unreadable: number;
  readonly canaryHits: number;
  readonly capabilityHits: number;
  readonly tokens: Readonly<Record<string, number>>;
  readonly tokenPositions: readonly {
    readonly line: number;
    readonly at: number | null;
    readonly event: string | null;
    readonly path: string;
    readonly kind: string;
  }[];
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly terminal: {
    readonly windows: readonly {
      readonly computerId: string | null;
      readonly window: number | null;
      readonly events: Readonly<Record<string, number>>;
      /** The browser's close codes (`code`) and the computer side's (`computerCode`). */
      readonly codes: Readonly<Record<string, number>>;
      readonly computerCodes: Readonly<Record<string, number>>;
      readonly instanceIds: readonly string[];
    }[];
    readonly totals: Readonly<Record<string, number>>;
  };
  readonly instances: readonly {
    readonly at: number | null;
    readonly class: string | null;
    readonly instanceId: string | null;
    readonly computerId: string | null;
    readonly version: string | null;
  }[];
}

/** At most this many positions are listed; the counts are always complete. */
export const MAX_POSITIONS = 200;

/** One Worker's scan. `values`: exact values to count, by label (never printed). */
export function scanLines(
  worker: string,
  lines: Iterable<string>,
  values: readonly { readonly label: string; readonly value: string }[] = [],
): ScanReport {
  const tokens: Record<string, number> = Object.fromEntries(
    [...TOKEN_SHAPES.map((s) => s.kind), ...values.map((v) => `value:${v.label}`)].map((k) => [
      k,
      0,
    ]),
  );
  const positions: ScanReport["tokenPositions"][number][] = [];
  const events: Record<string, unknown>[] = [];
  const instances: ScanReport["instances"][number][] = [];
  let count = 0;
  let unreadable = 0;
  let canaryHits = 0;
  let capabilityHits = 0;
  for (const text of lines) {
    if (text.trim() === "") continue;
    count += 1;
    canaryHits += text.split("cfo-canary-wp35-terminal").length - 1;
    capabilityHits += text.split("cfo-capability.").length - 1;
    for (const { label, value } of values) {
      const key = `value:${label}`;
      if (value.length >= 8) tokens[key] = (tokens[key] ?? 0) + text.split(value).length - 1;
    }
    let event: Json;
    try {
      event = JSON.parse(text) as Json;
    } catch {
      unreadable += 1;
      for (const hit of tokenHits(text)) {
        tokens[hit.kind] = (tokens[hit.kind] ?? 0) + 1;
        if (positions.length < MAX_POSITIONS) {
          positions.push({ line: count, at: null, event: null, path: "(line)", kind: hit.kind });
        }
      }
      continue;
    }
    const source = sourceOf(event);
    // The event's name, as code logs it: anything else is not printed.
    const name =
      typeof source?.event === "string" && segment(source.event) !== "<key>" ? source.event : null;
    for (const { path, text: s } of strings(event, "")) {
      for (const hit of tokenHits(s)) {
        tokens[hit.kind] = (tokens[hit.kind] ?? 0) + 1;
        if (positions.length < MAX_POSITIONS) {
          positions.push({ line: count, at: timeOf(event), event: name, path, kind: hit.kind });
        }
      }
    }
    if (source === null || name === null) continue;
    if (name === "instance_started") {
      instances.push({
        at: timeOf(event),
        class: typeof source.class === "string" ? source.class : null,
        instanceId: typeof source.instanceId === "string" ? source.instanceId : null,
        computerId: typeof source.computerId === "string" ? source.computerId : null,
        version: versionOf(event),
      });
    }
    if (name.startsWith("terminal_") || name === "page_change_refused") {
      const picked: Record<string, unknown> = { at: timeOf(event), event: name };
      for (const key of [
        "reason",
        "window",
        "code",
        "computerCode",
        "clean",
        "computerClean",
        "instanceId",
      ]) {
        if (source[key] !== undefined) picked[key] = source[key];
      }
      events.push(picked);
    }
  }

  // Terminal windows: by computer (through each line's instance) and window number.
  const computerOf = new Map(
    instances
      .filter((i) => i.class === "WorkspaceDO" && i.instanceId !== null)
      .map((i) => [i.instanceId as string, i.computerId]),
  );
  const windows = new Map<string, ScanReport["terminal"]["windows"][number]>();
  const totals: Record<string, number> = Object.fromEntries(TERMINAL_COUNTED.map((k) => [k, 0]));
  const bump = (o: Readonly<Record<string, number>>, key: string) => {
    (o as Record<string, number>)[key] = (o[key] ?? 0) + 1;
  };
  for (const e of events) {
    const name = String(e.event);
    if (!name.startsWith("terminal_")) continue;
    if (TERMINAL_COUNTED.includes(name)) bump(totals, name);
    const instanceId = typeof e.instanceId === "string" ? e.instanceId : null;
    const computerId = instanceId === null ? null : (computerOf.get(instanceId) ?? null);
    const window = typeof e.window === "number" ? e.window : null;
    const key = `${computerId ?? "?"}/${window ?? "-"}`;
    const w = windows.get(key) ?? {
      computerId,
      window,
      events: {},
      codes: {},
      computerCodes: {},
      instanceIds: [],
    };
    bump(w.events, name);
    if (typeof e.code === "number") bump(w.codes, String(e.code));
    if (typeof e.computerCode === "number") bump(w.computerCodes, String(e.computerCode));
    if (instanceId !== null && !w.instanceIds.includes(instanceId)) {
      (w.instanceIds as string[]).push(instanceId);
    }
    windows.set(key, w);
  }
  return {
    worker,
    lines: count,
    unreadable,
    canaryHits,
    capabilityHits,
    tokens,
    tokenPositions: positions,
    events,
    terminal: { windows: [...windows.values()], totals },
    instances,
  };
}

/** `--value-file <label>=<path>` arguments: each file's first line is the value. */
export function valuesFrom(
  args: readonly string[],
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--value-file") throw new Error(`unknown argument ${args[i]}`);
    const spec = args[i + 1] ?? "";
    i += 1;
    const at = spec.indexOf("=");
    if (at <= 0) throw new Error("--value-file <label>=<path>");
    const value = (read(spec.slice(at + 1)).split("\n")[0] ?? "").trim();
    if (value !== "") out.push({ label: spec.slice(0, at), value });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [worker, ...rest] = process.argv.slice(2);
  if (worker === undefined) throw new Error("scan.ts <worker> [--value-file <label>=<path>]...");
  const values = valuesFrom(rest);
  const lines: string[] = [];
  for await (const line of createInterface({ input: process.stdin })) lines.push(line);
  console.log(JSON.stringify(scanLines(worker, lines, values)));
}
