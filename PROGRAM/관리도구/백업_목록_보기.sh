#!/usr/bin/env sh
set -eu
TOOL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PROGRAM_DIR=$(CDPATH= cd -- "$TOOL_DIR/.." && pwd -P)
exec sh "$PROGRAM_DIR/memory-suite.sh" admin list-backups "$@"
