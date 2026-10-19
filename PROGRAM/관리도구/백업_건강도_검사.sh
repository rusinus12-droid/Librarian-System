#!/usr/bin/env sh
set -eu
TOOL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PROGRAM_DIR=$(CDPATH= cd -- "$TOOL_DIR/.." && pwd -P)
printf '%s\n' '전체 백업의 SHA-256과 SQLite integrity를 검사합니다.'
exec sh "$PROGRAM_DIR/memory-suite.sh" admin scrub "$@"
