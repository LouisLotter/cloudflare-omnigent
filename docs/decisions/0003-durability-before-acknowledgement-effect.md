# 0003 — Durability before acknowledgement or effect

Status: accepted design. Two server barriers and the launcher's effect fence are implemented in main; the effect fence is not yet qualified against a real platform receiver.

## Context

The server commits to local SQLite and replicates asynchronously with Litestream to R2. A successful local commit can be lost with its container. Holding an HTTP response cannot order effects already performed inside that request, and a scheduled wake has no browser response. Transcript senders can discard their copy as soon as an acknowledgement arrives.

## Decision

Keep three distinct barriers:

| Boundary | What must wait | Failure meaning and retry |
| --- | --- | --- |
| Security response | A response for effective account, grant, token, host, schedule, linked-account or MCP-server writes, and for what a team takes away (invitations, memberships, approvers, approval settings, policies, thread shares), waits until `replicated_txid` covers the committed position. | An otherwise successful response becomes `424 durability_unconfirmed`, `applied: true`; retain cookies and the route's error shape. Check state before repeating. |
| Transcript acknowledgement | Transcript items and turn-end `idle`/`failed` edges wait through `create_app(durability_barrier=...)`. | HTTP 503 or a retryable tunnel error asks the sender to retry with the same `source_id` or status `Idempotency-Key`. |
| Launcher effect | Before `provision`, `start_host`, `suspend` or `terminate`, wait for all database commits made before the call. | A timed-out fence sends no effect. Unknown outcomes after a sent call reconcile under stable operation identity. |

The response barrier observes SQLAlchemy writes and wraps the app as outermost ASGI middleware. Bookkeeping-only updates and inserts changing no row do not count. A WebSocket has its own scope; its writes must not hold unrelated responses. No blocking database commit hook may freeze the server event loop.

A table joins the barrier when a person is told a change took effect and losing it would give back access, a credential or a permission someone took away, or undo a narrowing. Each table makes its writes wait for the replica and answer `424` while it is blocked, so ordinary work stays out. Identity bindings are written by a first sign-in, so they are not held. A thread's new grants are not held either: every new thread inserts its owner's, and a lost grant gives back nothing; only a plain insert is exempt, so a replacing one still counts. Revoking a grant is held, and so is the sharing route, because a share can lower a level through the same upsert. A thread's deletion removes its grants, so it is held as well.

Some settings that decide who may see or do what in a thread live in tables written by ordinary use (`conversations`, labels, launch metadata), so the request is held instead of the table. A thread's settings request (`PATCH /v1/sessions/{id}`) is held when its body sets `share_workspace_files`, which lets view-level collaborators browse the workspace, or a permission mode, approval mode, launch arguments or the Codex sandbox bypass, which decide what the agent may do without asking. Presence is the signal, whatever the value, as in Omnigent's own permission tiers. The barrier reads the body as the app pulls it, changing nothing and reading nothing twice; a body too large or not a JSON object is held, to be safe. A title, archive or model change is not held. Held routes, and the choice of a 424 body's shape, match the path Omnigent routes: below `OMNIGENT_WEB_BASE_PATH`, which Omnigent strips after the barrier has seen the request, and below the ASGI `root_path`.

Background work that writes a held table has no response to hold: a scheduled run, or the sweep that expires team invitations before each admission push. Such a commit holds every write request in flight instead (an orphan commit), so a lost context never yields a false "confirmed". While the replica is blocked, an unrelated request can therefore answer `424` though it changed nothing held. This costs availability, not only latency, and it is the deliberate price of never confirming early. A lost expiry is harmless: redemption checks an invitation's expiry itself.

Approval verdicts are not held. Every protected action writes them (the request, its single consumption, its outcome), and holding them would not help: the approved effect happens before the response, so a held response cannot make the consumption durable before the effect. A consumption lost with the server can let the same, still valid approval authorize a duplicate external effect without a new human decision, bounded by the approval's expiry and its full binding. Closing that needs the consumption made durable before the effect, or the destination enforcing idempotency; it is a follow-up.

The transcript hook uses one bounded asynchronous deadline below sender acknowledgement timeouts. Running edges, usage and arbitrary state do not acquire this guarantee automatically. The launcher runs its synchronous replication wait in the worker thread used by Omnigent's launcher calls.

Creation must persist the pending host before provisioning. A launch token must be durable before publication to a computer; sleep must revoke it durably before stopping. Removal must be durable before the platform records its removal intent, which fences later wakes. Follow-up writes lost after effects require reconciliation; the response barrier cannot make them atomic with external systems.

## Alternatives and consequences

One response barrier for everything misses scheduled and in-request effects. A blocking commit hook prevented progress and could have its error masked by application handling. Accepting every transcript acknowledgement at local commit loses the last sender copy after replacement. Stable identifiers make transcript retries safe; they do not make arbitrary applied security changes safe to repeat.

Unreplicated data can still be lost. Replication catch-up and restore durations are operational observations, not a universal loss guarantee. Checkpoint publication is a separate computer-storage boundary covered by [ADR 0005](0005-checkpoint-publication-continuation.md).

## Implementation and qualification

Main [installs both server barriers](../../images/server/cfo_server/app.py); [barrier code](../../images/server/cfo_server/barrier.py) and [Litestream adapter](../../images/server/cfo_server/litestream.py) define their behavior. Tests include [real-route response handling](../../images/server/tests/test_response_barrier_routes.py), [transcript hook](../../images/server/tests/test_transcript_barrier.py) and [forwarding without retries](../../worker/test/unit/forward.test.ts).

The fork supplies [the durability hook](https://github.com/LouisLotter/omnigent/blob/184b5cf8b32815b48c7859973a00a139e8aa50f0/omnigent/server/durability.py) and [its tests](https://github.com/LouisLotter/omnigent/blob/184b5cf8b32815b48c7859973a00a139e8aa50f0/tests/server/test_durability.py). Main's [Cloudflare launcher](../../python/cloudflare_omnigent/sandbox/core.py) applies the effect fence, wired by the [server image](../../images/server/cfo_server/launcher.py) to the same Litestream position as the barriers; [image tests](../../images/server/tests/test_launcher_registration.py) block replication and observe no request, and [launcher tests](../../python/tests/sandbox/) cover each effect and Omnigent's persistent-host flow against a fake launcher API. The launcher API's receiver is not built yet. Reported Litestream/R2 experiments establish only their recorded cases. Final image identity, startup on the server's instance and the full creation/re-arm/suspend/removal crash matrix remain separate qualification requirements.
