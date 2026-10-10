#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
TARGET_ROOT=''
EXPECT_TARGET=0
for arg in "$@"; do
  if [ "$EXPECT_TARGET" -eq 1 ]; then
    TARGET_ROOT=$arg
    EXPECT_TARGET=0
    continue
  fi
  if [ "$arg" = '--target-root' ]; then EXPECT_TARGET=1; fi
done
STAGE_ROOT=${TARGET_ROOT:-$ROOT}
NODE_EXE=''
try_node() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  "$1" --no-warnings "$ROOT/UPDATER/runtime.cjs" --check >/dev/null 2>&1 || return 1
  NODE_EXE=$1
}
for candidate in "$ROOT/UPDATER/_runtime/node" "$ROOT/UPDATER/_runtime"/node-* "$ROOT/PROGRAM/_runtime/node" "$ROOT/.rollback/"*/PROGRAM/_runtime/node; do
  if try_node "$candidate"; then break; fi
done
if [ -z "$NODE_EXE" ] && [ -n "$TARGET_ROOT" ]; then
  for candidate in "$TARGET_ROOT/UPDATER/_runtime/node" "$TARGET_ROOT/UPDATER/_runtime"/node-* "$TARGET_ROOT/PROGRAM/_runtime/node" "$TARGET_ROOT/.rollback/"*/PROGRAM/_runtime/node; do
    if try_node "$candidate"; then break; fi
  done
fi
if [ -z "$NODE_EXE" ]; then
  for candidate in "$(command -v node 2>/dev/null || true)" "${PREFIX:-/usr}/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if try_node "$candidate"; then break; fi
  done
fi
if [ -z "$NODE_EXE" ]; then
  printf '%s\n' '[Librarian Updater] Node.js >=22.13 with node:sqlite is required.' >&2
  exit 22
fi
# This short process exits before PROGRAM can be renamed.
NODE_EXE=$("$NODE_EXE" --no-warnings "$ROOT/UPDATER/runtime.cjs" --stage-runtime "$STAGE_ROOT")
exec "$NODE_EXE" --no-warnings "$ROOT/UPDATER/updater.cjs" "$@"
