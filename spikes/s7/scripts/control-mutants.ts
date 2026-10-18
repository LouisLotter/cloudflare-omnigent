// Removes each IR-017 control from src/staging.ts in turn and checks that the handler tests
// fail. Restores the file afterwards. Writes results/control-mutants.txt.
//
//   node spikes/s7/scripts/control-mutants.ts

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESULTS_DIR, SPIKE_DIR } from "./lib.ts";

const FILE = join(SPIKE_DIR, "src", "staging.ts");
const MUTANTS: readonly [string, string, string][] = [
  ["no origin check", "if (!origin.ok) return", "if (false && !origin.ok) return"],
  [
    "no request-intent check",
    "if (!(await server.checkIntent(request.headers.get(INTENT_HEADER)))) {",
    "if (false) {",
  ],
  [
    "no arming check",
    "if (CAMPAIGN_ROUTES.includes(url.pathname) && !(await server.isArmed())) {",
    "if (false) {",
  ],
  ["forwarded GET starts the server", "if (!this.container().running) {", "if (false) {"],
  [
    "GET to a control URL performs it",
    "if (POST_ROUTES.includes(url.pathname)) {",
    "if (url.pathname === '/__s7/api/arm') return json({ armedUntil: await server.arm() });\n    if (POST_ROUTES.includes(url.pathname)) {",
  ],
  ["no self-disarm", "await this.stopAll();\n      console.log", "console.log"],
];

const original = readFileSync(FILE, "utf8");
const lines: string[] = [];
try {
  for (const [name, from, to] of MUTANTS) {
    if (!original.includes(from)) {
      lines.push(`${name}: NOT APPLIED (pattern missing)`);
      continue;
    }
    writeFileSync(FILE, original.replace(from, to));
    const run = spawnSync(
      "pnpm",
      ["exec", "vitest", "run", "--config", join(SPIKE_DIR, "vitest.config.ts")],
      { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
    );
    const summary = /Tests\s+(.*)/.exec(`${run.stdout}${run.stderr}`)?.[1]?.trim() ?? "no summary";
    lines.push(`${name}: ${run.status === 0 ? "SURVIVED" : "killed"} (${summary})`);
  }
} finally {
  writeFileSync(FILE, original);
}
writeFileSync(join(RESULTS_DIR, "control-mutants.txt"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
