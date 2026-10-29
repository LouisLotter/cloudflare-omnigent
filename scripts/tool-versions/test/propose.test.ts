// Proposing a bump (WP3.37) with real git against a bare "origin" made for the test, and a
// fake gh that keeps pull requests and CI runs: one branch, one pull request, rebuilt from main
// on each new bump, never rewritten or deleted over a person's commit, every step safe to
// repeat after a failure, and a fork's same-named branch ignored.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyBump, title } from "../apply.ts";
import { type Bump, COMPUTER, SERVER } from "../pins.ts";
import { BOT, bumpId, marker, propose, type Runner, TRAILER } from "../propose.ts";
import { computerDockerfile, serverDockerfile } from "./world.ts";

let dir: string;
let origin: string;
let work: string;
const BRANCH = "automation/tool-versions";

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

interface FakePr {
  number: number;
  url: string;
  body: string;
  state: "open" | "closed";
  mergedAt: string | null;
  isCrossRepository: boolean;
}

/** The fake gh: pull requests, dispatched CI runs by commit, and every call it got. */
class FakeGh {
  prs: FakePr[] = [];
  runs: string[] = [];
  calls: string[][] = [];
  fail: Record<string, string> = {};
  run(args: readonly string[]) {
    this.calls.push([...args]);
    const key = `${args[0]} ${args[1]}`;
    const failure = this.fail[key];
    if (failure !== undefined) {
      delete this.fail[key];
      return { status: 1, stdout: "", stderr: failure };
    }
    const flag = (name: string) => args[args.indexOf(name) + 1] as string;
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (key === "pr list") {
      return ok(JSON.stringify(this.prs.filter((p) => p.state === flag("--state"))));
    }
    if (key === "pr create") {
      const number = 7 + this.prs.length;
      const pr: FakePr = {
        number,
        url: `https://github.com/o/r/pull/${number}`,
        body: readFileSync(flag("--body-file"), "utf8"),
        state: "open",
        mergedAt: null,
        isCrossRepository: false,
      };
      this.prs.push(pr);
      return ok(`${pr.url}\n`);
    }
    const pr = this.prs.find((p) => p.number === Number(args[2]));
    if (key === "pr edit" && pr) pr.body = readFileSync(flag("--body-file"), "utf8");
    if (key === "pr close" && pr) pr.state = "closed";
    if (key === "run list") {
      return ok(JSON.stringify(this.runs.includes(flag("--commit")) ? [{ databaseId: 1 }] : []));
    }
    if (key === "workflow run") {
      this.runs.push(git(origin, "rev-parse", `refs/heads/${flag("--ref")}`));
    }
    return ok();
  }
  open() {
    return this.prs.filter((p) => p.state === "open" && !p.isCrossRepository);
  }
}

let gh: FakeGh;
/** Runs just before the first git command with an argument containing `match` (a race). */
let before: { match: string; act: () => void } | undefined;
const runner: Runner = (command, args) => {
  if (command === "gh") return gh.run(args);
  const race = before;
  if (race && args.some((a) => a.includes(race.match))) {
    before = undefined;
    race.act();
  }
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
  before = undefined;
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
const CURRENT: Bump = { ...bumpFor("0.164.0"), changes: [], args: {} };

const input = (bump: Bump, changed: string[]) => ({
  bump,
  files: changed,
  title: title(bump),
  body: "body",
  bodyFile: join(dir, "body.md"),
  branch: BRANCH,
  base: "main",
  ciWorkflow: "ci.yml",
});

/** A fresh checkout of main with the bump written in, as the workflow's propose step has it. */
function checkout(bump: Bump): string[] {
  git(work, "fetch", "-q", "origin");
  git(work, "checkout", "-q", "--detach", "origin/main");
  git(work, "reset", "-q", "--hard", "origin/main");
  return bump.changes.length === 0 ? [] : applyBump(work, bump, files);
}

/** One run of the workflow's propose step. */
function run(bump: Bump) {
  return propose(runner, input(bump, checkout(bump)));
}

function branchHead(): string | undefined {
  const r = spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${BRANCH}`], {
    cwd: origin,
    encoding: "utf8",
    env: env(),
  });
  return r.status === 0 ? r.stdout.trim() : undefined;
}
const calls = () => gh.calls.map((c) => c.slice(0, 2).join(" "));

/** A person's commit pushed on top of the branch, from their own clone. */
let people = 0;
function personPushes() {
  people += 1;
  const clone = join(dir, `person-${people}`);
  git(dir, "clone", "-q", "-b", BRANCH, origin, clone);
  writeFileSync(join(clone, "fix.txt"), "a fix\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "fix the tests for the new Codex");
  git(clone, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
}

describe("propose", () => {
  it("opens one pull request from a bot commit on the branch, then dispatches CI", () => {
    expect(run(bumpFor("0.165.0"))).toEqual({
      kind: "created",
      pr: "https://github.com/o/r/pull/7",
      ci: true,
    });
    const head = branchHead() as string;
    expect(git(origin, "log", "-1", "--format=%an <%ae>", head)).toBe(`${BOT.name} <${BOT.email}>`);
    expect(git(origin, "log", "-1", `--format=%(trailers:key=${TRAILER},valueonly)`, head)).toBe(
      bumpId(bumpFor("0.165.0")),
    );
    expect(git(origin, "diff", "--name-only", "main", head)).toBe(COMPUTER);
    expect(gh.prs[0]?.body).toBe(`body\n\n${marker(bumpId(bumpFor("0.165.0")))}\n`);
    expect(calls()).toEqual(["pr list", "pr list", "pr create", "workflow run"]);
    expect(gh.runs).toEqual([head]);
  });

  it("pushes nothing and starts no CI again when the same bump is already proposed", () => {
    run(bumpFor("0.165.0"));
    const head = branchHead();
    gh.calls = [];
    expect(run(bumpFor("0.165.0"))).toEqual({
      kind: "unchanged",
      pr: "https://github.com/o/r/pull/7",
      ci: false,
    });
    expect(branchHead()).toBe(head);
    expect(calls()).toEqual(["pr list", "run list"]);
  });

  it("dispatches CI on the next run when the dispatch failed", () => {
    gh.fail["workflow run"] = "HTTP 500";
    expect(() => run(bumpFor("0.165.0"))).toThrow(/workflow run .* failed/);
    expect(gh.open()).toHaveLength(1);
    expect(run(bumpFor("0.165.0"))).toMatchObject({ kind: "unchanged", ci: true });
    expect(gh.runs).toEqual([branchHead()]);
  });

  it("opens the pull request on the next run when opening it failed", () => {
    gh.fail["pr create"] =
      "pull request create failed: GitHub Actions is not permitted to create or approve pull requests";
    expect(() => run(bumpFor("0.165.0"))).toThrow(/can_approve_pull_request_reviews=true/);
    const head = branchHead();
    expect(head).toBeDefined();
    expect(run(bumpFor("0.165.0"))).toMatchObject({ kind: "created", ci: true });
    expect(branchHead()).toBe(head);
    expect(gh.runs).toEqual([head]);
  });

  it("rebuilds the branch from main for a newer bump and updates the same pull request", () => {
    run(bumpFor("0.165.0"));
    gh.calls = [];
    expect(run(bumpFor("0.166.0"))).toEqual({
      kind: "updated",
      pr: "https://github.com/o/r/pull/7",
      ci: true,
    });
    expect(git(origin, "rev-list", "--count", `main..${BRANCH}`)).toBe("1");
    expect(calls()).toEqual(["pr list", "pr edit", "workflow run"]);
    expect(gh.calls[1]).toContain("7");
    expect(gh.prs[0]?.body).toContain(marker(bumpId(bumpFor("0.166.0"))));
  });

  it("never lets a pull request's body name an older bump than its branch holds", () => {
    run(bumpFor("0.165.0"));
    // The edit fails: nothing is pushed, and the next run does both.
    gh.fail["pr edit"] = "HTTP 502";
    const head = branchHead();
    expect(() => run(bumpFor("0.166.0"))).toThrow(/pr edit .* failed/);
    expect(branchHead()).toBe(head);
    expect(run(bumpFor("0.166.0"))).toMatchObject({ kind: "updated" });
    expect(gh.prs[0]?.body).toContain(marker(bumpId(bumpFor("0.166.0"))));
    // The push fails after the edit: the body already names the new bump, so closing the pull
    // request then declines the bump it describes.
    before = { match: "HEAD:refs/heads/", act: personPushes };
    expect(() => run(bumpFor("0.167.0"))).toThrow(/git push .* failed/);
    expect(gh.prs[0]?.body).toContain(marker(bumpId(bumpFor("0.167.0"))));
  });

  it("puts right an open pull request whose body names another bump", () => {
    run(bumpFor("0.165.0"));
    (gh.prs[0] as FakePr).body = "an older body";
    expect(run(bumpFor("0.165.0"))).toMatchObject({ kind: "unchanged" });
    expect(gh.prs[0]?.body).toContain(marker(bumpId(bumpFor("0.165.0"))));
  });

  it("does not reopen a bump the owner closed unmerged, even with its branch deleted", () => {
    run(bumpFor("0.165.0"));
    (gh.prs[0] as FakePr).state = "closed";
    expect(run(bumpFor("0.165.0"))).toEqual({ kind: "declined" });
    git(origin, "update-ref", "-d", `refs/heads/${BRANCH}`);
    expect(run(bumpFor("0.165.0"))).toEqual({ kind: "declined" });
    expect(branchHead()).toBeUndefined();
    expect(run(bumpFor("0.166.0"))).toMatchObject({ kind: "created" });
  });

  it("never rewrites a branch holding a person's commit, nor closes its pull request", () => {
    run(bumpFor("0.165.0"));
    personPushes();
    const head = branchHead();
    expect(run(bumpFor("0.166.0")).kind).toBe("held");
    expect(branchHead()).toBe(head);
    expect(run(CURRENT).kind).toBe("held");
    expect(gh.calls.some((c) => c[1] === "close")).toBe(false);
  });

  it("closes the open pull request and deletes the branch once main pins everything", () => {
    run(bumpFor("0.165.0"));
    expect(run(CURRENT)).toEqual({ kind: "closed", pr: "https://github.com/o/r/pull/7" });
    expect(gh.calls.at(-1)?.slice(0, 3)).toEqual(["pr", "close", "7"]);
    expect(branchHead()).toBeUndefined();
  });

  it("keeps a commit pushed between the inspection and the branch's deletion", () => {
    run(bumpFor("0.165.0"));
    before = { match: `:refs/heads/${BRANCH}`, act: personPushes };
    expect(() => run(CURRENT)).toThrow(/git push .* failed/);
    expect(git(origin, "log", "-1", "--format=%s", `refs/heads/${BRANCH}`)).toBe(
      "fix the tests for the new Codex",
    );
  });

  it("does nothing when everything is current and no pull request is open", () => {
    expect(run(CURRENT)).toEqual({ kind: "nothing" });
    expect(calls()).toEqual(["pr list"]);
  });

  it("ignores a fork's pull request from a branch with the same name", () => {
    gh.prs.push({
      number: 3,
      url: "https://github.com/o/r/pull/3",
      body: "a fork's",
      state: "open",
      mergedAt: null,
      isCrossRepository: true,
    });
    expect(run(CURRENT)).toEqual({ kind: "nothing" });
    expect(run(bumpFor("0.165.0"))).toMatchObject({ kind: "created" });
    expect(gh.prs.find((p) => p.number === 3)?.body).toBe("a fork's");
    expect(gh.calls.some((c) => c[1] === "edit" || c[1] === "close")).toBe(false);
  });

  it("refuses files other than the Dockerfiles, and changes the bump did not make", () => {
    const bump = bumpFor("0.165.0");
    expect(() => propose(runner, input(bump, [".github/workflows/ci.yml"]))).toThrow(
      /refusing to commit/,
    );
    expect(() => propose(runner, input(bump, []))).toThrow(/must change a Dockerfile/);
    writeFileSync(join(work, SERVER), `${serverDockerfile()}# stray\n`);
    expect(() => propose(runner, input(bump, [COMPUTER]))).toThrow(/not the bump's/);
  });

  it("reports any other failed command", () => {
    const failing: Runner = (command, args) =>
      command === "git" && args[0] === "status"
        ? { status: 128, stdout: "", stderr: "not a git repository" }
        : runner(command, args);
    expect(() => propose(failing, input(CURRENT, []))).toThrow(
      /git status .* failed \(128\): not a git repository/,
    );
  });

  it.each([
    ["pr list", '[{"number":"7"}]', /unexpected answer/],
    ["pr list", "{}", /gh pr list: not a list/],
    ["run list", "{}", /gh run list: not a list/],
  ])("refuses an unexpected answer from gh %s", (which, stdout, error) => {
    run(bumpFor("0.165.0"));
    const odd: Runner = (command, args) =>
      command === "gh" && `${args[0]} ${args[1]}` === which
        ? { status: 0, stdout, stderr: "" }
        : runner(command, args);
    const bump = bumpFor("0.165.0");
    expect(() => propose(odd, input(bump, checkout(bump)))).toThrow(error);
  });
});
