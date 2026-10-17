# Agent guidance

## Current phase: planning

Do not add implementation code yet. The design is still under review. Changes to this repository are limited to structure and documentation until the design is settled.

## Where the design lives

The design documents are kept outside this repository for now, in the research folder next to this checkout, `../omnigent-cloudflare-context`:

- `design/hybrid-architecture.md`: the governing architecture.
- `design/code-structure.md`: repository layout, module rules, Omnigent core changes, workstreams and conventions.
- `research/review-2026-10-17.md`: gaps found in the research, which the plan must address.

When the design settles, it moves into `docs/`.

## Rules

- **Public from day one.** Never commit secrets, tokens, account IDs or personal data. Secrets belong in Cloudflare secrets or untracked local files such as `.dev.vars`.
- **Omnigent changes do not belong here.** Make them as separate branches in the fork `LouisLotter/omnigent`. This repository uses Omnigent only through its extension points and never patches its internals.
- **Nothing goes upstream early.** Do not open issues or pull requests on `omnigent-ai/omnigent` unless the maintainer asks.
- **Pin exactly.** Use exact versions for Wrangler and the `@cloudflare/*` packages, and observe a seven-day release cooldown for all dependencies, as Omnigent does.
- **Respect workstream ownership.** Each workstream owns the paths listed in `code-structure.md`. Shared files change through the scaffolding owner.

## Repository layout

| Path | Contents |
|---|---|
| `contracts/` | Python–Worker wire contract |
| `worker/` | Worker, Durable Objects, tests |
| `python/` | Omnigent plugin package |
| `images/` | Container images |
| `docs/` | Design documents |
