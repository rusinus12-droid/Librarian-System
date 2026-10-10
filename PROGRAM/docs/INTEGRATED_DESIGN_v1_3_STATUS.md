# MemorySuite 통합 설계 갱신 v1.3 — 5차 지원 범위

2026-09-07 / MemorySuite 0.3.31 · LIBRA 2.3.38.

v1.1 원 설계를 삭제하지 않는다. v1.2의 기억·상태·관계·Narrative 책임 분리를 유지하고, 제한된 main 단일 세션에서 native branch/세션 이관/명시 legacy prefix/identity 교정으로 범위를 넓혔다. 정확한 지원·차단 조건은 INTEGRATED_IMPLEMENTATION_PLAN.md가 우선한다.

| 계층 | 현재 계약 |
|---|---|
| Source Evidence | 승인 원문 버전, physical owner별 검증, 복사 시 메시지 identity만 대상에 맞게 결속. 본문 변경은 명시 승인 필요 |
| Canonical | 구간당 활성 정본 하나. 본문/검색/State의 finalArtifact 일치, 교정으로 원본 정본 수정하지 않음 |
| Worldline | 호스트의 실제 별도 채팅 분기를 기존 계통으로 수용. prefix 외 미래 정본/교정 제외 |
| Shared archive | ancestor immutable + 신규 delta. 원본 세션 삭제 뒤에도 필요한 evidence로 로컬 재생 가능 |
| Legacy prefix | 원형 읽기 보존, 미해석 과거 상태 경고. v4로 가장하거나 빈 현재값으로 과잉 확정하지 않음 |
| Identity | 이름·별칭·병합의 현재 해석을 기존 저널에 저장, Registry와 typed 참조를 함께 교정 |
| Current Head/Narrative | 최신 상태/현재 열린 서사만, 별도 역사 DB 없음. inherited local T0도 exact cursor로 교정 가능 |
| ResponseContext | 요청 단위 읽기 snapshot, 원문/활성 정본/Head/세계선/설정 변경 시 무효화. 조회는 분석·승인·벡터 작업을 실행하지 않음 |

5차는 외부 모델 WM 의미 동등성이나 모든 RisuAI 설치 조합의 완료 선언이 아니다. plugin_only 단일 writer, 명시 unified 선택이 계속 적용된다. 같은 scope 가상 fork, rollback view의 암묵적 승계, arbitrary identity split, 임의 세대 교차 체인, 분산 writer는 지원하지 않는다. 모델 의미 정확도·속도·비용의 실제 측정은 별도이다.
