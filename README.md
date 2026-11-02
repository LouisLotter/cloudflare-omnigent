# cloudflare-omnigent

A Cloudflare deployment layer for [Omnigent](https://github.com/omnigent-ai/omnigent): authenticated ingress, a durable server, and an intended fleet of persistent cloud computers in one person's own Cloudflare account. This is an independent open-source project, not an official Omnigent or Cloudflare service.

## Status — 2 November 2026

| Component | Current state |
|---|---|
| Installation | The owner's installation has run on Cloudflare since 29 October and on Omnigent 0.20 since 31 October. This is one personal installation, not completion of the staging release gates (G3/G5), multi-user qualification or disaster recovery from scratch. |
| Cloud computers | The owner's installation runs Claude Code and Codex sessions on cloud computers. PRs #62 and #63 were written by Codex on one. Several users per installation are not qualified. |
| Personal hosts | Personal machines can join through the Cloudflare One Client; the first run on the owner's installation was 1 November (WP3.43). Reboot, a lapsed client session and a revoked device remain open lifecycle cases. |
| Updates | `update` takes a restore point, holds a read-only acceptance window and can roll back before acceptance. Since PR #64 it accepts only when the GitHub and MCP integrations that were enabled remain enabled. The owner's successful update does not qualify every release or recovery check. |
| Connected services | GitHub and, since PR #65, OpenRouter run through Omnigent's MCP gateway, so agents do not receive their service keys. Native GitHub tokens are still available to local processes while its broker runs; native Claude/Codex logins use their separate computer credential stores. |

The [compatibility snapshot](docs/compatibility.md) identifies exact revisions and pins. Implemented source, packaged artifacts and the owner's runtime experience are evidence at different levels; none of the status above claims a fully qualified release or completion of the open gates.

## Install

To set up your own installation in your Cloudflare account with one command, follow the [install guide](docs/install.md). It lists what the account needs first (the Workers Paid plan, R2, a domain and a Zero Trust organization), the two sign-ins, and what happens at the first sign-in.

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
