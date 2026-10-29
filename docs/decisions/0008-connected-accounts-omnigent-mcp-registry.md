# 0008 — Connected accounts through Omnigent's MCP registry

Status: accepted design (owner decision D43, 29 October 2026). Supersedes ADR 0004's "Platform connected accounts" custody row and its sentence on installation-wide default approval policies for connected accounts. Platform wiring is in source and tested locally; Cloudflare qualification remains.

## Context

The earlier plan built connected accounts on the platform: a Worker connection service with one Durable Object per account, its own vault and operation journal, a gateway on a private host, two core changes in Omnigent to plug it in, and installation-wide default approval policies generated for write tools (ADR 0004). Meanwhile Omnigent gained what that plan provided: an MCP registry of administrator-approved services, a gateway on its own server that holds each account's login and calls the service itself, a settings page to connect, test and disconnect accounts, a per-conversation picker, and policies around every gateway call. Its credential store encrypts through a pluggable cipher, and the platform Worker already serves the key service that cipher needs (ADR 0004, WP5.9). On the platform the registry was simply not switched on, and the cipher was tied to GitHub linking.

## Decision

**Omnigent's server is the gateway.** Connected accounts are Omnigent's own MCP registry: `POST /v1/mcp/{service}` on the server, its credential store, its Settings → MCP page and its picker. The platform builds no gateway, connection service, vault, journal or approval layer of its own, and needs no Omnigent core change for it.

**Custody.** An account's login is a row of Omnigent's credential store, sealed by the platform Worker's key service under the record's own identity; the database and its replica hold only ciphertext, and the record keys never leave the Worker. The server uses the plaintext only in memory, to call the service or refresh the login, and every write to the record (connect, a refresh that rotates the refresh token, disconnect) is acknowledged only once replicated (ADR 0003). No endpoint returns a token, and generic MCP logins are never vended to a host: no connected account's login reaches a computer or a checkpoint. GitHub's native linking remains the one deliberate exception (ADR 0004). The cipher is on whenever the key service's signing pair is set, with or without GitHub, and the installer makes the key service's keys at install.

**Which services.** A service is one Omnigent registry entry shipped in the server image as a manifest, reviewed and released with the code, with a non-empty tool allowlist and the list of what the installer must ask for (the service's origin, an OAuth client's ID and secret). The installation stores only its choices, as Worker secrets that reach the server; the image checks them at every start and builds the registry. The server refuses to start (exit 78, naming the setting, never its value) on a manifest or choice that breaks the destination rules: `https` only, a public host name (no IP literal, `localhost`, `.internal` or `.local` host), no credentials, query or fragment in a URL; Omnigent itself refuses redirects. Adding or changing a service is a secrets change through the installer, which waits for the server's restart and confirms from Omnigent's own `/v1/info`.

**Approvals.** Writes go through Omnigent's policies as they are. No default approval policy is generated, and manifests carry no read/write split for policy purposes. An ask rule can be added in Omnigent later. The approval-bypass risk ADR 0004 records for policies added by runner tokens is unchanged.

**Disconnect** deletes the login; the next call fails at once, and a call already authorized may finish. It does not revoke the grant at the provider.

## Alternatives and consequences

The platform connection service would have given the same guarantee to computers, logins never on a computer, with far more parts in two repositories. A separate connector container or a hosted MCP portal would add cost or a second gateway in front of Omnigent's.

Consequences:
- A service the installation turns on, or a change to it, restarts the server once.
- A tool a service adds later stays hidden until its manifest lists it.
- Version one has no OAuth discovery or dynamic client registration, no refresh after a provider's 401, and "connected" only means that a record exists; a dead login shows "Reconnect" only with the fork change that adds it.
- Code on a computer holds a runner's delegated owner token, which Omnigent refuses only under `/auth` and `/oauth`: it can list the catalog and disconnect or replace one of the owner's logins, never read one. The owner accepted this with the rest of an agent's reach on its own computer (decision D44, 30 October 2026): what must not leak are the logins and keys shared with Omnigent, and none of these calls returns one. The computer route therefore blocks none of Omnigent's MCP account endpoints.
- Whoever controls the Worker or the account can use the logins, as for GitHub's.

## Implementation and qualification

Platform main builds [Omnigent's registry](../../images/server/cfo_server/app.py) from the [shipped manifests](../../images/server/services/) and [the installation's choices](../../images/server/cfo_server/mcp.py), with the credential store on the [key service](../../worker/src/internal/key-service.ts); the installer's `bootstrap.ts services` step stores the choices and waits for the server's report on the watchdog's status line. Version one ships Omnigent's demo OAuth MCP service as the test service and GitHub's MCP server through the GitHub link. Tested in source, in process with a loopback key service and the demo service, and in a local end-to-end run with the platform Worker's real key service, the server and computer images and the demo service over HTTPS (connect, calls from a computer with the runner's own client, a refresh, disconnect, ciphertext only in the database and its replica, a canary scan of the computer, of what its checkpoint would hold and of every log). Not yet run on Cloudflare: the provider's callback through Access, a computer's private route to the gateway, drops and deploys during a call, and a real provider's OAuth client.
