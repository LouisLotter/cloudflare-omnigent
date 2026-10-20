# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# X1 server container: the echo server (8081), its log (8082) and cloudflared. Every input is
# pinned by digest or checksum, and there is no RUN step, so a rebuild from the same sources and
# build epoch gives the same image and a redeploy starts no container rollout (DC-36).
FROM python:3.12.15-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
# cloudflared 2026.10.0 (released 2026-10-05), the official linux-amd64 build. The checksum is the
# one GitHub records for the release asset and the release notes list.
ADD --chmod=0755 --checksum=sha256:d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db \
    https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-linux-amd64 \
    /usr/local/bin/cloudflared
# websockets 15.0.1, the pure-Python wheel, imported straight from the wheel (zipimport).
ADD --checksum=sha256:f7a866fbc1e97b5c617ee4116daaa09b722101d4a3c170c787450ba409f9736f \
    https://files.pythonhosted.org/packages/fa/a8/5b41e0da817d64113292ab1f8247140aac61cbf6cfd085d6a0fa77f4984f/websockets-15.0.1-py3-none-any.whl \
    /x1/lib/websockets-15.0.1-py3-none-any.whl
COPY echo_server.py /x1/
ENV PYTHONPATH=/x1/lib/websockets-15.0.1-py3-none-any.whl \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
EXPOSE 8081 8082
CMD ["python", "/x1/echo_server.py"]
