# MemorySuite 통합 설계 갱신 v1.2 — 4차 구현 상태

2026-09-06 / MemorySuite 0.3.30, LIBRA 2.3.37.

이 문서는 원 통합 설계 v1.1을 대체 삭제하지 않고 이번 차수의 책임 분리·지원 범위·구현 상태를 갱신한다. `INTEGRATED_IMPLEMENTATION_PLAN.md`의 지원 경계와 다음 작업이 3차 인계의 typed replay 미구현 표기보다 우선한다. native branch/RE:TRACE/portable 및 backend 미지원 표기는 그대로 유효하다.

| 계층 | 권위와 보존 | 이번 차수 |
|---|---|---|
| 원본 U+A 증거 | 승인된 특정 원문 버전을 보존. 현재 수정 본문과 구분 | 정본 ref와 digest로 결속하여 로컬 replay 입력으로 사용 |
| 정본 기억 | 5 U+A당 활성 정본 한 개, 본문/facts/검색 동일 finalArtifact | 변경 승인 후 revision 교체, 이전 정본 보존 |
| 월드 매니저 | 현재 인물·방향 관계·세계·지식·서사 Head | typed clear/remove, 소속/시각, 단일 owner 로컬 replay와 교정 |
| 관계 | A→B와 B→A의 구체적인 자연어 정의 | 숫자 게이지가 아닌 정의/방향/근거/사용자 교정 표시 |
| 현재 Narrative | 지금 열린 갈등·약속·질문과 근거 있는 현재 의미 | kind/interpretation/해결 상태 및 교정. 독립 과거 요약·미래 계획 DB 없음 |
| 사용자 교정 | 기존 Correction Journal의 시점별 override | 정확한 필드 CAS와 선택 pending 해제, 명시 중지 보존 |
| 응답 작성 | 기존 GRADIA/Planner/Input Writer의 읽기 소비 | 기존 공용 코드 보존, 새 state read projection/리콜 반영 |

## 4차 완료 판정의 실제 범위

지원되는 all-v4/main/plugin_only 체인에서는 분석·정본·상태·리콜을 유지하면서 교정과 승인 원문 교체 후 재적용을 실행할 수 있다. 데이터가 모호하거나 근거가 부재하면 마지막 유효값/정본을 보존하고 pending/오류로 남긴다. GUI를 바꿨다는 이유로 전체 월드 매니저 의미 기능을 완료로 세지 않는다.

단일 owner 임시 transaction의 readback/rollback을 실제 backend 원자성으로 확대 해석하지 않는다. 동일 저장소 여러 writer 또는 세션 승계의 재결속은 후속이다. 현재 값만 유지하는 Head와 임시 replay 후보를 별도 장기기억 아카이브로 바꾸지 않는다.

원 통합 설계의 승인·선택·실패 보존, 수동 cold start, 자동 전체 재분석/일괄 벡터 재생성 금지, 기존 데이터/프로필/GUI 보존 조건은 유지한다.
