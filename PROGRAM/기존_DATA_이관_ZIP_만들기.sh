#!/usr/bin/env sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
printf '기존 DATA 폴더 전체 경로: '
IFS= read -r OLD_DATA
printf '저장할 이관 ZIP 전체 경로: '
IFS= read -r OUT_ZIP
NODE_BIN=${NODE_BIN:-node}
"$NODE_BIN" --experimental-sqlite "$HERE/tools/portable_export_stopped.cjs" --source-data-dir "$OLD_DATA" --output "$OUT_ZIP"
