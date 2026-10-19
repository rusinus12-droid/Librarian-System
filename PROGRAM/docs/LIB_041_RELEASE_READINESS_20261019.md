# LIB 0.4.1 배포 가능 여부 — 2026-10-19 재검증

판정: **제한된 개발판 시험 배포 후보로 사용할 수 있다. 일반 사용자 대상 정식 배포 승인은 보류한다.**

현재 후보에서 재현된 새 제품 결함은 없다. 다만 실제 RisuAI 설치 환경의 IPC·설정·입출력 연결, 실 Voyage 임베딩 검색 품질, 누적 데이터가 있는 기존 배포본의 업데이트를 확인하지 못했다. 전체 회귀 검사도 이번 실행 범위에 포함하지 않았다. 빌더 성공만으로 이 항목까지 통과했다고 판단하지 않는다.

이전 감사·검증 문서를 근거로 사용하지 않고 현재 코드, 새로 만든 ZIP, 이번 실행 관측으로 판단했다. GitHub Release와 태그는 생성하지 않았다.

## 검사한 바이트와 환경

| 항목 | 값 |
| --- | --- |
| 제품 코드 기준 | main `f021ba78ffa457fa4c085f2cbc4615a225187855` — 원격 main과 일치 확인 |
| 패키지 | 0.4.1, `release` 프로필, Min 플러그인 6종 |
| ZIP SHA-256 | `655c095c31a69f38f3330db2cf08387f50d923644d2d8eb18780569db994f535` |
| ZIP 크기 / 항목 수 | 3,675,297 bytes / 152 files |
| LIBRA Full SHA-256 | `e5c94287f7eb6c4f5e22d4496b5a45e9b8d054fcbce9a6f8593f129127a390a7` |
| ZIP의 LIBRA Min SHA-256 | `603daa602bb177ed786653d054df1137375e07d443718f1a87de31dcf5c3056b` |
| 실행 환경 | Linux VM, Node 24.19.0, 시스템 Chromium |
| Node 런타임 포함 | 미포함. 사용자가 Node 22.13 이상을 설치해야 함. 이번 실제 실행은 24.19.0에서 수행 |
| 플러그인 버전 | LIBRA 2.3.174 / HAYAKU 3.0.155 / Flashback 1.0.120 / LIA 0.26.88 / RETRACE 1.9.86 / GRADIA 0.25.91 |

## 새로 실행한 검사

| 경로 | 결과와 관측 범위 |
| --- | --- |
| 정식 배포 빌더 | release smoke 91개 파일, **463 tests passed, 0 failed, 0 skipped**. 빌더의 `publicationSmokePassed`, `updaterEligible`, `sourceUnchangedVerified`가 true |
| ZIP 독립 검사 | 필수 파일·체크섬·Unix 실행 권한·파일 이름·정적 DATA만 포함하는지 검사 통과. 소스 DATA를 복사하지 않음 |
| 런타임 의존성 | 추출한 ZIP에서 NODE_PATH를 비운 상태로 로컬 의존성 75 files / 158 requires / 164 builtin requires 검사 통과. 저장소 소스로의 fallback 없음 |
| 설치 서버 | 추출한 PROGRAM의 실제 launcher로 백그라운드 시작·상태 조회·종료·재시작 성공 |
| 저장과 접근 권한 | 실제 HTTP KV CAS 쓰기와 재시작 후 동일 값 읽기 성공. 인증 없는 읽기와 다른 owner 읽기 모두 403, 데이터 미반환 |
| 관리 기능 | 추출한 admin의 실제 SQLite 백업 생성과 무결성 검사 성공 |
| 업데이트 후보 준비 | 실제 updater로 ZIP 체크섬·manifest와 151개 파일 staging 검증. 이 항목은 **동일 버전 후보 준비**이며 기존 버전 데이터 이관 성공을 의미하지 않음 |
| Min 6종 시작 | ZIP에서 추출한 6종을 API 호스트 fixture에서 실행. 헤더·공개 API·저장 경계 검사 통과, 시작 시 모델 호출 0 |
| Micro 최종 상태 GUI | ZIP의 LIBRA Min으로 미등록 장소 보류, 같은 턴 충돌 보류, 새 정본 흡수·대체, 진단 행 한도 이후의 개별 판정 표시 검사 통과. 조회가 쓰기·모델 호출을 만들지 않음 |
| Micro 벡터 회귀 | 현재 Full 런타임과 통제된 1,024차원 벡터 30개로 2개 suite 통과. 전체 30개에서 정확 top-8을 선별하고 마지막 정답을 실제 RAG 패킷으로 전달. 4회 모두 정답 포함, 첫 조회 1,903ms, 반복 1,929/1,903/1,887ms. query embedding은 첫 조회 1회·반복 0회. 실임베딩 품질 또는 Claude 실모델 비교 결과가 아님 |
| RETRACE 대화상자 | ZIP의 Min RETRACE/HAYAKU로 실제 DOM callback 검사 **5 passed**. 재열기·닫기·Escape·Cancel·단일 확인·unload의 동의 수명 확인 |
| 기기 로컬 파생 인덱스 | native Chromium IndexedDB에서 두 탭의 reader 보호, 거래 중단 rollback, browser process 재시작 보존 확인. reader 해제 후 10개 키 회수, 6회 재구축 후 인벤토리 20개로 유지. 이 검사는 로컬 저장 모듈 경계이며 전체 플러그인의 대규모 실사용을 대신하지 않음 |

## 실모델 기억 작성과 GUI

실제 외부 HTTP 요청은 Ollama의 `deepseek-v4.1-flash:cloud`를 사용했다. 입력은 저장소의 합성 5턴 대화와 추가 이동 1턴이다. 서비스 연결 probe 1회, 위임 호출 모의 경로의 실패 1회, 직접 연결 정본 1회, 직접 연결 Micro 1회로 **총 외부 요청 4회**였다. GUI 재현용 정본 응답 재사용은 외부 호출에 포함하지 않는다.

| 관측 | 결과 |
| --- | --- |
| Ollama 연결 probe | HTTP 200, 1,341ms, 정상 종료 |
| 정본 작성 | 제품의 `ollama_cloud` 직접 경로. HTTP 200, 11,321ms, 응답 8,076자, finish reason `stop`. 정본 1개·fact 20개 저장, job 실패 0 |
| 정본 내용 점검 | 장소 포함 관계·관리 조직, 정숙 규칙과 조건부 공연 예외, 소유자와 소지자 구분, 암호 수신자와 신뢰 방향, 반환 약속 해결과 미확인 공연 허가자 질문이 출력에 존재함을 확인. 단일 합성 사례의 내용 점검이며 독립적인 전체 의미 품질 평가가 아님 |
| Micro 작성 | 같은 정본 모델 응답으로 저장 상태를 재현한 뒤 T6의 외부 요청은 실제 수행. HTTP 200, 2,465ms, 응답 1,197자, finish reason `stop`. verified Micro 1개·claim 2개 생성 |
| 상태 반영 | 상태 결정 API verified, 상태 claim 1개 admitted / still_current. Head throughTurn 6, 민아의 실제 locationRef가 공연실 항목을 가리킴 |
| 자동 GUI 갱신 | Micro 화면을 열어 둔 채 완료 턴 capture listener를 호출. 수동 새로고침 없이 T6 본문과 최종 상태 승인 `ready` 표시 |
| 저장 후 다시 열기 | 실제 모델 응답으로 저장한 정본과 Micro 스냅샷을 ZIP의 변경 없는 Min 플러그인으로 Chromium에서 재개. 정본 본문·Micro 본문·상태 승인 표시 성공. 이 조회 중 모델·네트워크 호출 0, JS 오류 0 |
| 표시 영역과 닫기 | Chromium 폭 320·390·1440px에서 닫기 버튼이 화면 안에 있고 클릭 가능. 문서 가로 넘침 0, host hide 호출 확인 |

직접 연결에는 `reasoning_effort: none`을 사용했다. 정본 max_tokens 16,000, Micro max_tokens 4,096이었다. 추론 설정 없이 RisuAI `runLLMModel`을 모의한 외부 HTTP bridge에서는 74,705ms 후 finish reason `length`, 본문 0자로 끝났고 제품은 정본 저장을 거절했다. 이는 실제 RisuAI 설치본의 실행 결과가 아니다. 해당 호스트에서 Other Ax의 추론·출력 설정이 어떤 요청으로 전달되는지는 별도 확인이 필요하다.

첫 GUI 검사의 ‘목차 읽는 중’ timeout은 테스트가 첫 실행 연결 안내창을 닫지 않고 그 뒤의 메뉴를 클릭한 데서 발생했다. 실제 사용 순서대로 ‘나중에 하기’를 누른 뒤 재검사하자 정본과 본문이 표시됐다. 제품 결함으로 집계하지 않았다. 정본 실응답은 추가 과금 없이 GUI 재현에 재사용했다.

## 검색 품질과 연결의 한계

환경 네트워크 정책에 `api.voyageai.com`, `ollama.com`이 허용되어 있음을 확인했다. Ollama는 실제 인증 요청 성공으로 연결을 확인했다. Voyage의 `RAG_EVAL_EMBED_KEY`는 현재 비공개 설정에 없어 인증·임베딩 요청을 수행하지 않았다. 정책 허용만으로 Voyage의 실제 응답 성공을 단정하지 않는다.

따라서 **voyage-4-large 실임베딩의 정답 근거 전달률·콜드/반복 지연·자원 중단율 및 Claude 기준과의 실모델 동등성은 이번 검사에서 입증하지 못했다.** 기존 합성 벡터 성과를 실모델 정확도로 바꿔 보고하지 않는다. 벡터 선별, source/digest/revision 검증, 자원 예산을 약화하거나 끄지 않았다.

## 기존 배포본 업데이트 관측

GitHub API로 확인한 최신 공개 Release는 `0.3.71`이었다. 해당 ZIP을 실제 다운로드하고 공개 asset SHA-256 `02c056876a8d3a461abf9fe712856ce373a3b9252264083ef92434058cd6ee41`과 일치함을 확인했다.

변경하지 않은 0.3.71 배포 ZIP은 `PROGRAM/server/wm/store.cjs`의 `../../sdk/WmStorageContracts.source.js`가 누락되어 서버 시작에 실패했다. 따라서 기존 서버에 값을 저장한 뒤 업데이트하는 시나리오는 시작 단계에서 중단했다. **0.4.1 업데이트 실행 실패로 집계하지 않으며, 실제 누적 데이터 업데이트 성공으로도 집계하지 않는다.** 이번 0.4.1 후보의 의존성 검사와 독립 서버 실행은 별도로 통과했다.

0.4.1 manifest의 업데이트 정책은 `migration_required`, minimum source version은 `0.3.51`이다. release smoke의 이관·rollback·강제 종료 복구 검사는 통과했지만, 이를 실제 0.3.71 사용자 데이터 이관 결과로 대체하지 않는다.

## 일반 배포 전에 남은 확인

- 실제 RisuAI 설치본에서 ZIP Min 6종의 설치·업데이트·설정과 IPC, 출력 capture, Other Ax 요청·반환, 닫기/재열기를 확인해야 한다. 이번 JSDOM·Chromium 검사는 실제 RisuAI 애플리케이션이 아니다.
- Voyage 키가 있는 환경에서 실임베딩 검색과 지정 모델 비교를 수행해야 한다. 현재는 새 요청을 만들 수 있는 키가 없다.
- 누적 데이터가 있는 지원 대상 설치본으로 0.4.1 이관과 복원을 확인해야 한다. 공개 0.3.71 ZIP의 시작 실패와 구분해야 한다.
- 빌더는 `fullRegressionRunByBuilder: false`, `fullRegressionRequiredBeforePublication: true`로 보고한다. 현재 전체 CJS 인벤토리는 1,234개 파일이며, 이번에는 release smoke와 위에 명시한 추가 검사를 실행했다. 전체 회귀 통과로 보고하지 않는다.
- 실제 Windows/macOS/Android 설치, 모바일 WebView, 대규모 장기 데이터와 다중 실사용 클라이언트는 이번 VM에서 확인하지 않았다.

원본 모델 요청·응답, 스냅샷, GUI 캡처, 서버 DATA와 로그는 저장소 밖 `/tmp/lib-release-check-f021ba7-20261019/`의 비공개 경로에 보관했다. 평가 스냅샷은 공급자 설정 키를 포함할 수 있으므로 공유·커밋하지 않는다. 이 문서에는 비밀값을 포함하지 않았다.
