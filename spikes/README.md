# spikes

Historical experiments, fault harnesses and reproduction tools that informed the product. Source remains useful after a question is settled; a successful spike is not qualification of a later integrated image. See the [architecture decisions](../docs/decisions/README.md) for the accepted behavior and [compatibility](../docs/compatibility.md) for current product boundaries.

| Directory | Question / harness |
|---|---|
| [s1/](s1/) | Container lifecycle, wake/restore and tunnels |
| [s2/](s2/) | Long-running sessions, redeployments and campaign analysis |
| [s3/](s3/) | Content-correct capture, pause leases, runner counts and restore |
| [s4/](s4/README.md) | Litestream, durability barriers, faults and historical issue reproduction |
| [s5/](s5/) | Access and platform login |
| [s6/](s6/) | Native login/credential families, continuation and restore |
| [s7/](s7/) | Managed-sharing settings and UI/variant checks |
| [x1/](x1/) | Transport/deployment experiments and analysis |
| [dc36/](dc36/) | Additional isolated container/deployment experiment |

## Reproduce deliberately

Each harness has its own dependencies, pinned artifacts, resource effects and output format. Root pnpm and Python installs do not set up every spike. Docker exercises may replace containers, inject faults and remove their own test volumes. Staging/real-account scenarios need separately owned resources, current instructions and human sign-in where required; they are not ordinary PR checks. Follow [contributing](../CONTRIBUTING.md) and [testing](../docs/testing.md).

Use caller-supplied checkout/configuration paths and a scratch checkout for a new campaign. Do not substitute current upstream/CLI versions for historical pins and call the result a reproduction. Prototype CLI/SDK pins are not selected production-computer versions. Confirm current R2/account capabilities rather than relying on old setup-state statements.

Staging deployments use the [guarded tool](../scripts/staging/stg.ts), owned `cfo-stg-` resources, bounded lifetimes and cleanup records. Account-specific Access application names and machine-local paths are not part of the generic harness contract. Do not modify unrelated account resources.

## Keep campaign controls

Authenticated browser access alone does not authorize a fault/reset/start action. GET/HEAD control requests must have no effect. Mutating requests use POST, the deployment's exact origin, appropriate same-origin fetch metadata and a validated request-intent token. Campaigns arm for a bounded window and disarm when finished. Preserve refusal tests and zero-effect guarantees. [Restore-drill controls](../scripts/restore-drill/staging/src/controls.ts) retain this design in a maintained harness.

## Retain evidence and reusable inputs

Selected raw outputs are preserved at an immutable historical revision and in the maintainer archive. See [historical result retrieval](results-retention.md); default analysis inputs and every harness remain in this checkout.

`results/` contains historical output, including failed runs and teardown observations. It is not a disposable cache. Some analysis programs read those exact files: S3's [facts.py](s3/bench/facts.py) and [report.py](s3/bench/report.py) read capture/report datasets by default. S2 also contains [executable analysis inside results](s2/results/analysis-2026-10-19/driver-saturation-check.py). Keep source/harnesses separate from generated output when reviewing retention.

New runs can overwrite fixed output names. Preserve old originals and run associations, use synthetic/generated credentials, and review output before retaining or sharing it. A previous redaction/canary check or teardown file is bounded historical evidence, not proof of current publication safety or resource absence. Archive/removal requires an approved per-file preservation and dependency plan; duplicated screenshot bytes alone do not remove distinct evidence labels. Preserve licences, notices and deterministic regression fixtures.
