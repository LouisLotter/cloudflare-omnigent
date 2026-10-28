// WP3.23: `run.sh status`'s reader (worker/test/staging/wp318/status.ts): the computers'
// `computer_status` events from Workers Logs, reduced to their changes and each one's latest.
import { describe, expect, it } from "vitest";
import { changes, main, statusEvent } from "../staging/wp318/status.ts";

const line = (at: number, fields: Record<string, unknown>, asString = false) => {
  const source = { cfo: "workspace", event: "computer_status", ...fields };
  return JSON.stringify({ timestamp: at, source: asString ? JSON.stringify(source) : source });
};

async function* lines(items: string[]) {
  for (const item of items) yield item;
}

describe("run.sh status", () => {
  it("reads computer_status events only, whatever form the source has", () => {
    expect(statusEvent(line(5, { computerId: "cmp_a", signOut: "none" }))?.fields.signOut).toBe(
      "none",
    );
    expect(statusEvent(line(5, { computerId: "cmp_a" }, true))?.at).toBe(5);
    expect(statusEvent("not json")).toBeNull();
    expect(statusEvent(JSON.stringify({ source: "{broken" }))).toBeNull();
    expect(statusEvent(JSON.stringify({ source: { event: "other" } }))).toBeNull();
    expect(statusEvent(JSON.stringify({ source: null }))).toBeNull();
    expect(statusEvent(JSON.stringify({ source: { event: "computer_status" } }))?.at).toBe(0);
  });

  it("names what changed, ignoring free disk", () => {
    expect(changes(undefined, { a: 1, cfo: "x", event: "y" })).toEqual({ a: 1 });
    expect(changes({ a: 1, diskFreeBytes: 5 }, { a: 1, diskFreeBytes: 6 })).toEqual({});
    expect(
      changes({ lastSave: { outcome: "published" } }, { lastSave: { outcome: "failed" } }),
    ).toEqual({
      lastSave: { outcome: "failed" },
    });
  });

  it("prints each change in time order, then each computer's latest", async () => {
    const out: string[] = [];
    await main(
      lines([
        line(3_000, { computerId: "cmp_a", lastSave: "failed" }),
        line(1_000, { computerId: "cmp_a", lastSave: null }),
        line(2_000, { computerId: "cmp_a", lastSave: null, diskFreeBytes: 9 }),
        "noise",
      ]),
      (text) => out.push(text),
    );
    const parsed = out.map((text) => JSON.parse(text) as Record<string, unknown>);
    expect(parsed.filter((p) => "changed" in p).map((p) => p.changed)).toEqual([
      { computerId: "cmp_a", lastSave: null },
      { lastSave: "failed" },
    ]);
    expect(parsed.at(-1)).toMatchObject({ computer: "cmp_a", lastSave: "failed" });
    const none: string[] = [];
    await main(lines([]), (text) => none.push(text));
    expect(none).toEqual([JSON.stringify({ latest: null, note: "no computer_status events" })]);
  });
});
