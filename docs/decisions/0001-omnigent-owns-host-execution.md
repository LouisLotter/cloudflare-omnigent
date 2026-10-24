# 0001 — Omnigent owns host execution

Status: accepted design. Implementation and qualification are separate below.

## Context

A cloud computer must appear as a persistent host that conversations and scheduled runs can share. A second scheduler or message-holding service in the platform would duplicate Omnigent's authorization, work identity and recovery decisions. Yet provider capacity, container generation and checkpoint publication need one physical authority.

## Decision

Omnigent owns application work: host identity, readiness, waiting messages, schedules, approvals and outcomes. General host features live in the Omnigent fork behind provider-neutral launcher interfaces. The platform uses these interfaces and `create_app`; it does not patch Omnigent internals at runtime.

A persistent host outlives any conversation. Creating it records a pending host row before provisioning. Removing it records a durable tombstone before termination. Persistent hosts are not silently replaced with blank computers when a provider reports them gone. The platform has no Omnigent login and no mirror of schedules or run history.

WorkspaceDO alone controls one physical computer: generation, reservation, start attempt, container and checkpoint pointers. ControlDO holds installation limits. A start persists its generation and reservation before effects; abandoned starts are fenced before capacity is reused. A running host repairs its connection with its existing token. Omnigent can re-arm a parked or absent host only after a granted `claim_start`; delayed starts from older attempts are refused. The supervisor alone restarts a crashed live host with the same token.

Sleep follows this order:

1. Omnigent closes admission under the host lifecycle lock; new work waits.
2. The host confirms no runner or admitted host operation remains, including operations outliving their requests and superseded connections.
3. Omnigent revokes the launch token; the launcher waits for replication before `suspend` can have an effect.
4. WorkspaceDO refuses unsafe capture/terminal/runner conditions, completes the required workspace and final credential saves, stops, confirms stop, then releases capacity.

A refusal before stop restores the token and reopens admission. A lost suspend reply keeps admission closed until the same operation ID establishes refused, stopped or still stopping. Capacity pressure never authorizes an autonomous stop of another computer; a wake at the limit is refused visibly.

## Alternatives and consequences

Platform wake plans, request holds and a schedule cache were rejected because they create another application authority. Ordinary laptop hosts cannot supply the required provider wake/sleep lifecycle. Persistent managed hosts require fork extensions but remove those duplicate state machines. The current lifecycle fence assumes a single server process; a multi-replica Omnigent installation would need a shared fence.

## Implementation and qualification

The fork at `184b5cf` contains persistent-host readiness and quiescence. Platform main contains [contracts and the lifecycle interpreter](../../contracts/src/lifecycle.ts), but the production controller, limits, private routes, supervisor and real launcher are not assembled. The [registered launcher](../../images/server/cfo_server/launcher.py) still refuses physical effects. The paused controller draft reuses the contract table; this is useful source structure, not crash/race qualification.

Source and tests: [fork launcher interface](https://github.com/LouisLotter/omnigent/blob/184b5cf8b32815b48c7859973a00a139e8aa50f0/omnigent/onboarding/sandboxes/base.py), [persistent-host tests](https://github.com/LouisLotter/omnigent/blob/184b5cf8b32815b48c7859973a00a139e8aa50f0/tests/server/test_persistent_hosts.py), [lifecycle/contract tests](../../contracts/test/m3.test.ts). Concurrent dispatch/sleep, lost replies, stale start claims and controller restarts still need qualification against the complete selected assembly.
