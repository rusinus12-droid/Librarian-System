#!/usr/bin/env sh
set -u

TOOL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PROGRAM_DIR=$(CDPATH= cd -- "$TOOL_DIR/.." && pwd -P)

NODE_EXE=''
for candidate in "$PROGRAM_DIR/_runtime/node" "$PROGRAM_DIR/_runtime"/node-* "$(command -v node 2>/dev/null || true)" "${PREFIX:-/usr}/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" --no-warnings "$PROGRAM_DIR/tools/check_node.cjs" >/dev/null 2>&1; then
    NODE_EXE=$candidate
    break
  fi
done

if [ -z "$NODE_EXE" ]; then
  printf '%s\n' '[Librarian System] Node.js 22.13.0 이상을 찾지 못했습니다.' >&2
  exit 22
fi

exec "$NODE_EXE" --no-warnings "$PROGRAM_DIR/tools/run_regression_tests.cjs" "$@"
