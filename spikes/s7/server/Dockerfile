# Spike S7 staging server: the published Omnigent server image, pinned by digest, unchanged.
# The managed values reach it as environment variables from the OmnigentServer Durable Object.
# managed_entrypoint.py is included for the authoritative-mode comparison but is not the default.
FROM ghcr.io/omnigent-ai/omnigent-server@sha256:dba491573ba16b42da7447a7ab6e978bfeb6f49876093cc925f8340abd010df6
COPY managed_entrypoint.py /app/s7_managed_entrypoint.py
EXPOSE 8000
