# State 프로젝션: 실패한 것만 보류하고 나머지는 반영 (2026-11-20)

대상: LIBRA `projectActiveMicroStateForResponse`, `loadContinuityStateForResponse`.

## 문제

Micro → State 프로젝션에서 claim 하나를 State Head에 적용하다 예외가 나면 그 예외가 함수 밖으로 나갔다. 그러면 `loadContinuityStateForResponse`가 Micro 프로젝션 **전체**를 버리고 Canonical Head로 돌아갔다(`micro_projection_read_failed`). 같은 턴이나 다른 턴의 정상 claim도 모두 반영되지 않았다.

읽기와 승인 판정 단계는 이미 claim 단위로 `pendingClaims`에 보류했다. 하지만 Head에 실제로 적용하는 단계에는 이런 격리가 없었다. 이 단계에는 관계 행 생성, 컬렉션 병합, 이전 값 보존(superseded), 위치 참조 기록이 포함된다.

## 조치

| 단위 | 실패 시 |
| --- | --- |
| Canonical 이후 턴의 claim | 그 턴 시작 시점의 Head로 되돌리고, 실패한 claim만 빼고 그 턴을 다시 적용한다. 실패한 claim은 `pendingClaims`에 `micro_projection_apply_failed`로 보류한다. |
| claim에 묶이지 않는 턴 실패 | 그 턴만 `micro_projection_turn_failed`로 보류하고 다음 턴은 계속 진행한다. |
| Canonical 겹침 구간의 claim 수집 | 그 claim만 `overlap_projection_failed`로 보류한다. |
| Canonical 겹침 구간의 필드 그룹 적용 | Head를 되돌리고 그 필드 그룹만 `overlap_projection_failed`로 보류한다. |
| 프로젝션 다음 단계 (상속 Micro, 기억 검토) | 이 단계의 실패가 이미 만든 Micro 프로젝션을 지우던 결합을 풀었다. 이 단계만 실패하면 기존과 같이 Canonical로 대체한다. |

보류된 claim은 기존 기억 검토 계층으로 넘어간다. 이 계층은 행마다 따로 `try`로 적용하므로, 자동 적용이 켜져 있으면 적용 가능한 것은 그 경로로 반영된다.

프로젝션 전체를 판단할 수 없는 실패는 기존처럼 Canonical로 대체한다. 세계선 메타 읽기 실패, cutoff 이상이 여기에 해당한다. `assertConsumedDataCurrent`처럼 읽는 도중 데이터가 바뀌었는지 보는 일관성 검사도 그대로 전체 단위로 둔다.

## 검증

`PROGRAM/tests/libra_state_projection_partial_failure_test.cjs`를 추가했다. 턴 6 Micro에 State claim 2개(`condition`, `doorStatus`)를 두고, `doorStatus`를 적용할 때 예외를 주입한다.

- 이번 수정 전: `condition`도 반영되지 않는다(시간 초과).
- 이번 수정 후: `condition`이 반영되고, 프로젝션이 턴 6까지 진행한다. `doorStatus`는 보류되었다가 기억 검토 계층에서 적용된다.

회귀: LIBRA State·Micro 관련 테스트 115개 파일(311건)을 수정 전후로 비교했다. 차이는 새 테스트 1건뿐이고 새로 생긴 실패는 없다. 나머지 61건 실패는 양쪽이 같은 목록이며, 이전부터 실패하던 것이다.
