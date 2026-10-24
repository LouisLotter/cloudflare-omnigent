# 0002 — Two Workers and native transport

Status: accepted design. The server-base split is implemented in main; computer-route integration remains draft.

## Context

A deployment of the Worker hosting Durable Objects can reset the long-lived connections passing through those objects after their version switch. UI changes should not force every computer to reconnect. Container interception also has WebSocket handshake behavior that a local development proxy can hide.

## Decision

Build two deployments from one source tree:

- The platform Worker owns Durable Objects, container classes, private virtual hosts and egress. It has no public route.
- The web Worker owns public ingress, forwarding and platform pages. It reaches the platform through versioned bindings and keeps no application state.

The accepted computer connection is native forwarding: container interception at `omnigent.internal`, then the server's Durable Object, then the server container. It bypasses the web Worker. The server object fetches the native container TCP port and returns its unaccepted WebSocket response. This path must not accept both sockets through the containers library's default forwarding helper. A platform response carries only the subprotocol header on its 101; the interception layer supplies the handshake headers. Duplicated `Upgrade` headers break the deployed handshake even where local development appears to work.

Interception is also a policy boundary: trusted computer identity/generation, canonical route restrictions and size/stream limits are checked before forwarding. A private hostname is never admitted through the public route table. Native forwarding does not remove authentication or authority checks.

A web release does not sit on the computer tunnel path. Browser sockets, terminals and viewers do traverse the web Worker and may drop after its release; they reconnect and renew capabilities. Platform releases, image changes and platform secret changes require deliberate reconnect/recovery checks. Deploy platform additions before web code uses them; reject unsupported interface versions visibly.

## Alternatives and consequences

Keeping UI and Durable Objects in one deployment made frequent UI releases disrupt every live computer. Extra connection bridges add socket ownership and forwarding complexity. Cross-script Durable Object bindings preserve the split with fewer hops; a service-binding entrypoint remains the fallback if those bindings cannot support the required behavior. That fallback is not an additional active topology.

Reconnects are expected failures to handle, not proof of lost work. Operation identity, durable acknowledgements and uncertainty rules remain necessary across them. Measured version-switch delays are observations, not platform timing guarantees.

## Implementation and qualification

Main has both [platform](../../worker/wrangler.jsonc) and [web](../../worker/wrangler.web.jsonc) configurations, [versioned RPC](../../worker/src/shared/rpc.ts), [native-port adapter](../../worker/src/server/container-port.ts) and [forwarding](../../worker/src/server/forward.ts). The web entrypoint currently forwards to Omnigent; platform pages are future work. Main does not yet implement the complete private computer interception path.

Saved server-forwarding and topology experiments support this choice. They do not qualify the final real-host/runner assembly, half-open HTTP behavior or route-security matrix. The paused routes branch contains harness work, not a completed production router. Source/tests: [deployment boundaries](../../worker/test/unit/deployments.test.ts), [container adapter](../../worker/test/unit/container-port.test.ts), [forwarding tests](../../worker/test/unit/forward.test.ts), [server Workers-runtime tests](../../worker/test/workers/omnigent-server.test.ts). Local and deployed transport checks cover different failure surfaces.
