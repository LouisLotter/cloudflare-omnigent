# worker

The single Worker deployment and its Durable Objects.

Planned contents:

| Area | Responsibility |
|---|---|
| Server | `OmnigentServer` container class and the public proxy, which forwards traffic to Omnigent and blocks internal platform routes |
| Internal hosts | Handlers for the hostnames the server container calls, such as `control.internal` and `mcp.internal` |
| `ControlDO` | Admission, capacity and wake tickets |
| `WorkspaceDO` | Workspace lifecycle, leases, checkpoints and egress rules |
| `ConnectionDO` | Connected accounts, credential vault and operation journal |
| Egress | Entry points that add credentials to outbound model, git and backup traffic |

Module rules:

- Each Durable Object keeps its behavior in pure state-machine modules that run in plain Node tests.
- Only one adapter module per Durable Object touches container or Sandbox SDK APIs.
- Every inbound payload is parsed with a `contracts` schema before use.

Tests run in three layers: unit tests in Node, Workers-runtime tests for Durable Objects, and local end-to-end tests with `wrangler dev` and Docker.
