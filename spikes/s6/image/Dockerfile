# Spike S6 computer image: Omnigent's host image with the pinned Claude Code and Codex CLIs,
# the spike's checkpoint code, fake CLIs (under /opt/s6/fakes/bin, not on PATH), inotify-tools
# for write traces, and ttyd for the owner's sign-in terminal in staging.
#
# Build context: spikes/s6
#   docker build -f spikes/s6/image/Dockerfile -t cfo-s6-computer:dev spikes/s6
#
# Versions: the newest releases at least seven days old on 2026-10-18 (AGENTS.md cooldown).
#   Omnigent host v0.17.0 (2026-10-05), Claude Code 2.1.296 (2026-10-09), Codex 0.162.1 (2026-10-09).
FROM ghcr.io/omnigent-ai/omnigent-host@sha256:51880f0edb7e0357f395f88f4bc3c4e1dfc3df06e46cffb55ae6700c1dfd82b2

ARG CLAUDE_CODE_VERSION=2.1.296
ARG CODEX_VERSION=0.162.1
ARG TTYD_SHA256=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55

RUN apt-get update \
 && apt-get install -y --no-install-recommends inotify-tools strace \
 && rm -rf /var/lib/apt/lists/*

# Replace the base image's CLIs (Claude Code 2.1.290, Codex 0.160.1) with the pinned versions,
# exactly as published on npm.
RUN npm uninstall -g @anthropic-ai/claude-code @openai/codex \
 && npm install -g --no-fund --no-audit --registry=https://registry.npmjs.org/ \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 && claude --version && codex --version \
 && rm -rf /root/.codex /root/.claude /root/.claude.json /root/.npm

RUN curl -fsSL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
 && echo "${TTYD_SHA256}  /usr/local/bin/ttyd" | sha256sum -c - \
 && chmod 755 /usr/local/bin/ttyd

# Codex: file-based credentials, no analytics, no update check. Managed config wins over the
# user's ~/.codex/config.toml, which lives in the workspace checkpoint.
COPY image/codex-managed_config.toml /etc/codex/managed_config.toml

# Claude Code: telemetry, error reporting and updates off (design, "Network").
ENV DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    DISABLE_UPDATES=1 \
    S6_CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION} \
    S6_CODEX_VERSION=${CODEX_VERSION}

COPY credsync /opt/s6/credsync
COPY fakes /opt/s6/fakes
COPY realcli /opt/s6/realcli
COPY owner /opt/s6/owner
COPY staging/selftest.py /opt/s6/staging/selftest.py
COPY image/entry.sh /opt/s6/image/entry.sh
RUN chmod 755 /opt/s6/fakes/bin/* /opt/s6/realcli/*.sh /opt/s6/owner/*.sh /opt/s6/image/entry.sh \
 && ln -s /opt/s6/owner/inner.sh /usr/local/bin/s6

# 1 in the staging build (wrangler image_vars): the entry point serves the owner's terminal.
ARG S6_SERVE=0
ENV S6_SERVE=${S6_SERVE}
WORKDIR /root
CMD ["/opt/s6/image/entry.sh"]
