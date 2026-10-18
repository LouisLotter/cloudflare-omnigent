# S1 computer image, approximating the design's computer image: the Omnigent host, Claude Code
# and Codex, with git and tmux. The files come from the published Omnigent host image, pinned by
# digest. That image also bundles Kiro, Antigravity, pi and gh (about 2.9 GB, one layer of
# 1.7 GB), which the design does not use, so they are left out. The supervisor and the restore
# step are not part of this spike's image.
FROM ghcr.io/omnigent-ai/omnigent-host:v0.17.0@sha256:51880f0edb7e0357f395f88f4bc3c4e1dfc3df06e46cffb55ae6700c1dfd82b2 AS published

FROM python:3.12.15-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:${PATH}" \
    IS_SANDBOX=1

# The host image's runtime tools, as in Omnigent's deploy/docker/Dockerfile host stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git tmux procps lsof bubblewrap curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=published /usr/local/bin/node /usr/local/bin/node
COPY --from=published /usr/local/lib/node_modules/@anthropic-ai /usr/local/lib/node_modules/@anthropic-ai
COPY --from=published /usr/local/lib/node_modules/@openai /usr/local/lib/node_modules/@openai
RUN ln -s ../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe /usr/local/bin/claude \
 && ln -s ../lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex
COPY --from=published /build /build
COPY --from=published /opt/venv /opt/venv

# Changing S1_IMAGE_SALT changes only this layer, giving a new image digest for cold starts.
ARG S1_IMAGE_SALT=1
RUN echo "${S1_IMAGE_SALT}" > /etc/s1-image-salt
COPY s1-entry.sh /usr/local/bin/s1-entry.sh
RUN chmod 0755 /usr/local/bin/s1-entry.sh
WORKDIR /root
CMD ["/usr/local/bin/s1-entry.sh"]
