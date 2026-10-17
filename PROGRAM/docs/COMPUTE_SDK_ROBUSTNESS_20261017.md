# Compute SDK 견고성 보강 · 2026-10-17

기준 `da0949a`. Compute SDK 0.3.7 → 0.3.8. Compute SDK 감사에서 확인된 결함(C1–C14, S1–S2)을 기존 설계 안에서 국소적으로 고쳤다. 공개 API와 오류 코드 집합은 유지했고, 플러그인이 언제나 로컬 실행으로 답할 수 있다는 원칙도 그대로다.

## 문제와 변경

**마감 시간과 owner callback (C1·C2).** `validateBinding`, binding readback, 원격 `validateResult`, `bindingProvider`, mode 읽기(`modeProvider`/`getArgument`)에는 시간 제한이 없었다. 이 중 하나가 멈추면 `execute`가 `deadlineMs`를 넘겨 무기한 대기했다. half-open 시도 중에 멈추면 `halfOpenInFlight`가 영구히 true로 남아 서버를 다시 쓰지 못했고 `probe({force:true})`도 거부됐다.

- 원격 쪽 callback은 남은 원격 예산(`deadline − localReserve`, 최소 25ms) 안에서만 기다린다. 초과하면 binding 계열은 `BINDING_STALE`, 원격 결과 검증은 `DEADLINE_RESERVED`로 끝나고 로컬로 대체된다. 두 코드 모두 circuit 실패로 세지 않는다.
- 요청 시점의 `bindingProvider`가 시간을 넘기면 그 호출은 로컬 전용이 된다. `prime`은 `binding_unavailable`로 건너뛴다.
- mode 읽기는 `min(probeTimeoutMs, 남은 예산)`으로 제한하고, 시간을 넘기면 캐시된 mode나 기본 mode를 쓴다.
- 로컬 결과 검증은 `max(남은 deadline, localReserve)`로 제한한다. 시간을 넘기면 `LOCAL_RESULT_INVALID`로 거부한다.
- half-open 시도는 시작 시각과 예산을 lease로 기록한다. `max(probeTimeoutMs, 시도 예산)`이 지난 lease는 회수한다. `force` probe도 같은 규칙으로 회수한다. 회수된 이전 시도가 늦게 끝나도 circuit 상태를 바꾸지 않는다.

**Job 컨텍스트와 연결 (C3·C4·S2).**

- 공개 `waitForJob`은 결과 채택이나 종료 상태 관찰로 끝나지 않으면 컨텍스트를 해제한다. 상태 503·404, 결과 digest 불일치, deadline 도달이 이에 해당한다. 해제가 먼저이고, 그다음 접수 서버에 250ms 취소를 최선 노력으로 보낸다.
- 한 번도 기다리지 않은 Job의 컨텍스트는 `deadlineAt + 30초`가 지나면 다음 제출 때 정리한다.
- 상태와 취소 응답의 `jobId`가 요청한 `jobId`와 다르면 `JOB_INVALID`, 결과 응답에서 다르면 `RESULT_INVALID`로 거부한다.
- `jobContexts`는 Job을 접수한 연결(URL·토큰)을 함께 저장한다. status·result·cancel은 그 연결만 사용하며, 이후 URL이 바뀌거나 연결 캐시가 만료돼도 따라가지 않는다. 401/403 때 자격 증명 갱신은 같은 URL로 갱신될 때만 허용한다. dispose 중에는 bootstrap 자체를 하지 않는다.

**고아 서버 Job (C5).**

- dispose가 시작되면 `disposing` 상태가 되어 새 제출(`submitJob`·`prime`·백그라운드 예약)을 `BRIDGE_DISPOSED`로 거부한다.
- 제출 응답이 클라이언트 시간 초과나 dispose 뒤에 늦게 도착해도, 서버가 접수한 Job이면 그 연결로 250ms 취소를 보낸다. 이 취소는 lifecycle 밖에서 보내며 입력 본문은 싣지 않는다.
- dispose 중에 접수된 Job도 같은 방식으로 취소한다.

**세대와 상한 (C6–C10).**

- `setMode('local')`은 Job 세대를 올린다. 이전 세대의 백그라운드 Job은 다음 단계에서 `ABORTED`로 끝나고, 컨텍스트 해제와 취소 1회 외에는 폴링·bootstrap·캐시 기록을 하지 않는다.
- `clearDerivedCache`(전체 또는 operation별)는 캐시 세대를 올린다. 진행 중이던 Job의 결과는 반환하지만 캐시에 다시 쓰지 않는다.
- 동시에 실행되는 백그라운드 Job은 기본 6개(`maxBackgroundJobs`, 1–64)로 제한한다. 한도에 도달하면 `executeCachedOrLocal`은 Job 예약 없이 로컬 답만 반환하고, `prime`은 `background_job_limit`로 건너뛴다.
- 합류한 `prime` 호출자마다 자신의 `onDerivedResult`가 호출된다. callback이 실패하면 나머지 callback까지 모두 호출한 뒤 첫 오류를 전달한다.
- 파생 캐시는 `cachedAt`이 아니라 `lastUsedAt`이 오래된 항목부터 내보낸다(LRU).

**dispose와 응답 크기 (C11–C14, S1).**

- dispose 이후 끝나는 작업은 상태나 circuit을 바꾸지 않는다. dispose가 중단시킨 probe가 `unavailable`이나 실패 횟수를 남기던 문제가 없어졌다.
- 동시에 호출된 `dispose()`는 하나의 종료 작업을 공유한다. 실제로 종료를 수행한 첫 호출만 true를 반환한다.
- 폴링 대기 타이머는 lifecycle에 등록되고, dispose 때 즉시 해제되며 대기하던 쪽을 깨운다.
- 응답 크기가 `maxResultBytes + maxBindingBytes + 64KiB`를 넘으면 JSON.parse 전에 거부한다. 판단에는 Content-Length와 원문 길이를 쓴다. 서버 결과의 구조 한도 위반은 `INPUT_INVALID`가 아니라 `RESULT_INVALID`로 분류한다.
- 공유 bootstrap은 자신의 결과로만 연결 상태를 정한다. 시작한 호출자의 짧은 예산이 먼저 끝나도 다른 호출자가 합류한 bootstrap을 지우지 않는다.
- 같은 오래된 연결로 401/403을 받은 동시 요청은 강제 갱신 1회를 공유한다.

## 배포 반영

| 항목 | 변경 후 버전 |
|---|---|
| Compute SDK | 0.3.8 |
| Flashback | 1.0.114 |
| HAYAKU | 3.0.146 |
| LIBRA | 2.3.164 |
| LIA | 0.26.86 |

`tools/sync_embedded_sdk.cjs`로 네 플러그인의 Compute 내장본을 동기화했고 `check_sdk_sync.cjs`가 통과했다. manifest와 `SHA256SUMS.txt`도 다시 생성했다. GRADIA·RE:TRACE에는 Compute SDK를 추가하지 않았다.

## 검증

`compute_sdk_robustness_test.cjs`는 **24/24 통과**하며 3회 반복해도 결과가 같다. 같은 검사를 0.3.7 소스(`COMPUTE_SDK_SOURCE_FILE`)로 실행하면 **24건 모두 실패**한다. 관찰에는 공개 API와 가짜 transport만 사용했고, 새로운 제품 debug API는 추가하지 않았다.

기존 Compute·SDK·버전·manifest·checksum 관련 검사 56건을 HEAD 기준 worktree와 비교했다. 새로 생긴 실패는 없다. 기준 커밋에서 이미 실패하던 6건은 변경 후에도 같다.

## 한계

- 취소 성공은 보장하지 않는다. 서버 단절이나 AbortSignal을 무시하는 transport에서는 서버 deadline이 최종 정지를 맡는다.
- 늦게 도착한 제출 응답을 처리하려면 transport가 응답을 끝내 전달해야 한다. 실제 fetch처럼 abort에 반응해 거부되면, 서버가 접수했는지 클라이언트는 알 수 없다.
- 동기 callback이 이벤트 루프를 막는 경우는 시간 제한으로 끊을 수 없다.
- 폴링 타이머는 일부러 `unref`하지 않았다. 호출자가 `waitForJob`을 기다리는 동안 Node 호스트가 종료되는 것을 막기 위해서다. 대신 dispose가 이 타이머를 즉시 해제한다.
- 실패 뒤 `waitForJob` 핸들은 재사용할 수 없다. 일시적인 `getJobStatus` 실패 뒤의 재시도는 계속 허용된다. deadline + 30초가 지난 컨텍스트는 다음 제출 때 해제되므로, 그 뒤의 `getJobResult` 호출은 `JOB_CONTEXT_MISSING`이 된다.
- 응답 크기 사전 거부는 transport가 문자열 본문을 넘기는 경우에 적용된다. 이미 객체로 파싱해 넘기는 transport에는 적용되지 않는다.
