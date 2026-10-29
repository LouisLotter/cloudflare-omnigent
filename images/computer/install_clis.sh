#!/bin/sh
# Install Claude Code and Codex exactly as published, and check (or record) their trees.
# The computer Dockerfile runs it from a bind mount in two stages, with the same environment:
#
#   sh install_clis.sh check              the image: every digest must match its build argument
#   sh install_clis.sh record OUT_FILE    the cli-digests stage: write the digests to OUT_FILE
#   sh install_clis.sh compare AUDITED GLOBAL
#       record's comparison alone (its tests): AUDITED is a project's node_modules, GLOBAL a
#       global node_modules directory
#
# Both read CLAUDE_CODE_VERSION and CODEX_VERSION; `check` also reads CLAUDE_CODE_TREE_SHA256,
# CLAUDE_CODE_INSTALLED_SHA256 and CODEX_TREE_SHA256. `record` is how a version bump gets its
# digests (scripts/tool-versions): the same commands as the image's own install, so a recorded
# digest is the one the image build then checks, in a second, independent install.
#
# No unverified code runs: npm extracts both packages without running scripts (it checks each
# tarball against the registry's integrity value), the extracted trees must match the digests
# (every file's path and SHA-256, every symbolic link's target), and only then does Claude
# Code's own postinstall (install.cjs, which links its native binary over bin/claude.exe) run,
# after which the tree is checked again. Codex has no scripts.
#
# `record` first installs the same versions into a throwaway project and checks the npm
# registry's signatures over them, and Codex's provenance attestations, with `npm audit
# signatures` (which does not support global packages). Before anything from the packages runs,
# each CLI's global tree must be exactly the audited package plus its linux-x64 part (the native
# binary): every file and symbolic link, and nothing else. It also writes the integrity values
# npm checked the audited packages against, which the tool compares with the registry metadata
# it reads itself.
set -eu  # each check on its own line: set -e ignores a failure inside an && list
MODE=${1:-}
case "$MODE" in
  check) ;;
  record) OUT=${2:?record needs an output file} ;;
  compare) ;;
  *) echo "usage: install_clis.sh check | record OUT_FILE | compare AUDITED GLOBAL" >&2; exit 2 ;;
esac
REGISTRY=https://registry.npmjs.org/
LIB=/usr/local/lib/node_modules
CLAUDE=@anthropic-ai/claude-code
CODEX=@openai/codex

# Every file (its SHA-256) and symbolic link (its target) under a directory, by path, with the
# directory written as PREFIX: one line each, as tree() lists them.
listing() ( cd "$1" \
  && { find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum; \
       find . -type l -printf '%p -> %l\n'; } | sed "s#\./#$2/#" )
# A CLI's global tree ($2/$3) must be exactly the audited package and its linux-x64 part, both
# from the audited project's node_modules ($1), where npm puts them side by side.
as_audited() {
  test -f "$1/$3/package.json" && test -f "$1/$3-linux-x64/package.json" \
    && test ! -e "$1/$3/node_modules" && test ! -e "$1/$3-linux-x64/node_modules" \
    || { echo "$1: not the audited layout of $3" >&2; exit 1; }
  want=$( { listing "$1/$3" "$3"; listing "$1/$3-linux-x64" "$3/node_modules/$3-linux-x64"; } \
    | LC_ALL=C sort | sha256sum)
  got=$(listing "$2/$3" "$3" | LC_ALL=C sort | sha256sum)
  test "$got" = "$want" || { echo "$2/$3 is not the audited $3 and its linux-x64 part" >&2; exit 1; }
}
if [ "$MODE" = compare ]; then
  as_audited "${2:?}" "${3:?}" "$CLAUDE"
  as_audited "$2" "$3" "$CODEX"
  exit 0
fi
: "${CLAUDE_CODE_VERSION:?}" "${CODEX_VERSION:?}"

if [ "$MODE" = record ]; then
  AUDIT=$(mktemp -d)
  echo '{"private": true}' > "$AUDIT/package.json"
  (cd "$AUDIT" \
    && npm install --ignore-scripts --no-audit --no-fund --save-exact --registry="$REGISTRY" \
         "$CLAUDE@${CLAUDE_CODE_VERSION}" "$CODEX@${CODEX_VERSION}" \
    && npm audit signatures --registry="$REGISTRY")
fi

npm install -g --ignore-scripts --no-audit --no-fund --registry="$REGISTRY" \
  "$CLAUDE@${CLAUDE_CODE_VERSION}" "$CODEX@${CODEX_VERSION}"
npm cache clean --force

if [ "$MODE" = record ]; then
  as_audited "$AUDIT/node_modules" "$LIB" "$CLAUDE"
  as_audited "$AUDIT/node_modules" "$LIB" "$CODEX"
  integrity() { node -p "require('$AUDIT/package-lock.json').packages['node_modules/$1'].integrity"; }
  {
    echo "CLAUDE_CODE_INTEGRITY=$(integrity "$CLAUDE")"
    echo "CLAUDE_CODE_LINUX_X64_INTEGRITY=$(integrity "$CLAUDE-linux-x64")"
    echo "CODEX_INTEGRITY=$(integrity "$CODEX")"
    echo "CODEX_LINUX_X64_INTEGRITY=$(integrity "$CODEX-linux-x64")"
  } > "$OUT"
  rm -rf "$AUDIT"
fi

# The digest of an installed package's tree: every file's SHA-256 by path, then every
# symbolic link's target, in byte order. Unchanged since the image first pinned the CLIs.
tree() ( cd "$LIB" \
  && { find "$1" -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum; \
       find "$1" -type l -printf '%p -> %l\n' | LC_ALL=C sort; } | sha256sum | cut -d' ' -f1 )
# The package must be the requested version, so a missing tree never digests as empty input.
installed() {
  got=$(node -p "require('$LIB/$1/package.json').version")
  test "$got" = "$2" || { echo "$1: installed $got, expected $2" >&2; exit 1; }
}
# check: the digest must equal the expected value. record: append NAME=digest to OUT.
digest() {
  got=$(tree "$2")
  if [ "$MODE" = record ]; then
    echo "$1=$got" >> "$OUT"
  else
    eval "want=\${$1}"
    test "$got" = "$want" || { echo "$2: installed tree $got, expected $want ($1)" >&2; exit 1; }
  fi
}

installed "$CLAUDE" "$CLAUDE_CODE_VERSION"
installed "$CODEX" "$CODEX_VERSION"
digest CLAUDE_CODE_TREE_SHA256 "$CLAUDE"
digest CODEX_TREE_SHA256 "$CODEX"
(cd "$LIB/$CLAUDE" && node install.cjs)
digest CLAUDE_CODE_INSTALLED_SHA256 "$CLAUDE"
test "$(readlink /usr/local/bin/claude)" = "../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
test "$(readlink /usr/local/bin/codex)" = "../lib/node_modules/@openai/codex/bin/codex.js"
test "$(claude --version | cut -d' ' -f1)" = "$CLAUDE_CODE_VERSION"
test "$(codex --version 2>/dev/null | tail -1)" = "codex-cli $CODEX_VERSION"
if [ "$MODE" = record ]; then
  echo "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION" >> "$OUT"
  echo "CODEX_VERSION=$CODEX_VERSION" >> "$OUT"
fi
rm -rf /root/.claude /root/.claude.json /root/.codex /root/.npm /tmp/*
