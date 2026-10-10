# HAYAKU 패킷 미작성 원인 분석 및 대응 방안


## 0. 후속 구현 체크포인트 — 2026-09-04

이 분석에서 제안한 저장 timeout 계층은 현재 코드에서 다음 단계까지 반영됐다.

- **HAYAKU 3.0.41**: ledger write 결과를 `confirmed / indeterminate / rejected`로 분리하고, timeout을 즉시 분석 실패로 오판하지 않는다. 동일 runtime에서는 원래 write의 늦은 완료를 exact readback으로 `eventually_confirmed` 처리하며 LLM을 다시 호출하지 않는다.
- **HAYAKU 3.0.42**: `indeterminate` write의 `scopeKey + requestNonce + packetHash + ledger hash`를 작은 durable reconciliation journal에 보존한다. 패킷 본문이나 대형 ledger를 이중 저장하지 않는다. reload 후 exact physical readback 또는 더 최신 authoritative ledger가 해당 write를 승계했음이 확인될 때 journal을 제거한다. 이 복구 경로에서도 LLM 호출은 0회다.
- 자동 회귀는 느린 write, false Recovery Journal 방지, reload 경계 journal 복원/정리까지 포함한다.
- 남은 항목은 실제 RisuAI/pluginStorage 부하 환경에서 종료·reload·서버 재시작을 섞은 라이브 검증이다.

따라서 이 문서 아래의 P1 제안 중 durable pending metadata는 더 이상 미구현 계획으로 읽지 말고, **3.0.42 구현의 근거와 라이브 검증 체크리스트**로 읽는다.

## 1. 분석 범위

이 문서는 사용자가 제공한 `hayaku_operation_debug_export_v1`를 분석한 결과다.

- Export 시각: `2026-09-03T16:43:49.447Z` (KST 2026-09-04 01:43:49)
- Export에 기록된 HAYAKU 버전: `3.0.29`
- 채팅 원문: 개인정보 보호 설정으로 생략됨
- 현재 채팅 범위: `chat_h642bgi9pzblmeh5`, authoritative scope 확인됨
- MemorySuite 서버 진단: `diagnostics_not_loaded` (서버 상태는 이 자료만으로 판정할 수 없음)

따라서 아래의 “확인된 사실”은 export에 직접 기록된 값이고, “가능성이 높은 원인”은 그 값을 연결한 추론이다. 이 자료만으로 실시간 RisuAI Provider 응답이나 현재 설치 버전의 동작까지 보증하지는 않는다.

## 2. 결론

이번 export에는 서로 다른 두 종류의 실패가 함께 기록되어 있다.

1. **3턴은 분석·검증 단계에서 실패했다.** afterRequest가 Other Ax를 1회 호출했지만 `HAYAKU_NATIVE_REPAIR_GROUNDING_INVALID`가 발생했다. 따라서 정본 packet을 쓰지 않은 것은 저장 실패가 아니라, 원본 U+A로 근거를 확인하지 못한 후보를 채택하지 않은 결과다.
2. **4턴은 packet을 찾았지만 영구 mirror 저장이 실패했다.** output capture에서 `packetCount: 1`이 확인됐고 형식상 semantic incomplete도 0이었지만, `MemorySuite.setItem` bounded call이 timeout되어 `durable:false`, `saved:false`, `storage_write_failed`로 끝났다.
3. 4턴의 경우 chat output이 authoritative source이므로 원문과 packet이 채팅에 남아 있을 가능성은 높다. 다만 export 시점에 pluginStorage readback과 worldline binding이 완료되지 않았으므로 “정본으로 영구 저장됐다”고 말할 수 없다.
4. packet 작성 프롬프트의 terminal seal budget 부족이나 hook 미등록이 직접 원인이라는 증거는 없다. beforeRequest 단계의 terminal seal은 `544`자로 유지됐고, 모든 request/output/afterRequest hook은 등록되어 있으며 마지막 hook 오류도 비어 있다.

## 3. 실행 흐름 증거

| 시각(KST) | 이벤트 | 대상 | 확인된 결과 |
|---|---|---:|---|
| 01:17:13 | `recovery_vault:evidence_saved` | T2 | packet이 보이지 않는 revision에서 U+A 증거를 Recovery Vault에 저장. `durable:true` |
| 01:17:13 | `capture:...revision_saved` | T2 | `packetCount:0`이어도 Vault revision은 durable하게 남음 |
| 01:26:00 | `binding:completed` | T2 | `bound:true`, `packetGroupComplete:true`; 이후 authoritative reconcile로 결속 완료 |
| 01:27:05 | `native_recovery:after_request_packet_failed` | T3 | `errorCode:HAYAKU_NATIVE_REPAIR_GROUNDING_INVALID`, `physicalCalls:1` |
| 01:27:20 | `recovery_vault:evidence_saved` | T3 | User 81자, Assistant 4,744자 U+A 증거가 `durable:true`로 저장 |
| 01:41:46 | `beforeRequest:done` | T4 요청 준비 | 요청 범위와 packet authoring 단계 자체는 완료 |
| 01:42:56 | `recovery_vault:evidence_saved` | T4 | User 53자, Assistant 5,022자 증거가 `durable:true`로 저장 |
| 01:42:56 | `capture:...revision_failed` | T4 | `packetCount:1`이었지만 `durable:false`, `saved:false`, `storage_write_failed` |

## 4. 원인 분석

### 4.1 3턴: grounding 검증 실패

export의 operation log 36번은 다음을 직접 기록한다.

```text
event: native_recovery:after_request_packet_failed
pairIndex: 3
errorCode: HAYAKU_NATIVE_REPAIR_GROUNDING_INVALID
error: native_repair_grounding_failed:native_repair_grounding_invalid
physicalCalls: 1
```

이 단계에서는 Other Ax가 만든 복구 후보가 packet 모양을 갖췄는지뿐 아니라, exact U+A에 실제로 근거가 있는지 확인한다. grounding을 통과하지 못했으므로 정본 ledger에 packet을 넣지 않은 것은 의도된 fail-closed 동작이다.

중요한 점은 원문이 버려지지 않았다는 것이다. 바로 다음 event 37에서 T3의 U+A가 Recovery Vault에 `durable:true`로 저장됐다. 따라서 3턴의 문제는 “원문 저장 실패”가 아니라 “분석 후보가 근거 검증을 통과하지 못함”이다.

이 export에는 첫 후보의 세부 validation path나 어떤 entity/relation/event가 근거 부족이었는지는 포함되어 있지 않다. 따라서 실패 필드를 특정하려면 Failed Recovery artifact의 원본 후보와 grounding 진단을 추가로 확인해야 한다.

### 4.2 4턴: pluginStorage mirror write timeout

마지막 capture snapshot은 다음 상태다.

```json
{
  "packetCount": 1,
  "normalizedFallbackPackets": 0,
  "semanticIncompletePackets": 0,
  "deferredBinding": true,
  "durable": false,
  "saved": false,
  "reason": "storage_write_failed",
  "packetGroupComplete": false,
  "recoveryVault": true,
  "recoveryEvidenceDurable": true,
  "recoveryEvidenceSaved": true
}
```

즉, 4턴에서는 output에서 packet 하나를 발견했지만 HAYAKU의 2차 저장소인 pluginStorage에 ledger mirror를 쓰는 단계가 끝나지 않았다. U+A 자체는 Recovery Vault에 별도로 저장됐으므로 원문 보존과 packet 정본 저장은 별개의 결과다.

호스트 호출 통계에는 `timeouts: 6`, `failures: 0`이 기록되어 있다. warning에는 다음 저장·조회 timeout이 남아 있다.

- `host_timeout:MemorySuite.setItem:hayaku.v2.ledger.chat_h642bgi9pzblmeh5`
- `host_timeout:MemorySuite.getItem:hayaku.v2.ledger.chat_h642bgi9pzblmeh5`
- `host_timeout:MemorySuite.setItem:hayaku.v2.retrace_compatibility.v1`
- `host_timeout:localPluginStorage.keys`

현재 구현의 `RisuCompat.setStorageItem`은 host storage 작업을 기본 1,500ms bounded call로 감싼다. 실제 Promise가 늦게 끝났는지, 저장 자체가 거부됐는지는 이 export의 `failures:0`만으로 구분할 수 없다. 그래서 `storage_write_failed`는 저장소 quota나 JSON 오류를 의미하지 않고, 이 실행에서는 “정해진 시간 안에 저장 결과를 확인하지 못했다”는 뜻으로 해석해야 한다.

4턴 capture에는 `deferredBinding:true`도 있다. export 시점의 `pendingCaptures`에는 request sequence 6이 남아 있고 authoritative chat snapshot은 아직 준비되지 않은 상태였다. 따라서 packet이 chat output에 존재하더라도, 영구 mirror readback과 worldline node 결속 전 단계에서 멈춘 것이다.

### 4.3 원인이 아닌 것으로 확인되는 항목

- **Hook 미등록:** beforeRequest 6회, afterRequest 6회, output 6회가 모두 관찰됐고 등록 오류가 비어 있다.
- **Packet authoring 자체의 terminal seal 부족:** 마지막 beforeRequest에서 `terminalSealChars:544`, `terminalSealBudgetTrimmed:false`였다.
- **응답 형식이 전혀 없는 경우:** T4 capture에서 `packetCount:1`, `semanticIncompletePackets:0`이다.
- **Recovery Vault 원문 소실:** T3/T4 모두 U+A evidence 저장은 `durable:true`였다.

## 5. 대응 방안

### 5.1 즉시 운영 대응

#### T4 — LLM을 다시 호출하기 전에 capture/readback부터 확인

1. 해당 채팅 원문과 Assistant output을 삭제하거나 재생성하지 않는다.
2. HAYAKU 상태 새로고침으로 authoritative chat snapshot을 다시 읽는다.
3. T4의 동일 packet·request lineage를 pluginStorage에 mirror하고 readback hash를 확인한다.
4. readback과 worldline binding이 확인되면 T4는 정상 packet으로 종료한다.
5. authoritative chat에도 packet이 없을 때만 targeted regeneration 또는 Recovery Journal 복구를 사용한다. 저장 timeout만으로 Other Ax를 추가 호출해서는 안 된다.

#### T3 — Failed Recovery에서 grounding 원인을 먼저 확인

1. Recovery Vault의 exact U+A와 실패 후보를 함께 확인한다.
2. grounding 오류에 표시된 unsupported entity/relation/event를 원문과 대조한다.
3. LLM 자동 복구는 한 번의 corrective call로 제한하고, 통과한 후보만 canonical adoption한다.
4. 계속 실패하면 원문과 진단을 유지한 채 수동 수정으로 넘긴다. 빈 template나 근거 없는 후보를 정본으로 채택하지 않는다.

### 5.2 구현 개선 우선순위

#### P1 — 저장 timeout과 분석 실패를 분리

capture 결과에 다음을 분리해 기록해야 한다.

- `storage_write_timeout`: host가 deadline 안에 응답하지 않음
- `storage_write_rejected`: host가 명시적으로 실패를 반환
- `storage_readback_mismatch`: 저장 후 hash가 다름
- `capture_deferred_binding`: packet은 있으나 최종 chat/worldline 결속 대기

현재처럼 모두 `storage_write_failed`로 합치면 사용자는 packet 생성 실패와 저장소 지연을 구분할 수 없다.

#### P1 — pending capture의 durable 재생 지점 확보

packet을 발견한 즉시 `scopeKey + requestNonce + packetHash`로 pending capture 후보를 별도 durable queue에 보존한다. pluginStorage mirror가 timeout되어도 다음 beforeRequest/output cycle에서 같은 후보를 재생하고, 최종 readback이 확인될 때만 queue 항목을 제거한다. 이 과정은 추가 LLM 호출이 아니다.

#### P1 — authoritative chat 우선 readback

HAYAKU는 live chat이 1차 원장이고 pluginStorage가 mirror다. 따라서 mirror write timeout은 채팅 원문을 실패로 간주하는 이유가 되어서는 안 된다. chat output에서 packet·lineage가 확인되면 먼저 mirror 재동기화하고, 실제로 chat에도 packet이 없을 때만 복구 분석으로 분기해야 한다.

#### P2 — host 지연 진단 강화

`MemorySuite.setItem/getItem` 호출의 요청 키, payload 크기, 시작·종료 시각, timeout 여부, late completion 여부를 제한된 메타데이터로 남긴다. MemorySuite 서버 진단이 `diagnostics_not_loaded`인 상태에서는 서버 장애라고 단정하지 말고 RisuAI Tauri pluginStorage 지연, 동시 쓰기, 브리지 부하를 각각 확인해야 한다.

#### P2 — grounding 진단을 Failed Recovery에 노출

`HAYAKU_NATIVE_REPAIR_GROUNDING_INVALID`만 표시하지 말고 실패 path, 누락된 evidence path, 후보의 해당 fragment를 함께 보존한다. 그래야 사용자가 “왜 packet이 작성되지 않았는지”를 원문과 직접 비교할 수 있다.

## 6. 최종 판정

- **3턴:** 정본 packet 미작성의 직접 원인은 grounding 검증 실패. 원문은 보존됐고, 분석 후보를 채택하지 않은 것은 안전한 동작이다.
- **4턴:** 정본 packet 미작성의 직접 원인은 pluginStorage mirror write timeout 및 그에 따른 deferred binding. packet 형식 자체가 없었던 것은 아니다.
- **가장 먼저 보강할 부분:** 저장 timeout을 semantic failure와 분리하고, chat output packet을 durable pending queue에서 재생하는 capture readback 경로다.
- **현재 export만으로 확인할 수 없는 부분:** 4턴의 늦은 write가 이후 성공했는지, T3 후보에서 구체적으로 어떤 path가 grounding 실패했는지, MemorySuite 서버가 당시 정상 응답했는지.

관련 구현 참고: [RisuCompat host timeout](../plugins/HAYAKU_Locator_Continuity.js#L8694), [ledger durable write/readback](../plugins/HAYAKU_Locator_Continuity.js#L37866), [native repair grounding/adoption](../plugins/HAYAKU_Locator_Continuity.js#L41646).
