#!/usr/bin/env sh
set -eu

PROGRAM_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

find_node() {
  if [ -x "$PROGRAM_DIR/_runtime/node" ]; then
    printf '%s\n' "$PROGRAM_DIR/_runtime/node"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  return 1
}

if ! NODE_EXE=$(find_node); then
  printf '%s\n' '[Librarian System] Node.js 22.13.0 이상을 찾지 못했습니다.' >&2
  printf '%s\n' 'macOS/Linux에서는 공식 Node.js 22 이상을 설치하세요.' >&2
  printf '%s\n' 'Android Termux에서는 먼저 sh "PROGRAM/안드로이드_Termux_준비.sh"를 실행하세요.' >&2
  exit 22
fi

exec "$NODE_EXE" --no-warnings "$PROGRAM_DIR/tools/platform_launcher.cjs" "$@"
