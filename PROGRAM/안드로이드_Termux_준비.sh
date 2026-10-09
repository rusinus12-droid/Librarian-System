#!/usr/bin/env sh
set -eu

PROGRAM_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

case "$PROGRAM_DIR" in
  /storage/*|/sdcard/*)
    printf '%s\n' '[Librarian System] SQLite DATA를 Android 공유 저장소에서 실행하지 않습니다.' >&2
    printf '%s\n' '같은 PROGRAM 폴더의 안드로이드_설치.sh를 sh로 실행하면 내부 HOME에 새로 설치할 수 있습니다.' >&2
    printf 'sh "%s/안드로이드_설치.sh"\n' "$PROGRAM_DIR" >&2
    exit 3
    ;;
esac

if ! command -v pkg >/dev/null 2>&1; then
  printf '%s\n' '[Librarian System] 이 스크립트는 Android Termux 전용입니다.' >&2
  exit 2
fi

printf '%s\n' '[Librarian System] Termux 패키지 목록을 갱신합니다.'
pkg update -y
printf '%s\n' '[Librarian System] Node.js를 설치하거나 갱신합니다.'
pkg install -y nodejs

node --no-warnings "$PROGRAM_DIR/tools/check_node.cjs"
node --no-warnings "$PROGRAM_DIR/tools/platform_launcher.cjs" prepare

printf '%s\n' ''
printf '%s\n' '[Librarian System] Android 준비가 완료되었습니다.'
printf '%s\n' '포그라운드 실행: sh "PROGRAM/1_서버_실행.sh"'
printf '%s\n' '백그라운드 실행: sh "PROGRAM/서버_백그라운드_실행.sh"'
printf '%s\n' '안전 종료: sh "PROGRAM/2_서버_종료.sh"'
printf '%s\n' 'Android 설정에서 Termux의 배터리 최적화를 해제하세요.'
if command -v termux-wake-lock >/dev/null 2>&1; then
  printf '%s\n' '장시간 실행 전 termux-wake-lock 사용을 권장합니다.'
fi
