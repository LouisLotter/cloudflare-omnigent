// WP3.23 (the M3 sitting's lead visibility): the computers' `computer_status` events from the
// platform Worker's Workers Logs, as `logs.ts` prints them, reduced to each computer's latest
// status and its changes. WorkspaceDO logs names, versions, outcomes, reasons and counts only, so
// nothing here can hold a value; the lead follows a sitting without asking the owner to paste.
//
//   node worker/test/staging/wp318/logs.ts <platform> <from> <to> | node status.ts
//
// Prints one JSON line per change of a computer's status (time, computer, the changed fields),
// then a summary line per computer with its latest status.

import { createInterface } from "node:readline";

type Fields = Record<string, unknown>;

/** The `computer_status` event in one `logs.ts` line, or null. */
export function statusEvent(line: string): { at: number; fields: Fields } | null {
  let event: { timestamp?: unknown; source?: unknown };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return null;
  }
  let source = event.source;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source) as unknown;
    } catch {
      return null;
    }
  }
  const s = source as Fields | null;
  if (s === null || typeof s !== "object" || s.event !== "computer_status") return null;
  return { at: typeof event.timestamp === "number" ? event.timestamp : 0, fields: s };
}

/** What changed between two statuses of a computer (its time-varying disk aside). */
export function changes(before: Fields | undefined, after: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(after)) {
    if (["cfo", "event", "diskFreeBytes"].includes(key)) continue;
    if (before === undefined || JSON.stringify(before[key]) !== JSON.stringify(value)) {
      out[key] = value;
    }
  }
  return out;
}

export async function main(lines: AsyncIterable<string>, print: (text: string) => void) {
  const events: { at: number; fields: Fields }[] = [];
  for await (const line of lines) {
    const event = statusEvent(line);
    if (event !== null) events.push(event);
  }
  events.sort((a, b) => a.at - b.at);
  const latest = new Map<string, { at: number; fields: Fields }>();
  for (const event of events) {
    const computer = String(event.fields.computerId ?? "unknown");
    const before = latest.get(computer)?.fields;
    const changed = changes(before, event.fields);
    if (Object.keys(changed).length > 0) {
      print(JSON.stringify({ at: new Date(event.at).toISOString(), computer, changed }));
    }
    latest.set(computer, event);
  }
  for (const [computer, event] of latest) {
    const { cfo: _c, event: _e, ...fields } = event.fields;
    print(JSON.stringify({ latest: new Date(event.at).toISOString(), computer, ...fields }));
  }
  if (latest.size === 0) print(JSON.stringify({ latest: null, note: "no computer_status events" }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(createInterface({ input: process.stdin }), (text) => console.log(text));
}
