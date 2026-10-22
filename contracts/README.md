# contracts

The wire contract between the Worker and the processes in its containers: the computer supervisor, the server's Cloudflare launcher, and the gateway backend later. It is defined once, in TypeScript with zod, and checked from both TypeScript and Python.

| Path | Contents |
|---|---|
| `src/` | The zod schemas: IDs and timestamps, the error body, M2's contracts (the Access assertion claims, the two 424 "durability unconfirmed" bodies, the outage record, the bootstrap status, the replication position) and M3's (below). `wireSchemas` in `src/index.ts` registers every schema that crosses a boundary. |
| `schema/` | JSON Schema exported from `src/` by `pnpm contracts:export`. Generated and committed; CI fails if it drifts from the source. |
| `fixtures/<Schema>/` | Golden fixtures: valid examples at the top level, invalid ones under `invalid/`, and under `refined/` the ones invalid only by a cross-field rule that JSON Schema cannot express (TypeScript refuses them; a Python reader checks those rules itself, and each schema's comment lists them). Every registered schema needs at least one valid and one `invalid/` fixture. |
| `vectors/` | Cross-language test vectors: the launcher API's signatures, the tree index's digest and the checkpoint policy's decisions. Both test suites check them. |
| `test/` | Vitest: every fixture parses as expected and round-trips unchanged, plus property tests. |

The Python side, `python/tests/`, validates the same fixtures against the exported JSON Schema and checks the vectors.

## M3's contracts (3.C)

| Module | Contract |
|---|---|
| `launcher.ts` | The launcher API on `platform.internal`: its eleven operations as `LauncherRequest` and `LauncherResult`, the HMAC envelope with key IDs (core change 19's envelope, its own first line), the protocol version, the typed status and admission, `claim_start` and attempt-bound `start_host`, `suspend`'s outcomes, and per operation its idempotency rule, durability wait and error mapping. |
| `computer-protocol.ts` | The computer API between the supervisor and WorkspaceDO, both directions: protocol version, reports, the pause lease, captures, restores, credential checkpoints, host start parameters, with an operation ID and an idempotency rule per message; the intercepts' trusted props. |
| `manifests.ts` | Version 1 of the workspace manifest (a base and deltas, each layer carrying its own index; the tree digest) and of the credential checkpoint (the declared files with copy orders and tombstones). |
| `checkpoint-policy.ts` | Version 1 of the credential families and the checkpoint policy, from S6's classification: one ordered rule list for capture, prune and restore. |
| `lifecycle.ts` | WorkspaceDO's state × event table as typed data, with its reference interpreter `step`, the typed status, sign-out verification and the timing budget. Saving is a flag, not a state. |
| `controllers.ts` | The payloads of WorkspaceDO's and ControlDO's RPC, with interface versions; the TypeScript interfaces are in `worker/src/shared/rpc.ts`. |
| `setup-cards.ts` | The Claude and Codex setup cards' states, derived, never stored. |

The fakes for M3 are in `worker/test/support/`: `fake-computer-container.ts` (refuses starts after a stop, keeps stop records, drops connections), `fake-control.ts` and `fake-workspace.ts`.

## Changing the contract

- `contracts/` is a shared path owned by the integration lead. Other packages propose changes through a pull request to the lead.
- Each milestone starts with a contract package (schemas, fixtures, RPC interfaces and fakes), merged before its parallel work begins.
- To add a message: add its schema to `wireSchemas`, add valid and invalid fixtures, run `pnpm contracts:export`, and run both test suites.
- Versioned messages carry a protocol, format or interface version. A receiver rejects any version it does not support before changing state.

```bash
pnpm --filter @cfo/contracts test
pnpm contracts:export
uv run --directory python pytest
```
