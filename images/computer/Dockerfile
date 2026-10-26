# syntax=docker/dockerfile:1.17@sha256:38387523653efa0039f8e1c89bb74a30504e76ee9f565e25c9a09841f9427b05
#
# The cloud computer image for Omnigent on Cloudflare (WP3.4).
#
# Build context: the repository root (Wrangler's `image_build_context`), for example
#   docker build -f images/computer/Dockerfile -t cfo-computer:dev .              (the computer)
#   docker build -f images/computer/Dockerfile --target test -t cfo-computer:test .
# The last stage is the computer, so a build without --target (Wrangler's) gets the computer.
#
# What it holds:
#   - Omnigent's host, built from the fork LouisLotter/omnigent at the pinned `cfo/integration`
#     commit. The stages mirror the `host` target of the fork's deploy/docker/Dockerfile, whose
#     SHA-256 is checked, so a commit bump fails here until the mirror is reviewed. Differences:
#     Python packages install from the fork's uv.lock; only Claude Code and Codex are installed
#     (not pi, kiro-cli or agy, about 1.2 GB of other CLIs), at exact published versions, not
#     "latest"; no Databricks, GitHub App or credential-key configuration.
#   - gh at the fork's pin, behind core change 17's broker wrapper at /opt/venv/bin/gh.
#   - The Sandbox SDK's helper for DirectoryBackup (sandbox-shim), the same version as the SDK.
#   - ttyd for the setup page's terminal.
#   - The supervisor (cfo_computer, standard library only) as the container's main process
#     under tini, and the contract assets it reads: the exported JSON Schemas and checkpoint
#     policy version 1.
#
# The person's account is `omnigent` (uid 1000, home /home/omnigent, workspace ~/work), with
# passwordless sudo: agents are not restricted on their own computer (security calibration).
# The supervisor and its pause guard run as root. Every base image is pinned by digest. No
# secret is baked in: the computer's identity arrives in the start environment, its launch
# token only with `start_host`.

ARG OMNIGENT_REPO=https://github.com/LouisLotter/omnigent.git
ARG OMNIGENT_COMMIT=184b5cf8b32815b48c7859973a00a139e8aa50f0
ARG PYTHON_IMAGE=python:3.12-slim@sha256:cb33f7f771ecec2ef1225cf39b159591a040391bd73e4c01f00fdfc4c47611d2
ARG NODE_IMAGE=node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
ARG SANDBOX_IMAGE=docker.io/cloudflare/sandbox:1.0.0@sha256:5bc187515bad0d9d486a4f1476f7d8ad39fe97c57965f044e4b0a0dcc93eac06

# ── Omnigent's source at the pinned commit ───────────────────────────────────────────────
FROM scratch AS omnigent-src
ARG OMNIGENT_REPO
ARG OMNIGENT_COMMIT
ADD ${OMNIGENT_REPO}#${OMNIGENT_COMMIT} /

# ── The DirectoryBackup helper (@cloudflare/sandbox 1.0.0) ────────────────────────────────
FROM ${SANDBOX_IMAGE} AS sandbox

# ── Node, for the CLIs (mirrors the fork's `node-runtime` alias) ──────────────────────────
FROM ${NODE_IMAGE} AS node-runtime

# ── Python environment (mirrors the fork's `builder` stage) ───────────────────────────────
FROM ${PYTHON_IMAGE} AS builder
ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.12.10
WORKDIR /build
# The fork's Dockerfile at the pinned commit. If this check fails, the commit changed how
# Omnigent's images are built: review these stages against its `host` target, then update it.
COPY --from=omnigent-src /deploy/docker/Dockerfile /tmp/omnigent.Dockerfile
RUN echo "6d07b51a938e1e3b7b770fe4253360569247ece1738a7dd706fb5f730bf5550b  /tmp/omnigent.Dockerfile" \
      | sha256sum -c -
COPY --from=omnigent-src /pyproject.toml /setup.py /uv.lock /LICENSE /NOTICE ./
COPY --from=omnigent-src /sdks/ ./sdks/
COPY --from=omnigent-src /integrations/ ./integrations/
COPY --from=omnigent-src /omnigent/ ./omnigent/
COPY --from=omnigent-src /examples/ ./examples/
RUN python -m venv /opt/venv
ENV VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:${PATH}"
# Locked dependencies, then Omnigent and its SDKs, not editable (as the fork's host target
# re-installs them), so the runtime image needs nothing under /build.
RUN uv export --frozen --no-dev --no-emit-project --no-emit-workspace --no-editable \
      -o /tmp/requirements.txt \
 && uv pip install --no-cache-dir -r /tmp/requirements.txt \
 && uv pip install --no-cache-dir --no-deps . ./sdks/python-client ./sdks/ui \
 && ! grep -R --include='*.pth' --include='*.egg-link' -nE '/build(/|$)' /opt/venv/lib/python*/site-packages

# ── The computer's runtime ───────────────────────────────────────────────────────────────
FROM ${PYTHON_IMAGE} AS runtime
# IS_SANDBOX: kept from Omnigent's host image; Claude Code consults it (RC-53 runs with it).
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:${PATH}" \
    IS_SANDBOX=1
# As Omnigent's host image (git, tmux, procps, lsof, bubblewrap, curl, CA certificates, unzip),
# plus tini (PID 1), iproute2 (ss, for counting runners), sudo, and util-linux's setpriv.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git tmux procps lsof bubblewrap curl ca-certificates unzip \
      tini iproute2 sudo util-linux \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Claude Code and Codex exactly as published, at the versions the fork's native-harness work
# was tested with (X4b, AIR2-007, core change 20). Nothing of the build's home is kept.
ARG CLAUDE_CODE_VERSION=2.1.302
ARG CODEX_VERSION=0.163.0
RUN npm install -g --no-audit --no-fund --registry=https://registry.npmjs.org/ \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 && test "$(claude --version | cut -d' ' -f1)" = "${CLAUDE_CODE_VERSION}" \
 && test "$(codex --version 2>/dev/null | tail -1)" = "codex-cli ${CODEX_VERSION}" \
 && rm -rf /root/.claude /root/.claude.json /root/.codex /root/.npm /tmp/*

# gh at the fork's pin (deploy/docker/Dockerfile), checked.
ARG GH_VERSION=2.100.0
ARG GH_SHA256_AMD64=e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be
RUN set -eu; \
    curl -fsSL -o /tmp/gh.tar.gz \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz"; \
    echo "${GH_SHA256_AMD64}  /tmp/gh.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tar.gz -C /tmp "gh_${GH_VERSION}_linux_amd64/bin/gh"; \
    install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_amd64"; \
    test "$(gh --version | head -1 | cut -d' ' -f3)" = "${GH_VERSION}"

# ttyd 1.7.7 for the setup terminal (spike S6's pin), checked.
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
RUN curl -fsSL -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" \
 && echo "${TTYD_SHA256}  /usr/local/bin/ttyd" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/ttyd

COPY --from=sandbox /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY --from=builder /opt/venv /opt/venv

# Login shells keep the venv first (Debian's /etc/profile resets PATH), as the fork's host does.
RUN echo 'export PATH="/opt/venv/bin:${PATH}"' > /etc/profile.d/omnigent-venv.sh
# Core change 17: gh gets the owner's GitHub token from the host's broker as GH_TOKEN; nothing
# is written to gh's hosts.yml. The same three lines as the fork's host image.
RUN printf '%s\n' '#!/opt/venv/bin/python -I' \
      'from omnigent.host.credential_broker import gh_main' \
      'gh_main()' > /opt/venv/bin/gh \
 && chmod 0755 /opt/venv/bin/gh \
 && /opt/venv/bin/gh --version >/dev/null

# Codex settings a restored ~/.codex/config.toml cannot override (design, "Network").
COPY images/computer/config/codex-managed_config.toml /etc/codex/managed_config.toml

# The person's account. Its home holds nothing at first: no CLI, Omnigent or login state.
RUN useradd --create-home --home-dir /home/omnigent --uid 1000 --shell /bin/bash omnigent \
 && echo 'omnigent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/omnigent \
 && chmod 0440 /etc/sudoers.d/omnigent \
 && rm -f /home/omnigent/.bash_logout \
 && mkdir -p /var/cfo /var/log/cfo \
 && chmod 0700 /var/cfo /var/log/cfo

# The supervisor and the contract assets it reads.
COPY images/computer/cfo_computer/ /usr/local/lib/python3.12/site-packages/cfo_computer/
COPY contracts/schema/ /opt/cfo/contracts/schema/
COPY contracts/fixtures/CheckpointPolicy/v1.json /opt/cfo/contracts/checkpoint-policy-v1.json
RUN /usr/local/bin/python3 -I -c "import cfo_computer.main, cfo_computer.capture, cfo_computer.lease_guard" \
 && /opt/venv/bin/python -I -c "import omnigent.host.connect, omnigent.onboarding.sandboxes.base"

LABEL org.opencontainers.image.source="https://github.com/LouisLotter/cloudflare-omnigent" \
      cloudflare-omnigent.omnigent-commit="184b5cf8b32815b48c7859973a00a139e8aa50f0" \
      cloudflare-omnigent.claude-code="2.1.302" \
      cloudflare-omnigent.codex="0.163.0"
# 8090: the supervisor's command port; 7681: the setup terminal. Both reached only through
# the container port by the computer's WorkspaceDO.
EXPOSE 8090 7681
ENTRYPOINT ["/usr/bin/tini", "--"]
# The image's own Python (not Omnigent's /opt/venv, first on PATH): standard library only.
CMD ["/usr/local/bin/python3", "-I", "-m", "cfo_computer.main"]

# ── Tests: the image's own suite, run inside the image (a test variant with the fake CLIs) ─
FROM runtime AS test
RUN /usr/local/bin/python3 -m pip install --no-cache-dir pytest==9.1.1 hypothesis==6.169.0
COPY contracts/ /opt/cfo/repo/contracts/
COPY images/computer/ /opt/cfo/repo/images/computer/
COPY python/tests/computer/ /opt/cfo/repo/python/tests/computer/
# The fake CLIs come first on PATH in this variant only; their provider lives outside homes.
ENV PATH="/opt/cfo/repo/images/computer/fakes/bin:${PATH}"
RUN mkdir -p /var/lib/cfo-fake-provider && chown omnigent:omnigent /var/lib/cfo-fake-provider
WORKDIR /opt/cfo/repo
ENTRYPOINT []
CMD ["/usr/local/bin/python3", "-m", "pytest", "-q", "-p", "no:cacheprovider", "python/tests/computer", "images/computer/tests"]

# ── The computer (the default target: the last stage) ────────────────────────────────────
FROM runtime AS computer
