#!/usr/bin/env sh
set -eu
# Remote access (Docker, other devices): enable / disable / rotate / show. The server must be stopped to change it.
PROGRAM_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
ACTION="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi
if [ -z "$ACTION" ]; then
  printf '%s\n' "다른 기기나 Docker 컨테이너의 플러그인이 이 서버에 접속하도록 허용합니다."
  printf '%s\n' "바꾸기 전에 서버를 꺼 주세요. 실행 중이면 먼저 sh \"$PROGRAM_DIR/2_서버_종료.sh\"를 실행하세요."
  printf '%s\n' "  1. 외부 접속 켜기 (접근 키를 만들고 보여 줍니다)" "  2. 외부 접속 끄기" "  3. 접근 키 새로 만들기 (예전 키는 더 이상 쓸 수 없습니다)" "  4. 현재 상태와 접근 키 보기"
  printf '%s' '번호를 고르세요 (1~4): '
  read -r CHOICE || CHOICE=''
  case "$CHOICE" in
    1) ACTION=enable ;;
    2) ACTION=disable ;;
    3) ACTION=rotate ;;
    4) ACTION=show ;;
    *) printf '%s\n' '1~4 중 하나를 입력하세요.' >&2; exit 2 ;;
  esac
fi
exec sh "$PROGRAM_DIR/memory-suite.sh" set-remote-access "--$ACTION" "$@"
