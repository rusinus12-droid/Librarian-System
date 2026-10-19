#!/usr/bin/env sh
set -eu

PROGRAM_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

try_node() {
  [ -n "${1:-}" ] && [ -x "$1" ] || return 1
  "$1" --no-warnings "$PROGRAM_DIR/tools/check_node.cjs" >/dev/null 2>&1 || return 1
  printf '%s\n' "$1"
  return 0
}

find_node() {
  for candidate in "$PROGRAM_DIR/_runtime/node" "$PROGRAM_DIR/_runtime"/node-* "$(command -v node 2>/dev/null || true)" "${PREFIX:-/usr}/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if try_node "$candidate"; then
      return 0
    fi
  done
  return 1
}

if ! NODE_EXE=$(find_node); then
  printf '%s\n' '[Librarian System] Node.js 22.13.0 이상을 찾지 못했습니다.' >&2
  printf '%s\n' 'macOS/Linux에서는 공식 Node.js 22 이상을 설치하세요.' >&2
  printf '%s\n' 'Android Termux에서는 먼저 sh "PROGRAM/안드로이드_Termux_준비.sh"를 실행하세요.' >&2
  exit 22
fi

if [ "${1:-}" = "admin" ]; then
  shift
  exec "$NODE_EXE" --no-warnings "$PROGRAM_DIR/server/admin.cjs" "$@"
fi

exec "$NODE_EXE" --no-warnings "$PROGRAM_DIR/tools/platform_launcher.cjs" "$@"
