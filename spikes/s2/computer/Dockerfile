# syntax=docker/dockerfile:1.7
# The S2 "computer": the same pinned Omnigent v0.17.0 image as the server, which ships the
# `omnigent` CLI (with `omnigent host`), websockets and httpx. Only the spike's scripts and
# the start command differ. Omnigent's own mock LLM server, from the same release tag, lets
# runners answer without a provider account; it is fetched by commit and checksum, not copied
# into this repository.
FROM ghcr.io/omnigent-ai/omnigent-server:v0.17.0@sha256:101474ecb299d45aacf49cb01051cc2cc5392ee6a6d30879d72c55bf346af3c3
ADD --checksum=sha256:bcc0ddaceadc9af72694a2d0a8c76930a5f9e9c9472dd8847ebc4d148d3a2fda \
    https://raw.githubusercontent.com/omnigent-ai/omnigent/12b5f67d2529b43eab7366a7288fb89f7587e48b/tests/server/integration/mock_llm_server.py \
    /s2/mock_llm_server.py
COPY *.py /s2/
RUN mkdir -p /s2/ws
WORKDIR /s2
ENV PYTHONPATH=/s2 HOME=/root
CMD ["python", "/s2/run.py"]
