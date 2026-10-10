# 7차 writer 및 실패 경계

기준 소스는 이번 배포 LIBRA와 LIBRA 전용 SDK다. 이 표는 텍스트에 등장한 함수 개수가 아니라 검수 범위를 명시한다.

| 실제 경로 | server_only 처리 | 실패 시 |
|---|---|---|
| 정상 processBatch / source edit | 후보 body/evidence readback, manifest+active descriptor 조건부 활성화 | 활성화 반려 시 generic failure-handler의 candidate manifest 쓰기 금지 |
| runUnifiedStateAfterCommit | Registry+Head+frontier receipt 하나의 batch | 정본 유지, 기존 tx로 State만 재시도 |
| build/commitUnifiedReplayTransaction | correction/meta/commit/cache/Registry/Head/receipt 필요한 그룹 | server에 로컬 compensating rollback 금지, 원자 반려·영수증 확인 |
| append/status correction | journal을 미리 쓰지 않고 replay 후보에 넘김 | SQL 중간 실패 시 journal/Head 둘 다 미변경 |
| embedding | vector stage 확인 후 memory/ref metadata 묶음 | vector 재호출 없이 staged 결과 재시도, stale source/model/ABA 거절 |
| runtime work/run/progress | 기존 진단 저장. semantic active descriptor와 분리 | 동시 다중 writer 완성은 아님 |
| native/handoff/portable/migration/split/rollback | 새 server writer로 미전환, 기존 guard 유지 | fail-closed. plugin_only의 검수된 기능은 유지 |
| scope/과거 variant 삭제 | 새 통합 server 경로 차단 | 불완전 다중 키 삭제/rollback으로 우회하지 않음 |
| generic shared SDK와 다른 owner | 기능 동일, SDK version banner만 맞춤 | 새 LIBRA semantic 권위가 다른 owner에 쓰이지 않음 |

최대 64키/4MiB를 넘는 group은 여러 batch로 조용히 분할하지 않는다. 큰 body/evidence는 후보로 먼저 저장하며 활성화/State 그룹의 제한을 각각 확인한다. 한 번의 SQLite commit과 전체 LLM→정본→State→vector 작업은 다른 범위다. 정확한 source/approval 범위와 failure-preserving canonical 계약을 유지한다.

응답 유실이면 동일 operation ID/동일 payload의 보관 중인 영수증을 조회한다. 영수증은 과거 commit 증거이며 current revision readback을 대신하지 않는다. expired prepared, changed scope, mode, source, Head, Registry, correction, active identity는 임의 rebase하지 않는다. 예외는 확정 409의 embedding metadata 통계 갱신뿐이다. 이때도 원본 memory/descriptor read set은 변경 불가다.

미지원 저장 모드의 기존 데이터는 삭제/자동 이동하지 않는다. server endpoint와 pluginStorage의 이중 원자성은 제공하지 않는다. 여러 기기 writer는 계속 미검증이다.
