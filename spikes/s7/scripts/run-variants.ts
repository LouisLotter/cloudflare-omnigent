// Runs the variant matrix and writes raw results under spikes/s7/results/.
//
//   node spikes/s7/scripts/run-variants.ts direct  <label>   # control: straight to Omnigent
//   node spikes/s7/scripts/run-variants.ts guarded <label>   # through both Worker entry points
//   node spikes/s7/scripts/run-variants.ts down    <label>   # guarded, while the server is down
//   add --base-path to run the base-path variants instead
//
// "direct" resets the override files before each variant and records whether the variant reached
// Omnigent's write handler: an override file appeared or the settings moved. "guarded" sends
// every variant through the browser entry (cookie) and the computer entry (bearer token), and
// checks after each one that no override file exists and the settings are still the managed ones.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BROWSER_PORT,
  COMPUTER_PORT,
  type Credentials,
  directState,
  isManagedState,
  login,
  overrideFiles,
  type RawResponse,
  RESULTS_DIR,
  rawRequest,
  resetOverrides,
  SERVER_PORT,
  serverLogLines,
} from "./lib.ts";
import { BASE_PATH_VARIANTS, VARIANTS, type Variant } from "./variants.ts";

const EDITABLE_KEYS = [
  "editable",
  "public_sharing_editable",
  "public_sharing_max_level_editable",
  "default_public_sessions_editable",
];

interface Row {
  readonly id: string;
  readonly group: string;
  readonly description: string;
  readonly entry: "direct" | "browser" | "computer";
  readonly expect: string;
  readonly status: number;
  readonly guard: string;
  readonly reachedHandler: boolean;
  readonly overrideFiles: string[];
  readonly settingsManaged: boolean | null;
  readonly editableFlags: string | null;
  readonly bodySnippet: string;
  readonly pass: boolean;
  readonly note: string;
}

function snippet(response: RawResponse): string {
  return response.body.replace(/\s+/g, " ").slice(0, 160);
}

function editableFlags(response: RawResponse): string | null {
  if (!(response.headers["content-type"] ?? "").includes("json")) return null;
  try {
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    if (!("sharing_mode" in parsed)) return null;
    return EDITABLE_KEYS.map((k) => `${k}=${String(parsed[k])}`).join(" ");
  } catch {
    return "unparseable";
  }
}

function judge(
  variant: Variant,
  response: RawResponse,
  wrote: boolean,
  managed: boolean | null,
  serverUp: boolean,
) {
  const guard = response.headers["x-s7-guard"] ?? "";
  if (wrote || managed === false) return { pass: false, note: "WRITE REACHED OMNIGENT" };
  if (!serverUp && variant.expect !== "refuse") {
    // Server down: anything the guard lets through can only fail upstream.
    return {
      pass: guard === "upstream-error" || response.status >= 500,
      note: `server down, guard=${guard || "none"}, status ${response.status}`,
    };
  }
  switch (variant.expect) {
    case "refuse": {
      // Refused by the guard, or rejected by the local HTTP stack before reaching the Worker.
      const refusedByGuard = guard === "refused" && response.status === 403;
      // Locally, Wrangler's dev proxy answers 501 to methods it does not know and 500 to an
      // absolute-form target it cannot parse; the Worker never sees those requests.
      const rejectedEarlier = guard === "" && [0, 400, 405, 500, 501].includes(response.status);
      return {
        pass: refusedByGuard || rejectedEarlier,
        note: refusedByGuard
          ? "refused by guard"
          : rejectedEarlier
            ? `rejected before the Worker (status ${response.status})`
            : `not refused (guard=${guard || "none"})`,
      };
    }
    case "rewrite": {
      const flags = editableFlags(response);
      if (response.status === 200 && flags !== null) {
        const allFalse = !flags.includes("=true") && !flags.includes("=undefined");
        return {
          pass: guard === "rewritten" && allFalse,
          note: allFalse ? "rewritten as managed" : "an editable flag is not false",
        };
      }
      if (response.status === 200 && variant.build(["X", "y"], 0).line.startsWith("HEAD")) {
        return { pass: guard === "rewritten", note: "HEAD, no body" };
      }
      return {
        pass: guard === "managed-passthrough",
        note: `not rewritable, passed through: upstream ${response.status}`,
      };
    }
    case "forward":
      return { pass: guard === "forwarded", note: `forwarded, upstream ${response.status}` };
  }
}

async function runDirect(variants: readonly Variant[], creds: Credentials): Promise<Row[]> {
  const rows: Row[] = [];
  for (const variant of variants) {
    resetOverrides();
    const request = variant.build(["Authorization", creds.bearer], SERVER_PORT);
    const response = await rawRequest(SERVER_PORT, request);
    const files = overrideFiles();
    const state = await directState(creds);
    const managed = isManagedState(state);
    rows.push({
      id: variant.id,
      group: variant.group,
      description: variant.description,
      entry: "direct",
      expect: variant.expect,
      status: response.status,
      guard: "",
      reachedHandler: files.length > 0 || !managed,
      overrideFiles: files,
      settingsManaged: managed,
      editableFlags: editableFlags(response),
      bodySnippet: snippet(response),
      pass: true,
      note: files.length > 0 || !managed ? "reached the write handler" : "no write",
    });
  }
  resetOverrides();
  return rows;
}

async function runGuarded(
  variants: readonly Variant[],
  creds: Credentials,
  serverUp: boolean,
): Promise<Row[]> {
  const rows: Row[] = [];
  const entries = [
    { entry: "browser" as const, port: BROWSER_PORT, auth: ["Cookie", creds.cookie] as const },
    {
      entry: "computer" as const,
      port: COMPUTER_PORT,
      auth: ["Authorization", creds.bearer] as const,
    },
  ];
  for (const variant of variants) {
    for (const { entry, port, auth } of entries) {
      const response = await rawRequest(port, variant.build(auth, port));
      const files = serverUp ? overrideFiles() : [];
      const managed = serverUp ? isManagedState(await directState(creds)) : null;
      const wrote = files.length > 0;
      const verdict = judge(variant, response, wrote, managed, serverUp);
      rows.push({
        id: variant.id,
        group: variant.group,
        description: variant.description,
        entry,
        expect: variant.expect,
        status: response.status,
        guard: response.headers["x-s7-guard"] ?? "",
        reachedHandler: wrote || managed === false,
        overrideFiles: files,
        settingsManaged: managed,
        editableFlags: editableFlags(response),
        bodySnippet: snippet(response),
        pass: verdict.pass,
        note: verdict.note,
      });
      if (wrote) resetOverrides();
    }
  }
  return rows;
}

function markdown(label: string, rows: Row[]): string {
  const lines = [
    `# Variant results: ${label}`,
    "",
    `Generated ${new Date().toISOString()}. Pass ${rows.filter((r) => r.pass).length} of ${rows.length}.`,
    "",
    "| ID | Group | Variant | Entry | Expect | Status | Guard | Reached handler | Settings managed | Editable flags | Result | Note |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.id} | ${r.group} | ${r.description.replaceAll("|", "\\|")} | ${r.entry} | ${r.expect} | ${r.status} | ${r.guard || "-"} | ${r.reachedHandler ? "yes" : "no"} | ${r.settingsManaged === null ? "n/a" : r.settingsManaged ? "yes" : "no"} | ${r.editableFlags ?? "-"} | ${r.pass ? "pass" : "FAIL"} | ${r.note} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const [mode, label, ...flags] = process.argv.slice(2);
  if (!mode || !label) throw new Error("usage: run-variants.ts direct|guarded|down <label>");
  const variants = flags.includes("--base-path") ? BASE_PATH_VARIANTS : VARIANTS;
  const started = new Date();
  // Logging in needs the server; while it is down, reuse the last saved credentials.
  const creds =
    mode === "down"
      ? (JSON.parse(
          (await import("node:fs")).readFileSync(
            join(RESULTS_DIR, "..", ".run", "creds.json"),
            "utf8",
          ),
        ) as Credentials)
      : await login();
  if (mode !== "down") {
    writeFileSync(join(RESULTS_DIR, "..", ".run", "creds.json"), JSON.stringify(creds), {
      mode: 0o600,
    });
  }
  let rows: Row[];
  let preconditions = "";
  if (mode === "direct") {
    rows = await runDirect(variants, creds);
  } else {
    if (mode === "guarded") {
      const files = overrideFiles();
      const state = await directState(creds);
      preconditions = `before: override files [${files.join(", ")}], settings managed: ${isManagedState(state)}`;
      if (files.length > 0 || !isManagedState(state)) {
        throw new Error(`precondition failed, ${preconditions}`);
      }
    }
    rows = await runGuarded(variants, creds, mode === "guarded");
  }
  const logLines =
    mode === "down"
      ? []
      : serverLogLines(started.toISOString()).map((l) => l.replace(/^.*INFO:\s+/, ""));
  const out = {
    label,
    mode,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    preconditions,
    passed: rows.filter((r) => r.pass).length,
    total: rows.length,
    rows,
    serverAccessLogSharingLines: logLines,
  };
  writeFileSync(join(RESULTS_DIR, `variants-${label}.json`), `${JSON.stringify(out, null, 2)}\n`);
  writeFileSync(
    join(RESULTS_DIR, `variants-${label}.md`),
    `${markdown(label, rows)}\n## Omnigent access-log lines mentioning sharing during the run\n\n${
      logLines.length === 0 ? "none\n" : `\`\`\`\n${logLines.join("\n")}\n\`\`\`\n`
    }`,
  );
  console.log(
    `${label}: ${out.passed}/${out.total} pass; ${logLines.length} sharing lines in server log`,
  );
  for (const r of rows.filter((x) => !x.pass)) {
    console.log(`  FAIL ${r.id} ${r.entry} ${r.status} ${r.guard} ${r.note}`);
  }
  if (mode !== "direct" && out.passed !== out.total) process.exitCode = 1;
}

await main();
