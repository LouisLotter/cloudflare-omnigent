# contracts

The wire contract between the Worker and the processes in its containers: the computer supervisor now, and the server's gateway backend later. It is defined once, in TypeScript with zod, and checked from both TypeScript and Python.

| Path | Contents |
|---|---|
| `src/` | The zod schemas: IDs, the error body, the supervisor protocol. `wireSchemas` in `src/index.ts` registers every schema that crosses a boundary. |
| `schema/` | JSON Schema exported from `src/` by `pnpm contracts:export`. Generated and committed; CI fails if it drifts from the source. |
| `fixtures/<Schema>/` | Golden fixtures: valid examples at the top level, invalid ones under `invalid/`. Every registered schema needs at least one of each. |
| `test/` | Vitest: every fixture parses as expected and round-trips unchanged, plus property tests. |

The Python side, `python/tests/test_contracts.py`, validates the same fixtures against the exported JSON Schema.

## Changing the contract

- `contracts/` is a shared path owned by the integration lead. Other packages propose changes through a pull request to the lead.
- Each milestone starts with a contract package (schemas, fixtures, RPC interfaces and fakes), merged before its parallel work begins.
- To add a message: add its schema to `wireSchemas`, add valid and invalid fixtures, run `pnpm contracts:export`, and run both test suites.
- Versioned messages, such as `SupervisorHello`, carry a protocol or format version. A receiver rejects any version it does not support before changing state.

```bash
pnpm --filter @cfo/contracts test
pnpm contracts:export
uv run --directory python pytest
```
