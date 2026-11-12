#!/usr/bin/env sh
set -eu
# Other devices reach this server through Tailscale (tailscale serve): open / close / status.
# The server keeps listening on 127.0.0.1; Tailscale forwards https://<this PC>.<tailnet>.ts.net to it.
PROGRAM_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
ACTION="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi
EXTRA=""
if [ -z "$ACTION" ]; then
  printf '%s\n' "다른 기기(폰, 다른 PC)가 Tailscale로 이 서버에 접속하도록 엽니다."
  printf '%s\n' "이 PC와 접속할 기기에 Tailscale을 설치하고 같은 계정으로 로그인해 두세요."
  printf '%s\n' "  1. 열기 (원격 접속 모드가 꺼져 있으면 켤지 묻습니다)" "  2. 닫기" "  3. 상태 보기" "  4. Docker 서버용으로 열기"
  printf '%s' '번호를 고르세요 (1~4): '
  read -r CHOICE || CHOICE=''
  case "$CHOICE" in
    1) ACTION=open ;;
    2) ACTION=close ;;
    3) ACTION=status ;;
    4) ACTION=open; EXTRA=--docker ;;
    *) printf '%s\n' '1~4 중 하나를 입력하세요.' >&2; exit 2 ;;
  esac
fi
if [ -n "$EXTRA" ]; then
  exec sh "$PROGRAM_DIR/memory-suite.sh" remote-tunnel "--$ACTION" "$EXTRA" "$@"
fi
exec sh "$PROGRAM_DIR/memory-suite.sh" remote-tunnel "--$ACTION" "$@"
