#!/usr/bin/env sh
set -eu
# Server access mode: remote / local / rotate / show. The server must be stopped to change it;
# a change applies from the next server start.
PROGRAM_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
ACTION="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi
if [ -z "$ACTION" ]; then
  printf '%s\n' "서버 접속 모드를 바꿉니다."
  printf '%s\n' "  내부 접속 모드(기본): 이 PC의 플러그인만 키 없이 연결합니다."
  printf '%s\n' "  원격 접속 모드: 모든 플러그인이 접근 키로 연결합니다. 다른 기기는 Tailscale이나 Cloudflare Tunnel을 거쳐야 합니다."
  printf '%s\n' "바꾸기 전에 서버를 꺼 주세요. 실행 중이면 먼저 sh \"$PROGRAM_DIR/2_서버_종료.sh\"를 실행하세요."
  printf '%s\n' "  1. 원격 접속 모드 켜기 (접근 키를 만들고 보여 줍니다)" "  2. 내부 접속 모드로 돌아가기 (접근 키는 보존)" "  3. 접근 키 새로 만들기 (예전 키는 더 이상 쓸 수 없습니다)" "  4. 현재 모드와 접근 키 보기"
  printf '%s' '번호를 고르세요 (1~4): '
  read -r CHOICE || CHOICE=''
  case "$CHOICE" in
    1) ACTION=remote ;;
    2) ACTION=local ;;
    3) ACTION=rotate ;;
    4) ACTION=show ;;
    *) printf '%s\n' '1~4 중 하나를 입력하세요.' >&2; exit 2 ;;
  esac
fi
exec sh "$PROGRAM_DIR/memory-suite.sh" set-remote-access "--$ACTION" "$@"
