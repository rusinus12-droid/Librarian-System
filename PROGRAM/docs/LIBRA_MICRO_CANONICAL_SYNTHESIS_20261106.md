# Micro 임시 기억을 포함하는 정본 종합

## 요구사항 정정

Micro는 정본 생성 전 턴을 커버하는 임시 기억이다. 정본은 원문만 다시 분석하는 별도 레인이 아니라, 대상 구간 원문과 Micro가 만든 인물·관계·세계·서사 데이터, 필요한 이전 정본 문맥을 함께 검토해 최신 기억을 만든다. 이 원칙은 서사 후보에만 적용되는 예외가 아니라 모든 Micro 관측과 State 제안에 적용된다.

이전 패치의 ‘Micro 직접 State 반영은 28개’는 **직접 쓰기 권한의 범위**다. 이를 데이터 수집·정본 입력의 범위로 해석하면 안 된다. 서사 구조와 생명주기를 Micro가 직접 확정 State로 덮어쓰지 못하게 하되, 그 제안은 임시 기억에 남겨 정본이 함께 검토한다.

## 수정 전 공백

`executeUnifiedStage`는 정확한 5턴 원문, 이전 State, 이야기 연결 후보와 인물 후보를 입력했지만, 같은 구간의 Micro 전체 관측을 읽어 종합하는 입력은 없었다. Micro의 turningPoints/events 제안은 State intent의 일반 필드 필터에서 탈락할 수도 있었다. 또한 여러 개의 서사 제안이나 설명·유지 조건이 스칼라 변경처럼 처리되면 앞의 제안이 마지막 제안에 의해 State intent를 잃을 수 있었다.

## 이번 패치

### 전체 Micro 데이터의 정본 입력

`readCanonicalMicroInputs`가 정본의 정확한 원문 배치와 같은 scope·host worldline·turn·source revision·source digest에 연결된 활성 Micro를 읽는다. 기존 `readActiveMicroMemory`와 `microRecallMemoryFromRecord` 검증을 통과한 기록만 사용한다.

- 인물·관계·세계·서사 등 **영역을 걸러내지 않고 모든 검증된 claim**을 전달한다.
- text/actor/target/changeKind, 시간·확실성·인지 구분, State 변경 종류, `stateIntent` 및 원문 근거를 보존한다.
- 불확실한 관측과 직접 State 반영이 보류된 서사 제안도 검토 대상이다. 정본 입력에 포함됐다는 이유로 확정 사실이 되지 않는다.
- 원문 ID는 정본이 쓰는 `tN-u / tN-a`로 연결한다. 최종 사실은 기존 typed schema와 원문 인용 검증을 통과해야 한다.
- 해당 턴에 Micro가 없거나 검증되지 않았다면 상태와 사유를 남기고 정확한 원문으로 분석한다. 그 턴에 사건이 없다고 해석하지 않는다. 최소 원문 발췌만 있는 Micro는 동일 원문이 이미 정확한 원문 배치에 존재하므로 가짜 분석 claim을 만들지 않는다.
- 이미 존재하는 Micro를 읽기만 한다. 정본 분석 중 Micro 생성이나 별도의 모델 호출을 추가하지 않는다.

모델 입력의 `[VERIFIED MICRO INPUTS — REVIEW WITH THE ORIGINAL TURNS]` 블록은 원문과 함께 종합·대조·수정·기각하라고 명시한다. 기존 State에 적용된 Micro라도 정본 확정의 독립적인 증거로 취급하지 않는다. 사용자 커스텀 프롬프트나 Micro 텍스트는 데이터이며 시스템 지시가 아니다.

### 서사 제안 보존

Micro는 `threads/arcs/resolvedArcs/turningPoints/motifs/closedThreads/events`에 대한 source-bound State 제안을 남길 수 있다. 제안은 임시 기억 데이터로 저장되며 직접 확정 State 반영은 여전히 보류한다. `primaryArcId` 같은 런타임 식별자를 Micro가 직접 지정하는 것은 허용하지 않는다.

이전의 ‘서사 구조는 한 턴 대상이 아니므로 만들지 말라’는 Micro 프롬프트를 바꾸었다. 한 턴에서 뒷받침되는 전환·반복·과제 이행·종결 가능성을 후보로 남기되, 여러 턴의 확정 판단은 정본 종합에서 수행한다. 같은 필드의 여러 제안은 collection으로 다뤄, 뒤에 등장한 별도 소재가 앞의 소재를 덮어쓰지 않게 했다. 일반 인물·세계 누적 필드와 설명·유지 조건도 같은 collection 판별을 사용한다.

### 소비 출처와 저장 경계

정본의 `promptProvenance.stages.librarian.microInputs`에 소비한 Micro의 recordKey, analysisRevisionId, sourceRevisionId/sourceDigest, recordDigest, 턴별 상태와 claimCount를 저장한다. 진단의 promptBudget에도 Micro 입력 크기와 claim 수를 남긴다.

기존 optional reference/previous State 축약과 달리, 이미 선택한 Micro 입력을 문맥 압박 때문에 조용히 삭제하지 않는다. 원문과 Micro가 함께 들어가는 입력량은 실제 provider 예산을 따르므로 다음 실측에서 비용·시간·문맥 적합성을 확인해야 한다.

소비한 분석 revision은 불변 입력 스냅샷으로 검증한다. 같은 원문에 대한 새 Micro 분석이 나중에 완료되는 것과, 이미 소비한 기록의 바이트가 바뀌는 것을 구분한다. 후자는 모델 호출 후와 정본/manifest 저장 경계에서 검사하여 `CANONICAL_MICRO_INPUT_CHANGED`로 막는다. 원문 수정·scope 변경은 기존 원문 검증과 추가 Micro scope 검증으로 막는다.

정본 생성이 Micro 원본 기록을 삭제하거나 직접 정본 사실로 복사하지 않는다. 출처 추적과 재분석을 위해 원본을 보존한다. provenance는 ‘분석 입력으로 읽었다’는 증거이며, 각 후보의 의미가 모두 올바르게 확정됐음을 보증하는 점수표는 아니다.

## 검증

신규 `PROGRAM/tests/libra_canonical_micro_synthesis_test.cjs`는 외부 모델 없이 배포 플러그인과 격리된 저장소를 실행한다.

1. 정본이 없는 상태에서 5턴의 Micro를 먼저 생성한다. 턴마다 인물·세계·관계·서사 및 불확실한 관측 10개가 보존된다.
2. 서로 겹치지 않는 인용의 소재 후보 두 개가 같은 턴에서 모두 살아 있는지 확인한다.
3. 정본 요청에 다섯 턴의 Micro 관측 50개가 들어가는지 확인한다. 플러그인 단독·미러·서버 단독 모두 검사한다.
4. 정본의 통제된 응답이 선택한 사실만 저장되고 Micro 제안이 자동 승격되지 않는지 확인한다.
5. 소비한 Micro 출처가 정본 provenance에 남고 Micro 원본은 보존되는지 확인한다.
6. 원문을 수정한 턴의 오래된 Micro를 제외해 나머지 40개만 전달하는지 확인한다.
7. 모델 응답 대기 중 소비한 Micro를 변조하면 정본이 저장되지 않는지 확인한다.

`libra_micro_state_field_matrix_3mode_test`도 갱신해 서사 제안이 producer에서 사라지지 않고, 직접 State 반영 및 자동 검토 단계에서는 보류되는지 확인한다. 이전 패치의 28개 직접 State 필드와 잘못된 제안 10개 검사도 유지한다.

최종 관련 테스트 28개 스크립트가 모두 통과했다. 구문 검사와 `git diff --check`도 통과했다. 전체 LIBRA 회귀 수백 개를 다시 실행한 결과는 아니다.

실제 모델·Ollama Cloud·RisuAI UI 실측은 수행하지 않았다. 실사용 DB나 설정 변경, 커밋·푸시·설치 배포도 수행하지 않았다. 로컬 검증 기록은 `.development/static-validation-temp/*.synthesis.json`에 보관한다. 종전 정적 패치 결과와 함께 확인해야 하며, 이전에 확인한 baseline 실패를 전부 고쳤다고 주장하지 않는다.

## 실측에서 확인할 것

원문에서 확인 가능한 정보를 기준으로 Micro의 수집 누락과 정본 종합의 확정·수정·기각을 각각 평가한다. ‘정본이 Micro를 입력으로 받음’과 ‘최종 기억의 내용이 충분함’은 별개의 검증이다. 특히 이미 State에 반영된 인물·세계 데이터도 정본에서 누락되지 않는지, 서사 후보가 과도하게 확정되거나 동일 이야기로 중복 생성되지 않는지, Micro가 없거나 잘못된 경우 원문이 우선하는지 확인한다.

실측은 사용자가 정적 작업 후 보고를 받도록 요청했으므로 자동 시작하지 않는다.
