# Credential incidents and revocation

A computer has the person's native CLI logins and substantial delegated Omnigent authority. Wiping its files does not revoke credentials copied from it or remove schedules/policies it created. Use this guide with the exact [credential model](../decisions/0004-identity-credential-authority.md), [secret inventory](../secrets.md) and selected [artifact identity](../compatibility.md).

## Establish scope without exposing values

Record the affected computer/connection generation, timeframe, running image/fork revision and the observed behavior. Preserve only necessary, access-controlled evidence. Do not print login files, process environments, secret values, HTTP authorization headers, terminal streams or provider-key files into logs or a public report. Record secret names and presence instead of contents.

Distinguish the material at risk:

| Material | What compromise can mean |
| --- | --- |
| Claude/Codex login files | Copied refresh credentials can survive a computer wipe. Provider-side session revocation is needed; local CLI logout alone is not proof of it. |
| Omnigent launch token | Host registration/provider-credential access for that host; code on the computer can read its runtime environment. Old incarnation/generation checks must prevent registration takeover. |
| Runner binding/delegated tokens | Broad owner-equivalent application access, including other computers' work, with the fork's explicit delegation restrictions. This is not a tenant isolation boundary. |
| Native GitHub access token | When native GitHub linking is enabled, the host broker supplies plaintext to git/gh at runtime. An already vended token survives unlinking until expiry or GitHub revocation. |
| `provider_key` reference file | Codex key-provider API key held in a mode-0600 bridge file during app-server use. Removing/restarting the process does not revoke a copied key at its provider. |
| Server/Worker authority | Server cookie/storage/bridge credentials or Worker encryption keys can affect the whole installation. The storage credentials reach the replica's and the artifacts' buckets (uploaded files), never the checkpoint buckets. Worker-held encryption keys do not prevent authorized server plaintext use. |
| Checkpoint read access | Credential checkpoints contain login files. Version one has no application-level checkpoint encryption; Cloudflare account/Worker control defeats the intended storage boundary. |

Main wires Omnigent's GitHub linking and MCP registry with the Worker's key service in source. The owner's installation has run those integrations on Cloudflare, including GitHub and OpenRouter through the MCP gateway, but this is one installation rather than qualification of every release gate or credential class. Diagnose what is actually installed.

## Respond to a suspected computer compromise

The following is the accepted response sequence, not an implemented one-command recovery tool. Use the operator's trusted sessions, outside the affected computer, and record the resulting generation/revocation evidence:

1. Invalidate the owner's Omnigent account generation so existing sessions/tokens cease to authorize work. Check the selected fork's account-revocation behavior; a cookie-secret change alone is not equivalent to complete authority invalidation.
2. Review schedules, agents, policies and MCP-server settings, the servers listed in Settings → MCP among them; remove unexpected persistent instructions. Delegated runners may add session policies and manage user agents, so a clean computer alone is insufficient.
3. Revoke the relevant Claude and ChatGPT provider sessions through their account controls. Verify the replacement computer asks for the expected sign-ins; do not treat local logout as proof that a copied refresh token was revoked.
4. If native GitHub linking was enabled, revoke the Omnigent GitHub App authorization at GitHub, then unlink/relink as needed. Unlinking only stops future token vending. For each MCP service connected in Settings → MCP, disconnect it there and remove the app's access on the provider's own site: Omnigent's disconnect deletes the stored login but does not revoke the provider's grant. The login never reached a computer, but code on a computer could have replaced it with another account's, so connect it again yourself.
5. Rotate any affected provider API key and installation credentials according to their audience/scope. After preserving the evidence needed for diagnosis, replace the affected runtime through the reviewed lifecycle/recovery path.

Do not restore potentially compromised instructions/configuration blindly. Restore and account cleanup have different purposes. The full account-generation/recovery workflow is still an integration obligation; do not invent routes or bypass private controls when a required operator action is unavailable.

## Distrusted certificate authorities

A client that still trusts a compromised certificate authority can be shown a forged certificate for any host, including the provider, GitHub and storage endpoints that carry login and storage credentials. The images keep trust current this way:

1. **Know each trust store.** Debian's `ca-certificates` comes from the base image digest and the image's own install. certifi comes from the fork's lock, under the image's hash-pinned override, and pip vendors its own certifi. Node, Claude Code and Codex carry bundled roots or key denylists, though Codex's default client uses the system bundle through its own OpenSSL. Go programs (gh, Litestream) use the system bundle and get a denylist only from a newer Go toolchain.
2. **Fail the build on a stale store.** Add the distrusted root (subject name and public-key hash) and the first fixed `ca-certificates` release to [the trust check](../../images/trust/trust_check.py). A cached or stale layer then fails the build rather than shipping.
3. **Move the pins.** Update the base digest or rely on the image's `ca-certificates` install, then the certifi and pip pins (pip's also replaces the wheel `ensurepip` seeds into new virtual environments) and the CLIs. Build with fresh bases and no cache, run the image suites and, where test hosts exist, [the network probe](../testing.md#certificate-trust-checks).
4. **Replace running containers.** A running container keeps the image it started with, so stop running servers and computers and let them start on the refreshed image. Anything installed in a workspace, such as a project's own virtual environment with its own certifi, is outside the image and travels with checkpoints. Tell the person.
5. **Assess exposure.** If credentials may have crossed a forged connection, follow the compromise response above.

## Personal hosts

A personal machine connected as a host ([the guide](personal-hosts.md)) reaches the installation through the Cloudflare One Client, signed in to the installation's Zero Trust team as the owner. These boundaries hold:

- **Who gets in is unchanged.** The hostname's Access application still admits only the owner's email, and the web Worker still checks every assertion (issuer, audience, `app` type, a user rather than a service token) and the owner pin. Cloudflare One Client authentication is a way to sign in to Access, turned on for this installation's application only; the organization's default for every other application is left as it is.
- **Only the owner enrolls a device.** Device enrollment's only policy is the owner's email. The step refuses an enrollment policy someone else made that admits anyone else.
- **Nothing public.** A personal host connects out to `https://<hostname>`; it opens no port, tunnel or public route, and uses no service token. Its requests carry `Origin: omnigent://internal`, the marker Omnigent's own host, runners and command line send; ingress admits that exact value where it requires the installation's origin, because no web page can set it (a privileged browser extension could, as it could already set the installation's own origin), and the platform pages still require their exact origin.
- **The client's session is finite.** It lasts 30 days unless the installation chose otherwise (at most 90), then the person signs in again. A non-browser client whose session lapsed gets a `401`, never a login page it could hang on.

**An accepted exception to the cloud-computer custody rules.** [ADR 0004](../decisions/0004-identity-credential-authority.md) keeps long-lived Omnigent logins off cloud computers. A personal host is the owner's own machine: its Omnigent command line holds the owner's Omnigent session and refresh grant (in its own store, mode 0600), and its host runs agents with the owner's local account and files. Treat a personal machine's compromise as a compromise of the owner's Omnigent account.

**A lost or stolen machine:** revoke its registration in Zero Trust (Team & Resources → Devices → Revoke), which stops new connections through Access; change the owner's Omnigent password on `/platform/password` from another device, which rotates the account's generation and so invalidates every session, CLI sign-in and refresh grant, the lost machine's included; then remove its host in Omnigent. An open connection is not cut by Access's revocation: confirm the host shows offline. Then follow the compromise response above.

## Preserve approval and identity controls

The implemented fork delegation checks refuse approval answers, policy edits/deletes, default-policy creation, replacement of a session's agent and account/credential administration. The implemented [private computer route](../../worker/src/internal/omnigent-route.ts) additionally restricts sharing mutations, protected administrative/approval paths and another computer's identity. Its source tests and the owner's installation do not replace the still-open staging release gates or every assembled-image security check. A recorded human verdict binds a permitted runner MCP retry to its exact call and is consumed once.

Delegated runners can add session policies, set sub-agent cost budgets and manage user agents. Added policy state can affect another policy and bypass an approval; this remains an accepted risk. Connected accounts are Omnigent's MCP registry under Omnigent's own policies as they are, with no generated default approval policy ([ADR 0008](../decisions/0008-connected-accounts-omnigent-mcp-registry.md)). Omnigent refuses a delegated runner's token only under `/auth` and `/oauth`, and on its MCP page's administration routes (adding, changing and removing servers), so a runner can also list the MCP catalog and disconnect or replace one of the owner's MCP logins, never read one; the owner accepted this with the rest of an agent's reach on its own computer (decision D44), and the computer route blocks none of those endpoints. Do not describe these controls as general confinement of hostile code.

## Sharing, and nothing public

The server image chooses Omnigent's sharing settings and passes them to Omnigent as fixed values. Omnigent's own `PUT /v1/sharing` is refused, and any files it would have written are removed at every start ([`parse_sharing`](../../images/server/cfo_server/config.py)).

- **Sharing between the installation's own people is on,** Omnigent's default (owner decision D51). A thread's owner can give another signed-in member Read or Edit. The `SERVER_ENV_OMNIGENT_SHARING_MODE` secret can narrow it to `read_only`, `restricted_read_only` or `off`.
- **Nothing is public.** Sharing by link ("anyone with the link") is pinned off, at the read level, and new threads are never public. A public grant stored before, for example by an older image that allowed public sharing, gives nobody access on any path: Omnigent runs with `public_grants_when_disabled="ignored"`, and keeps the row. A setting that asks for either stops the server before it starts, with the reason in its `cfo.config.error` line: `OMNIGENT_PUBLIC_SHARING` other than `off`, `OMNIGENT_PUBLIC_SHARING_MAX_LEVEL` other than `read`, or `OMNIGENT_DEFAULT_PUBLIC_SESSIONS` other than `off`. The watchdog then holds the server until the setting changes, and `bootstrap.ts run` and `update` say so at once. A refusal's message names the setting and the rule, never the value given, which may be a secret set in the wrong place. Inside an update's window the server takes its restore point, or carries out a rollback order, before it refuses, so `update --rollback` still goes back ([troubleshooting](troubleshooting.md#a-server-that-refuses-a-setting)).
- **Edit is a grant of trust.** A colleague with Edit sends turns into the thread, and its owner's runner runs them on the owner's computer, with the owner's subscription and the connections the thread uses. Owners and administrators keep Omnigent's access to members' threads (owner decision D52). The [user manual](../manual/threads-and-sharing.md) explains both to members, with the warning about providers' terms.

## Rotation and logging

Secret changes on the platform Worker are releases and can reset Durable Object connections; plan reconnect checks and key overlap before changing them. A change to the server's secrets or settings takes effect through one controlled restart of the server, a short outage recorded with the cause `config_changed`; until then the running server keeps its previous values. A cookie-secret rotation signs everyone out at that restart, not before. The bootstrap's R2 token covers the database replica's and the artifacts' buckets, so revoking it stops both: rotate both credential pairs in the same release. Deleting it (under the user's API tokens in the dashboard, or `bootstrap.ts remove-r2-token --yes` with a login that may delete tokens; `cf`'s own sign-in may not) cuts the server off from both buckets at once; a replacement is a new token whose key pair is set as both pairs in one release, which no command does yet. Keep old credential-encryption key versions readable while stored records still reference them. Keep launcher and key-service signing credentials separate. A raw secret command is not a safe replacement for the installation's checked release path.

Credential-bearing request headers must not enter invocation logs. Both Worker configurations in main disable invocation logs while retaining structured console logs. Verify the actual deployed setting and review retained logs as part of any suspected exposure. Do not enable full header/body logging to debug authentication. Follow [troubleshooting](troubleshooting.md) for redacted observations and [recovery](recovery.md) if data must be restored.
