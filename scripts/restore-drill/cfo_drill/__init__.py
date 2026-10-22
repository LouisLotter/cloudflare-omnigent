"""The restore drill and the durability measurements for the server image (WP2.5).

- :mod:`cfo_drill.drill` restores the replica beside the running server and checks records,
  not only ``PRAGMA integrity_check``: the security tables row by row, the acknowledged
  security changes and transcript items of a canary run, the schema and the row counts.
- :mod:`cfo_drill.canaries` makes those acknowledged changes through Omnigent's real HTTP
  routes, and checks them through the same routes after a server replacement.
- :mod:`cfo_drill.lag` turns replicated positions into the replication-lag warning.
- :mod:`cfo_drill.fence` is the reference durability fence for the Cloudflare launcher, with a
  recording stub launcher behind it (FH-29's stub-launcher part).
- :mod:`cfo_drill.harness` runs the staging measurements inside a server container.

Everything here runs inside the server image (``/opt/drill``), next to ``cfo_server``; the
pure modules (``stats``, ``lag``) also run anywhere. No module prints or stores a credential.
"""
