#!/usr/bin/env sh
set -eu
PROGRAM_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if ! command -v pkg >/dev/null 2>&1; then
  printf '%s\n' 'Termux에서 실행하세요.' >&2
  exit 2
fi
if [ ! -r "$HOME/storage/downloads" ]; then
  printf '%s\n' '다운로드 폴더 접근 권한이 필요합니다. Android 권한 창에서 허용하세요.'
  termux-setup-storage
  printf '%s\n' '권한을 허용한 뒤 Enter를 누르세요.'
  read -r unused
fi
pkg install -y python nodejs
node --no-warnings "$PROGRAM_DIR/tools/check_node.cjs"
if [ "$#" -ge 1 ]; then
  ARCHIVE=$1
else
  printf '%s\n' '다운로드한 배포 ZIP을 선택하세요.'
  ARCHIVE=$(python -c '
import pathlib,sys
rows=sorted((pathlib.Path.home()/"storage/downloads").glob("*.zip"))
for i,p in enumerate(rows,1): print(str(i)+") "+p.name,file=sys.stderr)
if not rows: sys.exit("ZIP을 찾지 못했습니다. 다운로드 폴더와 접근 권한을 확인하세요.")
print("번호: ",file=sys.stderr,end="",flush=True)
try: n=int(input()); assert 1<=n<=len(rows)
except (ValueError,AssertionError,EOFError): sys.exit("올바른 번호를 입력하세요.")
print(rows[n-1])')
fi
python "$PROGRAM_DIR/tools/termux_install.py" "$ARCHIVE" --destination "${2:-$HOME/librarian-system}"
printf '%s\n' '설치는 완료됐습니다. 표시된 실행 명령으로 서버를 시작하세요.'
printf '%s\n' '이전에 설치한 DATA가 있다면 서버를 종료한 뒤 별도로 이전하세요. 자동으로 덮어쓰지 않습니다.'
