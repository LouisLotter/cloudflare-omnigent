"""Runs Omnigent's demo OAuth MCP service (``examples/mcp-registry/demo_service.py``) under a
public name, for the platform's tests (WP5.10's end-to-end test, WP5.13's check on Cloudflare).

The demo itself is unchanged. Two things its own ``__main__`` cannot do are set here:

- **its name.** The MCP SDK's FastMCP turns on DNS-rebinding protection for a server bound to
  ``127.0.0.1`` and accepts only ``localhost`` names (``Host``); any other answers 421. The
  service's own public name is added to the names it accepts, and nothing else;
- **TLS,** when ``--tls-cert`` and ``--tls-key`` are given; without them it serves plain HTTP on
  the port, for a tunnel that terminates TLS in front of it (``cloudflared tunnel --url``).

Run it with the server image's Python, which has the demo and its packages::

    docker run --rm -p 127.0.0.1:18782:18782 \\
      -v "$PWD/images/server/tests/integration/mcp_registry:/run-demo:ro" \\
      --entrypoint /opt/venv/bin/python <server image> -I /run-demo/run_demo.py \\
      --public-host <name> \\
      --redirect-uri https://<installation>/v1/connections/mcp-tracker/callback

The demo uses fictional accounts and grants without a login: never leave it running.
"""

from __future__ import annotations

import argparse
import importlib.util

DEMO = "/build/examples/mcp-registry/demo_service.py"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--public-host", required=True, help="the name clients use for it")
    parser.add_argument("--redirect-uri", required=True, help="Omnigent's callback for tracker")
    parser.add_argument("--port", type=int, default=18782)
    parser.add_argument("--tls-cert")
    parser.add_argument("--tls-key")
    parser.add_argument("--demo", default=DEMO)
    args = parser.parse_args()

    spec = importlib.util.spec_from_file_location("demo_service", args.demo)
    assert spec is not None and spec.loader is not None
    demo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(demo)
    # As the demo's own --redirect-uri option sets it.
    demo.REDIRECT_URI = args.redirect_uri
    # The session manager holds this same settings object: its accepted names grow by one.
    security = demo.mcp.settings.transport_security
    if security is not None:
        security.allowed_hosts.extend([args.public_host, f"{args.public_host}:*"])

    import uvicorn

    tls = (
        {"ssl_certfile": args.tls_cert, "ssl_keyfile": args.tls_key}
        if args.tls_cert and args.tls_key
        else {}
    )
    uvicorn.run(demo.app, host="0.0.0.0", port=args.port, log_level="warning", **tls)


if __name__ == "__main__":
    main()
