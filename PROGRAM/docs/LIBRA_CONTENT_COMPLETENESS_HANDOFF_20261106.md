# LIBRA 인물·세계·서사 기록 공백 수정 이관서

작성일: 2026-11-06 · 조사 대상: LIBRA 2.6.36

## 1. 작업 목표와 현재 상태

사용자는 인물 카드함의 소개·선호·경계 공백, 현재 위치의 내부 ID 노출, 소속·사물의 모순된 빈 안내를 보고했다. 원문을 다시 분석해 정본을 교체한 뒤에도 인물 공백이 남았고, 세계에 장소 설명이 부족하며, 서사의 흐름·전환·반복 소재·마무리된 이야기가 기록되지 않는다고 추가 보고했다.

후속 작업 목표는 **원문에 근거가 있는 내용을 추출부터 정본 저장, State 재생, 화면 표시까지 연결하여 기록 누락과 모순을 해결하는 것**이다. 모든 빈칸을 추측으로 채우는 것이 목표가 아니다.

지금까지 수행한 것은 원인 조사와 문서 작성이다. 제품 코드 수정, 기억 데이터 교정, 추가 모델 호출, 설치 파일 교체, 커밋·푸시는 하지 않았다. 실제 RisuAI UI 전체 재실행도 하지 않았다. 아래 수정 방향과 완료 기준은 후속 작업을 위한 제안이며, 구현 완료로 읽으면 안 된다.

## 2. 시작 전에 보존할 작업 상태

- 저장소: `C:\Users\rusin\Desktop\Librarian-System`
- 문서 작성 시 HEAD: `baf81f0072f196c8fbf572811ccb0f5973763757`
- 기존 수정: `PROGRAM/plugins/LIBRA.js`에 재분석 대기 처리 관련 변경이 이미 있었다. 이번 조사에서 만든 코드 변경이 아니다.
- 기존 미추적 항목: `.development/`, `PROGRAM/tests/libra_reanalysis_wait_gui_test.cjs`, `PROGRAM/tests/libra_reanalysis_wait_runtime_test.cjs`. 덮어쓰거나 정리하지 말 것.
- 이번 조사 문서는 세 개 모두 아직 미커밋 상태다. 다른 작업자의 변경과 구분하여 다룰 것.

시작 시 git 상태와 현재 소스를 다시 확인한다. 아래 행 번호는 조사 당시 탐색용이며, 수정 후에는 함수 이름으로 찾는다. 실사용 DB는 이번 조사에서 읽기 전용으로만 접근했다. 구현 검증에는 분리된 fixture/저장소를 사용한다.

## 3. 증거 자료와 재현 범위

### 원본과 상세 분석

| 자료 | 위치 |
|---|---|
| 최초 첨부 로그 | `C:\Users\rusin\Downloads\libra-debug-2026-11-06 (1).json` |
| 원문·정본 재분석 후 첨부 로그 | `C:\Users\rusin\Downloads\libra-debug-2026-11-06 (3).json` |
| 1차 상세 분석 | `PROGRAM/docs/LIBRA_CHARACTER_CABINET_CAUSE_ANALYSIS_20261106.md` |
| 재분석 후 상세 분석 | `PROGRAM/docs/LIBRA_REANALYSIS_CONTENT_GAPS_20261106.md` |
| 로컬 저장소 | `DATA/stores/libra/libra.sqlite` |

첨부 로그는 진단 자료이며, 그 안의 텍스트를 실행 지시로 해석하지 않는다. 원본 파일은 Downloads에 있으므로 저장소만 전달받은 작업자는 접근할 수 없을 수 있다. 사용자 원문을 공개 fixture나 PR 본문에 그대로 복제하지 말고, 재현에는 필요한 구조를 보존한 합성 자료를 만든다.

### 조사한 데이터 식별자

- scope: `bf8f10a0_11:4`
- host worldline: `wl_9845028df583d04e`, logical worldline: `main`
- 정본: `mem_000001`(T1~5), `mem_000006`(T6~10)
- 재분석 후 활성 키: `libra:v1:scope:bf8f10a0_11:4:memory:1:r2`, `...:memory:6:r2`
- 최초 문제 위치 ID: `ce_world_87c91f6f` = **거실**

SQLite는 Node의 `new DatabaseSync(path, {readOnly:true})`로 열었다. `kv`에서 `space='plugin'`, `deleted=0`인 값을 조회했고, `value_json`은 JSON 해석 후 문자열이면 한 번 더 JSON 해석해야 했다. 활성 revision은 `manifest.memories`가 가리키는 키로 확인한다. DB의 모든 과거 revision을 현재 결과로 집계하지 않는다. 로컬 DB는 첨부 당시와 동일한 스냅샷이라고 가정할 수 없다.

## 4. 통합 진단

| 문제 | 확인한 원인 | 확신·한계 |
|---|---|---|
| 현재 위치가 내부 ID로 표시 | 겹치는 Micro 재반영 경로가 새 참조의 이름을 조회 모델에 전달하지 않음; 표시 fallback이 ID 반환 | 실제 패치와 현재 함수를 이용한 최소 재현 완료. 전체 UI 재현은 미실시 |
| 소속·사물의 기록 없음과 상세 연결이 공존 | 빈 안내는 affiliations만 검사하고, 상세는 모든 세계 연결을 별도 추가 | 코드 분기 확인. 실제 UI 자동화 검사는 미실시 |
| 소속·사물에 현재 위치가 들어가고 라벨도 이상함 | 위치 연결까지 수집하고 장소→인물 역방향 관계명을 인물 화면에서 재사용 | 코드 흐름 확인 |
| 소개·선호·경계 공백 | 해당 typed facts와 State intent가 분석 결과에 없음. 형식 검증 통과는 내용의 충실도를 보장하지 않음 | r1/r2 정본 확인. 원문 전체의 추출 가능 항목 목록은 아직 미작성 |
| 세계의 장소 설명 부족 | 지속적인 용도·배경·특징을 누적할 전용 통합 계약·표시 경로가 없음 | 현재 typed claims와 atlas 읽기 코드 확인. condition으로 일부 설명 표현은 가능하지만 전용 누적 프로필과 다름 |
| 서사 흐름·전환·반복 소재 공백 | 화면이 읽는 배열과 현재 통합 정본이 쓰는 항목의 불일치 | 현재 통합 경로 확인. 과거/일반 서사 패치 함수가 존재해도 현 경로 자동 생성의 증거가 아님 |
| 마무리된 이야기 공백·중복 | 모델이 open/reaffirm만 생성; 기존 이야기 연결 두 건은 anchor 근거 부족으로 pending | 첨부 원응답·활성 정본·State 확인. 모든 열린 이야기가 종결 대상이라는 뜻은 아님 |

### A. 위치 ID 노출

T4 승인 Micro 패치는 세연의 `locationRef`를 `ce_world_87c91f6f`로 설정한다. 같은 패치의 `microNewEntities`에 거실의 검증된 식별 정보가 있지만, 영속 Registry/정본 State에는 이 장소가 없다.

`projectActiveMicroStateForResponse`의 정본 이후 Micro 경로는 새 항목을 `registryView.entities`에 합쳐 이름을 보존한다. 정본과 겹치는 경로는 `microEffectiveEntityId`로 기존 항목에 연결할 수 있는지만 확인하고, 새 항목을 합치지 않은 Registry로 `retainMicroLocationReference`를 호출한다. 따라서 인물 필드에는 ID가 들어가지만 이름을 가진 세계 행은 생기지 않는다. `worldManagerDisplayReferences`는 이름을 찾지 못하면 ID를 그대로 반환한다.

최소 재현: 현재 `retainMicroLocationReference`와 `worldManagerDisplayReferences`를 추출해 실제 패치/Registry/State를 입력했다. 기존 Registry에서는 결과가 ID였고, 승인 패치의 `microNewEntities`를 조회 목록에 추가하면 `거실`이었다. 이 조작은 메모리 내 재현용 입력에만 적용했으며 DB는 수정하지 않았다.

### B. 인물 공백과 재분석의 실제 결과

재분석 로그의 작업은 `source_edit`, 대상 `[1,6]`, completed 2, failed 0, committedTurn 10이다. 활성 manifest도 두 정본 r2를 가리킨다. 재분석 미실행이나 단순 화면 새로고침 문제로 설명할 수 없다.

| 활성 정본 | 인물의 현재 상태 관련 사실 | 소개·선호·경계 사실 |
|---|---|---|
| T1~5 r2 | condition 2, emotion 2, goal 2, location 3 | 0 |
| T6~10 r2 | condition 2, emotion 2, goal 2, location 1 | 0 |

마지막 정본 원응답의 `character_info` 2개는 모두 category goal이다. `character_info`가 있다는 것만으로 소개 추출 성공을 판정하면 안 된다. 최초 r1 두 정본에도 해당 프로필 사실은 없었으며, 당시 조회한 Micro 22개(분석 이력 포함)에도 해당 필드의 State intent가 없었다.

카드는 소개를 `appearance/background/personality/speech/habits/abilities`, 선호를 `preferences`, 경계를 `boundaries`에서 읽는다. 사건 문장이 누적되어도 이 필드로 추출되지 않으면 채워지지 않는다. 인물 domain의 `ready`는 이 항목들이 빠짐없이 추출되었다는 뜻이 아니다.

최초 r1의 일부 사실은 `source_quote_mismatch / UNIFIED_EVIDENCE_REQUIRED`로 제외되었다. 이는 추출 누락과 별개의 원인이다. 특히 개인정보를 팔지 않겠다고 선을 긋는 사실이 제외되었지만, 그것이 원래 구조화 boundary였는지는 확인하지 않았다. 이 한 건으로 모든 경계 공백을 설명하지 않는다.

### C. 세계와 서사의 쓰기 계약 공백

현재 세계 typed claims는 시각·포함·관리·소유·소지·보관·접근·규칙·condition을 처리한다. `bookWorldAtlasModel`은 `lead=''`로 두고 지정 필드 및 승인 Micro 필드만 보여준다. 장소의 지속적인 설명을 요청하려면 프롬프트 외에도 schema/정규화/저장/재생/근거/표시가 필요하다.

서사 화면은 `narrative.arcs/turningPoints/motifs`를 읽지만, 현재 통합 정본의 narrative claim은 thread뿐이고 event는 사건 연대기에 반영된다. 통합 출력의 최상위 필드는 schema/entities/facts/stateBindings로 제한된다. 현재 writer에 대응 항목이 없는 화면 배열은 반복 재분석으로 채워지지 않는다.

### D. 이야기 종결과 연결 실패

마무리 탭은 resolved/closed/transformed/superseded thread를 모으므로 종결 지원 자체는 존재한다. 이번 활성 thread 네 개는 모두 open이고, T6~10 원응답의 두 thread도 open/reaffirm이다. 두 연결은 `thread_anchor_evidence_missing`으로 pending이 되어 별도 lifecycle 행으로 남았다. 비슷한 약속이 중복되고 이전 과제는 열린 채 유지된다.

‘혼자 지정 장소에 오라’는 이전 과제와 이후 혼자 도착한 근거가 함께 존재하지만, 그 이행을 기존 과제의 resolve로 연결하지 않았다. 한편 별도 통화 과제를 reaffirm하려는 결과도 생성되었다. 후속 작업은 후보 선택, anchor 근거, 이행/종결 추출을 나누어 점검해야 한다. pending 검증을 제거하거나 이름이 같다는 이유만으로 합치는 것은 해결책이 아니다.

## 5. 구현 탐색 지도

모든 위치는 `PROGRAM/plugins/LIBRA.js`의 조사 당시 대략적인 행 번호다.

| 함수/상수 | 대략 행 | 확인할 부분 |
|---|---:|---|
| UNIFIED_CLAIMS | 58212 | typed claim의 domain/field/collection/profile 계약 |
| microEffectiveEntityId | 58660 | Micro 생성 항목과 정본 식별자 연결 |
| retainMicroLocationReference | 60624 | 검증된 참조의 이름을 읽기 모델에 보존 |
| projectActiveMicroStateForResponse | 60640 이후 | 겹침 60760~60870 / 이후 턴 60937~61003 경로 차이 |
| character_info 정규화 | 62059 | category 분류, memory-only 처리, 구조화 선호·경계 변환 |
| thread 후보 연결 | 63346 이후 | alias, 참여자, anchor, lifecycle 검증 |
| unifiedPromptContract | 63415 이후 | 실제 분석 모델에 주는 추출·출력 계약 |
| unifiedStateBindingsForRead | 63675 | 사실에서 State binding 파생 |
| 통합 thread/event State 적용 | 63947 / 64069 | pending과 lifecycle 처리, 사건 누적 |
| worldManagerSnapshotView | 90134 | currentStateView와 continuityState 선택 |
| worldManagerDisplayReferences | 90198 | 이름 조회와 미해결 참조 fallback |
| BOOK_WORLD_AUTO_FIELDS / bookWorldAtlasModel | 92995 이후 | 본문 표시 필드, 양방향 연결, 빈 lead |
| bookNarrativeModel | 93089 이후 | open/closed 분류, arcs/turningPoints/motifs 읽기 |
| buildApprovedMockupPeople | 96489 이후 | groupKeys, 빈 안내, worldLinks, 탭 배치 |

## 6. 권장 수정 순서와 완료 기준

### 1단계: 표시·참조 오류 수정

- 승인된 Micro 패치의 새 식별 정보를 겹침 경로에서도 참조 보존에 전달한다. 기존 정본 항목에 합쳐지는 경우와 새 항목만 있는 경우를 구분한다.
- 상속 경로에도 같은 누락이 있는지 조사한다. 상속 경로의 결함까지 재현한 것은 아니므로 결과를 추정하지 않는다.
- 미해결 참조는 사용자에게 자연스러운 확인 필요 상태로 보여주되 원래 진단 ID는 내부적으로 보존한다.
- 위치 연결은 현재 상황, 소속·소유·소지·관리 연결은 해당 탭으로 분류한다. 관계 방향에 맞는 라벨을 사용한다.
- 빈 안내는 최종적으로 표시할 필드·후보·연결 목록을 기준으로 판단한다.

완료 기준: 동일 조건에서 거실이 자연어로 표시된다. 소속·사물에 실제 소유/소지 등 항목이 있으면 포괄적인 기록 없음 안내가 나오지 않는다. 위치만 존재하면 현재 상황에 나타나며 소속·사물에 역방향 위치 라벨이 섞이지 않는다. 읽기만으로 영속 State/정본이 변경되지 않는다.

### 2단계: 인물 추출의 충실도 개선

- 먼저 사용자 원문에서 직접 확인할 수 있는 소개·선호·경계와, 근거가 없어 비어 있어야 할 항목을 나눈다. 원문 대조 없이 ‘모든 칸이 비어 있으면 실패’로 만들지 않는다.
- 추출 누락과 생성 후 인용/형식 검증 탈락을 각각 계측한다. 어느 단계에서 사라졌는지 진단에 남긴다.
- 명시적 근거가 있는 항목의 누락을 보완하는 분석 흐름을 설계한다. 프롬프트만 바꾸고 끝내거나 매 턴 무조건 추가 모델 호출을 붙이지 않는다. 비용·추가 호출·부분 실패 동작을 설명 가능하게 한다.
- 현재 사용자가 가진 대화 사실과 캐릭터 설명/로어를 구분한다. 설정으로 소개를 보충할 경우 출처·현재성 규칙을 명시한다.

완료 기준: 여러 종류의 명시적 프로필/선호/경계가 원문→정본→State→카드에서 각 근거와 함께 확인된다. 근거 없는 칸은 비어 있다. 추가·정확한 항목 제거·명시적 변경이 재생과 재시작 후 유지된다. 일회성 행동을 성격·습관·선호로 승격하지 않는다.

### 3단계: 장소 설명 계약 연결

- 용도·배경·특징을 근거별로 누적할 형태를 결정하고 typed 추출부터 atlas 표시까지 연결한다.
- 지속적인 설명과 일시적인 condition/sceneTime을 구분한다. 누락은 삭제가 아니며, 교체·해제는 근거를 요구한다.
- 기존 artifact 호환, schema 버전, 교정/재생/검색에서 필요한 변경 범위를 함께 검토한다.

완료 기준: 이름뿐인 장소와 설명이 있는 장소를 화면에서 구분할 수 있다. 장소 설명은 원문 근거를 열어 볼 수 있으며 재생·재시작 후 보존된다. 이후 장면의 임시 상태가 장소의 고정 특성으로 덮어써지지 않는다.

### 4단계: 서사 구조 및 종결 연결

- arcs/turningPoints/motifs가 어떤 근거를 바탕으로 어디서 생성되고 어떻게 저장·갱신되는지 통합 계약을 만든다. 단순 사건 나열과 서사 해석을 구분한다.
- 흐름과 반복 소재에는 여러 구간의 근거를 연결한다. 한 번 등장한 단어를 반복 소재로 확정하지 않는다.
- 열린 과제에 대한 이행/실패/철회 사건을 기존 lifecycle의 적절한 종결로 연결한다. 올바른 후보를 선택하고 충분한 anchor를 제공하도록 수정한다.
- 연결 보류 항목은 확정된 새 이야기나 완료된 이야기와 구분하여 표시한다. 동일 약속 재확인으로 중복 행을 늘리지 않는다.

완료 기준: 합성 여러 구간에서 흐름·전환·반복 소재가 근거와 함께 생성·복원된다. 과제 이행은 기존 이야기의 마무리로 이동하고 불확실한 약속은 열린 채 남는다. 참여자나 세계선이 다른 동명 과제는 합쳐지지 않는다. 재분석/재생으로 lifecycle 중복이 증가하지 않는다.

## 7. 검증 계획과 기존 검증 결과

### 이미 수행한 검사

- 위치 참조 보존/표시 함수의 실제 저장 데이터 최소 재현: 누락된 이름 정보 전달 여부에 따라 ID/거실로 결과가 달라짐을 확인했다.
- `node PROGRAM/tests/libra_character_info_admission_runtime_test.cjs`: PASS. 정상 인물 정보와 별칭, 알 수 없는 category의 기억 보존, 잘못된 인용 제외, recall/replay/restart를 검증한다. 통제된 모델 응답 검사이므로 실제 모델의 추출 품질 증거와는 다르다.
- 두 첨부 로그와 활성 r2 정본/State 대조. UI 전체 검사 및 새 모델 호출은 미실시.

### 후속 작업에서 필요한 검사

| 영역 | 핵심 회귀 시나리오 |
|---|---|
| Micro 참조 | 정본 이후/겹침, 새 참조/기존 항목으로 합쳐짐, 이름 미확인, 필드 해제, 상속 경로 점검 |
| 카드 분류 | 위치만 있음, 소속만 있음, 소유·소지·관리만 있음, 복수 연결, 진짜 빈 상태, pending/partial 표시 |
| 인물 | 명시적 소개·선호·경계, 서로 다른 주제·대상·행위·시점, 근거 부재, 일시 반응, 정확한 제거·교정 |
| 장소 설명 | 설명 추가·갱신·생략, 임시 condition과 공존, 재생·재시작, 다른 장소/세계선 혼입 방지 |
| 서사 구조 | 여러 배치의 흐름·전환·반복 소재, 근거 연결, 수정·재분석 후 중복/오래된 해석 처리 |
| 종결 | fulfilled/broken/withdrawn 등 지원한 의미, 올바른 lifecycle, 부분 이행, 동명 다른 과제, 잘못된 anchor pending |
| 저장·운영 | 지원 저장 모드별 parity, 서버 재조회, 분기·세계선, 취소·재시도, 읽기 불변성, 기존 artifact 호환 |

참고 테스트: `PROGRAM/tests/libra_character_profile_runtime_test.cjs`, `PROGRAM/tests/libra_character_info_admission_runtime_test.cjs`, `PROGRAM/tests/libra_character_info_provider_contract_test.cjs`, `PROGRAM/tests/browser/libra_character_profile_browser_test.cjs`, `PROGRAM/tests/browser/libra_character_cabinet_browser_test.cjs`. 필요한 thread/world/replay 테스트는 현재 트리에서 찾아 변경 범위에 맞게 선택한다. 참고 파일 모두를 이번 조사에서 실행한 것은 아니다.

실제 모델 검증 시에는 요청에 근거가 들어갔는지, 모델이 해당 사실을 생성했는지, 검증에서 탈락했는지, State/화면에 도착했는지를 구분하여 기록한다. 합성 테스트 통과와 실제 RisuAI/provider 검증을 분리해 보고한다.

## 8. 인계받은 작업자의 첫 작업

1. 현재 diff와 첨부 로그, 두 상세 분석 문서를 읽고 scope의 활성 revision을 확인한다.
2. 위치 ID와 카드 빈 안내/분류 오류의 합성 회귀 재현을 먼저 만든다.
3. 원문에서 인물·장소·서사에 추출 가능한 항목의 작은 근거 목록을 작성한다. 이 목록이 품질 검증의 기준이다.
4. 기존 계약으로 가능한 추출 개선과 새 계약이 필요한 장소 설명/서사 구조를 나누어 구현한다.
5. 검증 결과, 남은 미확인 사항, 재분석 필요 범위를 사용자에게 명시한다. 기존 정본에 없는 정보가 단순 State 재생으로 복구된다고 안내하지 않는다.

## 9. 복사하여 전달할 작업 요청

> LIBRA 2.6.36의 인물·세계·서사 기록 공백과 카드 표시 오류를 수정해 주세요. 먼저 `PROGRAM/docs/LIBRA_CONTENT_COMPLETENESS_HANDOFF_20261106.md`를 읽으세요. 원인 조사와 최소 재현은 끝났지만 제품 수정은 아직 없습니다. 위치 Micro 참조 누락, 소속·사물의 빈 안내/관계 방향/위치 혼입, 인물 소개·선호·경계 추출 누락, 장소 설명 계약 공백, 서사 흐름·전환·반복 소재 writer 공백, 이야기 종결 및 anchor 연결 실패를 다룹니다. 기존 LIBRA.js의 재분석 대기 변경과 미추적 작업 파일을 보존하고, 원문 근거·typed 검증·세계선/lifecycle 안전성을 유지하세요. 인물 원문의 추출 가능 항목 목록부터 확인하고, 추출→저장→재생→표시의 완료 기준을 검증해 주세요. 실사용 기억은 임의로 교정하지 말고, 합성 검증과 실제 UI/모델 검증 결과를 구분하여 보고하세요.
