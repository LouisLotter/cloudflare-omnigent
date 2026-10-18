"""Spike S7 prototype: start the published server image with authoritative sharing settings.

Omnigent's standard start command builds the app with ``sharing_mode=None`` and friends, which
makes every sharing setting file-backed and editable through ``PUT /v1/sharing``. Passing static
values to ``create_app`` instead (the embedding call that deployments such as Databricks use)
makes the server itself report the settings as not editable and refuse writes with 403.

This wrapper injects those values from the same environment variables into the image's own
entrypoint, so the rest of the start-up path stays the image's. It replaces one module
attribute, which is acceptable for a throwaway spike only. The evidence report recommends a
supported switch instead: an upstream or fork start option, or an image entrypoint that makes
the embedding call itself.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, "/app")

import entrypoint  # noqa: E402 - the image's /app/entrypoint.py
import omnigent.server.app as app_module  # noqa: E402
from omnigent.server.auth import SharingMode  # noqa: E402

_FALSY = ("0", "false", "no", "off")
_original_create_app = app_module.create_app


def _managed_create_app(*args, **kwargs):
    kwargs.setdefault("sharing_mode", SharingMode.coerce(os.environ.get("OMNIGENT_SHARING_MODE")))
    kwargs.setdefault(
        "public_sharing",
        os.environ.get("OMNIGENT_PUBLIC_SHARING", "off").strip().lower() not in _FALSY,
    )
    kwargs.setdefault(
        "public_sharing_max_level", os.environ.get("OMNIGENT_PUBLIC_SHARING_MAX_LEVEL", "read")
    )
    kwargs.setdefault(
        "default_public_sessions", os.environ.get("OMNIGENT_DEFAULT_PUBLIC_SESSIONS", "off")
    )
    return _original_create_app(*args, **kwargs)


app_module.create_app = _managed_create_app

if __name__ == "__main__":
    entrypoint.main()
