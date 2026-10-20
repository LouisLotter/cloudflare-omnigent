# python

The Python side of the platform: the distribution `cloudflare-omnigent`, managed with uv.

| When | Contents |
|---|---|
| Now (M0) | Contract tests. `tests/test_contracts.py` validates every golden fixture in `contracts/fixtures/` against the JSON Schema exported to `contracts/schema/`. |
| M3 | The computer supervisor (WP3.4), installed into the `images/computer` image |
| M5 | The Omnigent MCP gateway backend and connection service (WP5.4) |

```bash
uv run --directory python pytest
uv run --directory python ruff check
```
