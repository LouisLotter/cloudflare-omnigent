// How the computer's route answers a WebSocket upgrade that the server accepted. Runtime-bound
// (Response 101, WebSocketPair); exercised by the Workers-runtime tests.

import { bareUpgradeHeaders } from "../server/headers.ts";

export interface UpgradeAnswerOptions {
  /** Called once when the socket ends, with which side ended it. */
  onEnd?(fields: Readonly<Record<string, unknown>>): void;
}

/** The server's 101, returned as it came: the socket unaccepted, at most the subprotocol. */
export function serverUpgradeAnswer(
  response: Response,
  _options: UpgradeAnswerOptions = {},
): Response {
  return new Response(null, {
    status: 101,
    webSocket: response.webSocket,
    headers: bareUpgradeHeaders(response.headers),
  });
}
