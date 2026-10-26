# Secret and credential inventory

Record each new credential's purpose, audience, custody, persistence and revocation before using it. Values, login files, account identifiers and personal data do not belong in source, fixtures, test snapshots, build images, public evidence or logs. This inventory describes the server base and accepted future computer/connection design; [compatibility](compatibility.md) identifies what is actually included.

## Handling rules

- Keep deployment credentials on the authorized installer's computer. CI uses ordinary pull requests, a read-only repository token and no persisted checkout credentials; untrusted builds receive no provider/deployment secrets.
- Pass secrets through the checked bootstrap/staging tooling's prompt or stdin, not command arguments, tracked configuration or shell history. The tooling uses transient restricted files/open descriptors for deployment. Preserve its target/account checks; do not replace it with an unchecked bulk secret command.
- Treat platform secret changes as releases. Removing bootstrap credentials requires durable initialization, not only a successful local account query. Key rotation requires overlap and post-release checks.
- A release that changes the server's configuration takes effect through one controlled server restart. A container receives its environment only when it starts, and the new platform version adopts the running container, so until the restart the server keeps its previous values. The watchdog compares the configuration's fingerprint (a one-way digest, stored by the server's Durable Object and never logged) with the one the running container started with, and replaces an answering server once: SIGTERM, the entrypoint's final sync, then a start that restores the database. Expect a short outage per such release, recorded with the cause `config_changed`; a start still restoring or initializing is replaced only once it answers, and recovery mode is never restarted. The bootstrap counts its release complete only when the restarted server, running the released configuration, reports a durable owner.
- Copy declared native login files as opaque bytes. Do not parse or log them. Use synthetic runtime-generated canaries in tests, and record which paths, formats and values a scan covered.
- Do not log credential-bearing request headers or terminal/viewer streams. Both production Worker configurations set `observability.logs.invocation_logs: false` while retaining structured console logs. Do not send credential-bearing traffic through a Worker with invocation logs enabled; custom headers such as `X-Omnigent-Host-Token`, `X-Omnigent-Runner-Tunnel-Token` and `x-api-key` may be recorded. Verify the deployed configuration and keep credentials out of console logs.

## Installer-local material

| Material | Custody / removal |
| --- | --- |
| Wrangler and `cf` authentication | Existing CLI-managed stores on the installer computer; separate logins. Use the relevant CLI logout/revocation workflow when withdrawing access, rather than printing credentials. |
| GitHub CLI authentication | Existing CLI-managed credential store or keyring; do not assume a token file exists. Git/SSH credentials are separate from platform deployment credentials. |
| Staging configuration, registry and locks | `CFO_STAGING_DIR` or the staging tool's default config directory, outside the repository. Contains identifying account/zone/ownership data. Tooling manages registry/lifecycle records; do not delete locks to bypass another run. |
| Bootstrap journal | `CFO_INSTALL_DIR` or the installation tool's default config directory; restricted mode-0600 file in a mode-0700 directory. Identifying installation plan/progress, not passwords or keys. Keep until the installation is intentionally retired. |
| Optional staging Tunnel/service-token credentials | Only reviewed staging manifests use these; normal computer transport does not depend on an Access service token. Secrets travel through guarded input/upload paths, are scoped to their staging resources and are removed by the guarded teardown. Expiry alone is not proof of resource deletion. |
| Real native CLI test logins | Only the reviewed computer under test and its intended credential checkpoint; sign out after the run and verify restored absence. Provider-side revocation is separate from local logout. |

## Implemented server-base settings

Only `SERVER_ENV_<NAME>` values deliberately forwarded by the [server environment adapter](../worker/src/server/server-env.ts) become `<NAME>` in the container. This is an explicit prefix mapping, not a claim that containers contain no secrets. The image also pins or removes settings it does not support.

| Worker-held name | Purpose and container use | Removal / rotation |
| --- | --- | --- |
| `SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD` | Initial owner bootstrap; explicit username is a non-secret setting. Forwarded only to the server while needed. | Checked bootstrap release removes it only after current-installation initialization and replication proof. The running server loses it at the restart that applies the release; the bootstrap waits for that restart. The owner then verifies sign-in and changes the password as appropriate. |
| `SERVER_ENV_CFO_INSTALLATION_INITIALIZED` | Non-secret expectation deliberately stored as a secret so ordinary configuration deploys cannot erase it. A missing/old replica must produce recovery mode. | Do not clear it to force setup. Recovery requires an explicit plan. |
| `SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET` | Server session cookies. | Deliberate secret release. Existing cookie sessions end at the server restart that applies it: from then on the old key's cookies are refused and everyone signs in again. Until that restart the old key stays in use. This is not by itself complete revocation of every bearer/grant. |
| `SERVER_ENV_LITESTREAM_ACCESS_KEY_ID`, `SERVER_ENV_LITESTREAM_SECRET_ACCESS_KEY` | Bucket-scoped database replication credentials. The image gives these to Litestream and removes them from the app child's environment. Litestream's restore and replicate processes receive only these and basic process settings (an allowlist): never the bootstrap password, cookie secret, launcher key or artifact-storage credentials. | Rotate/revoke the scoped R2 credential; the new one is used from the server restart that applies the release. Do not broaden it to computer-checkpoint buckets. |
| `SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY`, `SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY_ID` | The launcher API's HMAC key (its UTF-8 bytes, at least 32) and its key ID; separate from the credential key service's key. The server's Cloudflare launcher signs with it as `CFO_LAUNCHER_SIGNING_KEY`, and the platform Worker's `platform.internal` receiver verifies with the same Worker secrets. Only the server container receives the signing pair. With neither set, the launcher stays registered but refuses every call, and so does the receiver; one alone or a malformed value stops the app. Not yet set by any deployment tool. | Rotate as a deliberate platform release with overlap: move the old key and ID to `CFO_LAUNCHER_SIGNING_KEY_PREVIOUS` and `CFO_LAUNCHER_SIGNING_KEY_PREVIOUS_ID` (Worker-only), set the new current pair; the watchdog's controlled restart that applies this release makes the server sign with the new key. Delete the previous pair only after that restart. |
| Access issuer/audience, hostname and owner pin | Ingress configuration. The salted pin permits guessing attacks against candidate addresses and is not a confidential identity store. | Update through installation configuration; keep identifying configuration out of public run records. |

There is no platform Omnigent login. Main/candidate explicitly disable native GitHub linking and the HTTP credential cipher configuration. Main registers the Cloudflare launcher, but its receiver on `platform.internal` is unfinished, so setting the launcher's key does not make computers usable. Setting integration environment variables does not enable unfinished wiring.

## Accepted computer/connection credential design

| Class | Intended custody and persistence |
| --- | --- |
| Host launch token | Supervisor/host memory and process environments, stable only for that live incarnation; no disk login or checkpoint copy. Generation/start claims and launch-token-only registration protect host identity. |
| Runner binding/delegated tokens | Runtime authority and excluded harness-secret families; short-lived delegated owner-equivalent access with explicit approval/account/policy restrictions. Broad access to other computers' work remains possible. |
| Native Claude/Codex logins | Declared credential checkpoint files: `.claude/.credentials.json`, `.claude/.device-keys.json`, `.codex/auth.json`, `.codex/.credentials.json`, relative to the computer home. No Omnigent login/refresh-grant file is declared. |
| Native-harness continuation | Save configuration, rollouts, transcripts, private Codex home and undelivered-event state. Exclude classified credential families and temporary siblings, not whole continuation directories. |
| Codex key-provider API key | Mode-0600 `provider_key` in `.omnigent/codex-native/<bridge>/`, read through a reference in generated config and removed on app-server close. `provider_key.*` temporary files are also excluded. Saved configuration uses references; computer key-provider configuration must not inline the key. |
| Native GitHub linking | Planned server-side GitHub App configuration and encrypted access/refresh records. Worker holds encryption keys; server uses plaintext for refresh/vending. Host broker supplies only the access token to git/gh at runtime, without helper-argv/gh token files. The refresh token stays on the server. Other native providers remain unconfigured. |
| Worker key service | Planned versioned encryption keys in Worker secrets plus a separate server signing credential. Record context/key identity are authenticated; old key versions remain readable while records use them. No deployed secret setting name is promised for this unfinished service. |
| Launcher and gateway signing | Separate server-side bridge credentials with key IDs and overlap for rotation. They authorize private operations, not public access. Keep launcher and key-service signing authority separate. The launcher's signer and its verifying receiver are in source (above); the key-service and gateway credentials remain planned. |
| Platform connected-account tokens and wrapping keys | Planned Worker-side connection service; raw connected-account credentials do not reach computers. This differs from the deliberate native GitHub exception. |

The [policy authority](../contracts/src/checkpoint-policy.ts) classifies secret families; the [manifest contract](../contracts/src/manifests.ts) declares opaque login files/tombstones. Workspace restore filters every layer; the newest credential generation/order is installed separately. A sign-out needs a published tombstone and restore verification so older saves cannot reintroduce login files.

The accepted design keeps checkpoint buckets private and accessible through Worker bindings, with no S3 API token for computers. Version one relies on R2 encryption at rest, without application-level checkpoint encryption. Someone controlling the Worker/account can read saved logins. The database replica contains encrypted native credential-store records only after the planned cipher integration exists; encryption-key separation does not remove server plaintext access.

## Verification and incident response

The [canary scanner](../scripts/canary-scan.ts) checks synthetic markers and exact configured values in selected supported inputs. Its existing CI invocation is not a whole-repository/history/image or arbitrary-secret scan; incomplete input fails. Actual checkpoint qualification additionally walks/decompresses every published layer, covers all live token generations and encoded forms, and proves detection with planted values. Those product tests are still pending integration.

Use [security operations](operations/security.md) for provider-side revocation, account-generation invalidation, persistence review and safe evidence collection. A computer wipe or local CLI logout alone does not establish revocation of copied credentials.
