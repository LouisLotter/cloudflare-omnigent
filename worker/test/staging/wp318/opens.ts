// WP3.18 staging soak (WP3.27): keeps only the host-tunnel opens from logs.ts's lines on stdin,
// for `run.sh collect`'s presence.jsonl (each host's connections before the soak's window):
//   node worker/test/staging/wp318/logs.ts <…> <from> <to> | node …/opens.ts
import { createInterface } from "node:readline";
import { hostTunnelOpen, type LogLine } from "./plan.ts";

for await (const text of createInterface({ input: process.stdin })) {
  if (text === "") continue;
  if (hostTunnelOpen(JSON.parse(text) as LogLine) !== null) console.log(text);
}
