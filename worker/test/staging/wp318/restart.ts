// WP3.18 staging (the M3 sitting): has the watchdog applied a configuration release? Reads the
// platform Worker's Workers Logs lines (logs.ts's JSON lines) on stdin and looks for the
// `config_changed` outage that a release since <since ms> caused (G2-SEC-001's controlled restart):
//   node worker/test/staging/wp318/logs.ts cfo-stg-wp318-platform <since> <now> |
//     node worker/test/staging/wp318/restart.ts <since>
// Prints what it found. Exit 0: one has ended (the server runs the released configuration);
// 3: none yet, or still restarting.
import { readFileSync } from "node:fs";
import { configRestarts, type LogLine } from "./plan.ts";

const since = Number(process.argv[2]);
if (!Number.isFinite(since)) throw new Error("restart.ts <since ms>");
const lines = readFileSync(0, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as LogLine);
const found = configRestarts(lines, since, Number.POSITIVE_INFINITY);
console.log(JSON.stringify(found));
process.exit(found.some((r) => r.endedAt !== null) ? 0 : 3);
