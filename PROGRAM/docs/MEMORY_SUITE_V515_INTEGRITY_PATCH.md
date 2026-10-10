# Memory Suite 0.3.18 · Book UX 5.15 무결성 패치

대상: 2026-09-05 V5.14 감수의 확정 결함 11개. 이 문서는 구현 범위이며, 실행 결과는 배포와 함께 제공되는 검증 보고서와 원본 로그를 기준으로 한다.

## 버전

| 구성 | 이전 | 이번 배포 |
|---|---|---|
| Librarian System | 0.3.17 | 0.3.18 |
| LIBRA | 2.3.24 / Book UX 5.14 | 2.3.25 / Book UX 5.15 |
| Flashback Memory | 1.0.25 | 1.0.26 |
| LIA | 0.26.61 | 0.26.62 |
| RE:TRACE | 1.9.65 | 1.9.66 |
| HAYAKU | 3.0.42 | 3.0.42 · 실행 소스 변경 없음 |

## 11개 수정 항목

| ID | 수정 |
|---|---|
| S-01 | `http.createServer` 앞단의 Reference-v2 우회 처리를 제거했다. 이전 모듈은 요청을 처리하지 않는 명시적 비활성 모듈이다. 파일 탐색·다른 namespace DB 읽기·별도 worker 기동을 수행하지 않는다. 순수 패킷 색인/검색 함수는 별도 순수 모듈로 보존했다. 정상 Storage/Compute router 및 SDK는 유지한다. |
| D-01 | 공식 `zip_writer.cjs`를 사용하는 배포 빌더로 UTF-8 파일명 flag와 Unix 실행 권한을 기록한다. 최종 ZIP의 표준 추출 결과를 별도로 검증한다. |
| D-02 | 모든 실행 소스와 문서가 확정된 다음 program manifest → 전체 checksum → ZIP 순서로 재생성한다. |
| L-01 | 진단/작업 목록 읽기에 scope, 화면 epoch, 요청 serial을 적용했다. 오류에 대해 최대 60초까지 증가하는 재시도 대기와 명시적 새로고침을 적용한다. 자체 재시도 timer는 추가하지 않는다. 닫힌 화면과 이전 scope의 늦은 결과를 채택하지 않는다. 도메인별 부분 성공과 stale/error를 구분한다. |
| L-02 | State 재생 명령은 `ok === true`와 읽어온 Head의 scope/worldline/basis/turn 일치 후에만 완료로 표시한다. 이전 상태로 복원됐다는 실패 결과를 재구축 성공으로 바꾸지 않는다. |
| L-03 | Compute 카드가 SDK의 실제 `state`, `mode`, `inFlight`, `operationCount` 등을 표시한다. SDK가 제공하지 않는 server worker/queue는 0이 아니라 미조회다. |
| L-04 | 정본 영수증은 `run.commit.providerBudget ?? run.providerBudget`를 사용한다. 미측정, 추정, 측정된 0을 구별한다. |
| L-05 | rollback 턴 입력과 worldline 선택 시 해당 버튼 활성 상태를 즉시 갱신한다. 전체 화면 재렌더를 요구하지 않는다. 명시적 확인 및 scope 경계를 유지한다. |
| F-01 | Flashback의 관측 revision과 저장 완료를 구분했다. 동일 본문이라도 이전 저장이 실패/미확정이면 다시 저장한다. 완료 중복 제거는 기존 저장 경로가 성공을 확인한 revision에만 적용한다. 요청 decision/monitor 종료도 저장 성공 뒤로 옮겼다. |
| A-01 | LIA의 Persona 생성/갱신에서 명시적 저장 거절을 검사하고, 재조회한 name/personaPrompt를 의도한 값과 비교한다. void 반환 자체를 실패로 취급하지 않는다. ID 존재만으로 성공 로그를 남기지 않는다. |
| R-01 | RE:TRACE가 저장 직전에 최신 Character를 다시 읽어 새 target chat만 추가한다. 준비 중 수정된 sibling/Character 정보를 보존하고, source 변경과 추가 prewrite 경합은 중단한다. 저장 후 채팅 내용을 재조회하며, 불일치 시 오래된 전체 객체로 rollback하지 않는다. |

## 추가로 연결한 보호

실행 영수증 페이지/상세에도 실패 후 명시적 재시도와 scope/epoch 검사를 적용했다. 다른 scope의 캐시를 그대로 보여주지 않으며, API 자체에도 expectedScopeKey를 전달한다. Canonical Job GUI의 이전/다음 페이지 버튼을 연결했다. **이 버튼은 화면 페이지 이동이며, backend의 모든 job JSON을 먼저 읽는 비용까지 해결한 저장소 인덱스 개선은 아니다.**

## 기존 계약

정본/패킷/벡터의 저장 schema, 원본 보존과 owner별 권위, 5턴 정본 규칙, 수동 cold start, 임베딩 모델 변경 뒤 명시적 벡터 재생성, Planner/GRADIA 보호 산출물 전달을 바꾸지 않는다. 추가 LLM 호출이나 제2 기억 DB를 만들지 않는다. Book UX의 독서면과 상세 작업대 구조를 유지한다. HAYAKU는 이번 확정 결함에 직접 해당하지 않아 실행 파일을 변경하지 않는다.

## 시험 해석

`suite_durable_commit_fault_test.cjs`, `suite_libra_operational_fault_test.cjs`는 배포 소스에서 실제 함수를 읽어 host/storage/DOM 경계에 오류를 주입한다. 실 RisuAI 시뮬레이터나 실제 설치 E2E가 아니다. `reference-compute-v2-http-integration.test.cjs`는 임시 DATA의 실제 HTTP/SQLite로 차단과 정상 인증 저장을 검사한다. 이전 Reference HTTP 시험의 무인증 200 허용 조건은 비활성 경로 거부 조건으로 변경했다. 순수 색인 시험은 유지한다. 기존 테스트의 버전 비교는 새 실행 버전과 동기화했다.

## 이번 배포가 완료했다고 주장하지 않는 항목

LIA의 host Persona DB와 pluginStorage 사이의 별도 2-store commit journal, 400턴 바깥의 Persona prefix 재검증, Canonical Job의 저장소 단계 metadata 인덱스, owner별 coverage/총 주입량 통합 화면은 확장 작업으로 남는다. RisuAI host에 원자적 CAS API가 없으므로 RE:TRACE는 관측한 동시 변경을 중단하고 readback 불일치를 보고하지만, 마지막 host RPC 안의 모든 외부 쓰기 경합을 원자적으로 차단한다고 주장하지 않는다. 5개 플러그인을 실제 사용자 RisuAI에서 장시간 돌린 시험과 실제 LLM 서비스 시험은 별도 확인이 필요하다.

## 기존 설치 업데이트

서버를 종료하고 기존 설치 및 RisuAI 데이터를 백업한다. 기존 `DATA`는 그대로 보존하고 배포본의 `PROGRAM`을 교체한다. 빈 배포용 `DATA`를 기존 데이터 위에 덮어쓰지 않는다. RisuAI에서는 같은 ID의 플러그인을 수정본으로 교체하며 중복 설치하지 않는다. HAYAKU는 3.0.42를 유지한다. 새 설치는 전체 ZIP을 새 폴더에 푼다. 서버 토큰/개인 데이터/DB는 배포본에 포함하지 않는다.
