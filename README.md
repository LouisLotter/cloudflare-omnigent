# cloudflare-omnigent

A Cloudflare deployment layer for [Omnigent](https://github.com/omnigent-ai/omnigent): authenticated ingress, a durable server, and an intended fleet of persistent cloud computers in one person's own Cloudflare account. This is an independent open-source project, not an official Omnigent or Cloudflare service.

## Status — 24 October 2026

| Component | Current state |
|---|---|
| Server base | Integrated source for owner-only ingress, two Worker configurations, server lifecycle/recovery, SQLite replication with Litestream, durability barriers, bootstrap and restore-drill tools. Production qualification remains incomplete. |
| Cloud computers | Version-one contracts and the Cloudflare launcher (Omnigent's provider plugin, registered by the server image) are integrated. Controller, private routes and supervisor remain separate partial drafts; there is no qualified end-to-end computer assembly. |
| Connected accounts | Platform connection service and connector runtimes are planned. Omnigent's own GitHub linking is wired (the installation's GitHub App, made by the installer, and the platform Worker's key service), tested locally, not yet on Cloudflare. |

Main registers the [Cloudflare launcher](python/cloudflare_omnigent/sandbox/), but its [private platform bridge](worker/src/server/platform-internal.ts) still returns unavailable and no deployment sets the launcher's signing key, so no physical computer effect can happen yet. The presence of fork capabilities, contracts or the launcher does not make cloud computers usable.

The [compatibility snapshot](docs/compatibility.md) identifies exact revisions and pins. The default server image uses an older fork commit than current fork integration and lacks later Stop and history-resume corrections. No production-ready release or selected, fully qualified image pair is claimed here.

## How it fits together

The **web Worker** owns public ingress and forwarding. The **platform Worker** owns Durable Objects, container bindings and private virtual hosts; it has no public route. Omnigent owns conversations, schedules, approvals and application work. The platform supplies provider lifecycle and storage interfaces rather than duplicating that state.

Cloud computers are intended to be persistent Omnigent hosts shared by conversations. Their checkpoint and lifecycle rules are described in the [architecture](docs/architecture.md) and [engineering decisions](docs/decisions/README.md), with implementation limits alongside each decision. The project requires provider-neutral capabilities in the [Omnigent fork](https://github.com/LouisLotter/omnigent).

Credentials require precise custody: server secrets, computer CLI logins and transient credential use are different materials. Worker-held encryption keys do not imply that usable credentials never reach process memory. Computers and delegated runners also have broad owner-equivalent application access. See the [security model](SECURITY.md) and [identity/credential decision](docs/decisions/0004-identity-credential-authority.md).

## Start contributing

[CONTRIBUTING.md](CONTRIBUTING.md) separates dependency downloads, local checks, Docker tests and account-backed qualification. From a clean checkout, the Node workspace's basic path is:

```bash
pnpm install --frozen-lockfile
pnpm check
```

Installation can download dependencies. The checks use local Node/workerd tooling and synthetic test inputs after setup; they do not deploy or qualify real Cloudflare/provider behavior. Python reference checks, additional CI obligations and test prerequisites are described in [contributing](CONTRIBUTING.md) and [testing](docs/testing.md).

| Directory | Purpose |
|---|---|
| [contracts/](contracts/README.md) | Wire schemas, lifecycle/policy authority, committed schemas, fixtures and vectors |
| [worker/](worker/README.md) | Web/platform Workers, Durable Objects and local test runtimes |
| [python/](python/README.md) | Python schema/vector reference checks |
| [images/](images/README.md) | Server image and image-local tests |
| [scripts/](scripts/README.md) | Canary scanner, guarded staging/bootstrap and restore tools |
| [spikes/](spikes/README.md) | Historical experiments and retained reproduction harnesses |

For operation-specific prerequisites, use [recovery](docs/operations/recovery.md), [security operations](docs/operations/security.md) and [troubleshooting](docs/operations/troubleshooting.md). Source and documentation are licensed under [Apache-2.0](LICENSE); retain applicable notices when redistributing dependencies or evidence.
