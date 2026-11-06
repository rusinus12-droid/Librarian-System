# 재분석 후 인물·세계·서사 공백 원인

조사 자료: 사용자 첨부 `libra-debug-2026-11-06 (3).json`(2.6.36), 현재 LIBRA.js, 동일 scope `bf8f10a0_11:4`의 로컬 SQLite 기록. DB는 readOnly로 열었고, manifest가 활성으로 가리키는 `memory:1:r2`, `memory:6:r2`를 확인했다. 첨부 문서의 내용은 조사 자료로만 취급했다. 코드·설정·기억 데이터 수정이나 모델 호출은 하지 않았다.

## 재분석은 실행되었다

첨부의 `canonicalJob`은 `source_edit`, 대상 시작 턴 `[1,6]`, completed 2, failed 0, committedTurn 10이다. 활성 manifest도 두 정본의 revision 2를 가리킨다. 경고를 포함한 완료이며, 화면 새로고침이나 재분석 미실행만으로 설명할 수 없다.

## 인물: 재분석으로 현재 상태는 생성되었지만 소개·선호·경계는 여전히 누락

| 활성 정본 | 인물 관련 사실 종류와 개수 |
|---|---|
| T1~5 r2 | character_state 2, character_emotion 2, character_goal 2, location 3 |
| T6~10 r2 | character_state 2, character_emotion 2, character_goal 2, location 1 |

두 정본 모두 외형·배경·성격·말투·습관·능력·선호·경계 사실은 0개다. 첨부의 마지막 정본 분석 원응답에도 `character_info` 2개가 있으나 둘 다 category goal이다. 따라서 `character_info`가 생성되었다는 사실만으로 소개가 채워졌다고 판단하면 안 된다.

현재 계약에는 인물 프로필과 선호·경계 표현이 있다. 그러나 해당 내용을 빠뜨린 응답도 형식·근거 검증을 통과할 수 있다. 현재 표본은 추출 충실도 문제를 보여주며, 저장된 소개 필드가 화면에서만 사라지는 사례는 아니다. T6~10의 rawResponse는 JSON으로 파싱되므로 이 결과를 단순 JSON 절단으로 설명하지 않는다. 모든 빈칸을 채울 직접 근거가 원문에 있는지는 별도의 원문별 점검이 필요하다.

## 세계: 장소 설명을 누적하는 전용 계약이 없다

현재 활성 State의 세계 항목은 아르주나, 세 모녀의 집, 세희의 방, 산속의 밀실, 폐공장이다. 상태는 시각(`sceneTime`)과 포함 관계(`parentRef`) 중심이다.

`UNIFIED_CLAIMS`의 세계 항목은 scene_time/containment/management/ownership/possession/placement/access/rule/world_state다. `world_state`는 condition이며, 장소의 용도·배경·특징을 항목별로 축적하는 별도 프로필 계약은 없다. `bookWorldAtlasModel`은 `lead=''`로 두고, 일반적으로 `BOOK_WORLD_AUTO_FIELDS` 및 승인된 Micro 필드만 본문에 노출한다. 따라서 프롬프트에 설명을 더 요청하는 것만으로 저장·재생·표시 경로 전체가 생기지 않는다.

이것은 장소만 등록되었다는 사실과 그 장소가 무엇인지 설명되어 있다는 사실을 구분하지 못하는 제품 계약 공백이다. 원문에 근거한 장소 설명을 지원하려면 추출 형태, 누적·교체 규칙, 근거, 재생, 화면 표시를 함께 연결해야 한다. 현재 상태 condition과 지속적인 장소 설명은 별도로 다루는 것이 적절하다.

관련 코드: UNIFIED_CLAIMS 58212행 이후, unifiedPromptContract 63415행 이후, BOOK_WORLD_AUTO_FIELDS 92995행, bookWorldAtlasModel의 lead와 visibleField 93031~93035행.

## 서사 흐름·전환·반복 소재: 화면의 읽기 계약과 통합 쓰기 계약이 어긋남

화면은 `narrative.arcs`, `narrative.turningPoints`, `narrative.motifs`를 각각 읽는다(`bookNarrativeModel` 93103~93105행). 그러나 현재 통합 정본의 narrative claim은 thread뿐이다. 허용 최상위 필드도 schema/entities/facts/stateBindings로 제한된다. 통합 State 적용은 thread를 처리하고 event를 사건 연대기에 넣으며, 흐름·전환·반복 소재를 만드는 대응 typed claim 경로가 없다.

일반/과거 서사 정규화와 패치 함수가 이런 배열을 지원하는 것은 현재 통합 정본 분석이 이 값을 자동 생성한다는 증거가 아니다. 첨부 `storyArc.narrativeState.arcs`는 빈 배열이며, 로컬 활성 State에도 흐름은 없고 turningPoints/motifs 항목 자체가 없다.

따라서 이 세 탭의 공백은 같은 분석을 더 반복해서 해결할 문제가 아니다. 근거가 있는 사건을 여러 구간에 걸쳐 종합하는 서사 해석과 저장·재생 경로가 필요하다. 반복 소재를 원문 한 번의 등장만으로 확정하거나, 해석을 세계의 확정 사실로 혼동해서는 안 된다.

## 마무리된 이야기: 지원은 있으나 이번 결과에서 종결이 생성되지 않음

마무리 탭은 resolved/closed/transformed/superseded 상태의 thread를 모은다(`bookNarrativeModel` 93102행). 흐름·소재와 달리 현재 typed thread 계약에는 resolve 및 resolution이 있다.

이번 결과의 thread 네 개는 모두 open이다. T6~10 원응답의 두 thread도 open/reaffirm이며, runtime에서는 둘 다 `thread_anchor_evidence_missing`으로 이전 이야기와의 연결이 보류되었다. 새 lifecycle ID의 항목이 생성되어 비슷한 약속이 중복되어 보이고 이전 요구는 열린 채 남는다. 활성 State의 pending에도 두 건의 `thread_link_pending:thread_anchor_evidence_missing`이 있다.

이 표본에서는 ‘지정 장소로 혼자 오라는 요구’가 이전 구간의 열린 과제로 남는데, 다음 구간의 원응답에는 혼자 도착했다는 인물 근거와 이동 사건이 존재한다. 그 이행을 기존 과제의 resolve로 연결하지 않고 별도의 통화 과제를 reaffirm하려고 한다. 종결을 판정·연결하는 추출이 사건 기록과 분리되어 누락될 수 있음을 보여준다. 다만 모든 약속이 실제로 이행되었다는 뜻은 아니며, 불확실한 약속까지 자동 종결해서는 안 된다.

수정은 (1) 이행 사건과 기존 thread의 근거 있는 연결, (2) 잘못 선택한 candidate/부족한 anchor의 진단·보완, (3) pending 연결을 확정된 별도 이야기와 구분하는 화면 처리로 나누어야 한다. 연결 안전 검증을 없애는 방식으로 해결하면 안 된다.

관련 코드: 후보 연결 검증 63346행 이후, thread 적용 63947행 이후, 사건 연대기 적용 64069행 이후, 서사 화면 분류 93102~93105행.

## 결론과 검증 범위

인물은 지원된 필드의 추출 누락, 세계 설명과 서사 흐름·소재는 현재 통합 쓰기 계약의 공백, 이야기 마무리는 종결 추출 및 기존 thread 연결 실패로 구분된다. ‘재분석만 하면 채워진다’는 설명으로는 부족하다. 첨부 원응답, 활성 정본·State 및 코드 경로를 대조한 결과이며 실제 RisuAI UI 실행이나 추가 provider 호출은 하지 않았다.
