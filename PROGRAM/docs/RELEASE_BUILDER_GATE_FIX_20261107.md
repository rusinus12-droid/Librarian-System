# Release Builder Gate 실패 수정

대상: PR의 `84c3c27`과 main을 합친 검사 커밋 `32735d3`. 제공된 로그의 release smoke는 1,035개 중 1,033개 통과·2개 실패다.

## 원인과 수정

1. `distribution_runtime_dependency_closure_test`가 ZIP에서 읽은 서버의 `createMemorySuiteServer`를 `undefined`로 받았다. 병렬 실행되는 `distribution_builder_test`는 실제 소스 저장소의 버전 트랜잭션을 복원했고, `restoreVersionTransactionFiles`는 변경 없는 서버·플러그인 파일도 `writeFileSync`로 다시 썼다. 쓰기 중 잘린 파일을 다른 검사의 ZIP 복사가 읽을 수 있었다. 검사 종료 후 원래 바이트가 복원되므로 최종 해시 비교만으로 이 중간 경쟁은 잡히지 않는다.
   - 변경 없는 파일은 쓰기·chmod를 생략하도록 수정했다.
   - 변경·롤백·실패 경로 검사는 전체 소스 allowlist로 만든 임시 저장소에서 실행한다. 실제 저장소의 manifest·서버를 테스트 중 수정하지 않는다.
   - ZIP 서버 바이트가 시작 시 캡처한 실제 소스와 일치하는지도 검사한다. 함수 export와 누락·전이 의존성 검사는 유지한다.
   - 결정적 제어 실험: 기존 복원 함수의 무변경 쓰기 순간을 복사하면 0바이트 CJS와 `undefined` export가 재현됐다. 수정 함수는 무변경 쓰기 없이 원래 서버 함수 export를 유지했다. 실제 CI 순간의 ZIP 바이트를 확보한 것은 아니며, 로그와 일치하는 경쟁 경로를 제어 실험으로 확인한 것이다.
2. `plugin_version_byte_provenance_test`는 `current_row_mismatch: libra`로 실패했다. LIBRA 본체가 바뀌었지만 Source 출처 기록은 이전 6,959,313바이트·이전 해시였다. 제공된 `plugin_version_provenance.cjs --write --backup`으로 미발행 Source 후보의 현재 LIBRA 행을 갱신했다. 현재 값은 7,083,943바이트, SHA-256 `d8cb1b47590cf1b4776d4dfe3df71a9e36018ad210821bcbd20510f9b588da9b`다.
   - 게시된 과거 기록과 충돌 이력은 변경하지 않았다. 현재 행은 미발행 Source 후보이며, 공식 생성기가 역사적 버전 충돌이 없다고 판단하므로 LIBRA `2.6.36`과 패키지 `0.5.0`은 유지한다. 이 갱신은 새 릴리즈 게시를 뜻하지 않는다.

## 검증

- 무변경 복원에 쓰기·chmod가 없다는 새 회귀 검사는 수정 전 실패, 수정 후 통과했다.
- Node의 `--test-concurrency=4`로 distribution builder·실제 ZIP 의존성·메타데이터 일관성·플러그인 바이트 출처·출처 계약/생성기·릴리즈 메타데이터·버전 입력·체크섬 검사 9개 파일이 모두 통과했다.
- 새 ZIP 해시 검사와 기존 함수 export·의존성 누락 음성 사례는 그대로 실행했다. 오류 경로 검사는 단순히 아무 예외나 받는 대신 실제 차단 출력 경로의 `EEXIST`/`ENOTDIR`까지 확인한다.
- Source manifest와 체크섬을 갱신한 뒤 스테이징·커밋 바이트를 다시 확인한다. `.development/`와 사용자 DATA는 커밋·업로드 대상에서 제외한다.
- 갱신 검증에서 `.gitignore`의 생성 자료 폴더가 체크섬에 포함되는 추가 경로를 발견했다. Source 패키지·manifest·체크섬에서 `evidence`·`checkpoints`·`backups` 생성 자료를 제외한다. 분배용 DATA 아래의 백업 DB는 제외로 숨기지 않고 계속 검사해 거부하며, 이 음성 사례도 재검사해 통과했다. 커밋 대상이 아닌 파일이 체크섬에 하나라도 있으면 스테이징을 중단하는 읽기 검증을 수행했다.
- 푸시 후 Linux/Node 22의 실제 GitHub Actions 결과를 확인한다. 로컬 Node 24에서의 집중 검사 통과만으로 원격 전체 게이트 통과를 주장하지 않는다.
