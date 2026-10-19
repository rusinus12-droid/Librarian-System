#!/usr/bin/env sh
set -eu
TOOL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PROGRAM_DIR=$(CDPATH= cd -- "$TOOL_DIR/.." && pwd -P)
printf '\n%s\n' '[주의] 서버가 정상 기동하지 못할 때만 사용하는 복구 전용 기능입니다.'
printf '%s\n\n' '현재 DATA의 대상 DB 원본은 recovery-quarantine에 별도 보존됩니다.'
printf '복원할 백업 ID를 정확히 입력하세요: '
IFS= read -r BACKUP_ID || exit 1
if [ -z "$BACKUP_ID" ]; then
  printf '%s\n' '백업 ID를 입력하지 않아 종료합니다.' >&2
  exit 1
fi
printf '대상 [all/flashback/hayaku/libra/lia/retrace 또는 쉼표 목록] (기본 all): '
IFS= read -r TARGET || TARGET=''
if [ -z "$TARGET" ]; then TARGET='all'; fi
printf '오프라인 복원을 실행하려면 OFFLINE-RESTORE를 입력하세요: '
IFS= read -r CONFIRM || exit 1
case "$CONFIRM" in
  OFFLINE-RESTORE|offline-restore) ;;
  *)
    printf '%s\n' '취소했습니다.' >&2
    exit 1
    ;;
esac
exec sh "$PROGRAM_DIR/memory-suite.sh" admin restore-offline "$BACKUP_ID" "$TARGET" --yes
