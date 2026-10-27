// The M3 sitting (WP3.19): the lead's records of the server's restarts, from the platform
// Worker's Workers Logs lines (logs.ts's JSON lines) on stdin. Laptop only, test tooling.
//   node worker/test/staging/wp318/logs.ts cfo-stg-wp318-platform <from> <now> |
//     node worker/test/staging/wp318/server-checks.ts replaced
//       the forced replacement's result (run.sh replace). Exit 0 once it ended (done or failed,
//       whatever its verdict), 3 while it has not
//     node worker/test/staging/wp318/server-checks.ts restarts <from ms>
//       each `config_changed` restart since <from>, with the watchdog's start-to-ready times
// Prints JSON: times and verdicts only, never a credential.
import { readFileSync } from "node:fs";
import { type LogLine, replaceResult, restartTimes } from "./plan.ts";

const [command, fromText] = process.argv.slice(2);
const lines = readFileSync(0, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as LogLine);
if (command === "replaced") {
  const result = replaceResult(lines);
  console.log(JSON.stringify(result));
  process.exit(result === null ? 3 : 0);
} else if (command === "restarts" && Number.isFinite(Number(fromText))) {
  console.log(JSON.stringify(restartTimes(lines, Number(fromText), Number.POSITIVE_INFINITY)));
} else {
  throw new Error("server-checks.ts replaced | restarts <from ms>");
}
