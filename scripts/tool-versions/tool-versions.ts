// The daily tool version check's command (WP3.37); .github/workflows/tool-versions.yml runs it.
// Node 26 runs it as it is (built-in TypeScript); it needs no installed dependencies.
//
//   node scripts/tool-versions/tool-versions.ts check [--out FILE]
//       Finds newer releases of the pinned tools and computes their pins (check.ts). Writes the
//       bump (JSON) to FILE, or prints it. Changes no file of the repository. Needs Docker, for
//       the CLIs' tree digests, only when Claude Code, Codex or a base image changes.
//   node scripts/tool-versions/tool-versions.ts check --reproduce
//       Recomputes every current pin the same way, and fails unless each comes out as committed.
//   node scripts/tool-versions/tool-versions.ts apply FILE
//       Writes the bump in FILE into both Dockerfiles (all or nothing) and prints the title.
//   node scripts/tool-versions/tool-versions.ts propose FILE [--branch B] [--base main]
//       apply, then commit, push and open or update the one pull request, and dispatch CI on
//       its branch (propose.ts). Needs GH_TOKEN for gh, and git push access.
//
// GITHUB_TOKEN, when set, is sent to api.github.com only (its rate limit). Exit status: 0 done,
// 1 an error or a refusal, 2 a usage error.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { applyBump, body, type Files, title } from "./apply.ts";
import { type CliRecord, checkTools, parseCliRecord } from "./check.ts";
import { COMPUTER, parseBump, SERVER, type Texts } from "./pins.ts";
import { propose } from "./propose.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");

const realFiles: Files = {
  read: (path) => readFileSync(path, "utf8"),
  write: (path, text) => writeFileSync(path, text),
  rename: renameSync,
  remove: (path) => rmSync(path, { force: true }),
};

function log(message: string): void {
  console.error(`tool-versions: ${message}`);
}

function summary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

/** Builds the computer Dockerfile's cli-digests stage and reads what it recorded. */
async function recordCliDigests(args: Readonly<Record<string, string>>): Promise<CliRecord> {
  const out = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "cfo-cli-digests-"));
  try {
    const build = spawnSync(
      "docker",
      [
        "build",
        "--progress=plain",
        "--platform",
        "linux/amd64",
        "-f",
        join(ROOT, COMPUTER),
        "--target",
        "cli-digests",
        // Always a fresh install and signature check, never a cached record.
        "--no-cache-filter",
        "cli-digests-record",
        ...Object.entries(args).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]),
        "--output",
        `type=local,dest=${out}`,
        ROOT,
      ],
      {
        stdio: ["ignore", "inherit", "inherit"],
        timeout: 30 * 60_000,
        // Docker never needs the GitHub token: keep it out of the build's process.
        env: Object.fromEntries(
          Object.entries(process.env).filter(([name]) => name !== "GITHUB_TOKEN"),
        ),
      },
    );
    if (build.status !== 0) throw new Error(`docker build --target cli-digests: ${build.status}`);
    return parseCliRecord(readFileSync(join(out, "cli-digests.env"), "utf8"), {
      claudeCode: args.CLAUDE_CODE_VERSION as string,
      codex: args.CODEX_VERSION as string,
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function texts(): Texts {
  return {
    [COMPUTER]: realFiles.read(join(ROOT, COMPUTER)),
    [SERVER]: realFiles.read(join(ROOT, SERVER)),
  } as Texts;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      reproduce: { type: "boolean", default: false },
      branch: { type: "string", default: "automation/tool-versions" },
      base: { type: "string", default: "main" },
      "body-file": { type: "string" },
    },
  });
  const [command, file] = positionals;
  if (command === "check" && file === undefined) {
    const githubToken = process.env.GITHUB_TOKEN;
    const bump = await checkTools(
      texts(),
      {
        fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(120_000) }),
        ...(githubToken ? { githubToken } : {}),
        recordCliDigests,
        log,
      },
      { reproduce: values.reproduce },
    );
    const json = `${JSON.stringify(bump, null, 2)}\n`;
    if (values.out) writeFileSync(values.out, json);
    else process.stdout.write(json);
    if (values.reproduce) {
      log("every pin reproduced exactly");
      summary("Every pin reproduced exactly.");
    } else if (bump.changes.length === 0) {
      log("every tool is current");
      summary("Every pinned tool is current.");
    } else {
      log(title(bump));
      summary(`### ${title(bump)}\n\n${body(bump)}`);
    }
    for (const w of bump.warnings) log(`warning: ${w}`);
    return 0;
  }
  if ((command === "apply" || command === "propose") && file !== undefined) {
    const bump = parseBump(JSON.parse(readFileSync(file, "utf8")) as unknown);
    const changed = bump.changes.length === 0 ? [] : applyBump(ROOT, bump, realFiles);
    if (command === "apply") {
      log(changed.length === 0 ? "nothing to apply" : `${title(bump)} (${changed.join(", ")})`);
      return 0;
    }
    const bodyFile =
      values["body-file"] ?? join(mkdtempSync(join(tmpdir(), "cfo-tool-versions-")), "body.md");
    const run = (cmd: string, args: readonly string[]) => {
      const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout: 5 * 60_000 });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    const outcome = propose(run, {
      bump,
      files: changed,
      title: title(bump),
      body: body(bump),
      bodyFile,
      branch: values.branch,
      base: values.base,
      ciWorkflow: "ci.yml",
    });
    const say: Record<typeof outcome.kind, string> = {
      nothing: "every tool is current; no pull request is open",
      created: "opened the pull request and started CI on its branch",
      updated: "updated the pull request and started CI on its branch",
      unchanged: "the open pull request already proposes exactly this",
      closed: "main already pins these versions; closed the pull request",
      declined: "the same bump was closed unmerged; not reopening it until a newer release",
      held: "the branch has commits the workflow did not make; left it as it is",
    };
    const where = "pr" in outcome ? ` (${outcome.pr})` : "";
    const ci = outcome.kind === "unchanged" && outcome.ci ? "; started CI, which had not run" : "";
    log(`${say[outcome.kind]}${where}${ci}`);
    summary(`${say[outcome.kind]}${where}${ci}`);
    if (outcome.kind === "held") {
      log(
        `commits: ${outcome.commits.join("; ")}. Merge or close the pull request, or delete the branch.`,
      );
      return 1;
    }
    return 0;
  }
  console.error(
    "usage: tool-versions.ts check [--out FILE] [--reproduce] | apply FILE | propose FILE [--branch B] [--base main]",
  );
  return 2;
}

main(process.argv.slice(2)).then(
  (status) => {
    process.exitCode = status;
  },
  (error: unknown) => {
    log(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
