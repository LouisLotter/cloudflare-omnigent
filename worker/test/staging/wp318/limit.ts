// `run.sh limit <n>` (WP3.33, the G3 sitting's step B6): the staging installation's limit of awake
// computers, `CFO_MAX_AWAKE_COMPUTERS`, set through the guarded staging tool and nothing else.
// Laptop only, test tooling.
//
// The limit is a platform Worker variable that the bootstrap does not render (the default is 2).
// run.sh keeps the lead's value in $WP318_DIR/limit and passes it to soak-config.ts as
// WP318_MAX_AWAKE, so that every platform deploy of the sitting renders it (soakPlatformConfig),
// and deploys the platform Worker once through the staging tool. It is not a `SERVER_ENV_`
// variable, so the server's configuration and image are unchanged: no `config_changed` restart.
// ControlDO reads it from its environment, so the new limit holds once ControlDO runs the
// deployed version, which run.sh waits for.
//
//   node worker/test/staging/wp318/limit.ts check <n | default>
//       ControlDO's own rule (parseLimits): prints the setting, exit 2 if ControlDO would refuse it
//   node worker/test/staging/wp318/logs.ts cfo-stg-wp318-platform <since> <now> |
//     node worker/test/staging/wp318/limit.ts applied <version>
//       exit 0 once a ControlDO instance runs that version (13 characters), 3 while none does

import { readFileSync } from "node:fs";
import { parseLimits } from "../../../src/control/limits.ts";
import { type LogLine, sourceOf } from "./plan.ts";

/** The variable run.sh passes the lead's limit in (unset: the installation's default). */
export const LIMIT_ENV = "WP318_MAX_AWAKE";
export const LIMIT_VAR = "CFO_MAX_AWAKE_COMPUTERS";

/**
 * The value to render for `n`, or null for "default" (the variable left out). Throws with
 * ControlDO's own message for a value it would refuse, so nothing is deployed.
 */
export function limitSetting(value: string): string | null {
  if (value === "default") return null;
  if (value === "") throw new Error(`${LIMIT_VAR} needs a value, or "default"`);
  const parsed = parseLimits({ [LIMIT_VAR]: value });
  if (!parsed.ok) throw new Error(parsed.problem);
  return String(parsed.limits.maxAwakeComputers);
}

/** The platform Worker's variables with the limit set, or left out for the default. */
export function withLimit(
  vars: Readonly<Record<string, unknown>>,
  limit: string | null,
): Record<string, unknown> {
  const { [LIMIT_VAR]: _old, ...rest } = vars;
  return limit === null ? rest : { ...rest, [LIMIT_VAR]: limit };
}

/** ControlDO's first `instance_started` on `version`, or null: the new limit holds from then. */
export function controlOnVersion(lines: readonly LogLine[], version: string): LogLine | null {
  return (
    [...lines]
      .sort((a, b) => a.timestamp - b.timestamp)
      .find((line) => {
        const s = sourceOf(line);
        return (
          line.version === version &&
          s?.cfo === "control" &&
          s.event === "instance_started" &&
          s.class === "ControlDO"
        );
      }) ?? null
  );
}

function main(argv: readonly string[]): number {
  const [verb, value] = argv;
  if (verb === "check" && value !== undefined) {
    try {
      const limit = limitSetting(value);
      console.log(JSON.stringify({ [LIMIT_VAR]: limit ?? "(unset: the default, 2)" }));
      return 0;
    } catch (error) {
      console.error(`run.sh: ${(error as Error).message}`);
      return 2;
    }
  }
  if (verb === "applied" && value !== undefined) {
    const lines = readFileSync(0, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogLine);
    const found = controlOnVersion(lines, value);
    console.log(
      JSON.stringify(
        found === null ? { applied: false } : { applied: true, at: new Date(found.timestamp) },
      ),
    );
    return found === null ? 3 : 0;
  }
  console.error("limit.ts check <n | default> | applied <version>");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
