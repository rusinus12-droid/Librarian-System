#!/bin/sh
PROGRAM_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
sh "$PROGRAM_DIR/1_서버_실행.sh"
EXIT_CODE=$?
printf '\nLibrarian System 종료 코드: %s\n' "$EXIT_CODE"
printf '이 창을 닫으려면 Enter를 누르세요.\n'
read -r _unused
exit "$EXIT_CODE"
