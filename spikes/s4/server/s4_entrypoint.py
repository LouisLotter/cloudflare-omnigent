"""S4 spike entrypoint: Omnigent's own Docker entrypoint, plus the barrier.

Packaging only. It loads Omnigent's unmodified ``/app/entrypoint.py``, wraps
its public ``build_app`` so the returned FastAPI app gets the barrier
middleware, installs engine-wide SQLAlchemy listeners before any engine
exists, and then runs Omnigent's ``main()`` unchanged. No Omnigent source
file is edited.
"""

from __future__ import annotations

import importlib.util
import sys
import time

import s4_barrier

s4_barrier.log("entrypoint_start", monotonic=time.monotonic())
s4_barrier.install_sql_hooks()

_spec = importlib.util.spec_from_file_location("omnigent_docker_entrypoint", "/app/entrypoint.py")
assert _spec is not None and _spec.loader is not None
_ep = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _ep  # dataclasses in the module look themselves up here
_spec.loader.exec_module(_ep)

_original_build_app = _ep.build_app


def _build_app_with_barrier(resolved_config=None):  # noqa: ANN001, ANN202
    built = _original_build_app(resolved_config)
    s4_barrier.install_app(built.app)
    return built


_ep.build_app = _build_app_with_barrier

if __name__ == "__main__":
    _ep.main()
