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

## Access application

Owner-only Cloudflare Access is the boundary in front of the installation's hostname; the web Worker also checks every Access assertion and pins the owner's address (see [architecture](../architecture.md)).

- **Setting up.** In the installer's own account, `bootstrap.ts run` (and `install`, which runs it) creates the hostname's Access application before anything is deployed, with the installer's `cf` login: self-hosted, on exactly the hostname, one Allow policy whose only rule is the owner's email address, its cookie SameSite=lax, no CORS preflight bypass, no service token, a 24-hour session. The owner's address comes from `--owner-email` and must match the plan's owner pin. It offers the account's login method (all of them when there are several); an account with none gets the one-time PIN method. The state file records the application's name (`<web Worker>--<nonce>`) and ID; the address is not kept.
- **What it checks.** Before the web Worker's first deploy, the application is read again (by its ID) and must still be owner-only and the only one covering the hostname. An application someone else made on the hostname is used as it is only if it passes the same check; otherwise the run stops with each difference and its fix in the Zero Trust dashboard. The bootstrap never changes, widens or deletes an application it did not create, and never creates an Access bypass or service token.
- **Interrupted runs.** The create is recorded before it is sent and its ID after the answer. A run that finds an unanswered create adopts the application carrying its name, or waits once for the create to settle (5 minutes from when it was sent) before creating a new one. A create that lands even later leaves two applications on the hostname, and the next check refuses until one is deleted.
- **What stays manual.** A Zero Trust organization needs a plan choice and a payment method in the dashboard, even for the Free plan: the installer stops with that one step. A `cf` login that may not create Access applications (403) gets the dashboard step in one sentence; the next run checks what the person made.
- **Removing it.** `bootstrap.ts remove-access` deletes the application the state file records as the installation's, and nothing else. It refuses while a Worker with the web Worker's name exists, unless `--yes`. Where Cloudflare refuses the delete (403), it names the application with the click that deletes it, keeps it recorded and exits 1; run again afterwards to confirm it is gone.

## Bucket names

An installation's data lives in R2 buckets named when it is planned, and those names never change: a server or computer pointed at another name starts from an empty bucket.

- **Defaults.** `bootstrap.ts plan` names the buckets after the platform Worker and the installation's tag, the first 8 characters of its installation ID after `ins_`: the database replica `s3://<platform Worker>-<tag>-replica/omnigent`, Omnigent's artifacts `s3://<platform Worker>-<tag>-artifacts`, and the computers' checkpoints `<platform Worker>-<tag>-checkpoints`. The tag keeps a later installation from reusing a removed one's names, which an R2 token left behind would still reach (see removing an installation, below).
- **Given names.** `--replica-url` and `--artifacts-url` name other buckets, kept exactly as given. The checkpoint bucket is always the platform Worker's own.
- **Length.** R2 allows 63 characters. A platform Worker name that would make a longer bucket name is refused at `plan` (with the checked-in configuration, at most 42 characters), never shortened.
- **Recorded, never derived again.** The plan records the replica's and the artifacts' URLs and the tag, and every later run and deploy names the buckets from it.
- **Installations planned before the tag** keep their untagged names (`<platform Worker>-artifacts`, `<platform Worker>-checkpoints`, and the replica they were given). Their state files stay at version 1. A plan with a tag is written as version 2, which an older bootstrap refuses rather than read without the tag. Once its journal records the code each Worker runs, a state file is written as version 3, and once it records an update (`bootstrap.ts update`) as version 4, tagged or not: an older bootstrap refuses each rather than drop those records. Renaming or moving an existing installation's buckets is not supported.

## Uploaded files

Omnigent keeps uploaded files, session resources and agent bundles in its artifact store, which the server image puts in an R2 bucket of its own (`SERVER_ENV_OMNIGENT_ARTIFACT_URI`; [secret inventory](../secrets.md)). The database replica holds only their rows. The container's disk is lost at every replacement and at every release's controlled restart, so the image refuses to start without the artifact bucket rather than fall back to the disk.

- **Setting up.** The bootstrap plans the bucket (`<platform Worker>-<tag>-artifacts` unless `--artifacts-url` names another; see [bucket names](#bucket-names)). Before its first deploy, `bootstrap.ts run` creates the plan's missing buckets in the installer's account and, with the installer's `cf` login, the installation's R2 token: a user API token with object read and write ("Workers R2 Storage Bucket Item Write") on exactly the replica's and the artifacts' buckets, named `<platform Worker>-r2--<installation ID>`. It sets the token's S3 key pair (the token's ID, and the SHA-256 of its value) on the platform Worker for both uses; the value is never shown or stored. If the `cf` login may not make API tokens (Cloudflare answers 403), `run` says so, gives the dashboard step in one sentence, and asks for that token's two values; `--secrets-stdin` can also supply a token's values made by hand. A token that misses the replica's bucket shows up as restore or replication failures. One that misses the artifacts' bucket, a wrong bucket name or endpoint, or an R2 outage stops the server's start: Omnigent checks its built-in agents' bundles in the bucket as it starts, so the app exits before it serves (the container exits with the app's error code after its final sync) and the watchdog starts it again, with its backoff, until the bucket is reachable. The database is not affected.
- **The token's lifetime.** An installation's token does not expire: an expiry would stop replication and the server's start, and nothing can replace it on a schedule. It belongs to the Cloudflare user whose `cf` login ran the bootstrap, and stops working if that user leaves the account, so install with the owner's own login. Each token is named `<platform Worker>-r2--<installation ID>--<UTC time of its create>`, and its ID is in the bootstrap's state file.
- **What the `cf` login may do.** `cf`'s own sign-in (OAuth) may create API tokens, but Cloudflare refuses it (403) to list, roll or delete them: those need the "API Tokens" permissions, which `cf auth login` cannot request. So a re-run never rolls a token. While the platform Worker holds its key pair, that pair is reused and no token is touched. When it does not (a first deploy that failed), the run makes a new token and lists the old one, whose value is gone, as a token to delete. Whatever the bootstrap may not delete it names exactly, with the click that deletes it: open <https://dash.cloudflare.com/profile/api-tokens>, open the three-dot menu next to the token, and choose Delete. A login with the "API Tokens Write" permission (an API token in `CLOUDFLARE_API_TOKEN`) deletes them itself.
- **Removing an installation.** `bootstrap.ts remove-r2-token` deletes the installation's tokens; it refuses while a Worker with the platform Worker's name exists unless `--yes`, which cuts the server off from its database replica and files. With `cf`'s own sign-in it cannot delete them: it names each one with the click above, keeps them recorded, and exits 1; run it again after deleting them, and it confirms they are gone (that sign-in may read a token by its ID). A token whose create was never answered cannot be checked: it is named once, "if it exists". Delete them: until then a token reaches its buckets' objects, and those of any bucket created later under one of their names, which the output names too. Default bucket names carry the installation's tag, so a later installation's defaults never reuse them; buckets named by hand, and an installation planned before the tag, can. A staging installation's state file stays at its default path, where the staging tool looks; its tokens go with its platform deployment's teardown in the same way (`sweep` reports any left over, `sweep --yes` deletes what it may); they also expire a day after the staging deployments would.
- **An existing installation without the bucket** stops with exit 78 after an image upgrade. Create the bucket, extend the token to it, and set the three variables and the two `SERVER_ENV_AWS_*` secrets in one deliberate release; files uploaded before the upgrade were on the container's disk and are already gone.
- **Backup.** R2 stores the objects durably but keeps no earlier versions, and nothing restores the bucket together with the database. A delete in Omnigent removes the object at once. To protect files against deletion or a destructive restore, copy the bucket to a second private bucket with an S3 tool, keeping the keys. The platform has no scheduled copy yet.
- **Restore.** A database restored to an earlier point can list files whose objects were deleted later: those rows answer `500 internal_error` (an upstream candidate) and their bytes come back only from a bucket copy. Objects newer than the restore point remain as unreferenced objects; leave them until the restored installation is accepted. Restore a bucket copy under the same keys and the same prefix, never into the replica's bucket.
- **Diagnosis.** A `500` for one file with others working points at a missing object (`cf r2 objects list --bucket-name <bucket>`, read-only). Every download failing, or a server whose app exits at each start, points at the bucket name, endpoint or token. The image's boot line reports `artifacts: "s3"`; `"local"` means the test switch is set and files will not survive the next restart.

## Rollback and destructive restore

**Inside an update's window (implemented, WP3.41).** Every `bootstrap.ts update` follows [ADR 0007](../decisions/0007-compatible-releases-recovery.md): its new server copies the database replica aside before Omnigent starts, and Omnigent takes no request until the update is checked and accepted. Until acceptance, `bootstrap.ts update --rollback` goes back:

1. one secrets change orders the rollback (`SERVER_ENV_CFO_ROLLBACK_TO`); the server started with it, inside the update's window only, restores the restore point to a scratch file and checks it against its manifest (the database's SHA-256, its integrity and its owner) before anything changes, deletes the replica's objects, copies the restore point's back, checks the listing, records `rolled-back.json` beside it and exits 79, and the watchdog holds it, logging `rolled_back` at every check;
2. the web Worker's and then the platform Worker's versions from before the update are deployed again as they were (code, configuration, images, secrets; `cf workers deployments create`);
3. the previous version's server restores the replica as it left it, and the command checks that it answers with a durable owner.

Each step can be repeated: run the command again after an interruption. A rollback is done once per restore point (`rolled-back.json`): a leftover order never puts it back again over later writes. With the window's secret gone (ended outside the installer) before the restore point is back, the command refuses on every run: a rollback whose order was not sent yet is called off; one whose order was sent keeps it, and the server its hold (it refuses an order outside its window), because the replica may be partly put back. That is a decision for a person: the restore point itself is never changed by a rollback, and setting the window's secret again to its ID lets the command finish. Once the update was accepted, the command refuses too.

Restore points live beside the replica in its own bucket, `s3://<replica bucket>/cfo-restore-points/<id>/` for the default replica (`replica/` holds the copied objects, `manifest.json` lists them, written last). Litestream's retention never touches them, and the installation's buckets have no lifecycle rule. The server keeps the newest three and deletes older ones when it takes a new one; the journal records the same three (`bootstrap.ts status`). To read one by hand, restore it with the pinned Litestream into a scratch file (`litestream restore -o <file> s3://<bucket>/cfo-restore-points/<id>/replica`, with the replica's credentials), never over the live replica.

**After acceptance**, problems are fixed forward. A restore after new writes is destructive recovery, not implemented as a command. Its reviewed plan must keep ingress closed, record a new database recovery generation, invalidate account authority and login grants, revoke every computer launch token, rebuild reservations from actual state and state which work is discarded before reopening. This prevents a revocation made after the restore point from returning. Never restore one computer's login files into a second live container. Restoring files cannot undo external tool effects.

Deleting a Durable Object, database, R2 prefix, initialized marker or local installation journal is not a substitute for that plan. Recovery requirements are detailed in [ADR 0007](../decisions/0007-compatible-releases-recovery.md); execution/qualification remains pending. Use the [test matrix](../testing.md) for an isolated rehearsal, not a production reset.
