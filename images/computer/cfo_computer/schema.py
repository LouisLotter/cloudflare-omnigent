"""A small JSON Schema (draft 2020-12) validator for the contract's exported schemas.

The supervisor parses every inbound payload against the schemas exported from the zod
contracts (``contracts/schema/*.schema.json``), so both sides read one source. The exported
schemas use a small set of keywords; this validator implements exactly those and refuses a
schema with any other keyword, so a contract change that needs more fails loudly in the tests
instead of being skipped. Standard library only.

Differences from a full validator, all on the strict side or annotation-only:
- ``format`` is checked for the two formats the contracts use (``date-time``, ``uuid``); zod
  also exports a ``pattern`` beside each.
- ``maxLength`` and ``minLength`` count code points, as JSON Schema says (zod counts UTF-16
  units; they differ only for characters outside the Basic Multilingual Plane).
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

_ANNOTATIONS = frozenset({"$schema", "$id", "title", "description", "default", "examples"})
_KEYWORDS = frozenset(
    {
        "type",
        "const",
        "enum",
        "pattern",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "properties",
        "required",
        "additionalProperties",
        "propertyNames",
        "items",
        "prefixItems",
        "minItems",
        "maxItems",
        "anyOf",
        "oneOf",
        "allOf",
        "format",
    }
)
_UUID = re.compile(
    r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
    r"|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
)
_DATE_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")


class SchemaError(ValueError):
    """The schema uses something this validator does not implement."""


class ValidationError(ValueError):
    """The value does not match the schema. ``path`` locates the first problem."""

    def __init__(self, path: str, message: str) -> None:
        super().__init__(f"{path or '$'}: {message}")
        self.path = path


def _check_schema(schema: Any, where: str = "$") -> None:
    if isinstance(schema, bool):
        return
    if not isinstance(schema, dict):
        raise SchemaError(f"{where}: a schema must be an object or a boolean")
    for key, value in schema.items():
        if key in _ANNOTATIONS:
            continue
        if key not in _KEYWORDS:
            raise SchemaError(f"{where}: unsupported keyword {key!r}")
        if key in ("properties",):
            for name, sub in value.items():
                _check_schema(sub, f"{where}.properties.{name}")
        elif key in ("items", "propertyNames") or (
            key == "additionalProperties" and isinstance(value, dict)
        ):
            _check_schema(value, f"{where}.{key}")
        elif key in ("prefixItems", "anyOf", "oneOf", "allOf"):
            for i, sub in enumerate(value):
                _check_schema(sub, f"{where}.{key}[{i}]")
        elif key == "format" and value not in ("date-time", "uuid"):
            raise SchemaError(f"{where}: unsupported format {value!r}")


_PATTERNS: dict[str, re.Pattern[str]] = {}


def _regex(pattern: str) -> re.Pattern[str]:
    compiled = _PATTERNS.get(pattern)
    if compiled is None:
        # ECMAScript's \/ is an escaped slash; Python accepts it too. Patterns are searched,
        # as JSON Schema says; the contract's are all anchored.
        compiled = re.compile(pattern)
        _PATTERNS[pattern] = compiled
    return compiled


def _type_ok(value: Any, kind: str) -> bool:
    if kind == "object":
        return isinstance(value, dict)
    if kind == "array":
        return isinstance(value, list)
    if kind == "string":
        return isinstance(value, str)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "null":
        return value is None
    if isinstance(value, bool):
        return False
    if kind == "integer":
        return isinstance(value, int) or (
            isinstance(value, float) and math.isfinite(value) and value.is_integer()
        )
    if kind == "number":
        return isinstance(value, (int, float)) and (
            not isinstance(value, float) or math.isfinite(value)
        )
    raise SchemaError(f"unknown type {kind!r}")


def _equal(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    return a == b


def validate(value: Any, schema: Any, path: str = "") -> None:
    """Raise :class:`ValidationError` unless ``value`` matches ``schema``."""
    if schema is True:
        return
    if schema is False:
        raise ValidationError(path, "no value is allowed here")
    kind = schema.get("type")
    if kind is not None:
        kinds = kind if isinstance(kind, list) else [kind]
        if not any(_type_ok(value, k) for k in kinds):
            raise ValidationError(path, f"expected {kind}")
    if "const" in schema and not _equal(value, schema["const"]):
        raise ValidationError(path, f"expected {schema['const']!r}")
    if "enum" in schema and not any(_equal(value, option) for option in schema["enum"]):
        raise ValidationError(path, "not one of the allowed values")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            raise ValidationError(path, "too short")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            raise ValidationError(path, "too long")
        if "pattern" in schema and not _regex(schema["pattern"]).search(value):
            raise ValidationError(path, "does not match the pattern")
        fmt = schema.get("format")
        if fmt == "uuid" and not _UUID.match(value):
            raise ValidationError(path, "not a UUID")
        if fmt == "date-time" and not _DATE_TIME.match(value):
            raise ValidationError(path, "not a date-time")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            raise ValidationError(path, "below the minimum")
        if "maximum" in schema and value > schema["maximum"]:
            raise ValidationError(path, "above the maximum")
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            raise ValidationError(path, "not above the exclusive minimum")
        if "exclusiveMaximum" in schema and value >= schema["exclusiveMaximum"]:
            raise ValidationError(path, "not below the exclusive maximum")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in value:
                raise ValidationError(f"{path}.{name}", "missing")
        names = schema.get("propertyNames")
        extra = schema.get("additionalProperties", True)
        for name, item in value.items():
            if names is not None:
                validate(name, names, f"{path}[{name!r}]")
            if name in props:
                validate(item, props[name], f"{path}.{name}")
            else:
                validate(item, extra, f"{path}.{name}")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            raise ValidationError(path, "too few items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            raise ValidationError(path, "too many items")
        prefix = schema.get("prefixItems", [])
        for i, item in enumerate(value):
            if i < len(prefix):
                validate(item, prefix[i], f"{path}[{i}]")
            elif "items" in schema:
                validate(item, schema["items"], f"{path}[{i}]")
    for sub in schema.get("allOf", []):
        validate(value, sub, path)
    if "anyOf" in schema:
        errors = []
        for sub in schema["anyOf"]:
            try:
                validate(value, sub, path)
                break
            except ValidationError as exc:
                errors.append(exc)
        else:
            raise _best(errors, path)
    if "oneOf" in schema:
        matched = 0
        errors = []
        for sub in schema["oneOf"]:
            try:
                validate(value, sub, path)
                matched += 1
            except ValidationError as exc:
                errors.append(exc)
        if matched != 1:
            if matched == 0:
                raise _best(errors, path)
            raise ValidationError(path, "matches more than one alternative")


def _best(errors: list[ValidationError], path: str) -> ValidationError:
    """The most specific error of the alternatives: the deepest path."""
    if not errors:
        return ValidationError(path, "matches no alternative")
    return max(errors, key=lambda e: len(e.path))


class SchemaSet:
    """The exported contract schemas, loaded from one directory."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        self._schemas: dict[str, Any] = {}

    def get(self, name: str) -> Any:
        schema = self._schemas.get(name)
        if schema is None:
            schema = json.loads((self.directory / f"{name}.schema.json").read_text())
            _check_schema(schema, name)
            self._schemas[name] = schema
        return schema

    def validate(self, name: str, value: Any) -> None:
        validate(value, self.get(name))
