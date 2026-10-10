#!/usr/bin/env sh
set -eu
PROGRAM_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if [ -x "$PROGRAM_DIR/_runtime/node" ]; then NODE_EXE="$PROGRAM_DIR/_runtime/node"; elif command -v node >/dev/null 2>&1; then NODE_EXE=$(command -v node); else printf '%s
' '[Librarian System] Node.js 22.13.0 이상을 먼저 설치하세요.' >&2; exit 22; fi
"$NODE_EXE" --no-warnings "$PROGRAM_DIR/tools/check_node.cjs" >/dev/null
if [ "$#" -eq 0 ]; then exec "$NODE_EXE" --no-warnings "$PROGRAM_DIR/tools/release_builder_ui.cjs" --profile source; fi
exec "$NODE_EXE" --no-warnings "$PROGRAM_DIR/tools/build_distribution.cjs" --profile source "$@"
