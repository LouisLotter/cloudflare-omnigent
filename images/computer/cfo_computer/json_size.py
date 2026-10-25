"""Measure JSON.stringify's UTF-16 length for a decoded JSON value.

HostConfig's wire limit uses this length, not UTF-8 bytes or ASCII-escaped JSON. Only
length is needed: object property ordering and equally short decimal representations
do not affect it. No JavaScript runtime or new dependency is needed in the image.
"""

from __future__ import annotations

import math
from typing import Any


def _string_units(value: str) -> int:
    units = 2  # quotes
    i = 0
    while i < len(value):
        code = ord(value[i])
        if value[i] in '"\\\b\f\n\r\t':
            units += 2
        elif code < 0x20:
            units += 6
        elif (
            0xD800 <= code <= 0xDBFF
            and i + 1 < len(value)
            and 0xDC00 <= ord(value[i + 1]) <= 0xDFFF
        ):
            units += 2
            i += 1
        elif 0xD800 <= code <= 0xDFFF:
            units += 6  # well-formed JSON.stringify escapes lone surrogates
        else:
            units += 2 if code > 0xFFFF else 1
        i += 1
    return units


def _number_units(value: int | float) -> int:
    # JSON numbers become binary64 in JavaScript, including integer literals beyond 2**53.
    try:
        number = float(value)
    except OverflowError:
        return 4  # parsed overflow is Infinity; JSON.stringify emits null
    if not math.isfinite(number):
        return 4
    if number == 0:
        return 1  # includes -0
    sign = int(number < 0)
    mantissa, _, exponent = repr(abs(number)).partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = whole + fraction
    n = len(whole) + int(exponent or "0")
    leading = len(digits) - len(digits.lstrip("0"))
    digits = digits[leading:].rstrip("0")
    n -= leading
    # ECMAScript uses fixed notation for 1e-6 <= abs(number) < 1e21, exponential outside.
    if 0 < n <= 21:
        return sign + (n if len(digits) <= n else len(digits) + 1)
    if -6 < n <= 0:
        return sign + 2 - n + len(digits)
    return sign + len(digits) + int(len(digits) > 1) + 2 + len(str(abs(n - 1)))


def stringify_units(value: Any) -> int:
    """Serialized UTF-16 units; refuse non-JSON Python containers/keys."""
    if value is None:
        return 4
    if isinstance(value, bool):
        return 4 if value else 5
    if isinstance(value, str):
        return _string_units(value)
    if isinstance(value, (int, float)):
        return _number_units(value)
    if isinstance(value, list):
        return 2 + max(0, len(value) - 1) + sum(stringify_units(item) for item in value)
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return (
            2
            + max(0, len(value) - 1)
            + sum(_string_units(key) + 1 + stringify_units(item) for key, item in value.items())
        )
    raise ValueError("host configuration must contain JSON values")
