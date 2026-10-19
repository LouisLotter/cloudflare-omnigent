# Spike S7 emulated computer: the same pinned image, used only for its Python, running the
# variant replay against http://omnigent.internal (intercepted to the private host route).
FROM ghcr.io/omnigent-ai/omnigent-server@sha256:dba491573ba16b42da7447a7ab6e978bfeb6f49876093cc925f8340abd010df6
COPY replay.py variants.json /s7/
ENTRYPOINT ["python", "/s7/replay.py"]
# Changed for each staging redeploy after a teardown. Docker remembers that the old image was
# pushed, the registry still serves its manifest after deletion, so Wrangler skips the push and
# creating the application fails with IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE.
LABEL cloudflare-omnigent.staging-build="2026-10-19"
