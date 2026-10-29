// `run.sh limit <n>` (WP3.33, the G3 sitting's step B6): the staging installation's limit of awake
// computers, `CFO_MAX_AWAKE_COMPUTERS`, set through the guarded staging tool and nothing else.
// Laptop only, test tooling.
//
// The limit is a platform Worker variable that the bootstrap does not render (the default is 2).
// run.sh keeps the lead's value in $WP318_DIR/limit and passes it to soak-config.ts as
// WP318_MAX_AWAKE, so that every platform deploy of the sitting renders it (soakPlatformConfig),
// and deploys the platform Worker once through the staging tool. It is not a `SERVER_ENV_`
// variable, so the server's configuration and image are unchanged: no `config_changed` restart.
// ControlDO reads it from its environment, so it holds once ControlDO answers with it: run.sh
// asks with the soak module's read-only `limits` command until it does.
//
//   node worker/test/staging/wp318/limit.ts check <n | default>
//       ControlDO's own rule (parseLimits): prints the setting, exit 2 if ControlDO would refuse it
//   node worker/test/staging/wp318/limit.ts holds <n | default> < <a `limits` command's outcome>
//       exit 0 if ControlDO answered with that limit, 3 if not (yet)

import { readFileSync } from "node:fs";
import { DEFAULT_LIMITS, parseLimits } from "../../../src/control/limits.ts";

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

/** Whether a `limits` command's outcome shows ControlDO answering with the lead's limit. */
export function limitHolds(outcome: unknown, value: string): boolean {
  const limit = limitSetting(value);
  const expected = limit === null ? DEFAULT_LIMITS.maxAwakeComputers : Number(limit);
  const o = outcome as { outcome?: unknown; command?: unknown; detail?: unknown } | null;
  const detail = o?.detail as { maxAwakeComputers?: unknown } | null | undefined;
  return o?.outcome === "ok" && o.command === "limits" && detail?.maxAwakeComputers === expected;
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
  if (verb === "holds" && value !== undefined) {
    let outcome: unknown = null;
    try {
      outcome = JSON.parse(readFileSync(0, "utf8")) as unknown;
    } catch {
      // no outcome
    }
    const holds = limitHolds(outcome, value);
    console.log(JSON.stringify({ holds }));
    return holds ? 0 : 3;
  }
  console.error("limit.ts check <n | default> | holds <n | default>");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
