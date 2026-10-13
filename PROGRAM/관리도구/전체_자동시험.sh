#!/usr/bin/env sh
set -u

TOOL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PROGRAM_DIR=$(CDPATH= cd -- "$TOOL_DIR/.." && pwd -P)

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '[Librarian System] Node.js를 찾지 못했습니다.' >&2
  exit 22
fi

node --no-warnings "$PROGRAM_DIR/tools/check_node.cjs" || exit $?

PASS=0
FAIL=0
# 시험 스위트(*_test.cjs, *.test.cjs)만 실행합니다. 나머지 tests/*.cjs는 인자가 필요한 보조 도구입니다.
for TEST_FILE in "$PROGRAM_DIR"/tests/*_test.cjs "$PROGRAM_DIR"/tests/*.test.cjs; do
  [ -f "$TEST_FILE" ] || continue
  TEST_NAME=$(basename -- "$TEST_FILE")
  if node --no-warnings "$TEST_FILE"; then
    printf 'PASS %s\n' "$TEST_NAME"
    PASS=$((PASS + 1))
  else
    printf 'FAIL %s\n' "$TEST_NAME"
    FAIL=$((FAIL + 1))
  fi
done

printf 'SUMMARY pass=%s fail=%s total=%s\n' "$PASS" "$FAIL" "$((PASS + FAIL))"
[ "$FAIL" -eq 0 ]
