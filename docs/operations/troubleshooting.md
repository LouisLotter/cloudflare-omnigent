# Troubleshooting

Start with the selected [source/artifact combination](../compatibility.md). Main contains the server base and computer contracts; the computer controller/routes/supervisor/launcher remain paused drafts. The platform pages and status notices described for computers below are required behavior, not screens already available in main.

## Lost replies and durability

| Signal | What it establishes | What to do |
| --- | --- | --- |
| `424 durability_unconfirmed`, `applied: true` | The security change committed locally; replica confirmation missed its deadline. Cookies may already have changed. | Inspect current application state before repeating. Neither the forwarding Worker nor a client should blindly retry it. |
| Transcript HTTP 503 / tunnel `durability_unconfirmed` | The server did not acknowledge durability for an item or terminal status edge. | Let the sender retry with the same `source_id` or status `Idempotency-Key`; do not create a fresh message to imitate that retry. |
| Launcher fence timeout | The replication-before-effect fence failed before sending its lifecycle effect. | Diagnose replication; a normal lifecycle retry can follow its recorded operation policy. This fence is in the paused launcher draft, not main's stub. |
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
| Wake waits or fails at capacity | Actual container/reservation state and whether a prior stop is confirmed. | No capacity queue or autonomous stop of another active computer. Release only a confirmed-stopped or fenced-abandoned reservation. |
| Container runs but host is missing | Typed status and current start attempt. | Claim a start before re-arming. A live host reconnects with its current token; do not revoke/re-arm it from a stale status alone. |
| Sleep outcome unknown | Persisted sleep operation and current physical stop state. | Keep admission closed and repeat reconciliation of that operation. Do not race a wake or manufacture an asleep state. |

Version-one capture uses a content-correct two-phase copy. The normal pause target is 20 seconds; the paused controller draft raises it to 40 seconds only when declared bytes are greater than 2,000,000,000. The hard ceiling remains 40 seconds. Upload happens after resume and has its own deadline. This is accepted contract/draft behavior, not yet qualified production enforcement. A slow upload must not extend the pause. See [checkpoint publication](../decisions/0005-checkpoint-publication-continuation.md).

## Reconnect, Interrupt and continuation

A platform release can reset computer and browser connections at the Durable Object version switch. A web release is outside the computer tunnel path, but browser streams it proxies may drop later. Diagnose reconnection and generation together; a disconnected browser alone does not establish that a turn stopped.

Version-one fork behavior forwards Stop once and reports `delivered`, `not_delivered`, `unknown`, `failed` or `superseded`. For non-delivery/uncertainty or a request failure, inspect whether work still runs and press Interrupt again when needed. Do not automatically resend an old Stop after reconnect; it could reach a later turn. A first-delivery frame stalled on a live link can still arrive late. An optimistic cancelled UI state is not delivery confirmation.

The default server pin predates the no-redelivery correction. The separate server candidate includes it but omits later main-chat failure/launch notices and the final history-resume correction. Match the symptom with [compatibility](../compatibility.md) before assuming current fork UI behavior is installed.

A saved session's 201 response is distinct from `runner_launch: started|failed|unknown`. An interrupted/unknown tool outcome must stay visible until a matching result or the person's action resolves it. A replacement runner must not automatically replay uncertain external work. Preserve unreconciled transcript files; do not erase them or start a fresh transcript to make a history-outage error disappear. Current fork source includes refusal/preservation changes, with remaining real-replacement and missing-ID/bridge cases to qualify.

## Evidence to collect

Keep source/fork/image identities, affected generation/operation, timestamped phase transitions, error code, save cut/publication/proof metadata and a description of the user action. Avoid full headers, query strings, tokens, login files, terminal output or transcript contents unless necessary and access-controlled. Existing structured logs may provide enough. The [recovery guide](recovery.md) explains the implemented bootstrap observation command and private control-port boundary; the [test guide](../testing.md) separates local checks from account qualification.
