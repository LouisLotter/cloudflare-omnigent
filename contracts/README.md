# contracts

The versioned wire and behavior authority shared by the Workers and their container-side adapters. Current computer contracts are integrated source; the complete production controller, launcher and supervisor assembly is not yet integrated or qualified. See [compatibility](../docs/compatibility.md).

| Path | Authority |
|---|---|
| [src/](src/) | TypeScript/zod runtime schemas and cross-field refinements; [index.ts](src/index.ts) registers exported wire schemas |
| [schema/](schema/) | Committed JSON Schema projection generated from the runtime schemas |
| [fixtures/](fixtures/) | Valid examples, `invalid/` shape failures, `refined/` cases rejected by runtime cross-field rules that export cannot fully express, and `tolerated/` cases: `{ input, parsed }`, an input no writer of this release sends (the exported schema refuses it) and what a tolerant reader yields from it (the supervisor's `computer_status` reply; see [compatibility](../docs/compatibility.md)) |
| [vectors/](vectors/) | Cross-language signing, tree-digest and checkpoint-policy cases |
| [test/](test/) | Actual schema parsing, round trips, refinements and property checks |

[lifecycle.ts](src/lifecycle.ts) owns the reference state/event interpreter. [checkpoint-policy.ts](src/checkpoint-policy.ts) owns version-one credential-family/capture/prune/restore rules. [launcher.ts](src/launcher.ts), [computer-protocol.ts](src/computer-protocol.ts), [manifests.ts](src/manifests.ts) and [controllers.ts](src/controllers.ts) define their respective boundaries. Keep data-policy and lifecycle authority distinct from transport schemas.

## Changing a contract

Agree changes to shared wire interfaces with the integration maintainer first. Add a registered schema and valid/invalid fixtures; add refined cases for cross-field rules and update independent vectors when their semantics change. Regenerate the projection and include every changed/new schema file:

```bash
pnpm --filter @cfo/contracts test
pnpm contracts:export
uv run --locked --no-sync --offline --directory python pytest
```

These commands assume the [contributor setup](../CONTRIBUTING.md) is complete. Export rewrites `schema/`; CI checks for drift and untracked exported files. Preserve invalid/refined fixtures, generated schemas and vectors as maintained test assets.

The [Python reference tests](../python/README.md) validate exported-schema valid/invalid cases and independently calculate vectors. They do not import every production receiver or exercise `refined/` cases through a supervisor. Each actual adapter/parser must apply the matching runtime refinements, policy and supported-version checks before effects, and its image must contain the matching assets. See [testing](../docs/testing.md) and [checkpoint publication](../docs/decisions/0005-checkpoint-publication-continuation.md).
