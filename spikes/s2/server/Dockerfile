# The published Omnigent server, pinned to v0.17.0 (released 2026-10-05, outside the seven-day
# cooldown). Local SQLite on the container disk: the spike needs no durability beyond the
# container's life, and records whether the server container restarted.
FROM ghcr.io/omnigent-ai/omnigent-server:v0.17.0@sha256:101474ecb299d45aacf49cb01051cc2cc5392ee6a6d30879d72c55bf346af3c3
# Changed for each staging redeploy after a teardown. Docker remembers that the old image was
# pushed, the registry still serves its manifest after deletion, so Wrangler skips the push and
# creating the application fails with IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE.
LABEL cloudflare-omnigent.staging-build="2026-10-19"
