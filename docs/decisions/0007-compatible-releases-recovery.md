# 0007 — Compatible releases and recovery

Status: accepted design. Initial contracts and server safeguards exist; the full release/recovery matrix remains to qualify.

## Context

Deploying the Worker and rolling its containers are separate steps. A new Worker can serve an old running computer, and a fork fix can exist without being in either image. Restoring an older database can resurrect revoked authority unless recovery explicitly invalidates it.

## Decision

Release an identified assembly: platform/web revisions, fork commits, server/computer image digests, exact CLI/SDK/Litestream versions, protocol/schema/policy versions and evidence for that combination. A pin is reproducibility input, not qualification. Image source identity must be inspectable; claiming a fix requires checking the packaged code and exercising the affected behavior. Do not replace pins with “latest.”

Keep supervisor, launcher, manifest, intercept-props and cross-Worker interfaces versioned. Reject unsupported versions before effects. Cross-Worker additions are additive, tolerate unknown fields at the defined RPC boundary and ship platform support before web consumers. This does not relax strict payload schemas elsewhere. Once a second protocol version exists, support current and previous where the compatibility contract requires it; version-one constants do not already prove that future compatibility.

Keep container beta APIs behind adapters. Running computers use the `durable_object` scheduling policy so image updates take effect at a clean start rather than replacing a live computer. The server retains its existing scheduling policy; changing it requires a new container application. Test new Worker/old computer, new Worker/old server and new server/old computers. A managed-host-changing fork rebase must rerun persistent-host behavior tests.

Before a server migration, protect a restore point from retention. Keep a read-only maintenance window until migration/smoke checks pass and the release is accepted. Rollback to that restore point is permitted only inside that window, before new writes are accepted. After acceptance, fix forward.

A destructive restore after new writes is recovery, with explicit loss accounting: close ingress, restore under a new database recovery generation, rotate account authority, revoke login grants and every computer launch token, rebuild reservations from actual state, then reopen. A revocation after the restore point must not become usable again. Never restore a computer's credentials into a second live container.

An initialized installation whose replica/database/owner check fails enters recovery mode; it must not offer first-visitor setup. Bootstrap credentials are removed only after initialization is replicated. Recovery mode is an observable state, not permission for a watchdog restart loop or a destructive reset. Secret deletion/rotation creates a platform release and receives the corresponding reconnect checks.

## Alternatives and consequences

Branch names and green source suites cannot identify deployed behavior. Unbounded backward compatibility complicates every receiver; refusing unsupported versions makes incompatibility explicit. Routine rollback after writes risks silent data loss and revived credentials, so it is restricted to maintenance. Recovery can discard legitimate work and force sign-ins; the operator must state what was lost rather than claiming external effects were rolled back.

## Implementation and qualification

Main provides [versioned RPC](../../worker/src/shared/rpc.ts), [manifest versions](../../contracts/src/manifests.ts), [launcher/computer contracts](../../contracts/src/launcher.ts), [server restore/recovery logic](../../images/server/cfo_server/entrypoint.py), [database checks](../../images/server/cfo_server/dbcheck.py) and [bootstrap tests](../../worker/test/workers/bootstrap-script.test.ts). Full maintenance controls, authority-invalidating recovery and mixed-version computer tests are not yet an integrated product.

The server candidate adds build metadata/identity tests and revised startup budgets. Its reported local constrained-image startup is not the pending basic-instance/R2 run through the production controller. The default server fork pin is `af3e49de…`; candidate is `35ac1ebd…`; current fork integration is `184b5cf…`; the intended computer-image fork revision is `8730aabf8…`. This source snapshot does not establish qualification of a complete server/computer digest pair. The exact [architecture snapshot](../architecture.md) should be refreshed alongside any concrete release evidence.
