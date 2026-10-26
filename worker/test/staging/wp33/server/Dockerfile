# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# WP3.3 staging: the stand-in server container (stub_server.py). Every input is pinned by digest
# or checksum, and there is no RUN step, so a redeploy builds the same image and starts no
# container rollout (DC-36). The same base and wheel as spikes/x1.
FROM python:3.12.15-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
ADD --checksum=sha256:f7a866fbc1e97b5c617ee4116daaa09b722101d4a3c170c787450ba409f9736f \
    https://files.pythonhosted.org/packages/fa/a8/5b41e0da817d64113292ab1f8247140aac61cbf6cfd085d6a0fa77f4984f/websockets-15.0.1-py3-none-any.whl \
    /wp33/lib/websockets-15.0.1-py3-none-any.whl
COPY stub_server.py /wp33/
ENV PYTHONPATH=/wp33/lib/websockets-15.0.1-py3-none-any.whl \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
EXPOSE 8000 8001 8002
CMD ["python", "/wp33/stub_server.py"]
