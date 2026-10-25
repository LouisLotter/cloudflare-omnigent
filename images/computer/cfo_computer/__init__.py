"""Primitives for the planned cloud computer supervisor (WP3.4).

This package currently provides contract validation, checkpoint policy and tree utilities,
process observations, and the bounded pause guard. The supervisor entrypoint, capture/restore
pipeline, host lifecycle and credential publication are not yet assembled into a runnable image.

Standard library only: it runs on the image's system Python, apart from Omnigent's environment.
"""

SUPERVISOR_VERSION = "0.1.0"
SUPERVISOR_PROTOCOL_VERSION = 1
SUPPORTED_PROTOCOL_VERSIONS = (1,)
