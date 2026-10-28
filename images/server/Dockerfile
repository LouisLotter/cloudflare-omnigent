# syntax=docker/dockerfile:1.17@sha256:38387523653efa0039f8e1c89bb74a30504e76ee9f565e25c9a09841f9427b05
#
# The Omnigent server image for Omnigent on Cloudflare (WP2.3).
#
# Build context: the repository root (the `build_context` of Wrangler's `server` image), for example
#   docker build -f images/server/Dockerfile -t cfo-server:dev .              (the server)
#   docker build -f images/server/Dockerfile --target test -t cfo-server:test .
# The last stage is the server, so a build without --target (Wrangler's) gets the server.
#   docker build -f images/server/Dockerfile --target fork-tests -t cfo-server:fork-tests .
#   docker run --rm cfo-server:fork-tests     (the fork's Stop tests against this image's Omnigent)
#
# What it holds:
#   - Omnigent's server, built from the fork LouisLotter/omnigent at the pinned commit, which
#     the image carries: /opt/cfo/build.json, the image labels, and the entrypoint's GET /status
#     (`build`) and boot log line. The 0.20.0 fork retains single-attempt Stop and launch
#     outcomes, persistent hosts, native transcript reconciliation and credential custody.
#     The stages below mirror the `runtime` target of the fork's deploy/docker/Dockerfile,
#     whose SHA-256 is checked, so a commit bump fails here until the mirror is reviewed. Three
#     differences: Python packages install from the fork's uv.lock (Omnigent's own image
#     resolves them afresh), the `s3` extra is installed with them (the fork's image adds
#     extras only on request), and psycopg is left out (this image uses SQLite only).
#   - Litestream at the exact tested release, checksum-verified.
#   - The image's entrypoint package, cfo_server (restore, recovery mode, settings files, both
#     durability barriers, the launcher registration, the artifact store's settings).
#   - boto3 for Omnigent's S3 artifact store (the fork's `s3` extra, from its uv.lock): the
#     artifacts live in their own R2 bucket, which survives a replacement.
#   - The Cloudflare launcher, cloudflare_omnigent.sandbox, from the repository's python/.
#
# Every base image is pinned by digest. No secret is baked in: the Worker passes settings and
# secrets as container environment variables at start.

ARG OMNIGENT_REPO=https://github.com/LouisLotter/omnigent.git
ARG OMNIGENT_COMMIT=d2e98c9e7bbd885c5c7fc72ba01ec5f0d39bcfd9
ARG PYTHON_IMAGE=python:3.12-slim@sha256:cb33f7f771ecec2ef1225cf39b159591a040391bd73e4c01f00fdfc4c47611d2
ARG NODE_IMAGE=node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
# Trust pins over the fork's lock, hash-checked (see the builder stage).
ARG CERTIFI_PIN="certifi==2026.10.23 --hash=sha256:e9b54de76e530bb6cf0ccd036787103acb58fd42ba930ea8bf948ddbaa2f61d1"
ARG PIP_PIN="pip==26.2.2 --hash=sha256:fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70"
# uv for the builder, hash-checked: the base image's pip (25.0.1) would accept a forged chain.
ARG UV_PIN="uv==0.12.10 --hash=sha256:f7d6248ad9f2d282fea795f248da8fa666ab382df50d8385bd98e01049440a0c --hash=sha256:a34e1be296e6e30fdbfee9b84a45d082ce7df4dd4e588ebcfc44249505c10f02"

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
COPY --from=omnigent-src /patches/ ./patches/
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
ARG UV_PIN
RUN printf '%s\n' "${UV_PIN}" > /tmp/uv-pin.txt \
 && pip install --no-cache-dir --no-deps --require-hashes -r /tmp/uv-pin.txt
WORKDIR /build
# The fork's Dockerfile at the pinned commit. If this check fails, the commit changed how
# Omnigent's image is built: review these stages against it, then update the digest.
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
# Locked dependencies, then Omnigent itself (editable, as the fork's image installs it). The
# `s3` extra is Omnigent's S3 artifact store's boto3, at the lock's exact versions and hashes:
# the image keeps artifacts in R2, never on the container's disk (G2-DUR-001).
RUN uv export --frozen --no-dev --extra s3 --no-emit-project --no-emit-workspace --no-editable \
      -o /tmp/requirements.txt \
 && uv pip install --no-cache-dir -r /tmp/requirements.txt \
 && uv pip install --no-cache-dir --no-deps -e .
# Trust pins over the lock, hash-checked. Since 3d7f7d08c the lock's certifi is 2026.10.19,
# which no longer trusts emSign ECC Root CA - G3; the image keeps WP3.20's tested 2026.10.23
# (httpx, requests and botocore use it). pip 25.0.1 vendors a certifi with both roots of the
# eMudhra key compromise (October 2026). Drop the certifi override once the lock reaches the
# pin; the runtime stage's trust check fails the build either way.
ARG CERTIFI_PIN
ARG PIP_PIN
RUN printf '%s\n' "${CERTIFI_PIN}" "${PIP_PIN}" > /tmp/trust-pins.txt \
 && uv pip install --no-cache-dir --no-deps --require-hashes -r /tmp/trust-pins.txt
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
# Keep ca-certificates: Litestream 0.5.17 (built with Go 1.25, no key denylist) verifies R2
# against this bundle, and falls back to the roots compiled into it only if none is found.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates sqlite3 \
 && rm -rf /var/lib/apt/lists/*
# The image's own pip at the fixed release, and ensurepip's wheel (images/trust/pin_pip.sh).
ARG PIP_PIN
RUN --mount=type=bind,source=images/trust/pin_pip.sh,target=/tmp/pin_pip.sh \
    sh /tmp/pin_pip.sh "${PIP_PIN}"
COPY --from=builder /opt/venv /opt/venv
# Certificate trust (images/trust/trust_check.py): fail the build unless Debian's
# ca-certificates has dropped both roots of the eMudhra key compromise and no bundle still
# trusts them, and unless botocore verifies with certifi's bundle: its own fallback still holds
# AAA Certificate Services. A stale cached layer fails here too.
RUN --mount=type=bind,source=images/trust/trust_check.py,target=/tmp/trust_check.py \
    /usr/local/bin/python3 -I /tmp/trust_check.py --debian-ca-certificates \
      --bundle /etc/ssl/certs/ca-certificates.crt \
      --bundle "$(/opt/venv/bin/python -I -c 'import certifi; print(certifi.where())')" \
      --scan /opt/venv --scan /usr/local/lib/python3.12 \
      --except /opt/venv/lib/python3.12/site-packages/botocore/cacert.pem \
 && /opt/venv/bin/python -I -c 'import botocore.httpsession as h, certifi; assert h.where() == certifi.where(), h.where()'
COPY --from=builder /build /build
COPY --from=omnigent-src /deploy/docker/entrypoint.py /app/entrypoint.py
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY images/server/cfo_server/ /opt/cfo/cfo_server/
# The Cloudflare launcher (WP3.6), which cfo_server registers through sandbox_config.
COPY python/cloudflare_omnigent/ /opt/cfo/cloudflare_omnigent/
ENV PYTHONPATH=/opt/cfo \
    CFO_OMNIGENT_DOCKER_ENTRYPOINT=/app/entrypoint.py
# Bytecode for everything the server imports, compiled here once: with PYTHONDONTWRITEBYTECODE
# and no .pyc files, Python compiled Omnigent's sources at every start (WP2.5: most of the
# imports' 80 s in a 1 GB start on basic). Hash-checked .pyc files stay valid whatever the files'
# times in the layers, and a changed source is never run from a stale one.
RUN python -m compileall -q -f -j 0 --invalidation-mode checked-hash \
      /opt/venv /build/omnigent /opt/cfo /app \
 && mkdir -p /data /run/cfo \
 && python -c "import cfo_server.entrypoint, cfo_server.app, boto3"
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
RUN find /opt/venv /build/omnigent /opt/cfo/cfo_server /opt/cfo/cloudflare_omnigent /app \
      -name '*.py' \
      -not -path '*/__pycache__/*' | sort > /opt/runtime-python-sources.txt
RUN /opt/venv/bin/python -m pip install --no-cache-dir \
      pytest==9.1.1 hypothesis==6.169.0 jsonschema==4.26.0
COPY images/server/tests/ /opt/cfo/tests/
COPY images/trust/ /opt/cfo/trust/
COPY images/server/Dockerfile /opt/cfo/Dockerfile
COPY contracts/schema/ /opt/cfo/contracts/schema/
ENV CFO_TEST_LITESTREAM_BIN=/usr/local/bin/litestream \
    CFO_REPO_ROOT=/opt/cfo
WORKDIR /opt/cfo
CMD ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests", "trust/tests", "--ignore=tests/integration"]

# ── The fork's Stop tests, against the Omnigent installed in this image (AIR2-007) ──────────
# The fork's `test` dependency group, pinned by its uv.lock like the runtime's packages (so pip
# finds the runtime's own versions already installed), and its tests at the same commit. Never
# deployed: run it to check the built artifact, not the fork's source checkout.
FROM builder AS fork-test-requirements
# The test group, plus asgiref at its locked version (the Stop-over-tunnel test drives the app
# with its ApplicationCommunicator; the fork's own environment has it through OpenTelemetry).
# certifi stays at the runtime's trust pin: the lock's (2026.10.19) would replace it here.
RUN uv export --frozen --only-group test --no-emit-project --no-emit-workspace --no-hashes \
      -o /tmp/fork-test-requirements.txt \
 && sed -i '/^certifi==/d' /tmp/fork-test-requirements.txt \
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
