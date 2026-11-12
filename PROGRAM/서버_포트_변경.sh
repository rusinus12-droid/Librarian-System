#!/usr/bin/env sh
set -eu
# Changes the server port in DATA/config/server-config.json. The server must be stopped first.
PROGRAM_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PORT="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi
if [ -z "$PORT" ]; then
  printf '%s\n' "서버가 꺼진 상태에서만 포트를 바꿉니다. 실행 중이면 먼저 sh \"$PROGRAM_DIR/2_서버_종료.sh\"를 실행하세요."
  printf '%s' '새 서버 포트 번호 (1024~65535): '
  read -r PORT || PORT=''
fi
exec sh "$PROGRAM_DIR/memory-suite.sh" set-port --port "$PORT" "$@"
