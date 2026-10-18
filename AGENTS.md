# Agent guidance

## Current phase: implementation

Implementation has started. Work runs in milestones M0 to M7, each split into work packages and ending at a gate with recorded evidence.

**Process documents never go in this repository.** The tracker, verification evidence, gate reports, design-change proposals, review reports and review responses live in the maintainer's project notes, outside this repository, in `../omnigent-cloudflare-context/project/`. Never commit them here, in any branch.

## Where the design lives

The design documents are kept outside this repository, in the folder next to this checkout, `../omnigent-cloudflare-context`:

- `design/hybrid-architecture.md`: the governing design, including the release checks and failure handling.
- `design/code-structure.md`: repository layout, module rules, owned paths and conventions.
- `design/implementation-plan.md`: roles, milestones, work packages, gates and the test strategy.

They stay there. If implementation shows the design is wrong, change the design first, add a line to the tracker's design change notes, then change the code.

## Roles

| Role | Does |
|---|---|
| Integration lead | Owns the shared files: `contracts/`, `worker/src/shared/rpc.ts`, `worker/wrangler.jsonc`, CI and the tracker. Assigns packages, merges pull requests, runs gates, keeps the design and plan current. |
| Work-package agent | Implements one package in its own worktree, inside its owned paths only. |
| Independent reviewer | Reviews a package and reports. Codex reviews Claude's work, and the other way round. Never edits. |
| Owner | Approves gates, and anything that costs money or touches production. |

## Working on a package

1. **Take your package from the lead,** who keeps the tracker and the traceability matrix in the project notes and updates them from your reports.
2. **Use your own worktree and branch,** named `wp/<id>-<slug>`, for example `git worktree add ../cfo-wp-3.1 -b wp/3.1-workspace-core <integration branch>`. The integration branch for M0 is `m0/foundations`. Claude Code agent worktrees under `.claude/worktrees/` are fine; they are gitignored.
3. **Stay inside your owned paths,** as listed in the plan's work-package tables and the code-structure plan. Change shared files only through a pull request to the lead. If another package's interface blocks you, ask the lead for a contract change; never edit that package's paths.
4. **Contract first.** Build against the milestone's contract package and its fakes, never against another package's unfinished code. Parse every inbound payload with a `contracts` schema.
5. **Meet the definition of done** below.
6. **Get an independent review,** then write the evidence entry in the project notes and open a pull request to the lead. Merge needs green CI, a completed review and the evidence entry.

## Definition of done

1. Code follows the conventions: strict TypeScript, typed contracts, operation IDs, persist-before-effect, error codes rather than error classes across RPC.
2. Tests: unit and property tests for pure modules (fast-check, hypothesis); Workers-runtime tests for every DO method, evicting after each persisted transition; contract tests for every fixture the package uses; integration or end-to-end tests across process and network boundaries.
3. At least 90% line and branch coverage for pure modules; mutation score of at least 75% for state machines and the schedule cache. These supplement the failure tests, never replace them.
4. Every failure row the package touches has a test, not only the happy path.
5. No secrets or login material in logs, fixtures or snapshots; the canary scan passes.
6. Independent review done, findings fixed or answered, report saved in the project notes.
7. Evidence entry in the project notes, `verification/wp-<id>.md`, from the template there.
8. The package's traceability rows name real tests.

## Independent review

- Follow the handoff rules in `../AGENTS.md`, the workspace guidance one level above this checkout. Claude's work is reviewed by Codex with `codex exec` in a read-only sandbox, from a request packet that holds the diff, the test results and the questions.
- The reviewer only reports. The implementing agent fixes valid findings, records reasons for declined ones, and reruns the checks. Allow at most two reviewer runs per handoff, then raise disagreements with the lead.
- Save each report in the project notes, as `verification/reviews/<id>-r<n>.md`. Never commit a review to this repository.
- Codex also runs an ongoing review of the integration branch. Its file and the responses to it are kept in the project notes too.

## Staging and deployments

- Staging lives in the owner's main Cloudflare account. Name every resource `cfo-stg-` plus your package suffix, for example `cfo-stg-wp31-checkpoints`.
- Deploy only with the guarded deployment script from WP0.4. It refuses unprefixed names and the wrong account. Never deploy, create or delete Cloudflare resources around it. `wrangler deploy --dry-run` is always fine.
- Deploy only from the owner's laptop, with the owner's Wrangler login. CI never deploys.
- Record each staging resource's owner and lifetime. Remove it with your package's teardown script when done, and record the teardown in your evidence. The lead removes anything past its lifetime.
- Ask the owner before anything that costs money beyond staging, or touches production.

## Real accounts

- The owner has given standing approval to test with the owner's real Claude and ChatGPT accounts. Do not ask each time.
- Prefer the fake CLIs. Use real accounts only where a spike or gate needs them, and only with reviewed revisions.
- Record every run in the evidence: what ran, the revision, the standing approval, and the sign-out. Sign out after every run.
- Never record sign-in codes, tokens, login files or account details.

## Secrets and publishing

- **Public from day one.** Never commit secrets, tokens, login material, account IDs, email addresses or personal data, including in fixtures, snapshots, logs and evidence. Use synthetic canary values.
- Secrets belong in Cloudflare secrets or untracked local files such as `.dev.vars`.
- Builds of untrusted pull requests get no secrets. Pin GitHub Actions by commit.

## Security calibration

- Defend against outside attackers: Access and assertion checks, hostname allowlists, exact origins and CSRF checks, private virtual hosts, credential custody outside computers, generation fencing.
- Do not restrict what agents can do on their own cloud computers. A rogue agent is an accepted, low risk. The private route blocks only the few actions listed in the design: account administration, answering approvals, sharing settings, and another computer's identity.

## Other rules

- **Omnigent changes do not belong here.** Make them as separate branches in the fork `LouisLotter/omnigent` (WP5.1 and WP5.2). This repository uses Omnigent only through its extension points and never patches its internals.
- **Nothing goes upstream early.** Do not open issues or pull requests on `omnigent-ai/omnigent` unless the maintainer asks.
- **Pin exactly.** Use exact versions for Wrangler, the `@cloudflare/*` packages, images, Litestream and the CLIs, and keep the seven-day release cooldown. An emergency security patch may skip the cooldown after review.
- **Beta APIs stay behind adapters.** Only `container-port.ts` modules touch `ctx.container` or Sandbox SDK helpers. Pure modules import nothing from `cloudflare:workers`.

## Commands

```bash
pnpm install
pnpm check                        # lint, typecheck, unit and Workers-runtime tests
uv run --directory python pytest  # Python contract tests
pnpm contracts:export             # regenerate JSON Schema after a contract change
pnpm --filter @cfo/worker dry-run # wrangler deploy --dry-run
```

## Repository layout

| Path | Contents |
|---|---|
| `contracts/` | Wire contract: zod schemas, exported JSON Schema, golden fixtures |
| `worker/` | The Worker, its Durable Objects and their tests |
| `python/` | Python side: contract tests now, the supervisor and gateway backend later |
| `images/` | Container images: server, computer, LinkedIn connector |
| `spikes/` | Throwaway M1 experiments; their evidence is in the project notes |
| `scripts/` | Repository tools: the canary scanner and the guarded staging tool |
| `docs/` | `secrets.md`, the secret checklist |
