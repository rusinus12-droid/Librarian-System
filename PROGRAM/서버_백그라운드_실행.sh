#!/usr/bin/env sh
set -eu
PROGRAM_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec sh "$PROGRAM_DIR/memory-suite.sh" background "$@"
