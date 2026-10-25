# syntax=docker/dockerfile:1.17@sha256:38387523653efa0039f8e1c89bb74a30504e76ee9f565e25c9a09841f9427b05
#
# The Omnigent server image for Omnigent on Cloudflare (WP2.3).
#
# Build context: the repository root (Wrangler's `image_build_context`), for example
#   docker build -f images/server/Dockerfile -t cfo-server:dev .              (the server)
#   docker build -f images/server/Dockerfile --target test -t cfo-server:test .
# The last stage is the server, so a build without --target (Wrangler's) gets the server.
#   docker build -f images/server/Dockerfile --target fork-tests -t cfo-server:fork-tests .
#   docker run --rm cfo-server:fork-tests     (the fork's Stop tests against this image's Omnigent)
#
# What it holds:
#   - Omnigent's server, built from the fork LouisLotter/omnigent at the pinned `cfo/integration`
#     commit, which the image carries: /opt/cfo/build.json, the image labels, and the
#     entrypoint's GET /status (`build`) and boot log line. 35ac1ebd2 (22 Oct 2026) has the
#     Stop fix (AIR2-007: a Stop is sent once, its delivery reported) and core changes 20 and 21. The stages below mirror the `runtime` target of the fork's deploy/docker/Dockerfile,
#     whose SHA-256 is checked, so a commit bump fails here until the mirror is reviewed. Two
#     differences: Python packages install from the fork's uv.lock (Omnigent's own image
#     resolves them afresh), and psycopg is left out (this image uses SQLite only).
#   - Litestream at the exact tested release, checksum-verified.
#   - The image's entrypoint package, cfo_server (restore, recovery mode, settings files, both
#     durability barriers, the launcher registration).
#
# Every base image is pinned by digest. No secret is baked in: the Worker passes settings and
# secrets as container environment variables at start.

ARG OMNIGENT_REPO=https://github.com/LouisLotter/omnigent.git
ARG OMNIGENT_COMMIT=35ac1ebd2405264de7c0456084f45c4af1e657ca
ARG PYTHON_IMAGE=python:3.12-slim@sha256:cb33f7f771ecec2ef1225cf39b159591a040391bd73e4c01f00fdfc4c47611d2
ARG NODE_IMAGE=node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# ── Omnigent's source at the pinned commit ───────────────────────────────────────────────
FROM scratch AS omnigent-src
ARG OMNIGENT_REPO
ARG OMNIGENT_COMMIT
# A full commit ID only (checked in the runtime stage): BuildKit fetches exactly that commit, so
# the revision the image records is the source it was built from.
ADD ${OMNIGENT_REPO}#${OMNIGENT_COMMIT} /

# ── Web UI (mirrors the fork's `web-builder` stage) ──────────────────────────────────────
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web-builder
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org \
    PNPM_CONFIG_REGISTRY=https://registry.npmjs.org
WORKDIR /web
COPY --from=omnigent-src /pnpm-workspace.yaml /pnpm-lock.yaml ./
COPY --from=omnigent-src /web/package.json ./web/
COPY --from=omnigent-src /web/electron/package.json ./web/electron/
RUN npm install -g pnpm@11.15.1
RUN pnpm install --frozen-lockfile --filter web
COPY --from=omnigent-src /web/ ./web/
ARG VITE_OMNIGENT_HOST_ROUTING=false
RUN pnpm --filter web run build

# ── Python environment (mirrors the fork's `builder` and `server-builder` stages) ────────
FROM ${PYTHON_IMAGE} AS builder
ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.12.10
WORKDIR /build
# The fork's Dockerfile at the pinned commit. If this check fails, the commit changed how
# Omnigent's image is built: review these stages against it, then update the digest.
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
# Locked dependencies, then Omnigent itself (editable, as the fork's image installs it).
RUN uv export --frozen --no-dev --no-emit-project --no-emit-workspace --no-editable \
      -o /tmp/requirements.txt \
 && uv pip install --no-cache-dir -r /tmp/requirements.txt \
 && uv pip install --no-cache-dir --no-deps -e .
COPY --from=web-builder /web/omnigent/server/static/web-ui ./omnigent/server/static/web-ui
RUN test -f ./omnigent/server/static/web-ui/index.html

# ── Litestream ───────────────────────────────────────────────────────────────────────────
FROM ${PYTHON_IMAGE} AS litestream
# 0.5.17 (31 Aug 2026), the release spike S4 tested. Issues #1540 and #1552 are still open
# (rechecked 22 Oct 2026; fixes merged on main after 0.5.17 are unreleased). The image never
# sends a `wait` sync and never checkpoints, which keeps it off both paths.
ARG LITESTREAM_VERSION=0.5.17
ARG LITESTREAM_SHA256=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d
ADD --checksum=sha256:${LITESTREAM_SHA256} \
    https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz \
    /tmp/litestream.tar.gz
RUN tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream \
 && test "$(/usr/local/bin/litestream version)" = "${LITESTREAM_VERSION}"

# ── Runtime ──────────────────────────────────────────────────────────────────────────────
FROM ${PYTHON_IMAGE} AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:${PATH}"
# curl and CA certificates as in Omnigent's image; the sqlite3 shell for the restore drill.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates sqlite3 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /build /build
COPY --from=omnigent-src /deploy/docker/entrypoint.py /app/entrypoint.py
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY images/server/cfo_server/ /opt/cfo/cfo_server/
ENV PYTHONPATH=/opt/cfo \
    CFO_OMNIGENT_DOCKER_ENTRYPOINT=/app/entrypoint.py
# Bytecode for everything the server imports, compiled here once: with PYTHONDONTWRITEBYTECODE
# and no .pyc files, Python compiled Omnigent's sources at every start (WP2.5: most of the
# imports' 80 s in a 1 GB start on basic). Hash-checked .pyc files stay valid whatever the files'
# times in the layers, and a changed source is never run from a stale one.
RUN python -m compileall -q -f -j 0 --invalidation-mode checked-hash \
      /opt/venv /build/omnigent /opt/cfo /app \
 && mkdir -p /data /run/cfo \
 && python -c "import cfo_server.entrypoint, cfo_server.app"
# What the image was built from (AIR2-007 at artifact scope): the fork commit, which must be a
# full commit ID, and the Litestream binary's own version. Read by the entrypoint (/status).
ARG OMNIGENT_REPO
ARG OMNIGENT_COMMIT
RUN echo "${OMNIGENT_COMMIT}" | grep -Eqx '[0-9a-f]{40}' \
 && python -c 'import json, subprocess, sys; json.dump({"omnigentRepo": sys.argv[1], "omnigentCommit": sys.argv[2], "litestream": subprocess.check_output(["litestream", "version"], text=True).strip()}, open("/opt/cfo/build.json", "w"), indent=2)' \
      "${OMNIGENT_REPO}" "${OMNIGENT_COMMIT}" \
 && python -m cfo_server.buildinfo
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/LouisLotter/cloudflare-omnigent" \
      org.opencontainers.image.revision="${OMNIGENT_COMMIT}" \
      cloudflare-omnigent.omnigent-repo="${OMNIGENT_REPO}" \
      cloudflare-omnigent.omnigent-commit="${OMNIGENT_COMMIT}" \
      cloudflare-omnigent.litestream="0.5.17"
# 8000: Omnigent (or the recovery responder). 8001: the control port (GET /position, the
# ReplicationPosition contract, and GET /status), reached only by the OmnigentServer object.
EXPOSE 8000 8001
CMD ["python", "-m", "cfo_server.entrypoint"]

# ── Tests: the image's own suite, run inside the image ───────────────────────────────────
FROM runtime AS test
# The runtime's Python sources, listed before the test tools join them (test_bytecode.py).
RUN find /opt/venv /build/omnigent /opt/cfo/cfo_server /app -name '*.py' \
      -not -path '*/__pycache__/*' | sort > /opt/runtime-python-sources.txt
RUN /opt/venv/bin/python -m pip install --no-cache-dir \
      pytest==9.1.1 hypothesis==6.169.0 jsonschema==4.26.0
COPY images/server/tests/ /opt/cfo/tests/
COPY images/server/Dockerfile /opt/cfo/Dockerfile
COPY contracts/schema/ /opt/cfo/contracts/schema/
ENV CFO_TEST_LITESTREAM_BIN=/usr/local/bin/litestream \
    CFO_REPO_ROOT=/opt/cfo
WORKDIR /opt/cfo
CMD ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests", "--ignore=tests/integration"]

# ── The fork's Stop tests, against the Omnigent installed in this image (AIR2-007) ──────────
# The fork's `test` dependency group, pinned by its uv.lock like the runtime's packages (so pip
# finds the runtime's own versions already installed), and its tests at the same commit. Never
# deployed: run it to check the built artifact, not the fork's source checkout.
FROM builder AS fork-test-requirements
# The test group, plus asgiref at its locked version (the Stop-over-tunnel test drives the app
# with its ApplicationCommunicator; the fork's own environment has it through OpenTelemetry).
RUN uv export --frozen --only-group test --no-emit-project --no-emit-workspace --no-hashes \
      -o /tmp/fork-test-requirements.txt \
 && python -c 'import tomllib; lock = tomllib.load(open("uv.lock", "rb")); print(*(f"{p["name"]}=={p["version"]}" for p in lock["package"] if p["name"] == "asgiref"))' \
      | grep -E '^asgiref==' >> /tmp/fork-test-requirements.txt

FROM runtime AS fork-tests
COPY --from=fork-test-requirements /tmp/fork-test-requirements.txt /tmp/
RUN /opt/venv/bin/python -m pip install --no-cache-dir --no-deps \
      -r /tmp/fork-test-requirements.txt
COPY --from=omnigent-src /tests/ /build/tests/
WORKDIR /build
ENV HOME=/tmp/fork-tests-home \
    OMNIGENT_DISABLE_CATALOG_LOOKUP=1
CMD ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider", \
     "tests/server/integration/test_stop_over_tunnel.py", \
     "tests/server/integration/test_sessions_endpoints.py", "-k", "interrupt or stop"]

# ── The server (the default target: the last stage) ──────────────────────────────────────
FROM runtime AS server
