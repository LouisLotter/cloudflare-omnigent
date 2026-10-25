"""The launcher's settings from the environment: unset, partly set, malformed, and the key's
custody (never printed)."""

from __future__ import annotations

import pytest
from conftest import canary

from cloudflare_omnigent.sandbox.settings import (
    DURABILITY_TIMEOUT_ENV,
    SIGNING_KEY_ENV,
    SIGNING_KEY_ID_ENV,
    URL_ENV,
    LauncherConfigError,
    LauncherSettings,
    settings_from_env,
)


def test_neither_key_setting_means_not_configured() -> None:
    assert settings_from_env({}) is None
    assert settings_from_env({SIGNING_KEY_ENV: "  ", SIGNING_KEY_ID_ENV: ""}) is None


@pytest.mark.parametrize("present", [SIGNING_KEY_ENV, SIGNING_KEY_ID_ENV])
def test_only_one_key_setting_is_an_error_naming_the_other(present: str) -> None:
    other = SIGNING_KEY_ID_ENV if present == SIGNING_KEY_ENV else SIGNING_KEY_ENV
    with pytest.raises(LauncherConfigError, match=other):
        settings_from_env({present: "k" * 40})


def test_a_complete_configuration_with_defaults() -> None:
    key = canary(40)
    settings = settings_from_env({SIGNING_KEY_ENV: f" {key}\n", SIGNING_KEY_ID_ENV: "k-2026-10"})
    assert settings is not None
    assert settings.signing_key == key.encode()
    assert settings.signing_key_id == "k-2026-10"
    assert settings.base_url == "http://platform.internal/launcher"
    assert settings.durability_timeout_s == 10.0
    assert key not in repr(settings)
    assert key not in str(settings)


@pytest.mark.parametrize(
    ("env", "message"),
    [
        ({SIGNING_KEY_ENV: "short"}, SIGNING_KEY_ENV),
        ({SIGNING_KEY_ID_ENV: "bad id"}, SIGNING_KEY_ID_ENV),
        ({SIGNING_KEY_ID_ENV: "x" * 129}, SIGNING_KEY_ID_ENV),
        ({URL_ENV: "https://platform.internal/launcher"}, URL_ENV),
        ({URL_ENV: "ftp://platform.internal"}, URL_ENV),
        ({URL_ENV: "http://user:pw@platform.internal"}, URL_ENV),
        ({URL_ENV: "http://platform.internal/launcher?x=1"}, URL_ENV),
        ({URL_ENV: "http://platform.internal:0/launcher"}, URL_ENV),
        ({URL_ENV: "http://[::1/x"}, URL_ENV),
        ({DURABILITY_TIMEOUT_ENV: "soon"}, DURABILITY_TIMEOUT_ENV),
        ({DURABILITY_TIMEOUT_ENV: "0"}, DURABILITY_TIMEOUT_ENV),
        ({DURABILITY_TIMEOUT_ENV: "61"}, DURABILITY_TIMEOUT_ENV),
        ({DURABILITY_TIMEOUT_ENV: "nan"}, DURABILITY_TIMEOUT_ENV),
        ({DURABILITY_TIMEOUT_ENV: "inf"}, DURABILITY_TIMEOUT_ENV),
    ],
)
def test_malformed_values_are_refused_by_name_never_by_value(
    env: dict[str, str], message: str
) -> None:
    key = canary(40)
    full = {SIGNING_KEY_ENV: key, SIGNING_KEY_ID_ENV: "k1", **env}
    with pytest.raises(LauncherConfigError, match=message) as caught:
        settings_from_env(full)
    assert key not in str(caught.value)


def test_overrides_are_read_and_a_trailing_slash_dropped() -> None:
    settings = settings_from_env(
        {
            SIGNING_KEY_ENV: "k" * 32,
            SIGNING_KEY_ID_ENV: "k1",
            URL_ENV: "http://127.0.0.1:8080/launcher/",
            DURABILITY_TIMEOUT_ENV: "2.5",
        }
    )
    assert settings == LauncherSettings(
        signing_key=b"k" * 32,
        signing_key_id="k1",
        base_url="http://127.0.0.1:8080/launcher",
        durability_timeout_s=2.5,
    )


def test_the_key_is_its_utf8_bytes() -> None:
    settings = settings_from_env({SIGNING_KEY_ENV: "é" * 16, SIGNING_KEY_ID_ENV: "k1"})
    assert settings is not None and settings.signing_key == ("é" * 16).encode()
