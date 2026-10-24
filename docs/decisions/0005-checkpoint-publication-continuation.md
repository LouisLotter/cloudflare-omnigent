# 0005 — Checkpoint publication and continuation

Status: accepted design. Version-one contracts are present in main; production computer integration remains draft.

## Context

A capture can be accepted, paused and copied successfully while its upload or publication later fails. Native CLI homes also mix continuation state with credentials. Restoring an old workspace must neither resurrect a signed-out login nor discard the harness history needed to reconcile undelivered output.

## Decision

WorkspaceDO owns two independently published pointers:

- A workspace checkpoint contains workspace files, native CLI configuration/history/databases and audited continuation state, as a base plus file-level deltas. Credential families are filtered from every layer.
- A credential checkpoint contains only declared opaque login files or absence tombstones. Restore installs the newest published credential state after workspace restore, without replacing whole CLI homes. A logout tombstone prevents an older login from returning. Credential publication accepts only a newer order in the same generation, or a newer generation, so a delayed copy cannot replace fresher credentials.

One versioned path-family policy governs capture, prune and restore, including temporary files, symlinks and hard-link aliases. Save Codex continuation state under its bridge directory while excluding only the classified secret families. Keep Claude-native's temporary bridge outside all checkpoint roots; its saved transcript and unresolved sidecars are continuation state. A generic schema test does not prove a real supervisor implements this policy.

Omnigent requests saves after completed turns and during long turns at ten-minute intervals; requests arriving during capture fold into one follow-up whose cut covers them. WorkspaceDO persists accepted requests and retries until covered. A separate backstop saves after fifteen minutes without a request while runner processes exist. Sleep performs a workspace save and a final verifiably published credential save; SIGTERM capture is best effort.

**Accepted, captured, staged and published are different facts.** A turn is saved only when a published checkpoint has a cut after its end. An unchanged capture publishes no layer but records a durable proof bound to generation, parent and cut; it can cover pending requests and refresh verification. Failure cannot produce that proof.

A content-correct capture first copies while processes run, then pauses all writers, including Omnigent host/runners, CLIs, tools, shells and setup terminal, except supervisor/guard. During the pause it reconciles the local copy by content, not size/mtime. A separate guard owns stop/resume, checks process identity and resumes by the deadline or controller disappearance. The usual target is 20 seconds; above about 2 GB the target rises to the same 40-second hard ceiling. Upload occurs after resume, with a separate deadline. A change journal is later work, not a substitute for version one's content comparison.

Each layer includes an index; the manifest binds layer index hashes and successive whole-tree digests. Publish only verified objects, in one pointer switch. A delta whose parent is no longer current is discarded. A failed/expired copy, prune or upload leaves the previous pointer current. Restore applies a base and its ordered deltas in staging, validates the rebuilt index/tree and only then installs it; credential-family members found in workspace layers are stripped and reported. Retention cannot remove any layer still referenced by a retained checkpoint or protected restore point.

A new base is required after twenty deltas, when delta bytes exceed half the base, after format/policy changes or without a valid parent. Freshness is time since confirmed restore, publication or verified unchanged in the current generation. After thirty minutes without verification, admission closes as `not_saved`; admitted work finishes. Save retries after one, two, then five-minute intervals reopen admission automatically after a current-generation proof. The healthy loss-window target no longer applies while saves fail.

## Alternatives and consequences

Full archives after every turn repeat large unchanged trees. A live-tree upload cannot bound writer races or R2-induced pause time. Pausing only workloads would need a complete new-writer gate, so version one pauses Omnigent too. Chunk-level restic storage remains a fallback requiring a new implementation/format decision; native snapshots are not the durable source. Login checkpoints remain sensitive opaque data, separately from ordinary continuation files.

## Implementation and qualification

Main contains [manifests](../../contracts/src/manifests.ts), [checkpoint policy](../../contracts/src/checkpoint-policy.ts), [lifecycle timing](../../contracts/src/lifecycle.ts), [computer protocol](../../contracts/src/computer-protocol.ts), [fixtures/refinement tests](../../contracts/test/m3.test.ts) and [policy vectors](../../contracts/vectors/checkpoint-policy-v1.json). Reported capture/credential experiments informed them; they do not prove the paused controller/supervisor assembly.

The selected supervisor, launcher and controller must still demonstrate actual-parser conformance, pause recovery, save-request replay, stale-parent refusal, admission reopening, all-layer token exclusions and complete credential/workspace restore. History-preservation fixes available in current fork integration are newer than both current server pins and the intended computer-image fork revision. Preserve unresolved transcripts across unavailable history and verify that cold resume neither loses nor duplicates items; source availability alone is insufficient.
