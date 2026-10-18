# S4 spike server image: Omnigent (fork commit 90a9bed9a, built locally by
# scripts/build-base.sh) + Litestream 0.5.17 + the barrier packaging.
ARG OMNIGENT_IMAGE=cfo-s4/omnigent-server:90a9bed9a
FROM ${OMNIGENT_IMAGE}

ARG LITESTREAM_VERSION=0.5.17
ARG LITESTREAM_SHA256=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d

RUN apt-get update \
 && apt-get install -y --no-install-recommends sqlite3 \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/litestream.tgz \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz" \
 && echo "${LITESTREAM_SHA256}  /tmp/litestream.tgz" | sha256sum -c - \
 && tar -xzf /tmp/litestream.tgz -C /usr/local/bin litestream \
 && rm /tmp/litestream.tgz \
 && litestream version

COPY litestream.yml /etc/litestream.yml
COPY s4_barrier.py s4_entrypoint.py /opt/s4/
COPY tools/ /opt/s4/tools/

ENV PYTHONPATH=/opt/s4 \
    S4_DB_PATH=/data/db/omnigent.db \
    DATABASE_URL=sqlite:////data/db/omnigent.db \
    S4_LITESTREAM_LOG_LEVEL=info \
    S4_SHUTDOWN_SYNC_TIMEOUT=30s \
    S4_SYNC_INTERVAL=1s \
    S4_REPLICA_PATH=omnigent

RUN mkdir -p /data/db /run/litestream

# Litestream is PID 1: it restores a missing database, starts replication,
# runs the server as its child, forwards SIGTERM to it, and does a final
# sync after the child exits.
CMD ["litestream", "replicate", "-config", "/etc/litestream.yml", "-restore-if-db-not-exists", \
     "-exec", "python /opt/s4/s4_entrypoint.py"]
