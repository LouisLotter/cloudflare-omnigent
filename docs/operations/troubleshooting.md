# Troubleshooting

Start with the selected [source/artifact combination](../compatibility.md). Main contains the server base and computer contracts; the computer controller/routes/supervisor/launcher remain paused drafts. The platform pages and status notices described for computers below are required behavior, not screens already available in main.

## Lost replies and durability

| Signal | What it establishes | What to do |
| --- | --- | --- |
| `424 durability_unconfirmed`, `applied: true` | The security change committed locally; replica confirmation missed its deadline. Cookies may already have changed. | Inspect current application state before repeating. Neither the forwarding Worker nor a client should blindly retry it. |
| Transcript HTTP 503 / tunnel `durability_unconfirmed` | The server did not acknowledge durability for an item or terminal status edge. | Let the sender retry with the same `source_id` or status `Idempotency-Key`; do not create a fresh message to imitate that retry. |
| Launcher fence timeout | The replication-before-effect fence failed before sending its lifecycle effect. | Diagnose replication; a normal lifecycle retry can follow its recorded operation policy. A blocked start or creation fails visibly with "not yet replicated"; a blocked sleep stays unknown and is repeated. The server logs `cfo.launcher.durability_unconfirmed`. |
| Reply lost after a lifecycle request was sent | The physical effect may have happened. | Reconcile with the same operation ID. For unknown suspend, admission stays closed until its recorded outcome is known. |
| Unsafe browser request returns lost-answer error | The forwarding call failed without knowing whether Omnigent applied it. | Check current state; do not treat a new request as a harmless transport retry. |

The response barrier, transcript acknowledgement barrier and launcher effect fence solve different ordering problems. [ADR 0003](../decisions/0003-durability-before-acknowledgement-effect.md) describes the boundaries. Replication catching up after restore does not prove a computer checkpoint has published.

## Computer work and saves

| Symptom | Check | Expected safe behavior |
| --- | --- | --- |
| “Saving” for longer than expected | Separate accepted request, local cut/staging, upload and publication times; inspect generation and parent identity. | Work resumes by the pause ceiling even when upload is slow. Only verified publication or a durable unchanged proof completes the request. |
| “Not saved” / new work refused | Time since confirmed restore, publication or verified unchanged in the current generation; last save failure and retry. | After thirty minutes without verification, admission closes. Already-admitted work finishes. Save retries reopen admission after a current-generation proof; manual gate bypass is unnecessary. |
| Save accepted but last published time unchanged | Whether a follow-up is pending, publication failed, or a generation/parent-bound unchanged proof was recorded. | Unchanged files need no new layer, but still need durable proof. Failed capture leaves the old checkpoint current. |
| Credentials or sign-out appear stale | Latest credential generation/order and published tombstones, separately from workspace age. | Install newest credential state after workspace restore. Do not copy an older workspace's login files over it. |
| Wake waits or fails at capacity | Actual container/reservation state, whether a prior stop is confirmed, and the platform Worker's `CFO_MAX_AWAKE_COMPUTERS` (default 2). | No capacity queue or autonomous stop of another active computer. Release only a confirmed-stopped or fenced-abandoned reservation; Once WorkspaceDO is bound and answers, ControlDO's reconciliation gives back such a slot within about a minute even when its release was lost; while it cannot be reached, the slot is kept. Raising the limit is a deliberate platform release and adds cost. |
| Container runs but host is missing | Typed status and current start attempt. | Claim a start before re-arming. A live host reconnects with its current token; do not revoke/re-arm it from a stale status alone. |
| Sleep outcome unknown | Persisted sleep operation and current physical stop state. | Keep admission closed and repeat reconciliation of that operation. Do not race a wake or manufacture an asleep state. |

Version-one capture uses a content-correct two-phase copy. The normal pause target is 20 seconds; the paused controller draft raises it to 40 seconds only when declared bytes are greater than 2,000,000,000. The hard ceiling remains 40 seconds. Upload happens after resume and has its own deadline. This is accepted contract/draft behavior, not yet qualified production enforcement. A slow upload must not extend the pause. See [checkpoint publication](../decisions/0005-checkpoint-publication-continuation.md).

## Reconnect, Interrupt and continuation

A platform release can reset computer and browser connections at the Durable Object version switch. A web release is outside the computer tunnel path, but browser streams it proxies may drop later. Diagnose reconnection and generation together; a disconnected browser alone does not establish that a turn stopped.

Version-one fork behavior forwards Stop once and reports `delivered`, `not_delivered`, `unknown`, `failed` or `superseded`. For non-delivery/uncertainty or a request failure, inspect whether work still runs and press Interrupt again when needed. Do not automatically resend an old Stop after reconnect; it could reach a later turn. A first-delivery frame stalled on a live link can still arrive late. An optimistic cancelled UI state is not delivery confirmation.

The default server pin predates the no-redelivery correction. The separate server candidate includes it but omits later main-chat failure/launch notices and the final history-resume correction. Match the symptom with [compatibility](../compatibility.md) before assuming current fork UI behavior is installed.

A saved session's 201 response is distinct from `runner_launch: started|failed|unknown`. An interrupted/unknown tool outcome must stay visible until a matching result or the person's action resolves it. A replacement runner must not automatically replay uncertain external work. Preserve unreconciled transcript files; do not erase them or start a fresh transcript to make a history-outage error disappear. Current fork source includes refusal/preservation changes, with remaining real-replacement and missing-ID/bridge cases to qualify.

## GitHub setup

`bootstrap.ts github-app` stores the installation's GitHub App and then waits until a server started with its settings reports GitHub linking on, before it sends the browser to GitHub's install page. GitHub's "Install" returns to `https://<hostname>/platform/github`, which opens Omnigent's Integrations settings once linking is on.

| What the installer or the setup page says | What it establishes | What to do |
| --- | --- | --- |
| The link expired (the local page, after an hour) | Nothing was stored. If "Create GitHub App" was clicked after that, GitHub made an App that the installation does not know. | Delete that App on GitHub (its name begins with "Omnigent" and the installation's tag), and run the step again. |
| GitHub linking is not on yet (exit 3), or the setup page is still finishing | The App is stored; no server started with it has reported linking on yet, usually because the restart is still under way. | Open `/platform/github`, or install the App: the setup page keeps waiting for 15 minutes and then says what it sees. |
| GitHub linking is off (exit 1) | A server started with the App's settings answers, but Omnigent does not list GitHub in `/v1/info`'s `enabled_connections`: the image turned linking off, so a setting it needs is missing. | The server's `boot` line says `github_linking: off: incomplete`, and its `config.warning` line names what is missing (both in the platform Worker's Workers Logs). Run the step again with `--replace`, then delete the old App on GitHub. |
| The server does not start with the App's settings (exit 1), or the setup page says the server cannot start | The server exited 78 with a malformed setting and the watchdog holds it until the configuration changes: Omnigent is down. | The server's `config.error` line names the setting. Run the step again with `--replace` (a new App, freshly stored), then delete the old App on GitHub. |

## Updates

`bootstrap.ts update` opens a window in which Omnigent takes no request, takes a restore point, checks the new version, and accepts it ([install guide](../install.md#updating-your-installation)).

| What you see | What it means | What to do |
| --- | --- | --- |
| "Omnigent is being updated" (503, `retry-after: 60`) on every page and API call | The update's window is open: the platform Worker holds `SERVER_ENV_CFO_MAINTENANCE_WINDOW`, and its object passes nothing to the server. Cloud computers wait and reconnect afterwards; no scheduled task fires, and the server starts no computer. | Let the update finish; if it stopped, `bootstrap.ts update` continues it, or `bootstrap.ts update --rollback` goes back. `bootstrap.ts status` says which. |
| Not checked yet (exit 3), the window open | The new server has not answered with a durable owner, or has not reported its restore point. | `bootstrap.ts status --logs` shows `window=` and `restorePoint=` on the status lines. The server's `cfo.restore_point.failed` line (exit 74, retried at each start) says why a restore point could not be taken; Omnigent never starts without it. |
| Accepted, closing (exit 3) | The window's secret is deleted; the platform's object has not switched to that version yet (up to about 5 minutes), or the server it restarts without the window has not answered yet. | Run `bootstrap.ts update` again to confirm. |
| Rollback not finished (exit 3) | The server has not reported the restore point back (`rolled_back`), or the previous version's server has not answered yet. | Run `bootstrap.ts update --rollback` again. The server's `cfo.rollback.failed` line (exit 76, retried) names the cause; a restore point that does not restore as its manifest records is never put back, and the replica stays as it was. |
| "The update's read-only window was ended outside this installer" | `SERVER_ENV_CFO_MAINTENANCE_WINDOW` was deleted by hand: Omnigent may have taken changes since the restore point. | Going back would lose them, so rollback refuses (a rollback under way is called off, its order deleted; the server refuses an order outside a window too); `update` starts again with a new restore point. |
| "Cannot be updated: its replica … is at the root of its bucket" | A replica planned without a path leaves no room beside it for a restore point. | Nothing was changed. The default replica, `s3://<bucket>/omnigent`, has one; moving a replica is a recovery task. |
| `services` or `github-app` refuses: an update is waiting | A change made inside the window would be undone, unseen, by a rollback. | Finish the update first. |

## MCP services

`bootstrap.ts services add <id>` stores the service's settings and waits until a server started with them answers.

| What you see | What it means | What to do |
| --- | --- | --- |
| Not confirmed yet (exit 3) | The settings are stored; no server started with them has answered yet, usually because the restart is still under way. | Run `bootstrap.ts services` or `bootstrap.ts status --logs` in a few minutes. |
| Omnigent lists no MCP services (exit 1) | The server restarted with the change, but the image turned MCP off: a prerequisite is missing (the key service's keys or the OAuth state secret). | The server's `boot` line says `mcp_registry: off: incomplete` and its `config.warning` line names what is missing. Run `bootstrap.ts update`, which adds them, then the step again. |
| The server does not start with the change (exit 1) | The server exited 78 with a malformed choice or manifest, and the watchdog holds it until the configuration changes: Omnigent is down. | The `config.error` line names the setting, never its value. Run the `services remove <id>` the step names to undo the change. |
| A call fails with "Connect this MCP account" | The account is not connected, or it was disconnected. | Settings → MCP, **Connect**. |
| Settings → MCP says "Reconnect needed" | The service rejected the saved sign-in (a 401, or a refresh it refused): access removed on its site, or expired. The next call tries a refresh first. | Settings → MCP, **Reconnect**. |
| Settings → MCP says the registry is not configured | No service is on, or the server started without the change. | `bootstrap.ts services` lists what is on; `status --logs` shows the server's status lines. |

## Evidence to collect

Keep source/fork/image identities, affected generation/operation, timestamped phase transitions, error code, save cut/publication/proof metadata and a description of the user action. Avoid full headers, query strings, tokens, login files, terminal output or transcript contents unless necessary and access-controlled. Existing structured logs may provide enough. The [recovery guide](recovery.md) explains the implemented bootstrap observation command and private control-port boundary; the [test guide](../testing.md) separates local checks from account qualification.
