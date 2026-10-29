# 0007 — Compatible releases and recovery

Status: accepted design, amended 27 October 2026 (the server's scheduling policy, below) and 29 October 2026 (tolerant status readers). Initial contracts and server safeguards exist; the full release/recovery matrix remains to qualify.

## Context

Deploying the Worker and rolling its containers are separate steps. A new Worker can serve an old running computer, and a fork fix can exist without being in either image. Restoring an older database can resurrect revoked authority unless recovery explicitly invalidates it.

## Decision

Release an identified assembly: platform/web revisions, fork commits, server/computer image digests, exact CLI/SDK/Litestream versions, protocol/schema/policy versions and evidence for that combination. A pin is reproducibility input, not qualification. Image source identity must be inspectable; claiming a fix requires checking the packaged code and exercising the affected behavior. Do not replace pins with “latest.”

Keep supervisor, launcher, manifest, intercept-props and cross-Worker interfaces versioned. Reject unsupported versions before effects. Cross-Worker additions are additive, tolerate unknown fields at the defined RPC boundary and ship platform support before web consumers. This does not relax strict payload schemas elsewhere, with one exception (29 October 2026): the supervisor's informational `computer_status` reply, whose readers drop fields they do not know and read enum values they do not know as "can't tell", so an older WorkspaceDO after a rollback still reads a newer computer's status ([compatibility](../compatibility.md)). Once a second protocol version exists, support current and previous where the compatibility contract requires it; version-one constants do not already prove that future compatibility.

Keep container beta APIs behind adapters. The server and the computers use the `durable_object` scheduling policy, under which a deploy never replaces a running container: each start names the image the Worker version maps, and the size. A computer takes an image update at its next clean start. The server takes it through one controlled restart: its watchdog fingerprints the environment, image and size each start uses, and replaces an answering server once, gracefully, when the current version would start it with another fingerprint (an outage with the cause `config_changed`). A release that changes none of the three restarts nothing. Test new Worker/old computer, new Worker/old server and new server/old computers. A managed-host-changing fork rebase must rerun persistent-host behavior tests.

Before a server migration, protect a restore point from retention. Keep a read-only maintenance window until migration/smoke checks pass and the release is accepted. Rollback to that restore point is permitted only inside that window, before new writes are accepted. After acceptance, fix forward.

A destructive restore after new writes is recovery, with explicit loss accounting: close ingress, restore under a new database recovery generation, rotate account authority, revoke login grants and every computer launch token, rebuild reservations from actual state, then reopen. A revocation after the restore point must not become usable again. Never restore a computer's credentials into a second live container.

An initialized installation whose replica/database/owner check fails enters recovery mode; it must not offer first-visitor setup. Bootstrap credentials are removed only after initialization is replicated. Recovery mode is an observable state, not permission for a watchdog restart loop or a destructive reset. Secret deletion/rotation creates a platform release and receives the corresponding reconnect checks.

**Amendment, 27 October 2026: the server's scheduling policy.** This record first kept the server on Cloudflare's `default` policy, with application-wide image rollouts, a `basic` instance and `max_instances: 1`. Cloudflare then refused to create a new `default`-policy container application on the project's staging account and directed it to `durable_object`, so the server moved too. That policy has no `basic`: the server starts on a custom instance of 1 vCPU, 3 GiB of memory and 8 GB of disk, set in code ([`SERVER_INSTANCE`](../../worker/src/server/container-port.ts)), and one named OmnigentServer object runs one container, which takes the place of `max_instances`. A container application's policy cannot change. An installation created on the `default` policy cannot switch in place: Cloudflare's migration creates a new application behind a new Durable Object class and namespace, and moves no Durable Object storage. No such installation exists. The startup budgets measured on `basic` stay; the new size has not been measured on Cloudflare yet.

## Alternatives and consequences

Branch names and green source suites cannot identify deployed behavior. Unbounded backward compatibility complicates every receiver; refusing unsupported versions makes incompatibility explicit. Routine rollback after writes risks silent data loss and revived credentials, so it is restricted to maintenance. Recovery can discard legitimate work and force sign-ins; the operator must state what was lost rather than claiming external effects were rolled back.

## Implementation and qualification

Main provides [versioned RPC](../../worker/src/shared/rpc.ts), [manifest versions](../../contracts/src/manifests.ts), [launcher/computer contracts](../../contracts/src/launcher.ts), [server restore/recovery logic](../../images/server/cfo_server/entrypoint.py), [database checks](../../images/server/cfo_server/dbcheck.py) and [bootstrap tests](../../worker/test/workers/bootstrap-script.test.ts). Full maintenance controls, authority-invalidating recovery and mixed-version computer tests are not yet an integrated product.

The server candidate adds build metadata/identity tests and revised startup budgets. Its reported local constrained-image startup is not the pending run against R2 on the server's instance through the production controller. The default server fork pin is `af3e49de…`; candidate is `35ac1ebd…`; current fork integration is `184b5cf…`; the intended computer-image fork revision is `8730aabf8…`. This source snapshot does not establish qualification of a complete server/computer digest pair. The exact [architecture snapshot](../architecture.md) should be refreshed alongside any concrete release evidence.
