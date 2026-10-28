"""The Omnigent server image for Omnigent on Cloudflare (WP2.3).

The image runs Omnigent, built from the Dockerfile's pinned fork revision, with Litestream
replicating its SQLite database to R2. This package is the image's own code:

- :mod:`cfo_server.entrypoint`, the container's main process: restore, recovery mode,
  settings files, then Litestream and the Omnigent app as two supervised children, and a
  checked final sync on shutdown;
- :mod:`cfo_server.app`, the Omnigent app: one ``create_app`` call with authoritative sharing
  settings, the launcher registration and both durability barriers;
- :mod:`cfo_server.barrier`, the response barrier for security writes and the transcript
  barrier for core change 14;
- :mod:`cfo_server.litestream`, the client for Litestream's control socket;
- :mod:`cfo_server.config`, the deployment settings, parsed strictly from the environment.

No Omnigent file is edited and no Omnigent module attribute is replaced.
"""
