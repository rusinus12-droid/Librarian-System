# State 경로 정적 점검·패치 및 실측 준비

> 후속 정정: 사용자는 Micro를 정본 전 구간의 임시 기억으로 정의하며, 정본은 원문과 **모든 영역의 Micro 데이터**를 함께 분석해야 한다고 명확히 했다. 아래 표의 Micro 제한은 확정 State 직접 쓰기에만 해당한다. 후속 패치로 서사 제안도 Micro에 보존하고 해당 구간의 전체 검증된 Micro 기록을 정본 입력에 전달한다. 최신 설명과 검증은 `LIBRA_MICRO_CANONICAL_SYNTHESIS_20261106.md`를 참조한다.

## 범위와 기준

2026-11-06, `claude/libra-content-completeness-20261106`의 `2a9614d`와 작업 트리에 남아 있던 Micro 서사 허용 조건 변경을 이어받아 점검했다. 실제 모델·Ollama·RisuAI 호출은 하지 않았다. 테스트의 모델 응답은 모두 합성 응답이며, 서버 검사는 임시 폴더의 로컬 HTTP/SQLite를 사용한다. 실사용 `DATA`의 기억이나 설정은 수정하지 않았다.

이 문서의 준비 상태는 **다음 실측에서 추출 품질을 확인할 수 있도록 코드 경로와 관련 회귀를 점검한 상태**를 뜻한다. 실제 모델이 원문의 모든 정보를 빠짐없이 추출했다거나, Micro 단독으로 모든 서사 생명주기를 갱신한다는 뜻은 아니다.

## 현재 State 지원표

| 영역 / 필드 | 정본 | Micro | 읽기·표시 |
|---|---|---|---|
| 인물 appearance/background/personality/speech/habits/abilities | 범주별 누적 claim | 인용된 항목 추가 | 소개 |
| preferences/boundaries | 구조화 claim 및 확인 보조 호출 | 구조화 항목, 주체·대상·범위 검증 | 선호/경계 |
| locationRef/condition/emotion/goal | 직접 claim | 직접 State intent | 현재 상황 |
| knowledge/affiliations | 누적 claim | 지식·소속 항목 추가 | 지식/소속·사물 |
| 관계 state.value | 방향·차원별 claim | 방향·차원별 intent | 관계/관계 이정표 |
| 세계 description/sceneTime/condition | 직접 claim | 직접 intent | 세계 도감 |
| parentRef/containerRef/ownerRef/holderRef/managerRef | 형식별 참조 claim | 이름에서 검증된 참조로 변환 | 세계 및 인물 연결 |
| access | 사람·권한·상태 | 사람·권한·상태 | 세계 및 인물 연결 |
| rule.text/scopeRef/exceptions | 구조화 규칙 | 문자열 호환 + 구조화 규칙 지원 보완 | 규칙 적용 범위·조건부 예외 |
| narrative.locks/momentum | 구조 claim | 인용된 조건·현재 압력 | 서사 |
| narrative.summary | 열린 이야기에서 파생 | 기존 인용 기반 문장 경로 유지 | 서사 요약 |
| threads/closedThreads | 생명주기 검증 및 종결 보관 | 직접 쓰기 제한 | 남은/마무리된 이야기 |
| arcs/resolvedArcs/turningPoints/motifs | 검증된 사건 근거를 이용한 구조 claim | 직접 쓰기 제한 | 흐름·전환/반복 소재 |
| events | event claim에서 최근 사건 파생 | Micro 사실은 기록하되 이 배열 직접 쓰기 제한 | 사건 연대기 |
| primaryArcId | 활성 흐름에서 런타임 파생 | ID 직접 쓰기 제한 | 주요 흐름 |

Micro 직접 반영 항목은 인물 14개 + 세계 10개 + 관계 1개 + 서사 3개 = 28개다. `rule` 내부의 적용 범위와 예외까지 검사한다. 배경의 historical/flashback 정본 허용, 소속·사물의 역참조 계산, 감정의 현재 상황 표시 등 이전 작업의 동작은 유지한다.

**남아 있는 범위 제한:** Micro는 한 턴의 source-bound 사실을 저장·반영하는 경로다. 여러 턴의 해석과 이야기 생명주기를 기존 정본 경로 없이 직접 갱신하는 기능을 이번에 새로 구현하지 않았다. ‘정본과 Micro 각각이 모든 필드를 독립적으로 갱신’하는 요구까지 충족했다고 주장하지 않는다. 안전하게 이를 확장하려면 이전 근거의 현재성, lifecycle 후보, 종결·재개 및 정본과의 중복 해소 계약이 추가로 필요하다.

## 이번에 수정한 코드

1. **Micro 승인과 자동 검토의 제한 통일.** `microStateFieldAdmissionReason`을 공통으로 사용한다. 승인 단계가 보류한 motifs/closedThreads 등을 자동 검토가 `automatic_review`로 다시 적용하는 실제 우회를 필드 행렬 검사에서 발견했다. 검토 목록과 실제 적용 양쪽에서 차단한다. summary/locks/momentum의 기존 경로는 유지한다.
2. **형식 검사 실패 시 원래 값 적용 금지.** 자동 검토가 `microStateValueForField` 실패를 무시하고 원래 값을 사용하던 처리를 제거했다. 서사 값도 같은 값 형식 검사를 거친다. 원문에 없는 규칙 예외·경계 대상을 넣으려는 제안은 자동 검토로 복구되지 않는다.
3. **Micro 구조화 규칙.** `{text,scopeName,exceptions:[{locationName,condition,effect}]}`를 정본의 `{text,scopeRef,exceptions:[{locationRef,condition,effect}]}`로 변환한다. 각 문자열·이름의 원문 근거, 장소 종류, 미확인 참조, 추가 키 및 배열 크기를 검사한다. 기존 문자열 규칙도 호환한다.
4. **새 참조의 종류·이름 보존.** 새 소속 조직은 organization, 규칙의 적용·예외 장소는 location으로 생성한다. 소속·경계·접근·규칙 내부의 승인된 참조도 읽기 모델에 이름을 보존한다. 본문만 승인되고 화면에 ID만 남는 일을 막는다.
5. **중첩 참조의 정본 식별자 연결.** Micro가 만든 항목이 이후 정본 항목과 같은 정체성으로 연결될 때 배열/객체 내부의 `*Ref`도 기존 정본 ID로 바꾼다. text 같은 서술은 바꾸지 않는다. 이후 턴 및 겹침 경로가 같은 변환을 사용한다.
6. **대상·범위·종류 검사.** 인용에 없는 경계 대상/행위/시점, 조직이 아닌 소속 대상, 장소를 소유 주체로 취급하는 참조 등을 허용하지 않는다. parentRef의 새 대상 행은 장소 종류로 생성한다.
7. **생성 프롬프트 정렬.** Micro prompt에 summary의 인용 기반 경로와 규칙 적용 범위·예외의 구조를 명시했다. 단순 규칙 문자열만 요구하던 계약을 보완했다. 실제 모델을 호출해 품질을 확인하지는 않았다.

## 외부 작업자가 남긴 실패 처리

| 검사 | 처리 |
|---|---|
| libra_micro_state_field_coverage_test | 옛 소스 정규식 대신 공통 승인 조건의 동작 검사. 규칙 예외·경계 범위·참조 종류의 양성/음성 사례 추가 |
| libra_book_v516_lifecycle_runtime_test | 실제 함수 추출에 worldManagerDomainReasonLabel 포함. 내부 코드는 별도 보존하고 화면 문장은 읽기 쉬운지 검사 |
| libra_narrative_almanac_model_test | 유지 조건이 흐름·전환에 한 번 표시되는 제품 동작에 맞춰 검사. 다른 서사 항목 3개와 유지 조건 2개를 따로 확인 |
| libra_micro_state_reader_gui_runtime_test | 기존 build-support의 jsdom을 NODE_PATH로 지정하면 통과 |
| libra_micro_inherited_t5_overlap_3mode_test | 저장소 내부 임시 폴더를 TEMP/TMP로 지정하면 통과 |
| libra_q04_reopen_budget_test | 단독 및 이번 제한된 병렬 검사에서 통과. 고부하 전체 실행의 불안정성이 해결됐다고 주장하지 않음 |

## 로컬 검증

최종 관련 테스트 **22개 스크립트가 모두 통과**했다. 전체 LIBRA 테스트 수백 개를 다시 실행한 결과는 아니다. 목록과 결과는 `.development/static-validation-temp/*.final.json`에 보관한다. 새 `libra_micro_state_field_matrix_3mode_test.cjs`는 실제 플러그인의 분석·저장·승인·자동 검토·읽기를 격리된 세 저장 모드에서 실행한다.

- 28개 State 필드의 근거와 최종 값, 신규 조직·접근 인물·규칙 예외 장소의 이름/종류를 확인한다.
- 구조·ID 직접 쓰기와 원문에 없는 규칙 예외·경계 대상 등 10개 제안이 반영되지 않는지 확인한다. 일부 필드는 producer 단계에서 거부되며, 나머지는 승인/검토 단계에서 보류된다.
- 응답 읽기가 영속 정본 Head를 다시 쓰지 않는지 확인한다.
- 기존 20개 콘텐츠 검사로 소개·장소 설명·서사 구조·종결·재생·재시작·화면 읽기까지 확인한다.
- profile/claim admission, 정상·실패 인용, 정본 JSON 재시도, 재분석 대기, Micro 상속·충돌·저장 모드, 이야기 재개·상속, GUI 수명주기 등 관련 검사를 함께 실행한다.
- `node --check` 및 `git diff --check`를 수행한다.

추가 조사에서 아래 3개 검사는 패치 전 커밋 `2a9614d`의 플러그인 사본에서도 통과하지 않았다. 전체 검사 통과로 보고하지 않는다.

| 검사 | 작업 트리 결과 | 패치 전 사본 결과 |
|---|---|---|
| libra_micro_multi_predecessor_state_3mode_test | completenessVersion 6을 5로 기대하여 실패 | 동일 assertion 실패 |
| libra_micro_inherited_t5_conflict_3mode_test | conflicting T5 Micro 대기 시간 초과 | 같은 대기 시간 초과 |
| libra_micro_state_frontier_3mode_test | 폐기된 resumeNeverStartedMicro 경로 호출로 실패 | 더 앞의 durable T6 receipt 대기 시간 초과. 동일 실패 지점 재현은 아님 |

baseline 사본 실행은 git show로 내보낸 파일을 LIBRA_TEST_PLUGIN에 지정했다. 코드 체크아웃이나 브랜치 전환은 하지 않았다. 위 세 검사에 맞추어 제품의 구형 API를 복원하거나 보존 검사를 완화하지 않았다.

재실행 환경:

```powershell
$env:NODE_PATH = (Resolve-Path PROGRAM/build-support/node_modules).Path
$env:TEMP = (Resolve-Path .development/static-validation-temp).Path
$env:TMP = $env:TEMP
node PROGRAM/tests/libra_micro_state_field_matrix_3mode_test.cjs
```

## 다음 실측 단계 — 아직 실행하지 않음

1. 합성 검증과 별도로 `RUN_MICRO=1` 모드로 Micro→정본→재생→화면을 측정한다. 측정 도구·엔드포인트·호출 제한을 확인하고 시작한다.
2. 원문에서 추출 가능한 항목과 근거가 없는 항목의 목록을 기준으로, 생성 누락 / 인용·형식 탈락 / 승인 보류 / 저장·읽기 누락을 구분한다. 모든 빈칸을 채우도록 추측을 유도하지 않는다.
3. 인물 14개 필드, 규칙의 적용 범위·예외 및 새 참조 이름, locks/momentum/summary, 정본의 흐름·소재·종결을 각각 확인한다.
4. 추가 모델 호출 수·비용·시간, 같은 source의 재처리, 정본이 Micro를 흡수한 뒤 중복 여부를 기록한다.
5. 실제 RisuAI UI 설치·동작 검증과 통제된 VM에서 실제 모델을 호출하는 검증을 별개로 보고한다.

이 문서 작성 작업에서 실측을 자동 시작하지 않는다. 변경은 현재 작업 트리에 두며, 커밋·푸시·설치 배포는 수행하지 않는다.
