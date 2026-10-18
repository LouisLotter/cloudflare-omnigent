# cloudflare-omnigent

Run [Omnigent](https://github.com/omnigent-ai/omnigent) on Cloudflare: Workers and Durable Objects as the control plane, and Containers for the Omnigent server, cloud computers and browser-based connectors.

This is an independent project. It is not an official Omnigent or Cloudflare project.

## Status

**In development.** Milestone M0, foundations, is done: the wire contract, a Worker with one Durable Object, tests in TypeScript and Python, CI, and a guarded staging tool. Milestone M1 is a set of throwaway spikes under [`spikes/`](spikes/) that settle the design's open questions. Nothing is deployable yet.

## What it does

The goal is to bring advanced Claude and Codex use, with accounts such as GitHub and LinkedIn already connected, to people who would never set it up themselves. Each installation serves one person, in that person's own Cloudflare account. It is open-source software, not a hosted service.

- **Cloud computers are ordinary Omnigent hosts.** Each is one container running one long-lived `omnigent host` with a fixed host identity. It appears in Omnigent's host picker like a laptop, and conversations share it. It wakes when needed and sleeps when idle.
- **Sign-in happens on the computer.** The person signs in once to the unmodified Claude Code and Codex CLIs through the providers' own flows. Platform code never reads those logins.
- **Checkpoints to R2.** A computer's files are saved after each completed turn, at most every 10 minutes. Logins have their own small checkpoint, and are restored into the same computer, never cloned.
- **An always-on Omnigent server** keeps its SQLite database on the container disk, replicated continuously to R2 with Litestream. Security-relevant writes wait until they are replicated, or report that durability is not yet confirmed.
- **Owner-only Cloudflare Access** sits in front of everything, together with Omnigent's own login. The owner account is pre-provisioned, so there is no public setup page.
- **Platform pages** next to Omnigent: cloud computers (add, size, status, restore notices), a short-lived setup page with a terminal and the sign-in cards, and connected accounts.
- **Connected accounts** come from a provider registry built for many platforms. Their credentials stay encrypted in Durable Objects and never reach a computer; agents use them through Omnigent's MCP gateway.
- **Scheduled runs** fire from Omnigent's own scheduler. The platform wakes the pinned computer ahead of time and reports availability gaps instead of replaying missed runs.

## Architecture at a glance

| Part | Runs as | Responsibility |
|---|---|---|
| Worker | Cloudflare Worker | Access assertion checks and hostname allowlist; the one forwarding path to the server; platform pages; private virtual hosts for containers; git egress |
| `OmnigentServer` | Durable Object with an always-on container | The Omnigent server, with SQLite replicated by Litestream |
| `WorkspaceDO` | Durable Object per cloud computer, with a container while awake | Host identity, lifecycle and generations, wake and idle, checkpoint manifests |
| `ControlDO` | Durable Object per installation | Limits and capacity reservations, the schedule cache and wake plans, availability gaps, the platform's own Omnigent login |
| `ConnectionDO` | Durable Object per connected account | Encrypted credentials, revocation, operation journal; a LinkedIn browser container on demand |

## How it relates to Omnigent

Omnigent stays the application: its interface, conversations, harnesses, host protocol, tool policies and approvals. The server, cloud computers and scheduled runs need no Omnigent changes, provided the database durability barrier passes its tests. Connected accounts need two small, generic core changes, made as separate branches in the fork [`LouisLotter/omnigent`](https://github.com/LouisLotter/omnigent) and offered upstream only after heavy testing through this platform.

## Design

The design documents (architecture, code structure and implementation plan, with the reviews behind them) are maintained outside this repository. The summary above follows the current design.

## Development

You need Node.js 26 (see `.node-version`; at least 24), pnpm 11.15.1, Python 3.12 with [uv](https://docs.astral.sh/uv/), and Docker for local container tests.

```bash
pnpm install
pnpm check                        # lint, typecheck, unit and Workers-runtime tests
uv run --directory python pytest  # Python contract tests
```

After changing a contract schema, run `pnpm contracts:export` and commit the regenerated JSON Schema. Contributor and agent rules are in [`AGENTS.md`](AGENTS.md).

## Repository layout

```text
contracts/   wire contract: zod schemas, exported JSON Schema, golden fixtures
worker/      the Worker, its Durable Objects and their tests
python/      Python side: contract tests now, the supervisor and gateway backend later
images/      container images: server, computer, LinkedIn connector
spikes/      throwaway M1 experiments
scripts/     repository tools: canary scanner, guarded staging tool
docs/        the secret checklist
```

Each folder has a README describing what lives there.

## Principles

- Omnigent keeps its own data in its own database. Platform state lives in Durable Objects, and the platform adds no tables to Omnigent's database.
- Each Durable Object's behavior is a pure state machine inside a thin class, so crash and retry behavior can be tested directly.
- No platform secrets or connected-account credentials in containers. A cloud computer holds only the person's own logins.
- One wire contract, defined once and checked by both languages.
- Beta Cloudflare APIs are used only behind small adapter modules, with exact version pins.
- Everything is public. Secrets and account-specific configuration live in Cloudflare secrets and local configuration, never in this repository.

## License

[Apache-2.0](LICENSE), the same as Omnigent.
