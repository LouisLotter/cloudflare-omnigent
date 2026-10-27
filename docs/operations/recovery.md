# Recovery

Use this guide to distinguish an unavailable server, replication catch-up and recovery mode before changing anything. It covers the implemented server base and labels the remaining recovery design. Cloud-computer lifecycle integration and complete production recovery tooling are unfinished; see [architecture](../architecture.md) and the exact [compatibility snapshot](../compatibility.md).

## Observe first

Record the source and artifact identity actually involved. From the checkout, these commands read local Git state:

```bash
git rev-parse HEAD
git status --short
git show HEAD:images/server/Dockerfile
```

A Dockerfile default is not the running image. Record actual build arguments, fork revision, Worker version, image digest/architecture, instance size, database size and the last known healthy/replicated time. The separate server candidate adds build/status metadata; main does not have all of it. Keep diagnostic output private until reviewed for identifying data and credentials.

For an existing installation planned by the bootstrap tool, set `CFO_PLATFORM_WORKER` to its recorded platform Worker name, then read its local journal:

```bash
node scripts/bootstrap/bootstrap.ts status --platform-worker "$CFO_PLATFORM_WORKER"
```

This does not contact Cloudflare. Adding `--logs` queries recent authenticated Workers Logs without changing the deployment; it needs the installer's existing `cf` login. It reports bootstrap evidence, not complete server health, and prints identifying installation metadata. The script's `run` command can deploy and change secrets; it is not an observation command.

The server's port 8001 exposes `GET /status` and `/position` only to its Durable Object. They are not public diagnostics endpoints. Use the trusted deployment/operator path to inspect existing diagnostics; do not expose the control port or create an Access bypass to obtain them. A status read may request a Litestream sync; it does not restore or reset data.

## Choose the matching condition

| Observation | Meaning | Next step |
| --- | --- | --- |
| Access/hostname/origin refusal | Request was rejected before application access. | Check intended hostname, Access application/assertion settings and exact origin. Preserve the boundary; do not disable authentication to diagnose it. |
| Server starting/restoring | Restore, validation or app startup may still be in progress. | Compare phase times with the selected source's watchdog budgets and database size. Observe the existing retry; avoid repeated manual stops. |
| `recovery_mode` / HTTP 503 | The image refused to start Omnigent safely. | Read the recovery reason below. A 503 alone is not permission to replace data. |
| `424 durability_unconfirmed`, `applied: true` | A security change committed locally but replication was not confirmed before its deadline. | Inspect current state before repeating the change; follow [troubleshooting](troubleshooting.md). |
| Final sync unconfirmed / exit 75 | Shutdown could not confirm the replica covered all commits. | Preserve replica/local-state evidence and identify the loss window before starting recovery from an older point. |
| Exit 78 / held configuration | A required setting is absent or invalid. | Correct the identified deployment setting through a deliberate release; the watchdog holds this exit until configuration changes. An installation planned before the artifact bucket existed stops here with `OMNIGENT_ARTIFACT_URI is required`: see [uploaded files](#uploaded-files). |
| An uploaded file answers `500 internal_error` | Omnigent has the file's database row but cannot read its bytes from the artifact store (the pinned fork answers 500 rather than 404 for a missing blob). | Check the artifact bucket and its credentials before anything else; see [uploaded files](#uploaded-files). |
| `config_changed` outage | A release changed the server's configuration or image; the watchdog replaced the running server once to apply it. | Expected after a secret, setting or server image release. It ends when the replacement answers; if it does not, diagnose it as a server start or restore. The bootstrap reports "released, not yet applied" until then. |

Main uses older startup/recovery logic than the separate candidate. The candidate's per-phase startup budgets and local constrained-Docker results do not establish real R2 startup on the server's instance: that production-object qualification remains pending. Do not treat a comment saying “qualified” as completion evidence or copy the candidate's timing defaults onto main.

## Server recovery mode

The [entrypoint](../../images/server/cfo_server/entrypoint.py) refuses an initialized installation with no replica, a corrupt database or a replica without the initialized owner. It also reports failed/timed-out restores. Omnigent and replication do not start in this state, so a public setup form cannot replace the existing installation.

| Reason | Diagnosis and action |
| --- | --- |
| `restore_failed` / `restore_deadline` | Check the configured replica location, bucket-scoped credential validity, connectivity and size/deadline evidence. The entrypoint retries transient restore failures; do not erase the replica to force progress. |
| `replica_empty` | Verify the selected bucket/prefix and installation identity. An initialized installation must not silently become a fresh one. |
| `database_corrupt` | Preserve the failing artifact and integrity-check result; select and verify a protected restore point through a reviewed recovery plan. |
| `not_initialized` | The local/restored database lacks the expected owner. Confirm it is the correct replica and restore point; do not clear the initialized marker or rerun first-visitor setup. |

A missing bootstrap password on a new installation is also refused by image startup. Initialization must be proved by both account state and replication before bootstrap credentials are removed. `/v1/info` alone does not prove durability. The implemented bootstrap journal/status explains progress; the owner's browser sign-in remains a separate acceptance step.

## Uploaded files

Omnigent keeps uploaded files, session resources and agent bundles in its artifact store, which the server image puts in an R2 bucket of its own (`SERVER_ENV_OMNIGENT_ARTIFACT_URI`; [secret inventory](../secrets.md)). The database replica holds only their rows. The container's disk is lost at every replacement and at every release's controlled restart, so the image refuses to start without the artifact bucket rather than fall back to the disk.

- **Setting up.** The bootstrap plans the bucket (`<platform Worker>-artifacts` unless `--artifacts-url` names another) and `bootstrap.ts buckets` creates the plan's missing buckets in the installer's account. Make one R2 API token with Object Read & Write on exactly the replica's and the artifacts' buckets, or two tokens. A token that misses the replica's bucket shows up as restore or replication failures. One that misses the artifacts' bucket, a wrong bucket name or endpoint, or an R2 outage stops the server's start: Omnigent checks its built-in agents' bundles in the bucket as it starts, so the app exits before it serves (the container exits with the app's error code after its final sync) and the watchdog starts it again, with its backoff, until the bucket is reachable. The database is not affected.
- **An existing installation without the bucket** stops with exit 78 after an image upgrade. Create the bucket, extend the token to it, and set the three variables and the two `SERVER_ENV_AWS_*` secrets in one deliberate release; files uploaded before the upgrade were on the container's disk and are already gone.
- **Backup.** R2 stores the objects durably but keeps no earlier versions, and nothing restores the bucket together with the database. A delete in Omnigent removes the object at once. To protect files against deletion or a destructive restore, copy the bucket to a second private bucket with an S3 tool, keeping the keys. The platform has no scheduled copy yet.
- **Restore.** A database restored to an earlier point can list files whose objects were deleted later: those rows answer `500 internal_error` (an upstream candidate) and their bytes come back only from a bucket copy. Objects newer than the restore point remain as unreferenced objects; leave them until the restored installation is accepted. Restore a bucket copy under the same keys and the same prefix, never into the replica's bucket.
- **Diagnosis.** A `500` for one file with others working points at a missing object (`cf r2 objects list --bucket-name <bucket>`, read-only). Every download failing, or a server whose app exits at each start, points at the bucket name, endpoint or token. The image's boot line reports `artifacts: "s3"`; `"local"` means the test switch is set and files will not survive the next restart.

## Rollback and destructive restore

The accepted upgrade design protects a restore point and keeps mutations closed during a read-only maintenance window. Rollback is allowed only within that window before new writes are accepted. After acceptance, fix forward. The repository does not yet provide a complete production maintenance/rollback command, so this document supplies no fabricated executable procedure.

A restore after new writes is destructive recovery. Its reviewed plan must keep ingress closed, record a new database recovery generation, invalidate account authority and login grants, revoke every computer launch token, rebuild reservations from actual state and state which work is discarded before reopening. This prevents a revocation made after the restore point from returning. Never restore one computer's login files into a second live container. Restoring files cannot undo external tool effects.

Deleting a Durable Object, database, R2 prefix, initialized marker or local installation journal is not a substitute for that plan. Recovery requirements are detailed in [ADR 0007](../decisions/0007-compatible-releases-recovery.md); execution/qualification remains pending. Use the [test matrix](../testing.md) for an isolated rehearsal, not a production reset.
