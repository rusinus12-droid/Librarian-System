#!/bin/sh
set -eu
# Container start. DATA lives in a volume. A container is reached through a port forward, so remote access
# stays on; the same PC and the local network connect without a key, only outside clients need it.
# With arguments it runs one launcher command instead, e.g. `set-remote-access --show`.
LIBRARIAN_HOME="${LIBRARIAN_HOME:-/librarian}"
PROGRAM_DIR="$LIBRARIAN_HOME/PROGRAM"
DATA_DIR="$LIBRARIAN_HOME/DATA"
launcher() { node --no-warnings "$PROGRAM_DIR/tools/platform_launcher.cjs" "$@" --data-dir "$DATA_DIR"; }
if [ "$#" -gt 0 ]; then
  launcher "$@"
  exit $?
fi
launcher prepare >/dev/null
if [ -f "$DATA_DIR/config/remote-access-key.txt" ]; then
  launcher set-remote-access --enable >/dev/null
  printf '%s\n' '[Librarian System] 외부 접속 켜짐. 이 PC와 내부 네트워크는 키 없이 연결됩니다. 바깥 접속용 접근 키 보기: docker compose run --rm librarian set-remote-access --show'
else
  # First start: the new key is printed once here (docker compose logs librarian).
  launcher set-remote-access --enable
fi
exec node --no-warnings "$PROGRAM_DIR/tools/platform_launcher.cjs" serve --data-dir "$DATA_DIR"
