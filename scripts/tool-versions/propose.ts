// Proposing a bump as one pull request on one branch (WP3.37), with git and gh.
//
// The branch is rebuilt from the checked-out main on every run that has something new, and
// force-pushed with a lease, so the pull request always shows main against the latest releases.
// It is never rewritten when it holds a commit the workflow did not make (a person's fix on top):
// the run stops and says so. An unchanged bump pushes nothing and starts no CI again; a bump
// the owner closed unmerged is not reopened until a newer release changes it. When main
// already has every pin, an open bump pull request is closed.
//
// CI: a push or pull request made with the workflow's GITHUB_TOKEN starts no `push` or
// `pull_request` run (only an approval-gated one). A `workflow_dispatch` event always starts a
// run, so after pushing, this dispatches CI on the branch; its checks attach to the branch's
// head commit, which is the pull request's.

import { createHash } from "node:crypto";
import { type Bump, DOCKERFILES } from "./pins.ts";

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export type Runner = (command: string, args: readonly string[]) => RunResult;

export const BOT = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
} as const;
export const TRAILER = "Tool-Versions-Bump";

export interface ProposeInput {
  readonly bump: Bump;
  /** The files `applyBump` changed in the working tree. */
  readonly files: readonly string[];
  readonly title: string;
  readonly bodyFile: string;
  readonly branch: string;
  readonly base: string;
  readonly ciWorkflow: string;
}

export type Outcome =
  | { readonly kind: "nothing" }
  | { readonly kind: "created" | "updated" | "unchanged" | "closed"; readonly pr: string }
  | { readonly kind: "declined" }
  | { readonly kind: "held"; readonly commits: readonly string[] };

/** A stable identity for a bump's content, kept in the commit as a trailer. */
export function bumpId(bump: Bump): string {
  const args = Object.fromEntries(Object.entries(bump.args).sort(([a], [b]) => (a < b ? -1 : 1)));
  return createHash("sha256")
    .update(JSON.stringify({ changes: bump.changes, args }))
    .digest("hex")
    .slice(0, 32);
}

function must(run: Runner, command: string, args: readonly string[]): string {
  const result = run(command, args);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    if (/not permitted to create or approve pull requests/i.test(detail)) {
      throw new Error(
        `${detail}\nAllow it once (repository admin): gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`,
      );
    }
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${detail}`);
  }
  return result.stdout;
}

interface OpenPr {
  readonly number: number;
  readonly url: string;
}

function openPr(run: Runner, input: ProposeInput): OpenPr | undefined {
  const out = must(run, "gh", [
    "pr",
    "list",
    "--head",
    input.branch,
    "--base",
    input.base,
    "--state",
    "open",
    "--json",
    "number,url",
    "--limit",
    "1",
  ]);
  const list = JSON.parse(out) as unknown;
  if (!Array.isArray(list)) throw new Error("gh pr list: not a list");
  const first = list[0] as { number?: unknown; url?: unknown } | undefined;
  if (first === undefined) return undefined;
  if (typeof first.number !== "number" || typeof first.url !== "string") {
    throw new Error("gh pr list: unexpected answer");
  }
  return { number: first.number, url: first.url };
}

/** Proposes the bump already written into the working tree. */
export function propose(run: Runner, input: ProposeInput): Outcome {
  if (input.bump.changes.length > 0 && input.files.length === 0) {
    throw new Error("a bump with changes must change a Dockerfile");
  }
  const allowed = new Set<string>(DOCKERFILES);
  for (const file of input.files) {
    if (!allowed.has(file)) throw new Error(`refusing to commit ${file}`);
  }
  const dirty = must(run, "git", ["status", "--porcelain", "--untracked-files=no"])
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.slice(3));
  const unexpected = dirty.filter((f) => !input.files.includes(f));
  if (unexpected.length > 0 || dirty.length !== input.files.length) {
    throw new Error(`the working tree's changes are not the bump's: ${dirty.join(", ")}`);
  }

  const ref = `refs/heads/${input.branch}`;
  const tracking = `refs/remotes/origin/${input.branch}`;
  const remote = must(run, "git", ["ls-remote", "--heads", "origin", ref]).split(/\s/)[0] ?? "";
  let manual: string[] = [];
  let previous = "";
  if (remote !== "") {
    must(run, "git", ["fetch", "--no-tags", "origin", `+${ref}:${tracking}`]);
    must(run, "git", [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${input.base}:refs/remotes/origin/${input.base}`,
    ]);
    manual = must(run, "git", [
      "log",
      "--format=%h %ae",
      `refs/remotes/origin/${input.base}..${tracking}`,
    ])
      .split("\n")
      .filter((l) => l !== "" && !l.endsWith(` ${BOT.email}`));
    previous = must(run, "git", [
      "log",
      "-1",
      `--format=%(trailers:key=${TRAILER},valueonly)`,
      tracking,
    ]).trim();
  }
  const pr = openPr(run, input);

  if (input.bump.changes.length === 0) {
    if (pr === undefined) return { kind: "nothing" };
    if (manual.length > 0) return { kind: "held", commits: manual };
    must(run, "gh", [
      "pr",
      "close",
      String(pr.number),
      "--comment",
      `${input.base} already pins these versions or newer ones.`,
      "--delete-branch",
    ]);
    return { kind: "closed", pr: pr.url };
  }
  if (manual.length > 0) return { kind: "held", commits: manual };

  const id = bumpId(input.bump);
  if (remote !== "" && previous === id) {
    return pr === undefined ? { kind: "declined" } : { kind: "unchanged", pr: pr.url };
  }

  must(run, "git", [
    "-c",
    `user.name=${BOT.name}`,
    "-c",
    `user.email=${BOT.email}`,
    "commit",
    "--no-verify",
    "-m",
    input.title,
    "-m",
    `${TRAILER}: ${id}`,
    "--",
    ...input.files,
  ]);
  must(run, "git", ["push", `--force-with-lease=${ref}:${remote}`, "origin", `HEAD:${ref}`]);
  let outcome: Outcome;
  if (pr === undefined) {
    const url = must(run, "gh", [
      "pr",
      "create",
      "--base",
      input.base,
      "--head",
      input.branch,
      "--title",
      input.title,
      "--body-file",
      input.bodyFile,
    ]).trim();
    outcome = { kind: "created", pr: url };
  } else {
    must(run, "gh", [
      "pr",
      "edit",
      String(pr.number),
      "--title",
      input.title,
      "--body-file",
      input.bodyFile,
    ]);
    outcome = { kind: "updated", pr: pr.url };
  }
  must(run, "gh", ["workflow", "run", input.ciWorkflow, "--ref", input.branch]);
  return outcome;
}
