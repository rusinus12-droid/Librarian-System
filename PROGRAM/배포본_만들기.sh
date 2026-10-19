#!/usr/bin/env sh
set -eu
PROGRAM_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
NODE_EXE=''
for candidate in "$PROGRAM_DIR/_runtime/node" "$PROGRAM_DIR/_runtime"/node-* "$(command -v node 2>/dev/null || true)" "${PREFIX:-/usr}/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" --no-warnings "$PROGRAM_DIR/tools/check_node.cjs" >/dev/null 2>&1; then
    NODE_EXE=$candidate
    break
  fi
done
if [ -z "$NODE_EXE" ]; then
  printf '%s\n' '[Librarian System] Node.js 22.13.0 이상을 먼저 설치하세요.' >&2
  exit 22
fi
if [ "$#" -eq 0 ]; then exec "$NODE_EXE" --no-warnings "$PROGRAM_DIR/tools/release_builder_ui.cjs" --profile release; fi
exec "$NODE_EXE" --no-warnings "$PROGRAM_DIR/tools/build_distribution.cjs" --profile release "$@"
