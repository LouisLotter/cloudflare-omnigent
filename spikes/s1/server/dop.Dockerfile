# The S1 server image for cfo-stg-s1-dop: the same server as ./Dockerfile, with one extra layer
# so that its digest differs. With identical digests, Wrangler 4.149.0 reported the image
# "already exists remotely" (it was in the s1-life repository), skipped the push to this
# deployment's repository, and creating the application then failed with
# IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE.
FROM ghcr.io/omnigent-ai/omnigent-server:v0.17.0@sha256:101474ecb299d45aacf49cb01051cc2cc5392ee6a6d30879d72c55bf346af3c3

ENV DATABASE_URL=sqlite:////tmp/omnigent.db \
    OMNIGENT_AUTH_ENABLED=0 \
    HOST=0.0.0.0 \
    PORT=8000

RUN echo dop > /etc/s1-deployment
