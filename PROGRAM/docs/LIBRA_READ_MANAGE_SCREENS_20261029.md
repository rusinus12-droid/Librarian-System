# 열람·관리 화면 분리와 기억 관리 개편

## 적용한 기준

읽기와 관리는 같은 페이지 안에서 숨겨진 영역을 펼치는 방식이 아니라, 머리말의 `읽기 / 관리` 전환으로 서로 다른 화면을 띄운다. 관리 화면은 독서 화면을 함께 마운트하지 않는다.

- 기억 서가: 관리 버튼 이름을 `정본 관리`로 바꿨다. 관리 화면은 Micro·렌즈 탭을 표시하지 않고 `관리 대상 · 정본 기억` 안내 띠를 둔다. Micro·렌즈 탭에서는 관리 전환 자체가 보이지 않으며, 관리로 들어가면 정본 탭으로 맞춘다.
- 기억 관리 도구: 여섯 작업을 `만들기 / 다시 쓰기 / 점검 · 복구` 세 묶음의 설명 타일로 정리하고, 정본 개수·최신 구간·부분 정본 수를 머리에 보인다. 기억 목록은 구간 배지·제목·메타 한 줄로 구성하고, 펼치면 작업 버튼 → 종합 메모리 본문 → 메타데이터·검색 영역 접기 순서로 놓는다. 버튼 이름과 개수는 그대로다.
- 정본 복사본 수정: `awaiting_edit` 상태에서 작업 창이 프레임 높이를 채우고, 진행 막대·단계 표시·경과 시간을 숨겨 편집창이 남은 높이를 모두 쓴다. 글자 수와 변경 여부를 편집창 아래에 표시한다.
- 인물 카드함·세계 도감: 관리 전환 시 기존 `인물 · 관계 상세 관리`, `세계 상세 · 교정 관리` 접기 영역 대신 독립 관리 화면을 띄운다. 목록·상세 2단 배치이며 좁은 화면에서는 1단으로 접힌다. 독서 화면 아래의 숨은 관리 버튼 묶음은 제거했고, 보류 근거 해결은 관리 화면의 인물 상세에서 보류가 있을 때 표시한다.
- 서사 연감: `사서의 여백`을 제거했다. 머리말에 `읽기 / 관리` 전환을 추가했다. 서사 구조 요약(현재 이야기, 압력, 열린 갈래·진행 중 흐름·유지 조건·기록된 사건 수)은 연감 읽기 화면 상단에 통합했고, 교정 관리는 별도 관리 화면으로 옮겼다.
- 세 관리 화면 모두 `교정 기록`(교정 생애주기 창)과 `읽기로 돌아가기`를 같은 자리에 둔다.

## 사서의 여백 제거 범위

GUI 편집기, GUI 전용 상태와 읽기·저장·초기화 함수, 초기화 확인 창 템플릿을 제거했다. `get/set/clearNarrativeDirection` 공개 API와 저장 레코드는 기존 데이터와 다른 소비자를 위해 유지했다. 2026-10-29 점검대로 이 값은 실제 응답 요청에 전달되지 않았으므로 동작상의 응답 변화는 없다.

## 실행한 검증

- `tests/browser/libra_memory_management_unified_browser_test.cjs`: 통과. 도구 한 벌, 편집창 하나, 후보 저장과 기존 유지, 빈 상태, 390px 넘침 0.
- `tests/browser/libra_read_manage_screens_browser_test.cjs`(신규): 34개 확인 통과. 세 페이지의 읽기/관리 화면 분리, 여백 제거, 연감 탭 유지, 관계 관리 페이지, Micro 탭에서 관리 전환 숨김, 1024·390px 넘침 없음, 페이지 오류 없음.
- 갱신한 정적 계약: 공용 경로 헬퍼, 승인 GUI 자산 목록(여백 초기화 창 제외), 서사 방향 계약(편집기 퇴역 + API readback 유지), 일반·진단 헤더 계약(여백 절반 제거), v5.13 view-layer 계약(연감 구조). 여백 렌더 경로 전용 테스트는 대상 코드가 없어져 삭제했다.

아래는 이번 변경 이전 HEAD에서도 같은 위치에서 실패하던 검사이며, 이번 변경으로 새로 실패한 것이 아니다: `libra_character_cabinet_browser_test`, `libra_mockup_adoption_browser_test`, `libra_narrative_almanac_browser_test`, `libra_world_atlas_browser_test`, `libra_header_mode_authority_browser_test`, `libra_book_ux_1to1_contract_test`, `libra_book_ux_v513_true_view_layer_contract_test`(`교정`), `libra_gui_architecture_alignment_contract_test`, `libra_pipeline_draft_workspace_rc2_test`, `libra_pipeline_scope_navigation_quick_settings_test`.

검증은 합성 호스트와 실제 제품 렌더러로 수행했다. 실제 RisuAI 앱과 서버 저장 모드는 확인하지 않았다.
