#!/usr/bin/env sh
set -u

TOOL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PROGRAM_DIR=$(CDPATH= cd -- "$TOOL_DIR/.." && pwd -P)

NODE_EXE=''
for candidate in "$PROGRAM_DIR/_runtime/node" "$PROGRAM_DIR/_runtime"/node-* "$(command -v node 2>/dev/null || true)" "${PREFIX:-/usr}/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" --no-warnings "$PROGRAM_DIR/tools/check_node.cjs" >/dev/null 2>&1; then
    NODE_EXE=$candidate
    break
  fi
done

if [ -z "$NODE_EXE" ]; then
  printf '%s\n' '[Librarian System] Node.js 22.13.0 이상을 찾지 못했습니다.' >&2
  exit 22
fi

PASS=0
FAIL=0
# 시험 스위트(*_test.cjs, *.test.cjs)만 실행합니다. 나머지 tests/*.cjs는 인자가 필요한 보조 도구입니다.
for TEST_FILE in "$PROGRAM_DIR"/tests/*_test.cjs "$PROGRAM_DIR"/tests/*.test.cjs; do
  [ -f "$TEST_FILE" ] || continue
  TEST_NAME=$(basename -- "$TEST_FILE")
  if "$NODE_EXE" --no-warnings "$TEST_FILE"; then
    printf 'PASS %s\n' "$TEST_NAME"
    PASS=$((PASS + 1))
  else
    printf 'FAIL %s\n' "$TEST_NAME"
    FAIL=$((FAIL + 1))
  fi
done

printf 'SUMMARY pass=%s fail=%s total=%s\n' "$PASS" "$FAIL" "$((PASS + FAIL))"
[ "$FAIL" -eq 0 ]
