# images

The maintained product image sources are [server/Dockerfile](server/Dockerfile) and [computer/Dockerfile](computer/Dockerfile), targeting `linux/amd64`. The computer image is built and tested locally but not yet deployed or driven by its WorkspaceDO; connector images are planned. Prototype spike images are historical reproduction tools, not selected product artifacts.

## Server image

The image builds Omnigent from a pinned fork commit, adds Litestream 0.5.17 and [cfo_server](server/cfo_server/), then restores/checks the database before starting the application. Initialized installations with an unusable replica/database/owner state enter recovery mode rather than first-visitor setup. The app wires response/transcript durability barriers and deployment-managed settings through supported Omnigent interfaces.

The integrated server registers the [Cloudflare launcher](server/cfo_server/launcher.py) from [python/cloudflare_omnigent](../python/cloudflare_omnigent/sandbox/), [disables native GitHub linking](server/cfo_server/app.py) and relies on an [unavailable private platform bridge](../worker/src/server/platform-internal.ts). Do not describe the server image as a complete cloud-computer or connected-account product.

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

## Identity and custody

The default server fork pin is fork integration `3228d4de38ef05f69ecc80a4539d7c02727ce314`; the computer image pins the same commit. [Compatibility](../docs/compatibility.md) maps which fixes earlier pins lacked. Record actual build arguments and immutable artifact identities before claiming a fix; source/base pins do not alone make rebuilt image bytes identical.

Builds must not embed installation credential values in images. Required server secrets are supplied at runtime, and computers are intended to hold native CLI logins and specified runtime credentials. Worker-held keys do not prevent authorized plaintext use inside a process. Follow [credential authority](../docs/decisions/0004-identity-credential-authority.md) and [the secret inventory](../docs/secrets.md) rather than a blanket “containers have no secrets” assumption. Preserve dependency licences and notices when changing the fork build or redistribution.
