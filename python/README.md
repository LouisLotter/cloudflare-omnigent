# python

This directory is a uv-managed **reference test project** that also holds the source of the Cloudflare launcher, which the server image copies in (below). It is not a packaged production computer supervisor. Its [pyproject.toml](pyproject.toml) sets `package = false`, has no runtime dependencies and discovers tests under `tests/`. Controller and supervisor work outside the integrated platform source must not be described as integrated merely because their wire contracts are present.

| Test | What it checks |
|---|---|
| [test_contracts.py](tests/test_contracts.py) | Exported draft-2020-12 JSON Schemas, valid fixtures and `invalid/` fixtures, with format checking |
| [test_contract_vectors.py](tests/test_contract_vectors.py) | Independent reference calculations for signing, tree-index hashes and checkpoint-policy vectors |
| [sandbox/](tests/sandbox/) | The Cloudflare launcher: its protocol against the fixtures, schemas, vectors and `launcher.ts` tables; each method against a [fake launcher API](tests/sandbox/fake_platform.py) over real loopback HTTP; one absolute deadline per HTTP attempt; and, where the fork's Omnigent is importable, the adapter, the registration and Omnigent's persistent-host flow (skipped otherwise) |

## The Cloudflare launcher

[cloudflare_omnigent/sandbox/](cloudflare_omnigent/sandbox/) is Omnigent's sandbox provider for cloud computers. The server image copies it to `/opt/cfo` and [registers it](../images/server/cfo_server/launcher.py); this project does not build or install it (`package = false`), and tests import it from this directory. Its protocol, settings, HTTP client and core import only the standard library, so they run here. The Omnigent adapter (`launcher.py`) and provider entry (`registration.py`) import the fork's Omnigent, which this project does not install. To run those tests too, use an environment with the pinned fork installed, for example the server image's `test` target or a virtual environment built from the fork's lockfile.

The generic schema suite does not load `refined/` cases or call every production parser. A green reference suite therefore cannot qualify an actual launcher/supervisor's cross-field rules, filesystem policy or packaged resources. See [contract authority](../contracts/README.md) and [testing](../docs/testing.md).

## Setup and local checks

Run from the repository root. Setup can download Python/dependencies:

```bash
uv sync --locked --directory python
```

With that environment installed, these commands avoid dependency syncing and uv network access:

```bash
uv run --locked --no-sync --offline --directory python ruff check
uv run --locked --no-sync --offline --directory python ruff format --check
uv run --locked --no-sync --offline --directory python pytest
```

Use Python 3.12 as selected by [.python-version](.python-version); the project requirement is `>=3.12`. CI uses uv 0.12.10. The root Python CI job covers this project only. [Server image tests](../images/server/tests/) and [restore-drill Python tests](../scripts/restore-drill/tests/) have separate dependencies and Docker/process prerequisites; they are not recursively discovered by this command. No product computer-image test target exists yet. Production packaging ownership remains an integration decision; do not relocate schemas or policy assets without checking their real consumers.
