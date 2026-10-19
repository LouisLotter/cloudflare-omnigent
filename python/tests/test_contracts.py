"""The Python side of the wire contract: every golden fixture must validate against the
JSON Schema exported from the TypeScript source, and every invalid fixture must not."""

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIR = ROOT / "contracts" / "schema"
FIXTURE_DIR = ROOT / "contracts" / "fixtures"


def _schemas() -> dict[str, dict]:
    return {
        path.name.removesuffix(".schema.json"): json.loads(path.read_text())
        for path in sorted(SCHEMA_DIR.glob("*.schema.json"))
    }


def _cases(valid: bool) -> list[tuple[str, Path]]:
    cases = []
    for name in _schemas():
        directory = FIXTURE_DIR / name if valid else FIXTURE_DIR / name / "invalid"
        cases += [(name, path) for path in sorted(directory.glob("*.json"))]
    return cases


def _validator(name: str) -> Draft202012Validator:
    schema = _schemas()[name]
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def test_every_schema_has_fixtures() -> None:
    assert _schemas(), "no exported schemas found; run `pnpm contracts:export`"
    for name in _schemas():
        assert list((FIXTURE_DIR / name).glob("*.json")), f"{name} has no valid fixture"
        invalid = list((FIXTURE_DIR / name / "invalid").glob("*.json"))
        assert invalid, f"{name} has no invalid fixture"


@pytest.mark.parametrize(("name", "path"), _cases(valid=True), ids=lambda v: getattr(v, "name", v))
def test_valid_fixture(name: str, path: Path) -> None:
    errors = list(_validator(name).iter_errors(json.loads(path.read_text())))
    assert not errors, [e.message for e in errors]


@pytest.mark.parametrize(("name", "path"), _cases(valid=False), ids=lambda v: getattr(v, "name", v))
def test_invalid_fixture(name: str, path: Path) -> None:
    assert list(_validator(name).iter_errors(json.loads(path.read_text()))), f"{path} should fail"
