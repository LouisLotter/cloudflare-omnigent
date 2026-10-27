#!/bin/sh
# Pin the image's own Python to a fixed pip: the installed pip, and the wheel ensurepip seeds
# into every new virtual environment (`python -m venv`). Both Dockerfiles run it from a bind
# mount, with the hash-pinned requirement as the only argument:
#
#   sh pin_pip.sh "pip==26.2.2 --hash=sha256:…"
#
# Why: pip before 26.2.2 vendors a certifi that still trusts both roots of the October 2026
# eMudhra key compromise, and adds it to the system store, so a fixed system bundle does not
# protect it. Python 3.12's ensurepip bundles pip 25.0.1. The download is hash-checked, so it is
# safe even with the old pip doing it.
set -eu
PIN=$1
PY=/usr/local/bin/python3
WORK=$(mktemp -d)
printf '%s\n' "$PIN" > "$WORK/pin.txt"
"$PY" -I -m pip download --no-cache-dir --disable-pip-version-check --no-deps \
  --require-hashes -r "$WORK/pin.txt" -d "$WORK/wheel"
set -- "$WORK"/wheel/pip-*-py3-none-any.whl
test "$#" -eq 1 && test -f "$1"
WHEEL=$1
NEW=$(basename "$WHEEL" | cut -d- -f2)
"$PY" -I -m pip install --no-cache-dir --disable-pip-version-check --root-user-action=ignore \
  --no-index --no-deps "$WHEEL"
ENSUREPIP=$("$PY" -I -c 'import ensurepip, os; print(os.path.dirname(ensurepip.__file__))')
OLD=$(sed -n 's/^_PIP_VERSION = "\(.*\)"$/\1/p' "$ENSUREPIP/__init__.py")
test -n "$OLD" && test -f "$ENSUREPIP/_bundled/pip-$OLD-py3-none-any.whl"
rm "$ENSUREPIP/_bundled/pip-$OLD-py3-none-any.whl"
cp "$WHEEL" "$ENSUREPIP/_bundled/"
sed -i "s/^_PIP_VERSION = \"$OLD\"$/_PIP_VERSION = \"$NEW\"/" "$ENSUREPIP/__init__.py"
# Checked: the installed pip, and a fresh virtual environment's.
test "$("$PY" -I -m pip --version | cut -d' ' -f2)" = "$NEW"
"$PY" -I -m venv "$WORK/venv"
test "$("$WORK/venv/bin/python" -I -m pip --version | cut -d' ' -f2)" = "$NEW"
rm -rf "$WORK"
echo "pin_pip: pip $NEW installed and seeded by ensurepip (was $OLD)"
