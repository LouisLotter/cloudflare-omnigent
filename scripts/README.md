# scripts

Repository tools have different effects; choose the tool and test environment before running it. [Contributing](../CONTRIBUTING.md) covers local setup, [testing](../docs/testing.md) covers discovery/prerequisites, and [operations](../docs/operations/recovery.md) covers recovery decisions.

| Path | Purpose and effect |
|---|---|
| [canary-scan.ts](canary-scan.ts) | Local synthetic-marker/exact-value scanner and temporary self-test fixtures; no Cloudflare account needed |
| [staging/stg.ts](staging/stg.ts) | Guarded account/resource operations, owners, expiry, secrets and teardown; not an offline local test |
| [bootstrap/bootstrap.ts](bootstrap/bootstrap.ts) | Installation planning/state and guarded initialization/release, including the installation's R2 buckets and its bucket-scoped R2 token, made and removed with the installer's `cf` login; operational steps use account credentials and owner acceptance |
| [restore-drill/](restore-drill/) | Durability/fence calculations, Docker/process fault suites and staging harness; distinguish reference launcher effects from the final production adapter |
| [vitest.config.ts](vitest.config.ts) | Node test discovery for scanner, staging, bootstrap and restore-drill staging logic |

## Local scanner and Node tests

From the repository root, Node 26 can run the scanner without installing npm dependencies:

```bash
node scripts/canary-scan.ts --self-test
node scripts/canary-scan.ts contracts worker/src python/tests docs
```

The second command matches the current source-scan scope. It checks supported content for synthetic markers and configured exact values, not arbitrary real credentials. Root documents, images, spikes, other Python source, Git history and deployment logs are outside that invocation. Unsupported formats, unreadable/oversized inputs and empty explicit paths make a scan incomplete; nonzero/incomplete is not a clean result. Do not weaken those checks or claim whole-artifact/publication clearance from a bounded pass.

With root dependencies installed, `pnpm test:scripts` runs the scripts Node suite. It already discovers `restore-drill/staging/**/*.test.ts`; the durable-object tests there use Node fakes, not the production Containers service. The [restore-drill Python suite](restore-drill/tests/) has separate dependencies and Docker/process setup and is outside the root Python CI project. See [testing](../docs/testing.md) for its prerequisites and limits.

## Account and recovery tools

Staging and bootstrap source headers document their CLI arguments and state locations. Read their refusal/ownership behavior before approved account work, retain expiry/cleanup evidence, and supply secrets through the supported private input paths. Never put real values in command arguments, examples, committed configuration or logs. The platform has no public account-specific default configuration to copy.

Use [security operations](../docs/operations/security.md) and [recovery](../docs/operations/recovery.md) for actions that change authority or restored state. Listing, replacing, revoking and deleting resources are distinct effects; a tool's presence or a green local test is not account-operation authorization. No deployment is part of ordinary PR CI.
