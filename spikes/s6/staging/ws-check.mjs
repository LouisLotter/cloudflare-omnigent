// Spike S6: check the terminal's WebSocket through the Worker with a chosen Origin header.
// A same-origin handshake must reach ttyd and run a command; a foreign origin must be refused.
//
//   node spikes/s6/staging/ws-check.mjs http://127.0.0.1:18786 [origin]
import { randomBytes } from "node:crypto";
import http from "node:http";

const base = new URL(process.argv[2]);
const origin = process.argv[3] ?? base.origin;

function frame(text) {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const header =
    payload.length < 126
      ? Buffer.from([0x82, 0x80 | payload.length])
      : Buffer.from([0x82, 0x80 | 126, payload.length >> 8, payload.length & 255]);
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
  return Buffer.concat([header, mask, masked]);
}

const req = http.request({
  host: base.hostname,
  port: base.port,
  path: "/term/ws",
  headers: {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
    "Sec-WebSocket-Protocol": "tty",
    Origin: origin,
  },
});
const finish = (result) => {
  console.log(JSON.stringify({ origin_matches: origin === base.origin, ...result }));
  process.exit(0);
};
req.on("response", (res) => finish({ upgraded: false, status: res.statusCode }));
req.on("upgrade", (_res, socket) => {
  let seen = "";
  socket.on("data", (d) => {
    seen += d.toString("latin1");
    if (seen.includes("S6TERM42OK")) finish({ upgraded: true, command_ran: true });
  });
  socket.write(frame(JSON.stringify({ AuthToken: "", columns: 100, rows: 30 })));
  setTimeout(() => socket.write(frame("0echo S6TERM$((40+2))OK\r")), 800);
  setTimeout(() => finish({ upgraded: true, command_ran: false }), 10000);
});
req.on("error", (e) => finish({ error: e.code }));
req.end();
