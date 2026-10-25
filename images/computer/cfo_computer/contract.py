"""The computer API's contract, as the supervisor reads and writes it.

Every inbound payload is checked against the exported JSON Schema of its zod contract, then
against the refinements the zod side checks in code and the JSON Schema cannot express
(``.refine`` in contracts/src/computer-protocol.ts and manifests.ts). Every outbound payload
is checked against its schema before it is sent, so a supervisor bug is caught here and not by
WorkspaceDO.
"""

from __future__ import annotations

import datetime
from pathlib import Path
from typing import Any

from .json_size import stringify_units
from .schema import SchemaSet, ValidationError

DECLARED_CREDENTIAL_PATHS: tuple[str, ...] = (
    ".claude/.credentials.json",
    ".claude/.device-keys.json",
    ".codex/auth.json",
    ".codex/.credentials.json",
)
CREDENTIAL_PROVIDER = {
    ".claude/.credentials.json": "claude",
    ".claude/.device-keys.json": "claude",
    ".codex/auth.json": "codex",
    ".codex/.credentials.json": "codex",
}
WORKSPACE_FORMAT_VERSION = 1
CREDENTIAL_FORMAT_VERSION = 1
MAX_DELTAS_PER_BASE = 20
MAX_CREDENTIAL_FILE_BYTES = 64 * 1024
MAX_BODY_BYTES = 512 * 1024
MAX_HOST_CONFIG_UNITS = 64 * 1024
LAYER_METADATA_DIR = ".cfo-layer"
LAYER_INDEX_PATH = f"{LAYER_METADATA_DIR}/index.json"

ERROR_CODES = frozenset(
    {
        "bad_request",
        "unauthorized",
        "forbidden",
        "not_found",
        "conflict",
        "stale_generation",
        "unsupported_version",
        "unavailable",
        "internal",
        "gone",
        "at_capacity",
    }
)


class ContractError(ValueError):
    """A payload the contract refuses; ``code`` is the ErrorBody code to answer with."""

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        assert code in ERROR_CODES
        self.code = code
        self.retryable = retryable


def error_body(code: str, message: str, *, retryable: bool = False) -> dict[str, Any]:
    return {"error": {"code": code, "message": message[:500] or code, "retryable": retryable}}


def _unique(values: list[str]) -> bool:
    return len(set(values)) == len(values)


def _parse_time(value: str) -> float:
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def bundle_refinements(bundle: dict[str, Any]) -> None:
    orders = [f["copyOrder"] for f in bundle["files"].values()]
    if bundle["order"] != max(orders):
        raise ContractError("bad_request", "bundle order is not the highest copy order")


def manifest_refinements(manifest: dict[str, Any]) -> None:
    layers = manifest["layers"]
    if not (_unique([layer["layerId"] for layer in layers]) and _unique(manifest["roots"])):
        raise ContractError("bad_request", "manifest layer IDs and roots must be unique")
    if manifest["treeDigest"] != layers[-1]["treeDigest"]:
        raise ContractError("bad_request", "manifest tree digest is not its last layer's")
    if _parse_time(manifest["cutAt"]) > _parse_time(manifest["createdAt"]):
        raise ContractError("bad_request", "manifest cut follows its publication")


def layer_index_refinements(index: dict[str, Any]) -> None:
    if not (_unique([e["path"] for e in index["entries"]]) and _unique(index["deleted"])):
        raise ContractError("bad_request", "layer index repeats a path")


class Contract:
    """Parses and checks the computer API's messages with the exported schemas."""

    def __init__(self, schema_dir: Path) -> None:
        self.schemas = SchemaSet(schema_dir)

    def _schema(self, name: str, value: Any) -> None:
        try:
            self.schemas.validate(name, value)
        except ValidationError as exc:
            raise ContractError("bad_request", f"{name}: {exc}") from exc

    def parse_command(self, value: Any) -> dict[str, Any]:
        """A ``WorkspaceCommand``, schema and refinements; raises :class:`ContractError`."""
        self._schema("WorkspaceCommand", value)
        kind = value["type"]
        if kind == "start_host":
            # z.record strips this top-level property before HostConfig's refinement.
            # Return the same normalized config; never measure a filtered copy but then
            # pass the original, potentially oversized config on to the host.
            config = {key: item for key, item in value["hostConfig"].items() if key != "__proto__"}
            try:
                units = stringify_units(config)
            except (ValueError, RecursionError) as exc:
                raise ContractError("bad_request", "invalid host configuration JSON") from exc
            if units > MAX_HOST_CONFIG_UNITS:
                raise ContractError("bad_request", "host configuration larger than 64 KiB")
            value = {**value, "hostConfig": config}
        elif kind == "install_credentials" and value["bundle"] is not None:
            if value["bundle"]["computerId"] != value["computerId"]:
                raise ContractError("bad_request", "the bundle is another computer's")
            bundle_refinements(value["bundle"])
        elif kind == "restore_workspace":
            manifest = value["manifest"]
            count = len(manifest["layers"]) if manifest is not None else 0
            if count != len(value["layerDirs"]):
                raise ContractError("bad_request", "one restored directory per layer")
            if manifest is not None:
                if manifest["computerId"] != value["computerId"]:
                    raise ContractError("bad_request", "the manifest is another computer's")
                manifest_refinements(manifest)
        elif kind == "capture":
            if value["lease"]["targetMs"] > value["lease"]["hardMs"]:
                raise ContractError("bad_request", "the lease target exceeds its hard budget")
        return value

    def parse_layer_index(self, value: Any) -> dict[str, Any]:
        """Validate and normalize integer fields for Python filesystem consumers."""
        self._schema("LayerIndex", value)
        layer_index_refinements(value)
        # Validation has already rejected booleans, fractions and out-of-range numbers.
        # JSON's 1.0/1e0 spellings are valid integers, but os.chmod and octal formatting
        # need Python ints. Do not mutate the input object supplied by the caller.
        return {
            **value,
            "formatVersion": int(value["formatVersion"]),
            "generation": int(value["generation"]),
            "entries": [
                {
                    key: int(item) if key in ("mode", "uid", "gid", "size") else item
                    for key, item in entry.items()
                }
                for entry in value["entries"]
            ],
        }

    def parse_supervisor_reply(self, value: Any) -> dict[str, Any]:
        self._schema("SupervisorReply", value)
        return value

    def parse_error_body(self, value: Any) -> dict[str, Any]:
        self._schema("ErrorBody", value)
        return value

    def check_outbound(self, name: str, value: Any) -> None:
        """Our own message or reply, before it leaves; a failure is a supervisor bug."""
        self.schemas.validate(name, value)
        if name == "SupervisorMessage" and value["type"] == "credential_checkpoint":
            bundle = value["bundle"]
            assert bundle["computerId"] == value["computerId"]
            assert bundle["generation"] == value["generation"]
            bundle_refinements(bundle)
        if name == "LayerIndex":
            layer_index_refinements(value)
