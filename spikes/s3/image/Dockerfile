# Spike S3 computer image: an Omnigent host, the two coding CLIs, and the
# prototype supervisor. Throwaway spike code; see the S3 evidence in the
# project notes.
#
# Base: Omnigent's server image built from the fork's cfo/integration at
# af3e49de2 with the fork's own Dockerfile (target runtime), by
# spikes/s3/bench/prepare_staging.py, as S4 built its base. It carries the full
# omnigent package (server, host daemon, runner zygote, runners) in /opt/venv.
# The published images predate core changes 12 to 19.
ARG OMNIGENT_IMAGE=cfo-s3/omnigent-server:af3e49de2

# The DirectoryBackup helper, matching @cloudflare/sandbox 1.0.0 in
# spikes/s3/staging/package.json (the same pin S1 qualified on staging).
FROM docker.io/cloudflare/sandbox:1.0.0@sha256:5bc187515bad0d9d486a4f1476f7d8ad39fe97c57965f044e4b0a0dcc93eac06 AS sandbox

FROM ${OMNIGENT_IMAGE}

ARG CLAUDE_CODE_VERSION=2.1.296
ARG CODEX_VERSION=0.162.1
ARG BOTO3_VERSION=1.43.111
ARG PYTEST_VERSION=9.1.1

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DEBIAN_FRONTEND=noninteractive

# tini: PID 1 that reaps and forwards signals. rsync, zstd: snapshot copy and
# upload archive. git, tmux, procps, lsof: what the host image normally has.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini rsync zstd git tmux procps lsof curl ca-certificates iproute2 \
      nodejs npm \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-audit --no-fund \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @openai/codex@${CODEX_VERSION} \
 && npm cache clean --force \
 && claude --version && codex --version

# Separate venv for the supervisor so Omnigent's own environment is untouched.
RUN python -m venv /opt/s3venv \
 && /opt/s3venv/bin/pip install --no-cache-dir boto3==${BOTO3_VERSION} pytest==${PYTEST_VERSION}

# The unprivileged user that runs the host, the runners and the CLIs.
RUN useradd -m -u 1000 -s /bin/bash agent \
 && mkdir -p /snap /restore-staging \
 && chown agent:agent /snap /restore-staging

COPY --from=sandbox /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
# Omnigent's own e2e mock LLM, from the same fork commit (copied into the
# build context by prepare_staging.py). On staging it runs beside the server
# inside this container, so nothing needs the internet.
COPY mockllm /opt/s3/mockllm
COPY supervisor /opt/s3/supervisor
# S6's audited credential policy, copied into the build context by
# spikes/s3/bench/sync_policy.py: capture and restore share one list.
COPY s6credsync /opt/s3/s6credsync
COPY tests /opt/s3/tests

ENV PYTHONPATH=/opt/s3 \
    S3_AGENT_USER=agent \
    S3_SNAPSHOT_ROOT=/snap

ENTRYPOINT ["/usr/bin/tini", "-s", "-g", "--"]
CMD ["/opt/s3venv/bin/python", "-m", "supervisor.main"]
