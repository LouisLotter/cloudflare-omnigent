# syntax=docker/dockerfile:1.17@sha256:38387523653efa0039f8e1c89bb74a30504e76ee9f565e25c9a09841f9427b05
#
# The server image plus the restore drill (WP2.5): the durability suite's server containers and
# the staging measurement harness.
#
# Build context: the repository root. The server image is built first, from its own Dockerfile,
# and named by SERVER_IMAGE (a local tag; the build reads it from the local image store):
#   docker build -f images/server/Dockerfile -t cfo-wp25-server:dev .
#   docker build -f scripts/restore-drill/staging/Dockerfile -t cfo-wp25-drill:dev .
#
# Its default command is the measurement harness (cfo_drill.harness), which runs the server's
# own entrypoint as a child. The durability suite runs the plain entrypoint instead
# (`python -m cfo_server.entrypoint`), so its servers are the server image with the drill
# beside it, nothing else.
ARG SERVER_IMAGE=cfo-wp25-server:dev
FROM ${SERVER_IMAGE}
# py-spy, hash-pinned, for the harness's stack samples of a slow server start (it reads the
# app's stacks from outside; nothing in Omnigent or the server image changes).
RUN printf 'py-spy==0.4.1 --hash=sha256:6a80ec05eb8a6883863a367c6a4d4f2d57de68466f7956b6367d4edd5c61bb29\n' > /tmp/py-spy.txt \
 && python -m pip install --no-cache-dir --require-hashes --only-binary=:all: -r /tmp/py-spy.txt \
 && rm /tmp/py-spy.txt && py-spy --version
COPY scripts/restore-drill/cfo_drill/ /opt/drill/cfo_drill/
ENV PYTHONPATH=/opt/cfo:/opt/drill
RUN python -c "import cfo_drill.drill, cfo_drill.canaries, cfo_drill.harness"
# 8002: the harness's status and results (only the harness Durable Object reaches it).
EXPOSE 8000 8001 8002
CMD ["python", "-m", "cfo_drill", "harness"]
