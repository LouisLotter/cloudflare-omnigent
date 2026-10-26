"""The Cloudflare launcher: Omnigent's sandbox provider for cloud computers (WP3.6).

- :mod:`.protocol`: the launcher API's wire contract (3.C), pure.
- :mod:`.settings`: the launcher's settings from the server container's environment.
- :mod:`.client`: signed HTTP to ``platform.internal``, with lost replies repeated.
- :mod:`.core`: the eleven operations, operation IDs and the durability fence.
- :mod:`.launcher`: ``CloudflareLauncher``, Omnigent's ``SandboxHostLauncher`` (needs Omnigent).
- :mod:`.registration`: the provider entry for ``create_app(sandbox_config=…)`` (needs Omnigent).

Only the last two import Omnigent, so the rest is tested without an Omnigent build.
"""
