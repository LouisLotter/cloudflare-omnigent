# Testing and qualification

Run commands from the repository root unless noted. These entry points are source-verified for platform `91261d7e8fe4b87c8010d50739cd921dd4bf09fe`; listing them does not claim they were executed or pass on a selected release. Read [compatibility](compatibility.md) before choosing a main, candidate or draft checkout. Tests against a source checkout do not establish the code in a deployed image.

## Choose the execution boundary

| Class | What it does | Required boundary |
| --- | --- | --- |
| Local observation | Git source identity, configuration and recorded bootstrap progress | Reads local files; diagnostic output can identify an installation. |
| Dependency preparation | pnpm/uv install or sync | Network access and local cache/environment writes; no Cloudflare or provider login needed. |
| Node/Python checks | Lint, types, contracts, pure logic and local workerd tests | Existing dependencies; local processes/storage/caches. `uv run --locked` can sync/fetch on a cold environment. These are not Docker or Cloudflare tests. |
| Bundling/schema generation | Wrangler dry runs and schema export | Writes build/generated files, may download tooling/dependencies; no deployment. |
| Docker image and fault suites | Build/download images; run processes, Compose services and local kill/replace scenarios | CPU/disk/network and isolated test ownership. Never use production data or mounts. |
| Cloudflare/provider/browser qualification | Access, Workers/DOs, Containers, R2, real CLI sign-in/refresh/restore and user entry points | Manual reviewed assembly, account access/cost/cleanup boundaries and private evidence. Not ordinary PR CI. |
| Reset/teardown/recovery | Delete resources, restore data or invalidate authority | Explicit target/ownership and reviewed recovery plan. A test command is not authorization for a production reset. |

## Routine local checks

Install the locked workspace dependencies separately:

```bash
pnpm install --frozen-lockfile
uv sync --locked --directory python
```

Then run the existing repository checks:

```bash
WRANGLER_SEND_METRICS=false pnpm check
uv run --locked --no-sync --offline --directory python ruff check
uv run --locked --no-sync --offline --directory python ruff format --check
uv run --locked --no-sync --offline --directory python pytest
```

After the explicit sync, `--no-sync --offline` keeps uv on the prepared local environment; missing dependencies must be prepared before these commands can work. Without those flags, ordinary `uv run --locked` can sync/fetch. `WRANGLER_SEND_METRICS=false` suppresses Wrangler usage metrics during the Node checks.

`pnpm check` is exactly lint, typecheck and tests. It does not separately run coverage, schema-drift checks, Wrangler bundling or scanner CLI invocations. The pnpm workspace contains `contracts` and `worker`; the root test script also runs the tools under `scripts/`.

For targeted feedback:

| Command | Coverage |
| --- | --- |
| `pnpm --filter @cfo/contracts test` | Actual registered TypeScript schemas, valid/invalid/refined fixtures and contract helpers. |
| `pnpm --filter @cfo/worker test:unit` | Node unit/fake/pure-logic suites. |
| `pnpm --filter @cfo/worker test:workers` | Local workerd/DO storage and eviction tests under the test configuration. Containers service behavior remains separate. |
| `pnpm test:scripts` | Canary, staging, bootstrap and restore-drill staging tests. The restore-drill staging suite already runs in Node with mocked platform resources. |
| `pnpm coverage` | Existing configured per-file thresholds, not whole-product or image/Python coverage and not mutation testing. |

The root [Python project](../python/pyproject.toml) discovers only its own `tests`, including the [Cloudflare launcher's](../python/tests/sandbox/): its protocol against the contract's fixtures, schemas and signing vectors, each method against a fake launcher API over real loopback HTTP (signatures checked as the receiver would, lost and trickled replies, the replication fence), and, where the fork's Omnigent is installed, the Omnigent adapter and Omnigent's persistent-host flow driving it. Without Omnigent those last tests skip, as in CI's Python job; the server image's suite covers the registration inside the built image. It does not discover the server image, restore-drill Python, standalone spike projects or unfinished computer image tests. Its fixture tests use exported JSON Schema and do not cover `refined/` cases; its signing/tree/policy vector tests calculate reference results rather than invoking every production parser.

## Schema and Worker builds

A schema change requires regeneration and review of both tracked changes and newly generated files:

```bash
pnpm contracts:export
git diff --exit-code -- contracts/schema
git ls-files --others --exclude-standard -- contracts/schema
```

The export writes files. The diff command must be clean when checking an unchanged schema; the final command must produce no untracked schema paths. Inspect and include intentional generated changes when implementing a contract change.

The existing script `pnpm --filter @cfo/worker dry-run` bundles only the default platform configuration. To check both configurations explicitly, use separate output directories:

```bash
pnpm --filter @cfo/worker exec wrangler deploy --config wrangler.jsonc --dry-run --outdir dist/platform
pnpm --filter @cfo/worker exec wrangler deploy --config wrangler.web.jsonc --dry-run --outdir dist/web
```

CI runs both commands and scans both Worker output directories. The platform dry run also builds its configured server image, so it requires Docker and build-time network access; this remains within the Node job's existing 20-minute limit. These are local build commands, not deployments: they do not instantiate/qualify Cloudflare Containers, prove release image identity or exercise a real computer route.

## Bounded canary checks

```bash
node scripts/canary-scan.ts --self-test
node scripts/canary-scan.ts contracts worker/src python/tests docs
node scripts/canary-scan.ts worker/dist/platform worker/dist/web
```

Run the last command only after generating both nonempty output directories. Exit 0 means clean within the supported input/value limits; 1 means a finding/self-test failure, 2 usage, and 3 incomplete input. Incomplete does not mean clean. The scanner checks supported synthetic markers and exact `CFO_CANARY_VALUES` entries, not arbitrary real secrets or all transformations. Nested skipped directories/symlinks and unsupported compressed formats constrain coverage. These commands do not scan Git history, every source directory, image filesystems or all checkpoint layers, and do not authorize publication.

## Server image tests — CI and local Docker

The [Dockerfile](../images/server/Dockerfile) has `server` and `test` targets. Builds fetch public dependencies and use significant disk/CPU. From an isolated local test environment without real account credentials:

```bash
docker build --platform linux/amd64 -f images/server/Dockerfile --target server -t cfo-server:local-runtime .
docker build --platform linux/amd64 -f images/server/Dockerfile --target test -t cfo-server:local-test .
docker run --rm --network none cfo-server:local-test python -c 'import pathlib, subprocess; import omnigent.server.app; assert pathlib.Path("/app/entrypoint.py").is_file(); assert subprocess.check_output(["litestream", "version"], text=True).strip() == "0.5.17"'
docker run --rm --network none -e OMNIGENT_DISABLE_CATALOG_LOOKUP=1 cfo-server:local-test
```

CI uses these commands with its own local image tags and a 45-minute job limit. Builds require network access; the prerequisite and test containers run with `--network none`, which preserves loopback for local test servers. No host directories, credentials or Docker socket are mounted into the test containers.

The last command uses the existing image CMD: unit/in-process tests excluding `tests/integration`. Prerequisite checks prevent an absent app/Litestream from looking like passing skipped coverage. Inspect results and skips; do not count a skipped image test as evidence. Building the final `server` target and testing the derived `test` target do not replace a production-container smoke test or immutable artifact qualification.

The heavier [server integration suite](../images/server/tests/integration/conftest.py) uses actual containers, MinIO/Toxiproxy, generated credentials, local ports and kill/replace cleanup. Its conftest documents the required image tag and separate uv invocation. The [restore-drill Python suite](../scripts/restore-drill/tests/conftest.py) needs its own dependencies/drill image and local services; the root Python lock alone is insufficient. Its in-process fence launcher is a recording stub, not the production Cloudflare adapter. Read those suite-specific prerequisites and ownership/cleanup behavior before running; do not point them at real installation storage.

The separate server candidate adds a `fork-tests` build target and image-revision tests. Those do not exist in main. Its tree-comparison test needs a matching fork checkout and is excluded by the default image test CMD. The paused supervisor has no product Dockerfile/test directory, so there is no computer-image test command to recommend yet.

## Existing CI and remaining qualification

Current [CI](../.github/workflows/ci.yml) runs Node checks/coverage/schema drift, the root Python project, selected source canary scans, both Worker bundles and their canary scans, plus the existing server/test image builds and isolated image unit/in-process suite. It uses ordinary pull requests, read-only repository permissions and pinned actions, with no registry push or deployment. The 45-minute image-job cap is an initial budget; a cached local run does not establish hosted cold-build duration.

Server S3/fault integration, Python restore-drill, candidate-only fork/artifact tests, full image filesystem/layer credential scans and real Cloudflare/provider qualification remain outside these jobs. There is no computer image job until an actual product Dockerfile and suite exist.

Before qualification, record actual platform/fork revisions, Worker versions, final server/computer image digests and architecture, CLI/SDK/Litestream identities, packaged contract/policy assets, commands/results/skips and accepted limits. Then test actual receivers and the selected runtime assembly: version/generation refusal, replication-before-response/ack/effect, lost replies, sleep/start fencing, pause expiry, publication/unchanged freshness, credential families/tombstones, native continuation and real browser behavior. Generic reference fixtures and source ancestry do not replace those checks.

Real R2 startup on `basic` through the production watchdog remains pending for the server candidate. Local quota-constrained Docker is useful evidence, not that qualification. Keep Cloudflare/provider runs manual, use reviewed revisions, preserve exact failure cases and verify cleanup/sign-out. Existing gates and findings are not closed by a green subset or a documentation change.
