# MemorySuite 통합 설계 v1.5 — 7차 지원 상태

2026-09-07 / MemorySuite 0.3.33 · LIBRA 2.3.40 · Storage SDK 1.8.15.
원 v1.1 및 후속 불변 계약을 삭제하지 않는다. 차수 7은 원 설계 P7 실측의 완료가 아니다.

| 항목 | 반영 | 미완료/보호 |
|---|---|---|
| W SDK | revision/exists/tombstone/digest read set과 조건부 원자 batch | namespace 간·서버와 pluginStorage 간 원자성 없음 |
| W LIBRA | 제한된 server_only current main/all-v4 단일 writer의 정본/State/교정/vector | server lineage/legacy 이전/portable/split/rollback/삭제, mirror/distributed 미개방 |
| G | 실제 required canonical/evidence/archive-parent closure 검사. 결손 시 전체 점검/삭제 보류 | 영구 archive/evidence/canonical/교정 GC는 여전히 하지 않음 |
| M | 검증된 이전 artifact/evidence와 description/Persona 평가 context | external model 0호출, 인간 의미 점수 없음 |
| H | 제공 host 의존성 설치 재시도 | DNS 실패, actual RisuAI/IPC not_run |
| R | hash/실행 경계/사전 기준을 검사하는 읽기 release gate | default legacy 보존, reader/Observer 일괄 퇴역 없음 |

단일 namespace SQLite의 한 commit, 여러 단계의 정본/State/embedding 작업, 통제된 GUI 시험, 실제 호스트/실모델 검수는 서로 다른 보장이다. 정확한 범위는 INTEGRATED_IMPLEMENTATION_PLAN.md와 7차 보고서를 따른다.
