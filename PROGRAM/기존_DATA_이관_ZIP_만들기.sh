#!/usr/bin/env sh
set -eu
PROGRAM_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
NODE_EXE=''
for candidate in "${NODE_BIN:-}" "$PROGRAM_DIR/_runtime/node" "$PROGRAM_DIR/_runtime"/node-* "$(command -v node 2>/dev/null || true)" "${PREFIX:-/usr}/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" --no-warnings "$PROGRAM_DIR/tools/check_node.cjs" >/dev/null 2>&1; then
    NODE_EXE=$candidate
    break
  fi
done
if [ -z "$NODE_EXE" ]; then
  printf '%s\n' '[Librarian System] Node.js 22.13.0 이상을 찾지 못했습니다.' >&2
  exit 22
fi
if [ "$#" -gt 0 ]; then
  exec "$NODE_EXE" --no-warnings "$PROGRAM_DIR/tools/portable_export_stopped.cjs" "$@"
fi
printf '기존 DATA 폴더 전체 경로: '
IFS= read -r OLD_DATA || exit 2
OLD_DATA=$(printf '%s' "$OLD_DATA" | sed "s/^['\"]//;s/['\"]$//")
if [ -z "$OLD_DATA" ]; then
  printf '%s\n' '경로를 입력하지 않아 종료합니다.' >&2
  exit 2
fi
printf '저장할 이관 ZIP 전체 경로: '
IFS= read -r OUT_ZIP || exit 2
OUT_ZIP=$(printf '%s' "$OUT_ZIP" | sed "s/^['\"]//;s/['\"]$//")
if [ -z "$OUT_ZIP" ]; then
  printf '%s\n' '경로를 입력하지 않아 종료합니다.' >&2
  exit 2
fi
exec "$NODE_EXE" --no-warnings "$PROGRAM_DIR/tools/portable_export_stopped.cjs" --source-data-dir "$OLD_DATA" --output "$OUT_ZIP"
