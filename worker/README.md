# worker

Two deployments share this source tree. The [platform configuration](wrangler.jsonc) owns Durable Objects and containers without a public route; the [web configuration](wrangler.web.jsonc) owns authenticated public ingress and binds to the platform. [ADR 0002](../docs/decisions/0002-two-workers-native-transport.md) explains the split and reconnect obligations.

## Current source

| Path | Responsibility |
|---|---|
| [src/index.ts](src/index.ts), [src/env.ts](src/env.ts) | Platform exports, binding and environment contracts |
| [src/web.ts](src/web.ts) | Web ingress and forwarding entrypoint |
| [src/ingress/](src/ingress/) | Access assertions, owner identity, hostname/origin checks and request limits |
| [src/server/](src/server/) | Server Durable Object, watchdog, native-port adapter, forwarding and bootstrap status |
| [src/control/](src/control/) | Installation control storage/migration scaffold; no application schedule cache |
| [src/shared/](src/shared/) | Versioned RPC, IDs, errors, migrations and shared helpers |

The current [private platform entrypoint](src/server/platform-internal.ts) returns unavailable before effects. Computer controller/routes, platform pages and connection services are unfinished integration, not features implied by this directory layout. Omnigent remains the application scheduler and work authority; the platform has no application login or mirrored schedule state.

## Local checks

After [dependency setup](../CONTRIBUTING.md), run from the repository root:

```bash
pnpm --filter @cfo/worker test:unit
pnpm --filter @cfo/worker test:workers
pnpm --filter @cfo/worker typecheck
```

Unit tests use Node. Workers tests use local workerd with real test Durable Object storage, alarms and eviction under [wrangler.test.jsonc](wrangler.test.jsonc). They do not qualify a deployed Containers service or a real computer route.

Check each production configuration explicitly:

```bash
WRANGLER_SEND_METRICS=false pnpm --filter @cfo/worker exec wrangler deploy --dry-run --config wrangler.jsonc --outdir dist/platform
WRANGLER_SEND_METRICS=false pnpm --filter @cfo/worker exec wrangler deploy --dry-run --config wrangler.web.jsonc --outdir dist/web
```

These commands bundle locally and write generated output; they do not deploy. The package's existing `dry-run` script checks only the default platform configuration and writes to `dist`. The explicit pair above uses `dist/platform` and `dist/web` to match the [testing guide](../docs/testing.md); CI does not yet check both configurations. See that guide for coverage and [compatibility](../docs/compatibility.md) for artifact/qualification limits.

Keep beta container APIs behind their adapters and pure logic free of `cloudflare:workers`. Parse inbound payloads, preserve operation/version/generation checks and persist transitions before effects. Retain [worker-configuration.d.ts](worker-configuration.d.ts): the type-drift check intentionally depends on that generated file. Production and account operations use the owner/review boundaries in [AGENTS.md](../AGENTS.md).
