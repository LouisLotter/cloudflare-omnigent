// How the computer's route answers a WebSocket upgrade the server accepted: the server object's
// socket goes back unaccepted, under a 101 that carries at most the subprotocol (R-24), so the
// container egress writes the only handshake headers (spike S1). Native forwarding (A′, D18):
// WP3.3's staging diagnostic (25 Oct) saw every end of the server's side reach the computer as a
// transport close within 2 s on this path, so the route does not bridge the socket in
// JavaScript. Runtime-bound (a 101 Response); exercised by the Workers-runtime tests.

import { bareUpgradeHeaders } from "../server/headers.ts";

export function serverUpgradeAnswer(response: Response): Response {
  return new Response(null, {
    status: 101,
    webSocket: response.webSocket,
    headers: bareUpgradeHeaders(response.headers),
  });
}
