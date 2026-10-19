#!/usr/bin/env sh
set -eu
TOOL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PROGRAM_DIR=$(CDPATH= cd -- "$TOOL_DIR/.." && pwd -P)
printf '%s\n' '현재 백업 목록:'
sh "$PROGRAM_DIR/memory-suite.sh" admin list-backups
printf '\n복원할 백업 ID를 정확히 입력하세요: '
IFS= read -r BACKUP_ID || exit 1
if [ -z "$BACKUP_ID" ]; then
  printf '%s\n' '백업 ID를 입력하지 않아 종료합니다.' >&2
  exit 1
fi
printf '대상 [all/flashback/hayaku/libra/lia/retrace 또는 쉼표 목록] (기본 all): '
IFS= read -r TARGET || TARGET=''
if [ -z "$TARGET" ]; then TARGET='all'; fi
printf '\n%s\n' '복원 계획을 먼저 검증합니다.'
if ! sh "$PROGRAM_DIR/memory-suite.sh" admin restore-plan "$BACKUP_ID" "$TARGET"; then
  printf '%s\n' '복원 계획 검증에 실패했습니다.' >&2
  exit 1
fi
printf '\n%s\n' '선택한 데이터가 백업 시점으로 교체됩니다. 복원 직전 백업은 자동 생성됩니다.'
printf '계속하려면 RESTORE를 입력하세요: '
IFS= read -r CONFIRM || exit 1
case "$CONFIRM" in
  RESTORE|restore) ;;
  *)
    printf '%s\n' '취소했습니다.' >&2
    exit 1
    ;;
esac
exec sh "$PROGRAM_DIR/memory-suite.sh" admin restore "$BACKUP_ID" "$TARGET"
