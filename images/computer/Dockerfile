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
#   - Omnigent's host, built from the fork LouisLotter/omnigent at the pinned fork
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
#   - Certificate trust kept current (images/trust): the build fails if Debian's bundle or
#     certifi's still trusts a root through which forged certificates chain (the eMudhra key
#     compromise of October 2026), and every TLS client is at a release that refuses them.
#
# The person's account is `omnigent` (uid 1000, home /home/omnigent, workspace ~/work), with
# passwordless sudo: agents are not restricted on their own computer (security calibration).
# The supervisor and its pause guard run as root. Every base image is pinned by digest. No
# secret is baked in: the computer's identity arrives in the start environment, its launch
# token only with `start_host`.

ARG OMNIGENT_REPO=https://github.com/LouisLotter/omnigent.git
ARG OMNIGENT_COMMIT=72ba29a4f9aed97f08bcd44d3b7d8b2b260b72d6
ARG PYTHON_IMAGE=python:3.12-slim@sha256:cb33f7f771ecec2ef1225cf39b159591a040391bd73e4c01f00fdfc4c47611d2
ARG NODE_IMAGE=node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
ARG SANDBOX_IMAGE=docker.io/cloudflare/sandbox:1.0.0@sha256:5bc187515bad0d9d486a4f1476f7d8ad39fe97c57965f044e4b0a0dcc93eac06
# Trust pins over the fork's lock, hash-checked (see the builder stage).
ARG CERTIFI_PIN="certifi==2026.10.23 --hash=sha256:e9b54de76e530bb6cf0ccd036787103acb58fd42ba930ea8bf948ddbaa2f61d1"
ARG PIP_PIN="pip==26.2.2 --hash=sha256:fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70"
# uv for the builder, hash-checked: the base image's pip (25.0.1) would accept a forged chain.
ARG UV_PIN="uv==0.12.10 --hash=sha256:f7d6248ad9f2d282fea795f248da8fa666ab382df50d8385bd98e01049440a0c --hash=sha256:a34e1be296e6e30fdbfee9b84a45d082ce7df4dd4e588ebcfc44249505c10f02"

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
ARG UV_PIN
RUN printf '%s\n' "${UV_PIN}" > /tmp/uv-pin.txt \
 && pip install --no-cache-dir --no-deps --require-hashes -r /tmp/uv-pin.txt
WORKDIR /build
# The fork's Dockerfile at the pinned commit. If this check fails, the commit changed how
# Omnigent's images are built: review these stages against its `host` target, then update it.
COPY --from=omnigent-src /deploy/docker/Dockerfile /tmp/omnigent.Dockerfile
RUN echo "dca1880e581694c345a7138da34f10274c28c45c04cbee39ca61c24238cc21cd  /tmp/omnigent.Dockerfile" \
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
# Trust pins over the lock, hash-checked. Since 3d7f7d08c the lock's certifi is 2026.10.19,
# which no longer trusts emSign ECC Root CA - G3; the image keeps WP3.20's tested 2026.10.23.
# The venv's pip (25.0.1) trusts both roots of the eMudhra key compromise (October 2026)
# through the certifi it vendors; pip 26.2.2 is the first fixed release. Drop the certifi
# override once the lock reaches the pin; the runtime stage's trust check fails the build
# either way.
ARG CERTIFI_PIN
ARG PIP_PIN
RUN printf '%s\n' "${CERTIFI_PIN}" "${PIP_PIN}" > /tmp/trust-pins.txt \
 && uv pip install --no-cache-dir --no-deps --require-hashes -r /tmp/trust-pins.txt

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
# The image's own pip (agents run it too) at the fixed release, as in the builder stage, and
# the wheel ensurepip seeds into every new virtual environment (images/trust/pin_pip.sh).
ARG PIP_PIN
RUN --mount=type=bind,source=images/trust/pin_pip.sh,target=/tmp/pin_pip.sh \
    sh /tmp/pin_pip.sh "${PIP_PIN}"
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Claude Code and Codex exactly as published. Raised from the versions the fork's native-harness
# work was tested with (2.1.302 and 0.163.0) for the eMudhra key compromise: Claude Code
# 2.1.302 accepts a certificate forged through emSign ECC Root CA - G3, and Codex 0.164.0 is the
# first with rustls-webpki 0.103.16 (it refuses the compromised keys) and webpki-roots 1.0.10.
# Codex's default client verifies with its vendored OpenSSL against the system bundle, so the
# rustls denylist applies only when it is given a CA bundle of its own.
# Sign-in commands, status output, login-file paths and write patterns are as before; Codex
# 0.164.0 adds two fields to ~/.codex/auth.json, which the platform copies as opaque bytes.
# Nothing of the build's home is kept.
# No unverified code runs: npm extracts both packages without running scripts, the extracted
# trees must match the digests below (every file's path and SHA-256, every symbolic link's
# target), and only then does Claude Code's own postinstall (install.cjs, which links its native
# binary over bin/claude.exe) run, after which the tree is checked again. Codex has no scripts.
# The digests were recorded identically from independent installs; after a version bump, take
# the new values from the failing build's message.
ARG CLAUDE_CODE_VERSION=2.1.311
ARG CODEX_VERSION=0.164.0
ARG CLAUDE_CODE_TREE_SHA256=b3530205566c212f20930da7fbffde8a2d4637534ca8464c7493193b58bef659
ARG CLAUDE_CODE_INSTALLED_SHA256=e11f79605c8334fc76bcb23a008af5f9f5a411944d3cc995ba694050dac4160e
ARG CODEX_TREE_SHA256=6aa96e445074fc22662979ee4db20c58c71f63b7c56e12f02c2d11cb11b09170
RUN npm install -g --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 && tree() ( cd /usr/local/lib/node_modules \
      && { find "$1" -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum; \
           find "$1" -type l -printf '%p -> %l\n' | LC_ALL=C sort; } | sha256sum | cut -d' ' -f1 ) \
 && check() { got=$(tree "$1") && [ "${got}" = "$2" ] \
      || { echo "$1: installed tree ${got}, expected $2" >&2; return 1; }; } \
 && check @anthropic-ai/claude-code "${CLAUDE_CODE_TREE_SHA256}" \
 && check @openai/codex "${CODEX_TREE_SHA256}" \
 && (cd /usr/local/lib/node_modules/@anthropic-ai/claude-code && node install.cjs) \
 && check @anthropic-ai/claude-code "${CLAUDE_CODE_INSTALLED_SHA256}" \
 && test "$(readlink /usr/local/bin/claude)" = "../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe" \
 && test "$(readlink /usr/local/bin/codex)" = "../lib/node_modules/@openai/codex/bin/codex.js" \
 && test "$(claude --version | cut -d' ' -f1)" = "${CLAUDE_CODE_VERSION}" \
 && test "$(codex --version 2>/dev/null | tail -1)" = "codex-cli ${CODEX_VERSION}" \
 && rm -rf /root/.claude /root/.claude.json /root/.codex /root/.npm /tmp/*

# gh, checked: the fork's own pin since 3d7f7d08c, a release built with Go 1.27.3, whose
# crypto/x509 refuses chains through the compromised eMudhra keys.
ARG GH_VERSION=2.103.3
ARG GH_SHA256_AMD64=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d
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

# Certificate trust (images/trust/trust_check.py): fail the build unless Debian's
# ca-certificates has dropped both roots of the eMudhra key compromise and no bundle still
# trusts them: the system's (curl, git, gh, Claude Code, Codex, Python's ssl), certifi's
# (httpx, requests) and pip's vendored copies. A stale cached layer fails here too.
RUN --mount=type=bind,source=images/trust/trust_check.py,target=/tmp/trust_check.py \
    /usr/local/bin/python3 -I /tmp/trust_check.py --debian-ca-certificates \
      --bundle /etc/ssl/certs/ca-certificates.crt \
      --bundle "$(/opt/venv/bin/python -I -c 'import certifi; print(certifi.where())')" \
      --scan /opt/venv --scan /usr/local/lib/python3.12

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
# Claude Code settings no user or Omnigent settings file can override (managed settings, root's,
# 0644). `tui` named: while no settings name a renderer, Claude Code 2.1.311 shows its fullscreen
# upsell ("Try the new fullscreen renderer?") on the first three starts, an interactive dialog that
# blocked the terminal Omnigent drives (the 27 Oct 2026 staging sitting). "default" keeps the
# renderer Omnigent's harness was built for. The directory first: COPY --chmod would give the
# directory it creates the file's mode, which no other user can enter.
RUN install -d -m 0755 /etc/claude-code
COPY --chmod=0644 images/computer/config/claude-managed-settings.json \
     /etc/claude-code/managed-settings.json

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
      cloudflare-omnigent.omnigent-commit="72ba29a4f9aed97f08bcd44d3b7d8b2b260b72d6" \
      cloudflare-omnigent.claude-code="2.1.311" \
      cloudflare-omnigent.codex="0.164.0" \
      cloudflare-omnigent.gh="2.103.3"
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
COPY images/trust/ /opt/cfo/repo/images/trust/
COPY python/tests/computer/ /opt/cfo/repo/python/tests/computer/
# The commands WorkspaceDO sends, recorded from the controller, which the supervisor's parser
# must accept (python/tests/computer/test_workspace_commands.py).
COPY worker/test/fixtures/workspace-commands.json /opt/cfo/repo/worker/test/fixtures/
# The fake CLIs come first on PATH in this variant only; their provider lives outside homes.
ENV PATH="/opt/cfo/repo/images/computer/fakes/bin:${PATH}"
RUN mkdir -p /var/lib/cfo-fake-provider && chown omnigent:omnigent /var/lib/cfo-fake-provider
WORKDIR /opt/cfo/repo
ENTRYPOINT []
CMD ["/usr/local/bin/python3", "-m", "pytest", "-q", "-p", "no:cacheprovider", "python/tests/computer", "images/computer/tests", "images/trust/tests"]

# ── The computer (the default target: the last stage) ────────────────────────────────────
FROM runtime AS computer
