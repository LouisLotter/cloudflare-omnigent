# images

The maintained product image source is [server/Dockerfile](server/Dockerfile), targeting `linux/amd64`. A production computer image/supervisor assembly remains unfinished; connector images are planned. Prototype spike images are historical reproduction tools, not selected product artifacts.

## Server image

The image builds Omnigent from a pinned fork commit, adds Litestream 0.5.17 and [cfo_server](server/cfo_server/), then restores/checks the database before starting the application. Initialized installations with an unusable replica/database/owner state enter recovery mode rather than first-visitor setup. The app wires response/transcript durability barriers and deployment-managed settings through supported Omnigent interfaces.

The integrated server still registers a [placeholder launcher](server/cfo_server/launcher.py), [disables native GitHub linking](server/cfo_server/app.py) and relies on an [unavailable private platform bridge](../worker/src/server/platform-internal.ts). Do not describe the server image as a complete cloud-computer or connected-account product.

| Dockerfile target / test location | Purpose and prerequisite |
|---|---|
| `server` | Final runtime target; builds download base images, fork source, system and Python/web dependencies |
| `test` | Existing image-local unit/in-process test target; its default command excludes `tests/integration` |
| [server/tests/integration/](server/tests/integration/) | Separate built-image tests with Docker, MinIO/Toxiproxy, generated credentials, replacement/fault cases and cleanup ownership |

Use [testing](../docs/testing.md) for the build/run recipes and their prerequisites. CI builds the existing `server` and `test` targets, requires the pinned app/entrypoint/Litestream prerequisites, and runs the image's unit/in-process suite with networking disabled. S3/fault integration and full image credential/artifact qualification remain separate. The image also has a `fork-tests` target that runs the fork's Stop tests against the installed Omnigent.

## Identity and custody

The default server fork pin is fork integration `184b5cf8b32815b48c7859973a00a139e8aa50f0`. [Compatibility](../docs/compatibility.md) maps which fixes earlier pins lacked. Record actual build arguments and immutable artifact identities before claiming a fix; source/base pins do not alone make rebuilt image bytes identical.

Builds must not embed installation credential values in images. Required server secrets are supplied at runtime, and computers are intended to hold native CLI logins and specified runtime credentials. Worker-held keys do not prevent authorized plaintext use inside a process. Follow [credential authority](../docs/decisions/0004-identity-credential-authority.md) and [the secret inventory](../docs/secrets.md) rather than a blanket “containers have no secrets” assumption. Preserve dependency licences and notices when changing the fork build or redistribution.
