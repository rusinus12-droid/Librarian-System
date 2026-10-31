# GRADIA 기억 연결 진단 및 수정

2026-10-31 · GRADIA 0.28.8 / LIBRA 2.6.13

## 사용자 증거

- GRADIA 0.28.7 디버그: 4개 생성 단계는 실행됐지만 `externalEvidence:false`, `libReadStatus:unavailable`, `LIB_READ_CONNECTION_UNAVAILABLE`로 기억을 사용하지 않았다. 기억 조회 구간은 430ms였다.
- 추가 화면은 서버 모드가 적용된 상태였다. 화면의 연결 상태와 과거 실행의 읽기 상태는 같은 시점의 증거가 아니다.
- 추가 콘솔에서 `API method removePluginChannelListener not found`의 처리되지 않은 Promise 오류가 반복됐다.
- 기존 디버그에는 연결 상태와 원래 연결 오류가 빠져 있어 최초 실행의 연결 불가 원인을 하나로 확정할 수 없다. 로어 예산 초과나 thinking-only 재시도는 이 연결 불가 코드와 별개다.

## 수정

- LIBRA/GRADIA 공유 채널 transport의 optional listener 제거 API가 host proxy에서 거절되더라도 정리 Promise가 실패하지 않는다. 먼저 수행되는 영수증 폐기, 실행 해제, 취소는 유지한다. GRADIA의 비동기 bridge 정리에도 rejection 처리를 추가했다.
- 이미 진행 중인 명시적 연결/재연결 Promise를 기억 읽기 진입 시 기다린다. 새 연결을 중복 시작하거나 진행 중인 연결을 곧바로 미연결로 취급하지 않는다. 대기 상한과 기존 검증은 유지한다.
- 기억 연결 확인 버튼은 해당 설정 카드에 진행 상태, 완료 시각, 성공/실패와 오류 코드를 표시한다. 중복 확인은 합치며 성공 문구와 실제 기억 검색을 구분한다.
- 응답 실행의 일반 연결 불가 코드는 가능한 경우 원래 연결 실패 코드로 구체화한다. owner별 거절, 저장된 연결 설정 읽기 실패, 실행 시 연결 상태와 현재성 실패의 내부 코드를 진단에 보존한다. 기억 내용과 토큰은 추가하지 않는다.
- 새 연결 동의를 자동으로 만들거나 읽기 대상 owner를 임의 확대하지 않는다. 기존 저장 설정·스코프·reset·native 원문·현재성 검사를 유지한다.

## 검증과 제한

- `.test-output-gradia-final-contract.log`: 연결 GUI, SDK, owner 영수증, 다중 owner 연결, 결과 GUI 및 통합 읽기 계약에 대해 Node runner 67개 통과. 일부 계약 파일은 내부 assertion 묶음을 별도로 보고한다.
- `.test-output-gradia-regression-final.log`: 연결 진행 중 요청의 실제 근거 사용, 연결 오류 세부 정보 보존, 저장 설정 읽기 실패 표시 3개 통과. 연결 진행 중 요청 검증은 패치 전 GRADIA에서 실패했고 패치 후 통과했다.
- `.test-output-gradia-writer-focused.log`: 통제된 owner/model 응답을 사용하는 인풋 작성기 관련 검증 5개 통과. 근거가 실제 모델 요청에 들어가며 선택 결과를 복사하는 경로를 포함한다.
- `.test-output-gradia-plugin-final.log`: 실제 LIBRA 및 GRADIA 코드, upstream RisuAI 채널 함수로 plugin_only의 Micro와 비정본 렌즈 근거가 SHADOW/모든 AIDE 요청에 전달되는 검증 통과. 근거 변경 시 후속 전달 차단과 저장 불변성도 검사한다. RisuAI UI 및 모델 응답은 통제된 경계다.
- 실제 HTTP/임시 SQLite를 쓰는 서버 통합 검증은 샌드박스 loopback EACCES 이후 권한이 허용된 실행으로 재검사했으나 `LIB_READ_CURRENTNESS_LOST`로 실패했다. 진단 복사본에서는 내부 `LIB_READ_CANCELED`가 확인됐다. `.test-output-gradia-server-baseline.log`에서 패치 전 GRADIA도 동일하게 약 62초 후 현재성 검사에 실패했다. 이를 서버 모드 성공으로 계산하지 않는다.
- 별도의 기존 실패 3개(작성기 delivery 대기, malformed JSON 호출 수, 세 owner 중 HAYAKU capture 거절)는 패치 전 GRADIA에서도 같은 실패가 재현됐다. 테스트 기대값을 완화하지 않았다. 전체 회귀 통과나 모든 owner 조합의 성공을 주장하지 않는다.
- 사용자 설치 RisuAI 접근은 Computer Use에서 `Computer Use was not approved to use RisuAI`로 거부됐다. 사용자 채팅에서 실제 기억 사용/실제 제공자 생성 성공은 확인하지 못했다.

## 적용

`PROGRAM/plugins/GRADIA.js`와 `PROGRAM/plugins/LIBRA.js`를 함께 갱신하고 플러그인을 다시 로드한다. 자동 연결 동의가 없다면 관리 · 진단의 원하는 기억 읽기 모드에서 연결·적용을 누른다. 연결 확인 성공은 통신·스코프 검증이며, 다음 실제 실행의 기억 사용 성공과 동일하지 않다. 새 디버그의 `libReadConnection`, `lastLibReadDiagnostic.connection`, `causeCode`로 후속 실패 경계를 구분할 수 있다.

DATA는 수정하지 않았다. 기존 `DATA/data-layout.json` 변경은 작업 시작 전부터 존재했다. 원격 Git 작업, 커밋 및 설치 앱 교체는 수행하지 않았다.
