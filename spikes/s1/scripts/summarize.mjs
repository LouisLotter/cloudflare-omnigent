// Summarizes S1 result lines (one JSON object per line, as the Worker logs them) into the
// wake-time statistics for the evidence report.
//
//   node spikes/s1/scripts/summarize.mjs spikes/s1/results/<file>.jsonl [label]
//
// Percentiles use the nearest-rank method: p = the ceil(q * n)-th smallest value.

import { readFileSync } from "node:fs";

const [file, onlyLabel] = process.argv.slice(2);
if (!file) throw new Error("usage: summarize.mjs <results.jsonl> [label]");

const lines = readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => line.trim().startsWith("{"))
  .map((line) => JSON.parse(line));

function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

function stats(values) {
  const v = values.filter((x) => typeof x === "number");
  if (v.length === 0) return { n: 0 };
  return {
    n: v.length,
    min: Math.min(...v),
    p50: percentile(v, 0.5),
    p95: percentile(v, 0.95),
    max: Math.max(...v),
    mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length),
  };
}

const wakes = lines.filter(
  (l) => l.s1 === "wake" && (onlyLabel === undefined || (l.label ?? "") === onlyLabel),
);
const groups = new Map();
for (const w of wakes) {
  const key = `${w.label || "series"}${w.index === 0 ? " (first)" : ""}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(w);
}

const fields = ["onlineMs", "bootMarkMs", "firstHttpMs", "wsUpgradeMs", "startReturnedMs"];
// Restore wakes (label restore-<size>) add the restore's own times.
const restoreFields = ["execReadyMs", "restoreMs", "releasedMs", "hostAfterReleaseMs"];
const out = { file, total: wakes.length, failed: wakes.filter((w) => !w.ok).length, groups: {} };
for (const [key, list] of groups) {
  const keys = key.startsWith("restore-") ? [...fields, ...restoreFields] : fields;
  out.groups[key] = Object.fromEntries(keys.map((f) => [f, stats(list.map((w) => w[f]))]));
  out.groups[key].locations = [...new Set(list.map((w) => w.location))];
  out.groups[key].dns = [...new Set(list.map((w) => w.dns))];
  if (key.startsWith("restore-")) {
    out.groups[key].archiveBytes = [...new Set(list.map((w) => w.archiveBytes))];
    out.groups[key].rawBytes = [...new Set(list.map((w) => w.rawBytes))];
    out.groups[key].restoredMatches = list.filter((w) => w.restoredMatches).length;
    out.groups[key].restoreErrors = list.filter((w) => w.restoreError).length;
  }
}
out.backups = lines
  .filter((l) => l.s1 === "backup")
  .map(({ size, ok, makeMs, backupMs, rawBytes, files, archiveBytes, error }) => ({
    size,
    ok,
    makeMs,
    backupMs,
    rawBytes,
    files,
    archiveBytes,
    error,
  }));
const series = wakes.filter((w) => w.ok && (w.label ?? "") === "" && w.index >= 0);
out.series = Object.fromEntries(fields.map((f) => [f, stats(series.map((w) => w[f]))]));
out.seriesWithoutFirst = Object.fromEntries(
  fields.map((f) => [f, stats(series.filter((w) => w.index > 0).map((w) => w[f]))]),
);

// Local reference runs (local-wake.sh and restore-bench.sh).
const local = {};
for (const l of lines.filter((l) => l.s1 === "local-wake")) {
  const key = `wake ${l.image.split("@")[0]} restore=${l.restore}`;
  local[key] ??= [];
  local[key].push(l.onlineMs);
}
for (const l of lines.filter((l) => l.s1 === "restore")) {
  for (const f of ["downloadMs", "verifyMs", "extractMs", "totalMs"]) {
    const key = `restore ${l.size} (${l.rawBytes} B raw, ${l.archiveBytes} B archive) ${f}`;
    local[key] ??= [];
    local[key].push(l[f]);
  }
}
out.local = Object.fromEntries(Object.entries(local).map(([k, v]) => [k, stats(v)]));
console.log(JSON.stringify(out, null, 2));
