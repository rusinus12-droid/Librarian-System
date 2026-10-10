#!/bin/sh
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if [ "$#" -gt 0 ]; then
  exec sh "$ROOT/업데이트.sh" "$@"
fi
sh "$ROOT/업데이트.sh"
status=$?
printf '\n엔터 키를 누르면 창을 닫습니다...'
IFS= read -r _ || true
exit "$status"
