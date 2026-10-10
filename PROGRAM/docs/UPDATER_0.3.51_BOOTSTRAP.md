# 0.3.51 → 0.3.52 updater 1회성 승격

0.3.52부터 `migration_required` 업데이트는 `DATA.next` 논리 이관과 PROGRAM/DATA pair switch를 사용한다. 0.3.51에 포함된 구 updater는 이 정책의 실제 apply를 구현하지 않았으므로, **0.3.51에서 0.3.52로 올라가는 첫 한 번만 0.3.52 Release 안의 새 updater를 실행한다.** 성공 후 새 updater가 기존 설치의 `UPDATER` 정적 코드를 갱신하므로 이후 버전은 기존 설치의 updater를 사용한다.

## 준비

1. 기존 Librarian System 설치 폴더와 `DATA`를 삭제하거나 덮어쓰지 않는다.
2. 공식 `Librarian-System-0.3.52.zip`을 별도 폴더에 내려받고 압축을 푼다.
3. 아래 명령의 `<기존설치>`는 현재 사용 중인 0.3.51의 `PROGRAM`, `DATA`, `UPDATER`가 있는 최상위 폴더를 가리킨다.
4. `<ZIP>`은 검증할 공식 `Librarian-System-0.3.52.zip` 자체를 가리킨다.
5. 새 Release 쪽에 Node가 없어도 기존 설치의 `UPDATER/_runtime` 또는 `PROGRAM/_runtime` portable Node를 탐색한다. PROGRAM 안 Node를 사용할 때는 PROGRAM 교체 전에 기존 설치의 `UPDATER/_runtime`으로 검증 복사해 파일 잠금을 피한다.

## Windows

압축을 푼 0.3.52 폴더에서:

```bat
업데이트.bat --target-root "<기존설치>" --release-zip "<ZIP>" --apply --install-updater
```

## macOS / Linux / Termux

압축을 푼 0.3.52 폴더에서:

```sh
./업데이트.sh --target-root "<기존설치>" --release-zip "<ZIP>" --apply --install-updater
```

macOS에서는 같은 인자를 `업데이트.command`에 전달해도 된다.

## 수행되는 작업

- Release ZIP 외부 SHA-256과 내부 `SHA256SUMS.txt`/manifest를 검증한다.
- 기존 서버가 실행 중이면 먼저 안전하게 종료한다.
- 0.3.52 candidate PROGRAM의 read-only exporter가 기존 0.3.51 DATA를 논리 migration ZIP으로 읽는다.
- 빈 Release DATA template 위에 `DATA.next`를 재구성하고 runtime token, signing key, host/port를 승계한다.
- 기존 PROGRAM/DATA를 rollback 쌍으로 보존한 뒤 새 PROGRAM/DATA를 함께 활성화한다.
- 후보 서버의 version, dataInstanceId, integrity를 검증한 뒤 commit한다.
- commit 성공 후에만 기존 설치의 `UPDATER` 정적 코드를 0.3.52 updater로 승격한다. `update-state.json`, 실제 로그, operation-lock DB, `_runtime` 캐시는 보존한다.

## 실패 시

commit 전 실패하면 PROGRAM과 DATA를 모두 이전 0.3.51 쌍으로 복원한다. updater 승격은 성공한 업데이트 뒤에만 실행되므로, 마이그레이션이 실패한 경우 기존 updater도 그대로 남는다. 같은 공식 ZIP과 같은 명령으로 다시 시도할 수 있다.

새 Release의 빈 `DATA`를 기존 DATA 위에 수동 복사하지 않는다.
