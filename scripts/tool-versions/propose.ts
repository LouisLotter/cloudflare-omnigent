// Proposing a bump as one pull request on one branch (WP3.37), with git and gh.
//
// The branch is rebuilt from the checked-out main on every run that has something new, and
// force-pushed with a lease, so the pull request always shows main against the latest releases.
// It is never rewritten, closed or deleted when it holds a commit the workflow did not make (a
// person's fix on top): the run stops and says so.
//
// Each bump has an identity (bumpId), kept in its commit's trailer and in its pull request's
// body, which is updated before the branch is pushed. That makes every run safe to repeat:
//   - the branch already holds this bump and its pull request is open: nothing is pushed, and
//     CI is dispatched only if no dispatched CI run exists for the branch's head commit;
//   - the branch holds it but no pull request is open: one is opened, unless the owner closed
//     one with this identity unmerged (declined: not proposed again until a newer release
//     changes the bump, even if the branch was deleted);
//   - main already has every pin: the open pull request is closed and the branch deleted, with a
//     lease, so a push made in between is never lost.
// Only pull requests from this repository's own branch count, never a fork's branch that
// happens to have the same name.
//
// CI: a push or pull request made with the workflow's GITHUB_TOKEN starts no `push` or
// `pull_request` run (only an approval-gated one). A `workflow_dispatch` event always starts a
// run, so this dispatches CI on the branch; its checks attach to the branch's head commit, which
// is the pull request's.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
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
  /** The pull request's body; the bump's identity is added to it. */
  readonly body: string;
  /** Where the body is written for gh. */
  readonly bodyFile: string;
  readonly branch: string;
  readonly base: string;
  readonly ciWorkflow: string;
}

export type Outcome =
  | { readonly kind: "nothing" }
  | {
      readonly kind: "created" | "updated" | "unchanged" | "closed";
      readonly pr: string;
      /** Whether this run dispatched CI on the branch. */
      readonly ci?: boolean;
    }
  | { readonly kind: "declined" }
  | { readonly kind: "held"; readonly commits: readonly string[] };

/** A stable identity for a bump's content. */
export function bumpId(bump: Bump): string {
  const args = Object.fromEntries(Object.entries(bump.args).sort(([a], [b]) => (a < b ? -1 : 1)));
  return createHash("sha256")
    .update(JSON.stringify({ changes: bump.changes, args }))
    .digest("hex")
    .slice(0, 32);
}

/** The line in a pull request's body that carries the bump's identity. */
export function marker(id: string): string {
  return `<!-- ${TRAILER}: ${id} -->`;
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

interface Pr {
  readonly number: number;
  readonly url: string;
  readonly body: string;
  readonly merged: boolean;
}

/** This repository's pull requests from the branch to the base (a fork's are left out). */
function prs(run: Runner, input: ProposeInput, state: "open" | "closed"): Pr[] {
  const out = must(run, "gh", [
    "pr",
    "list",
    "--head",
    input.branch,
    "--base",
    input.base,
    "--state",
    state,
    "--json",
    "number,url,body,mergedAt,isCrossRepository",
    "--limit",
    "100",
  ]);
  const list = JSON.parse(out) as unknown;
  if (!Array.isArray(list)) throw new Error("gh pr list: not a list");
  return list.flatMap((item): Pr[] => {
    const p = item as Record<string, unknown>;
    if (
      typeof p.number !== "number" ||
      typeof p.url !== "string" ||
      typeof p.isCrossRepository !== "boolean"
    ) {
      throw new Error("gh pr list: unexpected answer");
    }
    if (p.isCrossRepository) return [];
    return [
      {
        number: p.number,
        url: p.url,
        body: typeof p.body === "string" ? p.body : "",
        merged: typeof p.mergedAt === "string" && p.mergedAt !== "",
      },
    ];
  });
}

/** Whether CI has been dispatched for `sha` (a pull_request run awaiting approval does not count). */
function ciDispatched(run: Runner, input: ProposeInput, sha: string): boolean {
  const out = must(run, "gh", [
    "run",
    "list",
    "--workflow",
    input.ciWorkflow,
    "--commit",
    sha,
    "--event",
    "workflow_dispatch",
    "--json",
    "databaseId",
    "--limit",
    "1",
  ]);
  const list = JSON.parse(out) as unknown;
  if (!Array.isArray(list)) throw new Error("gh run list: not a list");
  return list.length > 0;
}

function dispatchCi(run: Runner, input: ProposeInput): void {
  must(run, "gh", ["workflow", "run", input.ciWorkflow, "--ref", input.branch]);
}

/** Opens the pull request for the branch as it is on the remote, then dispatches CI. */
function create(run: Runner, input: ProposeInput): Outcome {
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
  dispatchCi(run, input);
  return { kind: "created", pr: url, ci: true };
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
  const id = bumpId(input.bump);
  writeFileSync(input.bodyFile, `${input.body.trimEnd()}\n\n${marker(id)}\n`);

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
  const open = prs(run, input, "open")[0];

  if (input.bump.changes.length === 0) {
    if (open === undefined) return { kind: "nothing" };
    if (manual.length > 0) return { kind: "held", commits: manual };
    must(run, "gh", [
      "pr",
      "close",
      String(open.number),
      "--comment",
      `${input.base} already pins these versions or newer ones.`,
    ]);
    // Deleted only if it is still the commit inspected above.
    if (remote !== "") {
      must(run, "git", ["push", `--force-with-lease=${ref}:${remote}`, "origin", `:${ref}`]);
    }
    return { kind: "closed", pr: open.url };
  }
  if (manual.length > 0) return { kind: "held", commits: manual };

  if (remote !== "" && previous === id) {
    if (open !== undefined) {
      // A body that names another bump (an earlier run failed part way) is put right.
      if (!open.body.includes(marker(id))) edit(run, input, open);
      const ci = !ciDispatched(run, input, remote);
      if (ci) dispatchCi(run, input);
      return { kind: "unchanged", pr: open.url, ci };
    }
  }
  if (open === undefined) {
    const declined = prs(run, input, "closed").some(
      (p) => !p.merged && p.body.includes(marker(id)),
    );
    if (declined) return { kind: "declined" };
    // The branch already holds this bump, but no pull request was opened (a failed run).
    if (remote !== "" && previous === id) return create(run, input);
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
  // An open pull request names the new bump before the branch changes, so its body never
  // describes an older bump than its branch holds, even if the push then fails.
  if (open !== undefined) edit(run, input, open);
  must(run, "git", ["push", `--force-with-lease=${ref}:${remote}`, "origin", `HEAD:${ref}`]);
  if (open === undefined) return create(run, input);
  dispatchCi(run, input);
  return { kind: "updated", pr: open.url, ci: true };
}

function edit(run: Runner, input: ProposeInput, pr: Pr): void {
  must(run, "gh", [
    "pr",
    "edit",
    String(pr.number),
    "--title",
    input.title,
    "--body-file",
    input.bodyFile,
  ]);
}
