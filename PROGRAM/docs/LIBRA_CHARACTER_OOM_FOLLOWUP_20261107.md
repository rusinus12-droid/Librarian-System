# 정본 재분석 후 인물 카드 열람 OOM 후속 점검·패치

## 확인한 사실

사용자의 `libra-debug-2026-11-07.json`과 Out of Memory 화면을 확인했다. JSON은 plugin 설치 후 약 14초, GUI first paint 8ms 시점이며 `canonicalJob=null`, 서버 진단 미로드, snapshot hydration 미완료다. 사고 직전의 힙·상태 추적 실행 기록으로 해석할 수 없다.

같은 로컬 SQLite를 readOnly로 조회한 별도 근거:

- 최신 정본 재분석 작업 1개 배치가 완료되어 T6~10 revision 3이 저장됐다.
- Head는 인물 4·세계 7·관계 4이며 직렬화 UTF-8 크기는 104,846바이트였다. 저장 Head 자체가 수 GB로 부풀었다는 증거는 없다.
- 인물·관계·세계·서사 domainStatus는 모두 ready였다. Head에는 `memory_record_quarantined` 4건이 보존되어 전체 status는 partial이었다.
- T1~5 revision 3과 T6~10 revision 3의 상태 추적 journal은 pending, reason은 `approved_source_edit_replay`였다. DB에는 재시작 후 재생·receipt 저장 흔적도 있었다. DB 조회는 첨부 JSON과 별도의 조회 시점이며 사고 순간을 단정하지 않는다.

## OOM 추정 원인으로 보고 수정한 경로

### 1. 제외 사실만 있는 완료 재생을 다시 복구하는 경로

`unifiedReplayReceipt`는 pending이 하나라도 있으면 partial을 기록한다. 반면 `stateTrackingResultComplete`는 complete receipt만 작업 완료로 분류했다. 이미 전체 도메인의 재생을 마치고 제외 사실만 보존한 경우도 journal이 pending으로 남았으며, source_edit 작업의 다음 복구에서 같은 전체 체인을 다시 재생할 수 있었다.

합성 원문·격리 VM에서 이 조건을 재현했다. 수정 전에는 같은 데이터의 강제 복구 두 번 모두 전체 재생이 1회씩 실행됐고 journal 1건이 계속 pending이었다. 기본 자동 복구에는 같은 boot에서 재시도하지 않는 guard가 있으므로 이를 무한 자동 루프라고 단정하지 않는다. 재시작·명시적 복구가 재진입 지점이다.

수정 후에는 성공한 local replay에서 receipt seal·Head/Registry 해시·모든 도메인의 ready·legacy 미포함·미해결 prefix 없음·도메인을 막지 않는 보류만 남음이 모두 확인되면 journal 작업만 완료한다. 제외 사실과 Head의 partial 표시는 보존한다. 서사 연결 미해결, not_updated 도메인, legacy, 미완료 prefix, 해시/receipt 손상은 완료로 바꾸지 않는다.

### 2. GUI 직접 snapshot 갱신이 전체 State를 겹쳐 만드는 경로

앞선 패치는 자동 알림으로 예약하는 `scheduleCurrentStateSnapshotRefresh`만 단일 실행으로 만들었다. GUI 열기·직접 새로고침·API 조회는 `refreshSnapshot`을 바로 호출하므로 해당 보호 밖이었다. `snapshotRefreshSerial`은 오래된 결과의 게시만 막았고 이미 시작한 복제·읽기를 취소하지 않았다.

이제 모든 `refreshSnapshot` 호출의 실제 생성 작업을 직렬화한다. 대기 중인 동일 scope/options 요청은 합치고, 진행 중인 갱신 이후 요청은 새 작업으로 읽는다. provisional callback은 각 요청에서 유지하며, 기본 clone 반환값은 호출자 사이에서 공유하지 않는다. 읽기/원문/소비 증거 guard는 유지한다.

두 곳 모두 코드 주석에 **“해당 경로를 OOM의 추정 원인으로 보고 패치했다”**고 기록했다. 힙 추적이 없어 이번 실제 OOM의 단일 직접 원인은 확정하지 못했다는 범위도 함께 남겼다. 실제 DATA나 저장 journal을 직접 수정한 것은 아니다.

## 전후 제어 실험과 검증

| 제어 조건 | 수정 전 | 수정 후 |
| --- | --- | --- |
| 같은 자료로 복구를 다시 실행할 때 전체 재생 | 1회 | 0회 |
| 복구 후 남은 journal | pending 1건 | 0건 |
| 제외 사실 보존 | 유지 | 유지 |
| 직접 snapshot 동시 실행 | 2개 | 1개 |

결과는 `.development/reanalysis-20261107/character-oom-recovery-probe-before.json`과 `character-oom-recovery-probe-after.json`에 있다. 원문은 합성 자료이며 클라우드 생성 요청은 하지 않았다.

- 신규 회귀 3개 통과: 실제 source_edit 후 제외 사실 보존/재복구 방지, 완료 판정 음성 사례, 직접 갱신 직렬화·대기 병합·clone 분리.
- 확장 11개 파일의 Node test 25건 중 23건 통과, 2건 실패. `libra_current_state_view_runtime_test`의 unknown location 기대값(admitted/pending)과 `libra_micro_native_copy_rollback_test`의 재시작 복사 verified 기대값은 **이번 두 수정만 제거한 이전 코드에서도 같은 조건·같은 위치로 실패**했다. 이 실패를 통과로 계산하거나 검사를 완화하지 않았다.
- 정상 원문 복사·재분석 대기/취소·Micro GUI·전체 재생/교정 무결성·durable journal 계약 회귀는 통과했다. 전체 재생 suite 내부 21개 제어도 통과했다.
- `node --check PROGRAM/plugins/LIBRA.js`, `git diff --check` 통과.

이 실험은 실제 WebView heap 사용량이나 실제 OOM 해소를 입증하지 않는다. 수정 파일을 실제 호스트에 로드한 뒤 재분석→인물 카드 열람→상태 갱신을 재현하며 프로세스 메모리와 재생 횟수를 확인해야 한다.
