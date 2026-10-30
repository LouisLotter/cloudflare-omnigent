# Testing and qualification

Run commands from the repository root unless noted. Listing an entry point does not claim it was executed or passes on a selected release. Read [compatibility](compatibility.md) before choosing a main, candidate or draft checkout. Tests against a source checkout do not establish the code in a deployed image.

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
| `pnpm --filter @cfo/contracts test` | Actual registered TypeScript schemas, valid/invalid/refined/tolerated fixtures and contract helpers. |
| `pnpm --filter @cfo/worker test:unit` | Node unit/fake/pure-logic suites. |
| `pnpm --filter @cfo/worker test:workers` | Local workerd/DO storage and eviction tests under the test configuration. The routes, the backup gateway and ControlDO run against the real WorkspaceDO, with only its container (a simulated supervisor and `sandbox-shim`'s backup protocol) and the clocks simulated; WorkspaceDO's own controller tests use port-level fakes on a second binding. Containers service behavior remains separate. |
| `pnpm test:scripts` | Canary, staging, bootstrap, tool version check and restore-drill staging tests. The restore-drill staging suite already runs in Node with mocked platform resources; the tool version check's run against fake registries and a real git repository with a fake `gh`. |
| `pnpm coverage` | Existing configured per-file thresholds, not whole-product or image/Python coverage and not mutation testing. |

The root [Python project](../python/pyproject.toml) discovers only its own `tests`, including the [Cloudflare launcher's](../python/tests/sandbox/): its protocol against the contract's fixtures, schemas and signing vectors, each method against a fake launcher API over real loopback HTTP (signatures checked as the receiver would, lost and trickled replies, the replication fence), and, where the fork's Omnigent is installed, the Omnigent adapter and Omnigent's persistent-host flow driving it. Without Omnigent those last tests skip, as in CI's Python job; the server image's suite covers the registration inside the built image. It also discovers `tests/computer`: the computer supervisor's receiver, capture, restore, credential and host tests, which need no image or root. It does not discover the server image, restore-drill Python, standalone spike projects or the computer image's in-image and container tests. Its fixture tests use exported JSON Schema and do not cover `refined/` cases; its signing/tree/policy vector tests calculate reference results rather than invoking every production parser.

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

The [Dockerfile](../images/server/Dockerfile) has `server`, `test` and `fork-tests` targets. Builds fetch public dependencies and use significant disk/CPU. From an isolated local test environment without real account credentials:

```bash
docker build --platform linux/amd64 -f images/server/Dockerfile --target server -t cfo-server:local-runtime .
docker build --platform linux/amd64 -f images/server/Dockerfile --target test -t cfo-server:local-test .
docker run --rm --network none cfo-server:local-test python -c 'import pathlib, subprocess; import omnigent.server.app; assert pathlib.Path("/app/entrypoint.py").is_file(); assert subprocess.check_output(["litestream", "version"], text=True).strip() == "0.5.17"'
docker run --rm --network none -e OMNIGENT_DISABLE_CATALOG_LOOKUP=1 cfo-server:local-test
```

CI uses these commands with its own local image tags and a 45-minute job limit. Builds require network access; the prerequisite and test containers run with `--network none`, which preserves loopback for local test servers. No host directories, credentials or Docker socket are mounted into the test containers.

On Cloudflare the server's container has a 64-character hostname, its Durable Object's ID, as every `durable_object` container does; a stock Python `http.server` cannot bind under it, because `socket.getfqdn()` raises. Run the in-image suite under such a hostname as well, with `--hostname "$(openssl rand -hex 32)"` added to the last command. The integration suite below runs every server container under one (`CFO_IT_HOSTNAME=docker` keeps Docker's own).

The last command uses the existing image CMD: unit/in-process tests excluding `tests/integration`. Prerequisite checks prevent an absent app/Litestream from looking like passing skipped coverage. Inspect results and skips; do not count a skipped image test as evidence. Building the final `server` target and testing the derived `test` target do not replace a production-container smoke test or immutable artifact qualification.

The heavier [server integration suite](../images/server/tests/integration/conftest.py) uses actual containers, MinIO/Toxiproxy, generated credentials, local ports and kill/replace cleanup. Its conftest documents the required image tag and separate uv invocation. The [restore-drill Python suite](../scripts/restore-drill/tests/conftest.py) needs its own dependencies/drill image and local services; the root Python lock alone is insufficient. Its in-process fence launcher is a recording stub, not the production Cloudflare adapter. Read those suite-specific prerequisites and ownership/cleanup behavior before running; do not point them at real installation storage.

The `fork-tests` target runs the fork's Stop tests against the Omnigent the image installs, as CI does:

```bash
docker build --platform linux/amd64 -f images/server/Dockerfile --target fork-tests -t cfo-server:local-fork-tests .
docker run --rm --network none cfo-server:local-fork-tests
```

The integration suite also checks the image's labels, build record and installed source tree ([image revision](../images/server/tests/integration/test_image_revision.py)); set `CFO_OMNIGENT_FORK` to a checkout of the pinned commit for the tree comparison. These integration tests are excluded by the default image test CMD.

## Computer image tests — local Docker

The [computer Dockerfile](../images/computer/Dockerfile) has `computer` (the default, last stage) and `test` targets; the test variant adds the fake Claude and Codex CLIs first on `PATH` and their file-backed fake provider. Three layers of tests, all with synthetic values only:

```bash
# 1. The supervisor's receiver and processes, without root (also run by the Python CI job).
uv run --locked --directory python pytest tests/computer

# 2. Inside the image, as root: the same suite plus image-only tests (contents and pins,
#    Omnigent's own native-harness writers paused before their renames, Codex's restore test,
#    the real host under the supervisor, the setup terminal's tmux sessions behind the real
#    ttyd). --privileged adds the cgroup-freezer cases.
docker build --platform linux/amd64 -f images/computer/Dockerfile --target test -t cfo-computer:local-test .
docker run --rm --privileged --hostname "$(openssl rand -hex 32)" cfo-computer:local-test

# 3. The built image as containers: the supervisor as tini's only child, its death ending the
#    container, an assembled restore/install/host/terminal/capture/SIGTERM through the command
#    port (the SIGSTOP freezer pausing the terminal's tmux server under tini), and
#    (after `npm ci --prefix images/computer/integration/directory-backup`) a base and a delta
#    carried between two computers by the Sandbox SDK's real DirectoryBackup and sandbox-shim.
docker build --platform linux/amd64 -f images/computer/Dockerfile -t cfo-computer:dev .
CFO_IT_IMAGE=cfo-computer:dev uv run --no-project --with pytest==9.1.1 pytest -p no:cacheprovider images/computer/integration
```

CI runs the second layer on every pull request (and on the daily tool version check's branch), with no network and without `--privileged`, so the cgroup-freezer cases skip there. `--privileged` is only for the local cgroup case; never mount host directories or credentials. The 64-character hostname is a Cloudflare `durable_object` container's (its Durable Object ID). The in-image start-fix tests first put back what Cloudflare leaves: the hostname absent from `/etc/hosts`, and `/` owned by uid 2346. They then check that the name resolves through NSS `myhostname`, so `sudo` prints no warning; that without `myhostname` the warning shows and the supervisor's fallback mapping stops it; and that `/` goes back to root. Cloudflare's `/etc/hosts` is a read-only mount: a privileged run checks that case with a read-only bind mount it makes itself, and you can also run the suite with `-v <file>:/etc/hosts:ro`, a synthetic file without the hostname. The container suite checks the same under the real supervisor, with `/etc/hosts` mounted read-only, including the supervisor's own status saying the name resolves and Claude Code binding its messaging sockets. RC-53's collector is tested against files written by Omnigent's own code: `images/computer/tests/rc53_formats.py`, run inside the image. The repository's suite uses a committed copy, `python/tests/computer/fixtures/rc53-formats.json`, whose credentials are placeholders. The image's suite fails when that copy no longer matches what the pinned Omnigent writes; regenerate it with `rc53_formats.py templates` inside the test image. The DirectoryBackup round trip also fails a part before and after its bytes arrive, and checks that the real shim's error is one WorkspaceDO repeats and that the failed attempt left no object. The container tests create and remove their own `cfo-wp34-it-*`/`cfo-wp34-rt-*` containers and networks. Every computer container there runs under a 64-character hostname, as a Cloudflare `durable_object` container does (its Durable Object ID); a stock Python `http.server` cannot bind under it, because `socket.getfqdn()` raises. These are local qualifications of the source and the built image, not of Cloudflare: the real container disk, cgroupfs and capabilities, R2 through the platform's gateway, WorkspaceDO and real sign-ins remain staging work. [`images/computer/tools/rc53_scan.py`](../images/computer/tools/rc53_scan.py) scans staged layers, restored trees or `tar+zstd` layer archives for planted tokens in every encoded form, with per-layer controls; use it on layers downloaded from a staging bucket.

**Signing in from the page.** The supervisor's parser reads the pinned CLIs' own login output. [`images/computer/fakes/login_transcripts.json`](../images/computer/fakes/login_transcripts.json) holds that output, chunk by chunk, with every link parameter and code replaced by a placeholder. It was captured with Claude Code 2.1.311 and Codex 0.164.0 in a throwaway home: the prompts by running each login up to its prompt and killing it, the rest by running the real CLIs against local fake providers (a throwaway CA for Anthropic's hosts, and Codex's issuer override). No real sign-in happened. On a terminal, the fake CLIs replay those transcripts with synthetic canary values, take Claude's code from the pty, and fail on request (a crash, unknown output, a link on another host, a network failure, a denial). The repository's suite runs the actual supervisor against them: success, a wrong or incomplete code, expiry, cancel, unknown output, a crash, a restart, the fence, and a sign-out ending an attempt. It then scans the supervisor's files, logs, alerts and journal, the CLIs' files, the status and a capture's staged layer for the planted values. After a CLI version bump, capture the transcripts again the same way, never completing a sign-in, and check that the parser still reads them.

## Tool version check

The [daily workflow](../.github/workflows/tool-versions.yml) proposes newer releases of the pinned tools ([compatibility](compatibility.md#keeping-the-pinned-tools-current)). Its tool runs locally on Node 26, reading the public registries; it changes no file until `apply`:

```bash
node scripts/tool-versions/tool-versions.ts check --reproduce          # every current pin, recomputed, must match
node scripts/tool-versions/tool-versions.ts check --out bump.json      # newer releases and their pins
node scripts/tool-versions/tool-versions.ts apply bump.json            # write them into both Dockerfiles
```

Both `check` commands build the computer Dockerfile's `cli-digests` stage when they need the CLIs' tree digests (always for `--reproduce`; for a check, when Claude Code, Codex, a base image or pip changes), so they need Docker and network access. Then build and test both images as above. `pnpm test:scripts` covers the tool against fake registries; the workflow's propose step (git, `gh`, the pull request) runs only on GitHub.

## GitHub linking end to end — local Docker

[`images/server/tests/integration/github_linking/`](../images/server/tests/integration/github_linking/) runs Omnigent's GitHub linking across every boundary but GitHub's own: the platform Worker's real `PlatformInternal` entrypoint under `wrangler dev` (workerd, in a Node container named `platform.internal` on the test's network; [`worker/test/e2e/key-service-e2e.ts`](../worker/test/e2e/key-service-e2e.ts)), the server image's final target, the computer image with the real `omnigent host` started as its supervisor starts it, and a fake `github.com` and `api.github.com` with a certificate from the test's own authority. It connects GitHub as the owner, checks that the database and a restore of its replica hold only ciphertext, clones and calls `gh api` on the computer through the host's credential broker, samples every argv while they run (a planted canary proves the sampler sees them) and scans the computer's disk for the tokens, unlinks, and checks the computer gets no new token; a second computer's host, whose startup probe cannot reach the server, is scanned too. The launch token is minted directly in Omnigent's host store.

```bash
docker build -f images/server/Dockerfile -t cfo-wp59-server:runtime .
docker build -f images/computer/Dockerfile -t cfo-wp59-computer:runtime .
pnpm install
uv run --no-project --with pytest==9.1.1 --with httpx==0.28.1 --with cryptography==46.0.3 \
  pytest -p no:cacheprovider images/server/tests/integration/github_linking
```

Every value is generated for the run. It creates and removes `cfo-wp59-e2e-*` containers and a network; `CFO_E2E_TMP` chooses its temporary directory and `CFO_E2E_KEEP=1` keeps it, with each container's log. It is a local qualification only: the intercept, Access in front of the callback and a real GitHub App remain staging work.

## MCP registry end to end — local Docker

[`images/server/tests/integration/mcp_registry/`](../images/server/tests/integration/mcp_registry/) runs Omnigent's MCP registry across every boundary but Cloudflare's: the platform Worker's real key service under `wrangler dev` (as for GitHub linking), the server image's final target with the settings `bootstrap.ts services add tracker` stores (the shipped manifest, the installation's choices, no test switch), Omnigent's own demo OAuth MCP service over HTTPS under a public-looking name with a certificate from the test's own authority ([`run_demo.py`](../images/server/tests/integration/mcp_registry/run_demo.py) runs it unchanged and lets it accept its own name), and the computer image, where the runner's own MCP client calls the gateway with a runner's delegated token. It connects the service as the owner (refusing a forged state and a reused code), checks that the database and a restore of its replica hold only ciphertext, calls from the computer (the allowlist hides a tool the service has), forces a refresh that rotates the tokens, scans the computer's files and every process's argv and environment, exactly what a checkpoint of the computer would hold (its own scan under the checkpoint policy) and every container's log for the logins, disconnects, and checks that the next call from the computer fails at once and the record is gone from the replica. The runner's token is minted in the server container with Omnigent's own `mint_runner_token`, and the computer reaches the server directly.

```bash
docker build -f images/server/Dockerfile -t cfo-wp510-server:runtime .
docker build -f images/computer/Dockerfile --target runtime -t cfo-wp510-computer:runtime .
uv run --no-project --with pytest==9.1.1 --with httpx==0.28.1 --with cryptography==46.0.3 \
  pytest -p no:cacheprovider images/server/tests/integration/mcp_registry
```

It creates and removes `cfo-wp510-e2e-*` containers and a network; `CFO_E2E_TMP` and `CFO_E2E_KEEP=1` work as for GitHub linking. The callback through Access, the computer's private route and a real provider remain Cloudflare work.

[`worker/test/e2e/mcp-services-e2e.ts`](../worker/test/e2e/mcp-services-e2e.ts) runs the installer's real `services` step on the GitHub setup flow's harness (below): the production OmnigentServer under `wrangler dev`, whose watchdog restarts the server image's real container after each secrets change. It checks a refused origin changes nothing; `add tracker` ends ready once the restarted server reports the change's revision and Omnigent lists `mcp`; Settings → MCP is Omnigent's page; a choice the image refuses ends held (a real exit 78 the watchdog holds) and `remove` brings the server back; removing the last service turns MCP off; and it scans the logs for the run's secrets.

```bash
node worker/test/e2e/mcp-services-e2e.ts
```

## GitHub setup flow end to end — local Docker

[`worker/test/e2e/github-setup-e2e.ts`](../worker/test/e2e/github-setup-e2e.ts) runs the installer's real GitHub step (`createGitHubApp`: its local page, its progress page and its wait for GitHub linking) against the production web Worker and OmnigentServer under `wrangler dev`, whose watchdog starts and, after the step's secrets change, replaces the server image's real container through Docker ([`github-setup-platform-e2e.ts`](../worker/test/e2e/github-setup-platform-e2e.ts)). GitHub is a scripted browser that does what GitHub does, and the conversion's answer; the secrets change restarts `wrangler dev` with the new settings, as a new version; Workers Logs are the platform Worker's own lines, labelled with the version that printed them; Access is a local stand-in for the team's keys. It checks the setup page's refusals (no Access, a stranger, a foreign origin, `/_cfo/`, another hostname), that the progress page goes on to GitHub's install page only once the restarted server reports GitHub linking on, that GitHub's return to the setup URL opens Omnigent's Integrations page, that an expired local page says so and stores nothing, and scans every log and page for the run's secrets.

```bash
docker build -f images/server/Dockerfile --target server -t cfo-wp336-server:runtime .
pnpm install
node worker/test/e2e/github-setup-e2e.ts
```

It creates and removes a `cfo-wp336-e2e-server` container; `CFO_E2E_DIR` chooses its directory (default `~/.pt/wp336-e2e`). The object's version switch on Cloudflare (and its yield to a newer version), real Workers Logs, a real GitHub App and Access remain staging work.

## Certificate trust checks

Both Dockerfiles run [`images/trust/trust_check.py`](../images/trust/trust_check.py) during the build: it fails on a `ca-certificates` older than the release that removed a distrusted root, or on any shipped bundle that still holds one, matched by subject name and by public key. Its offline tests and the probe's ([`images/trust/tests`](../images/trust/tests/)) run in both images' test targets.

The network probe is opt-in. It needs outbound HTTPS, uses no credentials, and runs every TLS client found in a built image against hosts serving the forged chains of the October 2026 eMudhra compromise and against GitHub, Anthropic, OpenAI and R2:

```bash
docker run --rm -v "$PWD/images/trust:/opt/trust:ro" --entrypoint /usr/local/bin/python3 \
  cfo-computer:dev -I /opt/trust/tls_probe.py --control
docker run --rm -v "$PWD/images/trust:/opt/trust:ro" --entrypoint /usr/local/bin/python3 \
  cfo-server:local-runtime -I /opt/trust/tls_probe.py --control
```

Any answer from the server counts as acceptance, whatever else the client printed. A forged host passes only when the client refuses it with a certificate error: a network error, a reset or a timeout fails. A client that prints no cause (Codex) cannot show a certificate error, so its refusal is reported as inferred. It passes only if its log shows the TCP connection was made, no reset, network error or timeout appears, a second attempt fails the same way, and the same command, with the two roots added to the trust its own TLS stack reads, gets an HTTP answer. That control always runs for such a client. `--strict` fails inferred refusals too. `--control` reruns every client against the forged hosts with the two roots added through its own CA variable. Clients without a key denylist then connect, which shows the probe reached their real TLS path. `--good NAME=URL` adds another endpoint, such as an account's R2 S3 endpoint; the results show it, in every message, as `<NAME>`. Litestream reports its refusal after ten attempts, about two minutes.

## Existing CI and remaining qualification

Current [CI](../.github/workflows/ci.yml) runs Node checks/coverage/schema drift, the root Python project, selected source canary scans, both Worker bundles and their canary scans, plus the existing server/test image builds and isolated image unit/in-process suite, and the computer image's build and in-image suite. It uses ordinary pull requests, read-only repository permissions and pinned actions, with no registry push or deployment. The 45-minute image-job cap is an initial budget; a cached local run does not establish hosted cold-build duration.

Server S3/fault integration, Python restore-drill, candidate-only fork/artifact tests, full image filesystem/layer credential scans and real Cloudflare/provider qualification remain outside these jobs. The computer supervisor's receiver tests run in the Python job, and the computer image's build and in-image suite in its own job; the image's container suite and its cgroup-freezer cases are not in CI.

Before qualification, record actual platform/fork revisions, Worker versions, final server/computer image digests and architecture, CLI/SDK/Litestream identities, packaged contract/policy assets, commands/results/skips and accepted limits. Then test actual receivers and the selected runtime assembly: version/generation refusal, replication-before-response/ack/effect, lost replies, sleep/start fencing, pause expiry, publication/unchanged freshness, credential families/tombstones, native continuation and real browser behavior. Generic reference fixtures and source ancestry do not replace those checks.

Real R2 startup through the production watchdog on the server's instance remains pending: it was measured on `basic`, the earlier size, and the custom instance the server now starts on is not yet measured. Local quota-constrained Docker is useful evidence, not that qualification. Keep Cloudflare/provider runs manual, use reviewed revisions, preserve exact failure cases and verify cleanup/sign-out. Existing gates and findings are not closed by a green subset or a documentation change.
