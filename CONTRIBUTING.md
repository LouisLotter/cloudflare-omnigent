# Contributing

Start with the [architecture](docs/architecture.md), [decision index](docs/decisions/README.md) and [compatibility snapshot](docs/compatibility.md). They separate integrated source, unfinished integration and artifact/runtime qualification. Follow the path ownership and review rules in [AGENTS.md](AGENTS.md).

Commands below run from the repository root. They are contributor instructions, not a claim that an arbitrary checkout or release has passed them. Never supply real credentials to local reference tests.

## Set up a clean checkout

Use Node.js 26 from [.node-version](.node-version), pnpm 11.15.1 from [package.json](package.json), and Python 3.12 from [python/.python-version](python/.python-version). The Python project permits newer compatible versions; CI uses uv 0.12.10. These selectors do not pin an exact Node/Python patch. Docker is needed only for image/process and integration work.

Dependency setup can access the network and download runtime binaries/packages:

```bash
pnpm install --frozen-lockfile
uv sync --locked --directory python
```

The pnpm workspace contains `contracts` and `worker`; root tooling also runs the repository-script tests. It does not install standalone spike packages or image/restore-drill Python environments. Keep lockfiles intact and review dependency changes explicitly.

## Run credential-free local checks

Once dependencies and the required runtime binaries are installed:

```bash
WRANGLER_SEND_METRICS=false pnpm check
uv run --locked --no-sync --offline --directory python ruff check
uv run --locked --no-sync --offline --directory python ruff format --check
uv run --locked --no-sync --offline --directory python pytest
```

`pnpm check` runs lint, typechecks and tests. Worker tests include local workerd with real Durable Object test storage; script tests include the restore-drill staging logic under Node with fakes. They do not contact a Cloudflare account or instantiate production Containers. The Python commands use the already-synced environment; `--offline` prevents uv dependency-network access and `--no-sync` avoids changing that environment. This is separate from testing real provider/network behavior.

Additional source/CI obligations include:

| Check | Purpose and limit |
|---|---|
| `pnpm coverage` | Node/Workers/script thresholds; not whole-product or image/Python coverage |
| `pnpm contracts:export` | Rewrites committed `contracts/schema/`; include reviewed schema changes and new files with the contract change |
| `pnpm --filter @cfo/worker dry-run` | Bundles the default platform configuration without deploying; the web configuration needs its own explicit check |
| `node scripts/canary-scan.ts --self-test` | Synthetic scanner controls; needs Node, not a dependency installation |
| `node scripts/canary-scan.ts contracts worker/src python/tests docs` | The current bounded source scan; it is not a repository/history/image publication review |

The [testing guide](docs/testing.md) gives command discovery, two-configuration bundling, image/restore-drill prerequisites and manual qualification. `pnpm check` does not itself include coverage, schema drift enforcement, bundling or canary CLI scans. Consult the actual [CI workflow](.github/workflows/ci.yml) when matching CI: it also builds the existing server/test image targets and runs their unit/in-process suite with networking disabled.

## Keep contract authority explicit

Propose changes to shared contracts and cross-component interfaces to the integration maintainer before changing consumers. [contracts/README.md](contracts/README.md) distinguishes TypeScript runtime schemas, exported JSON Schema, lifecycle/policy data and independent vectors. Add valid, invalid and relevant cross-field `refined` cases. A Python JSON Schema pass does not test every real receiver's refinements. Verify actual adapters/parsers and the assets packaged in their images when those components change.

Preserve operation identity, generation/start fencing, persistence before effects, honest unknown outcomes and published-checkpoint semantics. A transport retry must not silently repeat an uncertain external action. Explain changes to these invariants in the relevant decision record and tests.

## Separate local, Docker and account work

| Work | Prerequisites and effects |
|---|---|
| Node/Python reference and runtime checks | Installed dependencies/local runtimes, synthetic data; no account credentials |
| Image builds and in-process image tests | Docker, CPU/disk and dependency/base downloads; build/test targets described under [images](images/README.md) |
| Docker fault/integration suites | Isolated ports, generated test credentials, MinIO/Toxiproxy and owned test resources; replacement/kill/volume cleanup is intentional |
| Staging/bootstrap and real CLI/browser qualification | Explicitly owned account/resources, cost/expiry/cleanup plan, current reviewed assembly and owner/human sign-in where required |

Use the guarded [staging tool](scripts/staging/stg.ts) for approved staging deployments. Bootstrap and restore tools are operational commands, not part of getting a contributor's unit tests running. Do not add secrets or account flows to ordinary PR CI. Cloudflare operations and production changes follow the owner/review boundaries in [AGENTS.md](AGENTS.md) and the [operating guides](docs/operations/security.md).

## Work across the two repositories

Platform-specific ingress, deployment, secrets and container adapters belong here. General persistent-host, launcher, scheduling, credential and continuation capabilities belong in the Omnigent fork. Use supported interfaces and `create_app`; do not patch fork internals at runtime or duplicate the application scheduler in the platform.

Keep fork changes provider-neutral and review them separately with linked platform requirements. This project's fork publication namespace is `cfo/`; only the integration maintainer publishes those branches. Do not push to unrelated fork branches or open upstream issues/pull requests without the maintainer's request. A fork fix is not shipped until the selected image contains and qualifies it.

## Submit a reviewable change

Use a separate branch/worktree for assigned work and retain unrelated worktrees and local changes. Keep documentation, runtime behavior, CI/pins and retention changes reviewable as separate patches. State the concrete problem, changed behavior, relevant source/artifact identities, checks actually run and remaining checks. Distinguish reported evidence from your own execution and include failures or prerequisite skips.

Public product documentation should explain behavior and invariants using public source/tests. Tracker updates, owner conversations, account runs, gate approvals and independent review records remain private. Do not move raw results or delete historical evidence without an approved per-file preservation/dependency plan. Retain licences, notices, schemas, negative fixtures and useful fault harnesses.

Use synthetic examples, redacted diagnostics and temporary generated credentials. A bounded canary pass is not proof that arbitrary secrets are absent. For sensitive findings, follow [SECURITY.md](SECURITY.md) before posting details publicly.
