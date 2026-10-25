# 0006 — Honest uncertain outcomes

Status: accepted design. Fork implementation exists; inclusion and qualification vary by artifact.

## Context

A reply can disappear after a message, tool call, launch or Stop has taken effect. Treating that as failure can run work twice; treating it as success can hide work that never ran. Reconnecting transport or restoring files cannot undo an external side effect.

## Decision

Represent known success, known failure and unknown outcomes separately. Every retryable operation needs stable identity and an explicit deduplication/reconciliation contract; a transport retry is not permission to repeat arbitrary work.

Keep a pending message when its runner may have accepted it. Deduplicate native messages by their stable identity and persisted items by source identity. Repeated transcript/status delivery may be safe under those identities; a person must not be prompted to resend a message merely because its acceptance was lost. Host operation result caches are bound to the same host process/incarnation and have finite retention, not universal exactly-once execution.

After process death, preserve a durable interrupted/unknown outcome identifying an unfinished tool call. A new runner incarnation does not automatically begin history resume or a recovery envelope without the person's action. Kill orphaned CLI processes associated with a dead runner before replacing it. A late matching result can change an unknown outcome to known; reconnect and snapshot handling must not attach an old result to newer work.

Session creation still returns 201 when the session was saved, while `runner_launch` separately reports `started`, `failed` or `unknown`. Resource creation and agent launch are distinct outcomes.

**Version-one Stop is forwarded once.** Its answer reports `delivered`, `not_delivered`, `unknown`, `failed` or `superseded`. There is no automatic Stop redelivery after reconnect. The client reports delivery/request failure and keeps an Interrupt action available where appropriate, so the person can press again if work still runs. A newer input supersedes an older Stop waiting to forward. An optimistic interrupted UI event is not confirmation that the computer received Stop.

This does not bind a first-delivery frame to an exact future turn: a stalled live connection can still deliver that frame late. Safe turn-bound cancellation is later work. The decision removes automatic redelivery; it does not promise that every old frame can be recalled.

Unknown `suspend` is a separate lifecycle case: admission stays closed and the same operation ID is queried until the recorded outcome resolves. This is reconciliation of one physical operation, not replay of an uncertain external tool call. A `424` applied-but-unconfirmed security response likewise requires checking current state before repetition.

## Alternatives and consequences

Automatic turn replay after process death risks repeating external effects. Time-based Stop redelivery cannot reliably bind an interrupt to its original turn across delayed transport and separate processes. A turn-identity design needs end-to-end cancellation support; version one accepts another explicit button press instead. Unknown status is consequential information to preserve, not an error label to remove on reconnect.

## Implementation and qualification

Fork `184b5cf` source includes [Stop delivery rules](https://github.com/LouisLotter/omnigent/blob/184b5cf8b32815b48c7859973a00a139e8aa50f0/omnigent/server/routes/_sessions/interrupt_delivery.py), [tunnel Stop tests](https://github.com/LouisLotter/omnigent/blob/184b5cf8b32815b48c7859973a00a139e8aa50f0/tests/server/integration/test_stop_over_tunnel.py), and [disconnect outcome tests](https://github.com/LouisLotter/omnigent/blob/184b5cf8b32815b48c7859973a00a139e8aa50f0/tests/server/routes/test_disconnect_outcome_recovery.py). Its later UI follows launch and late-result outcomes as well as main-chat Stop failures.

The default platform [server pin](../../images/server/Dockerfile) precedes no-redelivery. The server candidate includes that correction but predates the later UI/history fixes. Reported native-harness and synthetic-effect experiments are limited to their exact revisions and faults; they do not prove all real external effects execute once or qualify the unfinished Cloudflare assembly. Review both source and packaged artifact before claiming the behavior for a release. [Forwarding tests](../../worker/test/unit/forward.test.ts) separately preserve no automatic retry of applied or uncertain unsafe browser requests.
