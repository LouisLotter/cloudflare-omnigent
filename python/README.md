# python

This directory is currently a uv-managed **reference test project**, not a packaged production computer supervisor. Its [pyproject.toml](pyproject.toml) sets `package = false`, has no runtime dependencies and discovers tests under `tests/`. Controller, supervisor and launcher work outside the integrated platform source must not be described as integrated merely because their wire contracts are present.

| Test | What it checks |
|---|---|
| [test_contracts.py](tests/test_contracts.py) | Exported draft-2020-12 JSON Schemas, valid fixtures and `invalid/` fixtures, with format checking |
| [test_contract_vectors.py](tests/test_contract_vectors.py) | Independent reference calculations for signing, tree-index hashes and checkpoint-policy vectors |

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
