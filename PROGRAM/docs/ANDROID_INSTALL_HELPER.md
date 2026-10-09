# Android에서 처음 설치하기

1. 배포 ZIP을 Android의 다운로드 폴더에 저장합니다. 파일 앱에서 ZIP을 열고 압축을 풉니다. 압축을 푼 폴더 안의 `PROGRAM` 경로를 확인합니다.
2. Termux에서 `termux-setup-storage`를 실행하고 Android의 저장소 권한을 허용합니다.
3. 아래 명령의 `압축을_푼_폴더` 부분만 실제 폴더 이름으로 바꿉니다. 폴더가 한 단계 더 있으면 그 경로도 포함합니다. 따옴표는 그대로 둡니다.

```sh
sh "$HOME/storage/downloads/압축을_푼_폴더/PROGRAM/안드로이드_설치.sh"
```

4. 표시되는 ZIP 목록에서 원래 다운로드한 배포 ZIP의 번호를 입력합니다. 도우미가 Node.js와 Python을 설치하고 ZIP을 검증해 Termux 내부 `$HOME/librarian-system`에 설치합니다. 사용자가 패키지를 직접 이동할 필요는 없습니다.
5. 완료 후 아래 명령으로 실행합니다.

```sh
sh "$HOME/librarian-system/PROGRAM/1_서버_실행.sh"
```

종료는 `sh "$HOME/librarian-system/PROGRAM/2_서버_종료.sh"`입니다. 같은 Android에서 연결 주소는 `http://127.0.0.1:47630`입니다. PocketRisu 서버 경유 연결은 `DOCKER_POCKET_CONNECTION.md`를 확인하세요.

설치가 이미 존재하면 자동 덮어쓰기를 중단합니다. 이 도우미는 신규 설치용입니다. 기존 설치의 DATA를 수동으로 옮기거나 삭제하지 말고 기존 백업·복원 절차를 사용하세요. 기존 폴더에 프로그램만 갱신하는 자동 업데이트는 아직 지원하지 않습니다.

권한 거부는 Android 설정에서 Termux 권한을 허용한 뒤 같은 명령을 다시 실행하세요. 패키지 설치 실패는 인터넷 연결과 Termux 패키지 저장소 설정을 확인한 뒤 재시도하세요. 체크섬 불일치는 ZIP을 다시 내려받아 재시도하세요. ZIP 내부 체크섬은 파일 일관성을 검사하며 배포자의 신원을 인증하지는 않습니다.

장시간 운영 시 Android 설정에서 Termux의 배터리 최적화를 조정하고 필요하면 `termux-wake-lock`을 사용하세요. 설치 도우미가 이 설정을 자동으로 변경하지 않습니다. 실제 Android 기기에서의 설치 완료 검증은 별도입니다.
