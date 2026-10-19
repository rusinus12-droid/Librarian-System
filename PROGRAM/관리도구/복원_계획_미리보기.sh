#!/usr/bin/env sh
set -eu
TOOL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PROGRAM_DIR=$(CDPATH= cd -- "$TOOL_DIR/.." && pwd -P)
if [ "$#" -ge 1 ]; then
  exec sh "$PROGRAM_DIR/memory-suite.sh" admin restore-plan "$@"
fi
sh "$PROGRAM_DIR/memory-suite.sh" admin list-backups
printf '\n검토할 백업 ID를 정확히 입력하세요: '
IFS= read -r BACKUP_ID || exit 1
if [ -z "$BACKUP_ID" ]; then
  printf '%s\n' '백업 ID를 입력하지 않아 종료합니다.' >&2
  exit 1
fi
printf '대상 [all/flashback/hayaku/libra/lia/retrace 또는 쉼표 목록] (기본 all): '
IFS= read -r TARGET || TARGET=''
if [ -z "$TARGET" ]; then TARGET='all'; fi
exec sh "$PROGRAM_DIR/memory-suite.sh" admin restore-plan "$BACKUP_ID" "$TARGET"
