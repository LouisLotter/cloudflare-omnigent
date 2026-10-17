# cloudflare-omnigent

Run [Omnigent](https://github.com/omnigent-ai/omnigent) on Cloudflare: Workers and Durable Objects as the control plane, and Containers for the Omnigent server, cloud workspaces and browser-based MCP connectors.

This is an independent project. It is not an official Omnigent or Cloudflare project.

## Status

**Planning.** The repository contains no runnable code yet. The design is under review, and implementation starts once it is settled.

## What it adds to Omnigent

Omnigent already runs agents on laptops and in managed sandboxes. This project keeps Omnigent as the application and adds a Cloudflare platform around it:

- **Cloud workspaces** that start on demand, checkpoint to R2 and resume later. Laptop hosts keep working alongside them.
- **Per-account connections**, such as GitHub and LinkedIn, whose credentials stay in a Durable Object and never enter an agent's container.
- **Scheduled and event-driven runs** that wake the right workspace exactly once.
- **Credential isolation.** Containers reach model APIs, git and storage only through Worker code that adds credentials on the way out.

## Architecture at a glance

| Part | Runs as | Responsibility |
|---|---|---|
| Worker | Cloudflare Worker | Public entry point; routes traffic to the Omnigent server; handles the internal hostnames that containers call |
| `OmnigentServer` | Container | The unmodified Omnigent server image plus this project's Python plugin |
| `ControlDO` | Durable Object | Admission, capacity and wake tickets |
| `WorkspaceDO` | Durable Object with a container | One cloud workspace: lifecycle, leases and checkpoints |
| `ConnectionDO` | Durable Object | One connected account: credential custody and the operation journal |

## How it relates to Omnigent

The platform uses Omnigent only through its extension points, such as the `omnigent.sandbox_providers` entry point. Where Omnigent lacks a seam, the change is made as a small, generic branch in the fork [`LouisLotter/omnigent`](https://github.com/LouisLotter/omnigent). Changes are offered upstream only after they have been tested heavily through this platform.

## Repository layout

```text
contracts/   Python–Worker wire contract: schemas and golden fixtures
worker/      the Worker, Durable Objects and their tests
python/      the Omnigent plugin: sandbox provider and control-plane client
images/      container images: server, workspace, LinkedIn connector
docs/        design documents
```

Each folder has a README describing what will live there.

## Principles

- Platform state lives in Durable Objects. The platform adds no tables to Omnigent's database.
- Each Durable Object's behavior is a pure state machine inside a thin class, so crash and retry behavior can be tested directly.
- No provider credentials in containers.
- One wire contract, defined once and used by both languages.
- Beta Cloudflare APIs are used only behind small adapter modules, with exact version pins.
- Everything is public. Secrets and account-specific configuration live in Cloudflare secrets and local configuration, never in this repository.

## License

[Apache-2.0](LICENSE), the same as Omnigent.
