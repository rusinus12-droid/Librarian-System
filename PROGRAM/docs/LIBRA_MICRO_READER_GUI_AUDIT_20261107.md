# Micro 열람 GUI 지연 점검

대상: 사용자 `libra-debug-2026-11-06 (6).json`과 T1 상세가 로딩 상태에 머무는 화면. 첨부 데이터는 진단 자료로만 취급했다. 점검 후 요청에 따라 아래 GUI 패치를 적용했다. 이전 재분석/State/OOM 패치는 작업 트리에 그대로 보존했다.

## 로그가 말하는 시간

| 구간 | 관측 |
| --- | --- |
| 최초 화면 표시 | 31ms, cached_gui |
| snapshot 준비 | 93,738ms |
| GUI 준비의 마지막 오류 | LIBRA_GRAPH_READER_BODY_CHANGED |
| main 영역 DOM 렌더링 | 24회 합계 15.4ms, 최대 2.5ms |
| detailReads | 0. Micro 상세 경로에는 이 카운터 증가 코드가 없어 읽지 않았다는 증거가 아님 |

snapshot 시간은 전체 GUI 준비 시간이다. T1 클릭부터 본문 표시까지의 측정 구간은 로그에 없으므로 93.7초 전체를 T1 클릭이나 특정 API에 귀속시키면 안 된다. 서버 이벤트 250개도 여러 작업이 섞인 제한된 창이다. 서버 처리 시간만으로 호스트 IPC·전송·역직렬화·검증 지연을 측정할 수 없다.

## 확인한 구현 결함/비용

1. **본문 표시를 전체 State 판정이 막는다.** `loadMicroReaderDetail`은 `readActiveMicroMemoryForTurn` 완료 시 `reader.detail.record`를 설정한 뒤, `readMicroStateAdmissionForTurn`까지 기다리고 나서야 finally에서 `detailLoading=false`로 바꾼다. 렌더러는 `detailLoading`이면 이미 읽은 본문을 숨기고 화면 전체를 로딩 안내로 바꾼다.
2. **한 턴의 열람에 전체 현재 State를 다시 계산한다.** State 판정 API는 선택 Micro를 다시 읽고, `loadContinuityStateForResponse(...,{microStateTurn})`로 정본·활성 Micro·중첩 판정·검토 정책 투영을 읽은 다음 선택 Micro와 소비 증거를 재검증한다. `microStateTurn`은 반환하는 진단 목록을 해당 턴으로 고르는 옵션이며, 전체 State 계산 범위를 한 턴으로 줄이지 않는다. 이 검증을 저장 본문 첫 표시의 선행 조건으로 삼은 것이 문제다.
3. **연속 클릭이 중복 읽기를 취소/합치지 않는다.** `detailSerial`은 오래된 결과를 화면에 반영하지 못하게 하지만 이미 시작한 API 읽기를 중단하지 않는다. 같은 턴을 여러 번 눌러도 새로운 저장 조회와 State 판정을 시작한다.
4. **목록도 단순 head 목록이 아니다.** 최대 20턴을 Promise.all로 읽으며 각 행마다 영수증·Micro 본문·work 바인딩을 검증한다. fastInspect는 일부 최종 재검증을 줄일 뿐 목록 조회를 메타데이터 전용으로 만들지 않는다. GUI의 목록 무효화 키에는 전역 State generation과 자동 판정 갱신 시각도 들어 있어 본문이 바뀌지 않아도 목록·선택 상세가 재조회될 수 있다.
5. **로딩 문구가 실제 단계를 구분하지 않는다.** 저장 본문 확인과 전체 State 승인 확인을 모두 “Micro를 읽는 중”으로 표시한다. 무한 로딩과 느린 State 검증을 구별할 상세 단계·측정 기록이 없다.

## 격리된 재현

합성 원문/응답의 기존 VM fixture와 JSDOM에서 실제 상세 로더·렌더러를 실행했다. State API 직전만 gate로 지연시켰으며 실제 RisuAI나 클라우드 모델을 호출하지 않았다. 사용자 원문은 실험에 사용하지 않았다.

- 본문 읽기 완료: true
- State 대기 중 detailLoading: true
- 로딩 문구 표시: true
- 이미 준비된 T1 본문 제목 표시: false
- 같은 턴 3회 호출의 동시 State 읽기: 3
- State 대기를 해제한 뒤 본문 제목 표시: true

원시 실험 스크립트/결과는 `.development/reanalysis-20261107/micro-gui-probe.cjs`와 `micro-gui-probe-result.json`에 있다. 이 결과는 UI 흐름의 결함을 재현하며 실제 호스트 지연 시간이나 OOM 원인을 확정하지 않는다.

## 수정 순서

1. 검증된 저장 본문이 오면 즉시 표시하고 State 영역만 “상태 반영 확인 중”으로 남긴다. State 승인을 기다리거나 실패해도 원문 바인딩을 통과한 저장 본문은 열람할 수 있어야 한다.
2. 같은 scope/worldline/turn/revision의 진행 중 상세 요청을 합치고, 이전 턴 요청은 다음 단계 진입을 중단한다. 기존 scope·revision·정본·복원 경계 검증은 유지한다.
3. 목록 재조회와 상세 State 판정 무효화를 분리한다. 저장 판정을 캐시하더라도 현재 반영이라고 표시하기 전에는 현행 원문/State basis를 검증한다.
4. 목록·본문·State 판정·첫 본문 표시를 각각 계측한다. 그 뒤 State API의 반복 물리 읽기와 host context 요청을 줄이는 범위를 정한다.

이전 패치의 자동 snapshot 단일 실행/재분석 중 선택적 작업 지연은 도움이 될 수 있지만, 이 상세 로더의 표시 순서와 클릭 중복 작업을 직접 고치지는 않는다.

## 적용한 GUI 패치와 검증

- 저장 본문 검증을 마치면 본문 로딩을 종료하고 즉시 렌더링을 예약한다. 다음 event-loop task에서 State 판정을 시작하므로 본문 렌더링이 전체 State 계산 뒤로 밀리지 않는다.
- State 영역에만 `현재 상태 · 반영 확인 중`을 표시한다. 확인 중을 승인/실패/반영 0건으로 표시하지 않는다. State 조회 실패 시에도 검증된 저장 본문을 유지한다.
- 같은 reader binding·턴·publication key·요청 serial의 실행 중 요청은 동일 Promise를 반환해 합친다. 완료된 결과는 authority 캐시로 재사용하지 않고 명시적 재확인 때 다시 읽는다.
- 다른 턴으로 이동하거나 scope/open serial이 바뀌면 이전 결과를 적용하지 않는다. 본문 읽기 종료와 State 계산 직전에 재검사하므로 이미 떠난 턴의 State 조회를 새로 시작하지 않는다. 이미 시작한 host API를 물리 취소하는 기능을 추가한 것은 아니다.
- 신규 JSDOM/실제 로더 회귀 3개에서 본문 선표시·동일 클릭 3회→본문/State 조회 각 1회·턴 전환·지연 결과 거부·State 실패·화면 범위 변경을 확인했다.
- 관련 5개 파일의 Node test **11/11 통과**. 기존 GUI 검사의 최종 판정 대기는 새 loading 단계를 제외하도록 변경했고 승인/보류/거부·원문 변경·읽기 무변경 검증은 유지했다. 결과: `.development/reanalysis-20261107/micro-gui-final.log`.
- 실제 RisuAI의 지연 시간은 재측정하지 않았다. 이 패치는 본문을 State 판정 뒤에 숨기는 문제와 같은 턴 중복 요청을 해결한다. 전체 State 판정 비용·목록의 저장 검증 비용 자체를 제거하거나 실제 호스트 속도 개선 수치를 주장하지 않는다.

## 정본 화면에도 같은 표시 순서 적용

- 정본 chapter의 scope·identity·revision·detailLoaded 검증이 끝나면 본문을 표시한다. 이후 별도 task에서 해당 구간의 턴별 Micro 근거를 읽으며, 근거 영역에만 `턴별 근거 · 확인 중`을 표시한다.
- 같은 화면 범위·정본 identity·Micro publication의 진행 중 요청은 공유한다. 정본/턴 전환 시 오래된 결과를 거부하며, 근거를 읽는 각 턴의 전후에도 ticket을 확인해 남은 이전 장의 조회를 중단한다.
- 근거 조회가 실패해도 검증된 정본 본문은 유지한다. 잘못된 scope/identity 본문은 계속 거부한다.
- Micro 코드 주석에는 “이 패치로 State 판정을 기다리느라 Micro 본문 화면이 느리게 뜨던 표시 순서 문제를 해결했다”고 기록했다. 실제 호스트의 전체 조회 시간 개선을 실측했다는 표현은 사용하지 않았다.
- 신규 정본 회귀 3개와 기존 Micro/정본 전체 GUI·읽기 공간·근거 연결·OOM 후속 회귀를 포함해 9개 파일, Node test **15/15 통과**. lifecycle suite의 기존 27개 제어도 모두 통과했다. 기존 extraction fixture에는 새 비동기 표시 단계에 필요한 실제 timer를 제공하고, 근거 API 진입까지 기다리도록 했다. scope·늦은 결과 거부 검사는 유지했다.
- 검증 로그: `.development/reanalysis-20261107/canonical-gui-final.log`. 실제 RisuAI 표시 시간은 아직 재측정하지 않았다.
