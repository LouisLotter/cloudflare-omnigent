# worker

The single Worker deployment: ingress, the forwarding path to the Omnigent server, platform pages, the private virtual hosts that containers call, and every Durable Object.

## Now

The M0 scaffold: an entry point with a health check, `ControlDO` with its schema migrations, shared error codes and the migration runner, with unit and Workers-runtime tests.

## Planned layout

From the code-structure plan. The milestone is when each part arrives.

| Path in `src/` | Responsibility | Milestone |
|---|---|---|
| `index.ts`, `env.ts` | Router; exports the DO classes and entry points | M0 |
| `shared/` | Typed DO RPC interfaces (`rpc.ts`), error codes, IDs, migrations, crypto, audit | M0 onward |
| `ingress/` | Access assertion validation, hostname allowlist, identity-header stripping, coarse rate limits | M2 |
| `server/` | `OmnigentServer` (always on, watchdog), the one forwarding path (`forward.ts`) with the managed-settings guard, the public proxy; later schedule observation and run-now wake | M2, M3, M4 |
| `control/` | `ControlDO`: limits and reservations, the platform's Omnigent login, the schedule cache and availability gaps | M2, M3, M4 |
| `computer/` | `WorkspaceDO`: identity, lifecycle and generations, admission, idle, sizing, checkpoints, the container port, the setup terminal, network intercepts | M3 |
| `internal/` | Virtual hosts reachable only from containers: `omnigent.internal`, the computer API, later `mcp.internal` | M3, M5 |
| `pages/` | Platform pages: cloud computers, setup, connected accounts | M3, M5 |
| `connection/` | `ConnectionDO`: vault, journal, provider registry, OAuth, provider adapters | M5 |
| `egress/` | `git.internal` and the backup gateway | M3, M5 |

## Module rules

- Each Durable Object keeps its behavior in pure state-machine modules. Pure modules import nothing from `cloudflare:workers`, so they run in plain Node tests.
- Only `container-port.ts` modules touch `ctx.container` or Sandbox SDK helpers.
- Durable Objects call each other only through the typed RPC methods in `shared/rpc.ts`.
- Every inbound payload is parsed with a `contracts` schema before use.
- Mutations take an operation ID and, where it applies, the expected generation. Persist the transition before the effect.

## Tests

| Folder | Runs in | Covers |
|---|---|---|
| `test/unit/` | Node (`vitest.unit.config.ts`) | Pure modules, with fast-check property tests |
| `test/workers/` | workerd through `@cloudflare/vitest-plugin` (`vitest.workers.config.ts`) | Real DO SQLite, alarms and RPC, evicting the object between steps |
| `test/e2e/` | `wrangler dev` with Docker (later) | Containers, interception, the private host route, checkpoints |

```bash
pnpm --filter @cfo/worker test        # unit, then Workers runtime
pnpm --filter @cfo/worker typecheck
pnpm --filter @cfo/worker dry-run     # wrangler deploy --dry-run
```

## Configuration and deployment

`wrangler.jsonc` is a shared file owned by the integration lead. `workers.dev` and preview URLs stay disabled. Deploy only through the guarded deployment script, which uses `cfo-stg-` names in staging and refuses the wrong account.
