#!/usr/bin/env sh
set -eu
TOOL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PROGRAM_DIR=$(CDPATH= cd -- "$TOOL_DIR/.." && pwd -P)
if [ "$#" -gt 0 ]; then
  exec sh "$PROGRAM_DIR/memory-suite.sh" admin backup "$@"
fi
exec sh "$PROGRAM_DIR/memory-suite.sh" admin backup "manual"
