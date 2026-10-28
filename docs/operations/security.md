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
| Native GitHub access token | With Omnigent linking enabled in a future assembled release, the host broker supplies plaintext to git/gh at runtime. An already vended token survives unlinking until expiry or GitHub revocation. |
| `provider_key` reference file | Codex key-provider API key held in a mode-0600 bridge file during app-server use. Removing/restarting the process does not revoke a copied key at its provider. |
| Server/Worker authority | Server cookie/storage/bridge credentials or Worker encryption keys can affect the whole installation. The storage credentials reach the replica's and the artifacts' buckets (uploaded files), never the checkpoint buckets. Worker-held encryption keys do not prevent authorized server plaintext use. |
| Checkpoint read access | Credential checkpoints contain login files. Version one has no application-level checkpoint encryption; Cloudflare account/Worker control defeats the intended storage boundary. |

Main and the server candidate still disable native GitHub/cipher wiring; the Worker key service and connected-account service remain unfinished. Diagnose what is actually installed rather than assuming every planned credential class exists.

## Respond to a suspected computer compromise

The following is the accepted response sequence, not an implemented one-command recovery tool. Use the operator's trusted sessions, outside the affected computer, and record the resulting generation/revocation evidence:

1. Invalidate the owner's Omnigent account generation so existing sessions/tokens cease to authorize work. Check the selected fork's account-revocation behavior; a cookie-secret change alone is not equivalent to complete authority invalidation.
2. Review schedules, agents, policies and MCP-server settings; remove unexpected persistent instructions. Delegated runners may add session policies and manage user agents, so a clean computer alone is insufficient.
3. Revoke the relevant Claude and ChatGPT provider sessions through their account controls. Verify the replacement computer asks for the expected sign-ins; do not treat local logout as proof that a copied refresh token was revoked.
4. If native GitHub linking was enabled, revoke the Omnigent GitHub App authorization at GitHub, then unlink/relink as needed. Unlinking only stops future token vending. Revoke/reconnect the platform's connected accounts if that planned service is present in the installed release.
5. Rotate any affected provider API key and installation credentials according to their audience/scope. After preserving the evidence needed for diagnosis, replace the affected runtime through the reviewed lifecycle/recovery path.

Do not restore potentially compromised instructions/configuration blindly. Restore and account cleanup have different purposes. The full account-generation/recovery workflow is still an integration obligation; do not invent routes or bypass private controls when a required operator action is unavailable.

## Distrusted certificate authorities

A client that still trusts a compromised certificate authority can be shown a forged certificate for any host, including the provider, GitHub and storage endpoints that carry login and storage credentials. The images keep trust current this way:

1. **Know each trust store.** Debian's `ca-certificates` comes from the base image digest and the image's own install. certifi comes from the fork's lock, under the image's hash-pinned override, and pip vendors its own certifi. Node, Claude Code and Codex carry bundled roots or key denylists, though Codex's default client uses the system bundle through its own OpenSSL. Go programs (gh, Litestream) use the system bundle and get a denylist only from a newer Go toolchain.
2. **Fail the build on a stale store.** Add the distrusted root (subject name and public-key hash) and the first fixed `ca-certificates` release to [the trust check](../../images/trust/trust_check.py). A cached or stale layer then fails the build rather than shipping.
3. **Move the pins.** Update the base digest or rely on the image's `ca-certificates` install, then the certifi and pip pins (pip's also replaces the wheel `ensurepip` seeds into new virtual environments) and the CLIs. Build with fresh bases and no cache, run the image suites and, where test hosts exist, [the network probe](../testing.md#certificate-trust-checks).
4. **Replace running containers.** A running container keeps the image it started with, so stop running servers and computers and let them start on the refreshed image. Anything installed in a workspace, such as a project's own virtual environment with its own certifi, is outside the image and travels with checkpoints. Tell the person.
5. **Assess exposure.** If credentials may have crossed a forged connection, follow the compromise response above.

## Preserve approval and identity controls

The implemented fork delegation checks refuse approval answers, policy edits/deletes, default-policy creation, replacement of a session's agent and account/credential administration. The accepted platform design additionally requires the private computer route to restrict sharing mutations, protected administrative/approval paths and another computer's identity; that production route is not yet implemented. A recorded human verdict binds a permitted runner MCP retry to its exact call and is consumed once.

Delegated runners can add session policies, set sub-agent cost budgets and manage user agents. Added policy state can affect another policy and bypass an approval; this remains an accepted risk. The planned connected-account service uses installation-wide default approval policies. Do not describe these controls as general confinement of hostile code.

## Rotation and logging

Secret changes on the platform Worker are releases and can reset Durable Object connections; plan reconnect checks and key overlap before changing them. A change to the server's secrets or settings takes effect through one controlled restart of the server, a short outage recorded with the cause `config_changed`; until then the running server keeps its previous values. A cookie-secret rotation signs everyone out at that restart, not before. The bootstrap's R2 token covers the database replica's and the artifacts' buckets, so revoking it stops both: rotate both credential pairs in the same release. Deleting it (`bootstrap.ts remove-r2-token --yes`, or under the user's API tokens in the dashboard) cuts the server off from both buckets at once; a replacement is a new token whose key pair is set as both pairs in one release, which no command does yet. Keep old credential-encryption key versions readable while stored records still reference them. Keep launcher and key-service signing credentials separate. A raw secret command is not a safe replacement for the installation's checked release path.

Credential-bearing request headers must not enter invocation logs. The separate candidate explicitly disables invocation logs on both Workers while retaining structured console logs; main does not yet carry that correction. Verify the actual deployed setting and review retained logs as part of any suspected exposure. Do not enable full header/body logging to debug authentication. Follow [troubleshooting](troubleshooting.md) for redacted observations and [recovery](recovery.md) if data must be restored.
