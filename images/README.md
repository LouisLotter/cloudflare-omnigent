# images

The maintained product image sources are [server/Dockerfile](server/Dockerfile) and [computer/Dockerfile](computer/Dockerfile), targeting `linux/amd64`. The computer image is built and tested locally but not yet deployed or driven by its WorkspaceDO. No connector image is planned: connected accounts are Omnigent's own MCP registry in the server. Prototype spike images are historical reproduction tools, not selected product artifacts.

## Server image

The image builds Omnigent from a pinned fork commit, adds Litestream 0.5.17 and [cfo_server](server/cfo_server/), then restores/checks the database before starting the application. Initialized installations with an unusable replica/database/owner state enter recovery mode rather than first-visitor setup. The app wires response/transcript durability barriers and deployment-managed settings through supported Omnigent interfaces.

The integrated server registers the [Cloudflare launcher](server/cfo_server/launcher.py) from [python/cloudflare_omnigent](../python/cloudflare_omnigent/sandbox/), [enables Omnigent's GitHub linking](server/cfo_server/app.py) when the installation's GitHub App and the key service's keys are set, builds Omnigent's MCP registry from the [shipped manifests](server/services/) and the installation's choices, and relies on the platform Worker's private bridge, [`platform.internal`](../worker/src/server/platform-internal.ts), for the launcher API and the credential store's key service, neither yet run on Cloudflare. Do not describe the server image as a complete or qualified cloud-computer or connected-account product.

| Dockerfile target / test location | Purpose and prerequisite |
|---|---|
| `server` | Final runtime target; builds download base images, fork source, system and Python/web dependencies |
| `test` | Existing image-local unit/in-process test target; its default command excludes `tests/integration` |
| [server/tests/integration/](server/tests/integration/) | Separate built-image tests with Docker, MinIO/Toxiproxy, generated credentials, replacement/fault cases and cleanup ownership |

Use [testing](../docs/testing.md) for the build/run recipes and their prerequisites. CI builds the existing `server` and `test` targets, requires the pinned app/entrypoint/Litestream prerequisites, and runs the image's unit/in-process suite with networking disabled. S3/fault integration and full image credential/artifact qualification remain separate. The image also has a `fork-tests` target that runs the fork's Stop tests against the installed Omnigent.

## Computer image

Omnigent's host from the pinned fork commit (a mirror of the fork's `host` target, checked by its Dockerfile's SHA-256), Claude Code and Codex exactly as published at exact versions with Codex's managed settings, gh behind the host's credential-broker wrapper, the Sandbox SDK's `sandbox-shim`, ttyd, and the supervisor [cfo_computer](computer/cfo_computer/) as tini's only child. [Architecture](../docs/architecture.md#the-computer-image) describes what it does.

| Dockerfile target / test location | Purpose and prerequisite |
|---|---|
| `computer` | Final runtime target (the last stage, which Wrangler builds); downloads base images, fork source, the CLIs, gh, ttyd and `sandbox-shim` |
| `test` | The same image with the fake CLIs first on `PATH`; its default command runs `python/tests/computer` and [computer/tests/](computer/tests/) inside the image, as root |
| [computer/integration/](computer/integration/) | Built-image tests with Docker: the supervisor as the main process, an assembled capture through the command port, and a DirectoryBackup round trip with the real SDK (needs `npm ci` in `directory-backup/`) |
| [computer/tools/rc53_scan.py](computer/tools/rc53_scan.py) | RC-53's layer scan for staged layers, restored trees and `tar+zstd` layer archives |

## Certificate trust

[trust/](trust/) holds the trust check both Dockerfiles run while building (it fails on a stale `ca-certificates` or on any shipped bundle that still trusts a distrusted root) and an opt-in network probe of every TLS client in a built image. See [testing](../docs/testing.md#certificate-trust-checks) and, for responding to a distrusted authority, [credential incidents](../docs/operations/security.md#distrusted-certificate-authorities).

## Identity and custody

The default server fork pin is the fork's 0.20.0 assembly `212fc5886522931b0e96ffc4f5edc1d5145dd2fa` (`cfo/upgrade-0.20.0`); the computer image pins the same commit, and a 0.20.0 server launches new runners only on a computer of the same release. [Compatibility](../docs/compatibility.md) maps which fixes earlier pins lacked. Record actual build arguments and immutable artifact identities before claiming a fix; source/base pins do not alone make rebuilt image bytes identical.

Builds must not embed installation credential values in images. Required server secrets are supplied at runtime, and computers are intended to hold native CLI logins and specified runtime credentials. Worker-held keys do not prevent authorized plaintext use inside a process. Follow [credential authority](../docs/decisions/0004-identity-credential-authority.md) and [the secret inventory](../docs/secrets.md) rather than a blanket “containers have no secrets” assumption. Preserve dependency licences and notices when changing the fork build or redistribution.
