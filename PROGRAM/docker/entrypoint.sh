#!/bin/sh
set -eu
# Container start. DATA lives in a volume. The container counts as a separate device: remote access mode
# is fixed and every plugin, on this PC too, connects with the access key. compose.yaml publishes the port
# on this PC's 127.0.0.1 only; other devices come in through Tailscale or Cloudflare Tunnel.
# With arguments it runs one launcher command instead, e.g. `set-remote-access --show`.
LIBRARIAN_HOME="${LIBRARIAN_HOME:-/librarian}"
PROGRAM_DIR="$LIBRARIAN_HOME/PROGRAM"
DATA_DIR="$LIBRARIAN_HOME/DATA"
export LIBRARIAN_CONTAINER=1
launcher() { node --no-warnings "$PROGRAM_DIR/tools/platform_launcher.cjs" "$@" --data-dir "$DATA_DIR"; }
if [ "$#" -gt 0 ]; then
  launcher "$@"
  exit $?
fi
launcher prepare >/dev/null
if [ -f "$DATA_DIR/config/remote-access-key.txt" ]; then
  launcher set-remote-access --remote >/dev/null
  printf '%s\n' '[Librarian System] 원격 접속 모드(컨테이너 고정). 같은 PC의 플러그인도 접근 키가 필요합니다. 키 보기: docker compose -f PROGRAM/docker/compose.yaml run --rm librarian set-remote-access --show'
else
  # First start: the new key is printed once here (docker compose -f PROGRAM/docker/compose.yaml logs librarian).
  launcher set-remote-access --remote
fi
exec node --no-warnings "$PROGRAM_DIR/tools/platform_launcher.cjs" serve --data-dir "$DATA_DIR"
