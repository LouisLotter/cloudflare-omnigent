// Proposing a bump (WP3.37) with real git against a bare "origin" made for the test, and a
// fake gh that records its calls: one branch, one pull request, rebuilt from main on each new
// bump, never rewritten over a person's commit, and CI dispatched only after a push.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyBump, title } from "../apply.ts";
import { type Bump, COMPUTER, SERVER } from "../pins.ts";
import { BOT, bumpId, propose, type Runner, TRAILER } from "../propose.ts";
import { computerDockerfile, serverDockerfile } from "./world.ts";

let dir: string;
let origin: string;
let work: string;

function env() {
  return {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
  };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: env() });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

/** The fake gh: an open pull request (or none), and every call it got. */
class FakeGh {
  open: { number: number; url: string } | undefined;
  calls: string[][] = [];
  createError: string | undefined;
  run(args: readonly string[]) {
    this.calls.push([...args]);
    const [a, b] = args;
    if (a === "pr" && b === "list") {
      return { status: 0, stdout: JSON.stringify(this.open ? [this.open] : []), stderr: "" };
    }
    if (a === "pr" && b === "create") {
      if (this.createError) return { status: 1, stdout: "", stderr: this.createError };
      this.open = { number: 7, url: "https://github.com/o/r/pull/7" };
      return { status: 0, stdout: `${this.open.url}\n`, stderr: "" };
    }
    if (a === "pr" && b === "close") this.open = undefined;
    return { status: 0, stdout: "", stderr: "" };
  }
}

let gh: FakeGh;
const runner: Runner = (command, args) => {
  if (command === "gh") return gh.run(args);
  const r = spawnSync(command, args, { cwd: work, encoding: "utf8", env: env() });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfo-tool-versions-propose-"));
  writeFileSync(
    join(dir, "gitconfig"),
    "[user]\n\tname = cfo-test\n\temail = cfo-test@example.test\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n",
  );
  origin = join(dir, "origin.git");
  work = join(dir, "work");
  git(dir, "init", "-q", "--bare", origin);
  git(dir, "clone", "-q", origin, work);
  mkdirSync(join(work, "images/computer"), { recursive: true });
  mkdirSync(join(work, "images/server"), { recursive: true });
  writeFileSync(join(work, COMPUTER), computerDockerfile());
  writeFileSync(join(work, SERVER), serverDockerfile());
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "main");
  git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
  gh = new FakeGh();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const files = {
  read: (p: string) => readFileSync(p, "utf8"),
  write: (p: string, t: string) => writeFileSync(p, t),
  rename: renameSync,
  remove: (p: string) => rmSync(p, { force: true }),
};

function bumpFor(version: string): Bump {
  return {
    schema: 1,
    changes: [{ tool: "codex", from: "0.164.0", to: version, link: "https://github.com/x" }],
    args: { CODEX_VERSION: version },
    warnings: [],
  };
}

/** One run of the workflow's propose step on a fresh checkout of main. */
function run(bump: Bump) {
  git(work, "checkout", "-q", "--detach", "origin/main");
  git(work, "fetch", "-q", "origin");
  git(work, "reset", "-q", "--hard", "origin/main");
  const changed = bump.changes.length === 0 ? [] : applyBump(work, bump, files);
  writeFileSync(join(dir, "body.md"), "body\n");
  return propose(runner, {
    bump,
    files: changed,
    title: title(bump),
    bodyFile: join(dir, "body.md"),
    branch: "automation/tool-versions",
    base: "main",
    ciWorkflow: "ci.yml",
  });
}

const branchHead = () => git(origin, "rev-parse", "refs/heads/automation/tool-versions");

describe("propose", () => {
  it("opens one pull request from a bot commit on the branch, then dispatches CI", () => {
    expect(run(bumpFor("0.165.0"))).toEqual({
      kind: "created",
      pr: "https://github.com/o/r/pull/7",
    });
    const head = branchHead();
    expect(git(origin, "log", "-1", "--format=%an <%ae>", head)).toBe(`${BOT.name} <${BOT.email}>`);
    expect(git(origin, "log", "-1", `--format=%(trailers:key=${TRAILER},valueonly)`, head)).toBe(
      bumpId(bumpFor("0.165.0")),
    );
    expect(git(origin, "diff", "--name-only", "main", head)).toBe(COMPUTER);
    expect(gh.calls.map((c) => c.slice(0, 2).join(" "))).toEqual([
      "pr list",
      "pr create",
      "workflow run",
    ]);
    expect(gh.calls.at(-1)).toEqual([
      "workflow",
      "run",
      "ci.yml",
      "--ref",
      "automation/tool-versions",
    ]);
  });

  it("pushes nothing and starts no CI when the same bump is already proposed", () => {
    run(bumpFor("0.165.0"));
    const head = branchHead();
    gh.calls = [];
    expect(run(bumpFor("0.165.0"))).toEqual({
      kind: "unchanged",
      pr: "https://github.com/o/r/pull/7",
    });
    expect(branchHead()).toBe(head);
    expect(gh.calls.map((c) => c[1])).toEqual(["list"]);
  });

  it("rebuilds the branch from main for a newer bump and updates the same pull request", () => {
    run(bumpFor("0.165.0"));
    gh.calls = [];
    expect(run(bumpFor("0.166.0"))).toEqual({
      kind: "updated",
      pr: "https://github.com/o/r/pull/7",
    });
    expect(git(origin, "rev-list", "--count", "main..automation/tool-versions")).toBe("1");
    expect(gh.calls.map((c) => c.slice(0, 2).join(" "))).toEqual([
      "pr list",
      "pr edit",
      "workflow run",
    ]);
    expect(gh.calls[1]).toContain("7");
  });

  it("does not reopen a bump the owner closed unmerged, until it changes", () => {
    run(bumpFor("0.165.0"));
    gh.open = undefined;
    expect(run(bumpFor("0.165.0"))).toEqual({ kind: "declined" });
    expect(run(bumpFor("0.166.0")).kind).toBe("created");
  });

  it("never rewrites a branch holding a person's commit", () => {
    run(bumpFor("0.165.0"));
    const clone = join(dir, "person");
    git(dir, "clone", "-q", "-b", "automation/tool-versions", origin, clone);
    writeFileSync(join(clone, "fix.txt"), "a fix\n");
    git(clone, "add", ".");
    git(clone, "commit", "-q", "-m", "fix the tests for the new Codex");
    git(clone, "push", "-q", "origin", "HEAD:refs/heads/automation/tool-versions");
    const head = branchHead();
    const outcome = run(bumpFor("0.166.0"));
    expect(outcome.kind).toBe("held");
    expect(branchHead()).toBe(head);
    // Nor is its pull request closed when main catches up.
    expect(run({ ...bumpFor("0.166.0"), changes: [], args: {} }).kind).toBe("held");
    expect(gh.calls.some((c) => c[1] === "close")).toBe(false);
  });

  it("closes the open pull request once main pins everything", () => {
    run(bumpFor("0.165.0"));
    expect(run({ ...bumpFor("0.165.0"), changes: [], args: {} })).toEqual({
      kind: "closed",
      pr: "https://github.com/o/r/pull/7",
    });
    expect(gh.calls.at(-1)?.slice(0, 3)).toEqual(["pr", "close", "7"]);
    expect(gh.calls.at(-1)).toContain("--delete-branch");
  });

  it("does nothing when everything is current and no pull request is open", () => {
    expect(run({ ...bumpFor("0.165.0"), changes: [], args: {} })).toEqual({ kind: "nothing" });
    expect(gh.calls.map((c) => c[1])).toEqual(["list"]);
  });

  it("refuses files other than the Dockerfiles, and changes the bump did not make", () => {
    const input = {
      bump: bumpFor("0.165.0"),
      title: "t",
      bodyFile: "b",
      branch: "automation/tool-versions",
      base: "main",
      ciWorkflow: "ci.yml",
    };
    expect(() => propose(runner, { ...input, files: [".github/workflows/ci.yml"] })).toThrow(
      /refusing to commit/,
    );
    expect(() => propose(runner, { ...input, files: [] })).toThrow(/must change a Dockerfile/);
    writeFileSync(join(work, SERVER), `${serverDockerfile()}# stray\n`);
    expect(() => propose(runner, { ...input, files: [COMPUTER] })).toThrow(/not the bump's/);
  });

  it("says how to allow pull requests from Actions when GitHub refuses one", () => {
    gh.createError =
      "pull request create failed: GitHub Actions is not permitted to create or approve pull requests";
    expect(() => run(bumpFor("0.165.0"))).toThrow(/can_approve_pull_request_reviews=true/);
  });

  it("reports any other failed command", () => {
    const failing: Runner = (command, args) =>
      command === "git" && args[0] === "status"
        ? { status: 128, stdout: "", stderr: "not a git repository" }
        : runner(command, args);
    expect(() =>
      propose(failing, {
        bump: { ...bumpFor("0.165.0"), changes: [], args: {} },
        files: [],
        title: "t",
        bodyFile: "b",
        branch: "x",
        base: "main",
        ciWorkflow: "ci.yml",
      }),
    ).toThrow(/git status .* failed \(128\): not a git repository/);
  });

  it("refuses an unexpected answer from gh pr list", () => {
    const odd: Runner = (command, args) =>
      command === "gh"
        ? { status: 0, stdout: '[{"number":"7"}]', stderr: "" }
        : runner(command, args);
    const input = {
      bump: { ...bumpFor("0.165.0"), changes: [], args: {} },
      files: [],
      title: "t",
      bodyFile: "b",
      branch: "x",
      base: "main",
      ciWorkflow: "ci.yml",
    };
    expect(() => propose(odd, input)).toThrow(/unexpected answer/);
    const notList: Runner = (command, args) =>
      command === "gh" ? { status: 0, stdout: "{}", stderr: "" } : runner(command, args);
    expect(() => propose(notList, input)).toThrow(/not a list/);
  });
});
