# WM-01–16 검증 추적 — 5차

원문 계약은 통합 설계 v1.1 ACCEPTANCE_TESTS.md / WORLD_MANAGER_CONTRACT.md이다. 아래 “로컬”은 실제 배포 JS에 합성 source/artifact를 넣는 계약 검사다. **어떤 행도 실제 외부 모델 의미 평가 통과로 표시하지 않는다.** 모델이 올바른 fact를 생성했는지는 별도 평가이며 인용 검사만으로 증명되지 않는다.

| ID | 계약 | 로컬 관련 근거/남은 의미 평가 |
|---|---|---|
| WM-01 | 포함/소속/관리 구분 | world replay/fact pipeline의 typed 필드; 실제 공간·조직 혼동 표본 필요 |
| WM-02 | 조건·scope·예외 우선순위 | 기존 rule exception 보존, 조건 자동 승격 안 함; 모델 조건 해석 표본 필요 |
| WM-03 | 극중 세계와 host 계통 분리 | lineage의 native prefix/epoch 분리·부모 보존; 다차원 서사 의미 표본 필요 |
| WM-04 | 명시 불가능 보존 | certainty/temporal/state binding 검사; 시간여행 부정 실제 출력 평가 필요 |
| WM-05 | 일상 작가/독자를 meta로 승격 금지 | 자동 키워드 승격 없음; 실제 모델 음성 사례 필요 |
| WM-06 | 미확정 평행우주 | uncertain은 강제 현재 사실로 올리지 않음; 불확실성 회수 평가 필요 |
| WM-07 | 미언급과 명시 부재 | no change/unknown/clear 구분; 부정·누락 모델 표본 필요 |
| WM-08 | 소지/보관≠소유/접근 | typed world/fact 검사; 추정 과잉 평가 필요 |
| WM-09 | 대여→전달→반환 | 실제 recall terminal closure 및 replay, 과거 revision 보존 |
| WM-10 | 인물별 비공개 지식 | knowledge/remove 및 항목별 closure; 서술자 지식 누수 모델 평가 필요 |
| WM-11 | 방향 관계 | fact/identity/lineage/GUI에서 역방향·endpoint 보존; 관계 해석 품질은 별도 |
| WM-12 | 장면과 영구 규칙 | scene_time와 rule 분리; 회상/전언 temporal 검사; 실제 모델 표본 필요 |
| WM-13 | 해결 약속과 열린 질문 | world replay/source edit 검사, 해결 사건 정본 유지 |
| WM-14 | 하나의 finalArtifact 소비 | 기존 typed fact patch, actual recall/Planner, 새 readonly context 검증; 실호스트 소비자 확인 별도 |
| WM-15 | 순환/부재/타 scope | fact pipeline/identity cycle 검증, sealed evidence corruption·source immutable 검사 |
| WM-16 | 미래계획을 현재 Narrative로 저장 금지 | 기존 Narrative typed contract/작성 경계 유지; 유도된 모델 출력 의미 평가 필요 |

## 실모델 평가 실행 계약

A=통합 Ariadne, B=통합+선택 ito, C=통합+세 ito. 동일 5 U+A, 이전 Head/Registry, 자료 권한, Provider/모델, 최종 renderer/applier로 비교한다. 각 표본에 기대 fact·허용 uncertainty·금지 승격·예상 현재값·상태 철회·관계 방향·비공개 지식 접근을 사전 정의한다. 품질 임계치와 표본 수는 결과를 보기 전에 고정한다.

측정은 누락/과잉 확정/주체·시점·방향 오류/최종 상태/리콜 반전 보존과 queue/model/local/storage/wall 시간·관측 가능한 실제 요청/토큰을 구분한다. provider가 usage를 주지 않으면 추정치를 실측으로 쓰지 않는다. 사용자 원문·API 키를 기본 evidence에 넣지 않는다. 이번 패키지는 실모델 평가 결과를 포함하지 않는다.
