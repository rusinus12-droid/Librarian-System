#!/bin/sh
set -u
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

if [ "$#" -gt 0 ]; then
  exec sh "$ROOT/UPDATER/launch.sh" "$@"
fi

printf '%s\n' '========================================'
printf '%s\n' '      Librarian System 업데이트'
printf '%s\n' '========================================'
printf '%s\n' ''
printf '%s\n' '  1. 이 폴더의 서버를 최신 버전으로 업데이트'
printf '%s\n' '  2. 다른 기존 설치 폴더를 업데이트'
printf '%s\n' '     (0.3.51에서 처음 업데이트할 때도 이 메뉴 사용)'
printf '%s\n' '  3. 미완료 업데이트 복구'
printf '%s\n' '  4. 내려받은 업데이트 ZIP을 직접 선택해서 업데이트 (인터넷 불필요)'
printf '%s\n' '  0. 종료'
printf '%s\n' ''
printf '%s' '번호를 선택하세요: '
IFS= read -r choice || exit 1

case "$choice" in
  1)
    sh "$ROOT/UPDATER/launch.sh" --user-update
    status=$?
    ;;
  2)
    printf '%s\n' ''
    printf '%s\n' '기존에 사용 중인 Librarian System 폴더를 입력하세요.'
    printf '%s' '기존 설치 폴더: '
    IFS= read -r target || exit 1
    target=$(printf '%s' "$target" | sed 's/^"//;s/"$//')
    if [ ! -f "$target/PROGRAM/VERSION.txt" ] || [ ! -d "$target/DATA" ]; then
      printf '%s\n' '[오류] PROGRAM/VERSION.txt와 DATA가 있는 Librarian System 최상위 폴더를 선택해 주세요.' >&2
      exit 2
    fi
    sh "$ROOT/UPDATER/launch.sh" --user-update --target-root "$target" --install-updater
    status=$?
    ;;
  3)
    sh "$ROOT/UPDATER/launch.sh" --recover
    status=$?
    ;;
  4)
    printf '%s\n' ''
    printf '%s\n' '내려받은 Librarian-System-버전.zip 경로를 입력하세요.'
    printf '%s\n' '비워 두면 파일 선택 창이 열립니다. (Termux는 경로를 입력해야 합니다)'
    printf '%s' 'ZIP 경로: '
    IFS= read -r zip || exit 1
    zip=$(printf '%s' "$zip" | sed 's/^"//;s/"$//')
    if [ -n "$zip" ]; then
      sh "$ROOT/UPDATER/launch.sh" --local-update --release-zip "$zip"
    else
      sh "$ROOT/UPDATER/launch.sh" --local-update
    fi
    status=$?
    ;;
  0)
    exit 0
    ;;
  *)
    printf '%s\n' '[오류] 잘못된 선택입니다.' >&2
    exit 2
    ;;
esac

printf '%s\n' ''
if [ "$status" -eq 0 ]; then
  printf '%s\n' '작업이 끝났습니다.'
else
  printf '%s\n' '작업을 완료하지 못했습니다.' >&2
  printf '%s\n' '자세한 내용은 UPDATER/logs/latest.log를 확인해 주세요.' >&2
fi
exit "$status"
