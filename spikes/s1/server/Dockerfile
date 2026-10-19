# S1 server image: the published Omnigent server, pinned by digest, with SQLite on the
# container disk and Omnigent's login switched off. Only the Worker's own Durable Objects reach
# it; it has no public route. The spike needs a server only so that a host can come online.
FROM ghcr.io/omnigent-ai/omnigent-server:v0.17.0@sha256:101474ecb299d45aacf49cb01051cc2cc5392ee6a6d30879d72c55bf346af3c3

ENV DATABASE_URL=sqlite:////tmp/omnigent.db \
    OMNIGENT_AUTH_ENABLED=0 \
    HOST=0.0.0.0 \
    PORT=8000
