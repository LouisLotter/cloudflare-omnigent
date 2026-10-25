"""Run the entrypoint as a process with a test layout: ``run_entrypoint.py <layout.json>``.

The configuration comes from the environment, as in the image; only the paths differ.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cfo_server import config as image_config  # noqa: E402
from cfo_server.entrypoint import EXIT_CONFIG, Layout, run  # noqa: E402
from cfo_server.events import log  # noqa: E402


def main() -> int:
    spec = json.loads(Path(sys.argv[1]).read_text())
    layout = Layout(
        db_path=Path(spec["db_path"]),
        omnigent_data_dir=Path(spec["omnigent_data_dir"]),
        config_path=Path(spec["config_path"]),
        artifact_dir=Path(spec["artifact_dir"]),
        run_dir=Path(spec["run_dir"]),
        litestream_socket=Path(spec["litestream_socket"]),
        litestream_config=Path(spec["litestream_config"]),
        litestream_bin=Path(spec["litestream_bin"]),
        app_command=tuple(spec["app_command"]),
        app_port=spec["app_port"],
        control_port=spec["control_port"],
        bind_host="127.0.0.1",
        app_stop_timeout_s=spec.get("app_stop_timeout_s", 10.0),
        recovery_retry_s=spec.get("recovery_retry_s", 60.0),
        app_env_overrides=tuple((k, v) for k, v in spec.get("app_env_overrides", {}).items()),
        build_info_path=Path(spec.get("build_info_path", "/nonexistent/build.json")),
    )
    try:
        config = image_config.load()
    except image_config.ConfigError as exc:
        log("config.error", message=str(exc))
        return EXIT_CONFIG
    import os

    return run(config, layout, os.environ)


if __name__ == "__main__":
    sys.exit(main())
