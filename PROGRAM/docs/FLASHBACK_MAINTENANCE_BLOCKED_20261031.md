# Flashback 자동 복구 차단 원인 분석 — 2026-10-31

근거: `flashback-memory-debug-2026-10-31T03-57-04-215Z.json`, 사용자 화면(기억 유지보수 진단),
그리고 `DATA/stores/flashback/flashback.sqlite`(읽기 전용 실측). scope `char:drggcm|chat:34wl25`.

## 1. 화면이 말한 것과 기록이 말한 것

화면: "판정: 파생 에피소드 인덱스 갱신이 필요합니다 … 실행 차단".

기록(`state.maintenanceInspection`, at 1793419000662):

```
automatic: { strategy: 'server_inspection_only', stages: [], blocked: true, reason: 'episode_index_stale' }
counts:    { missingTurns: 1, changedTurns: 0, dirtyRecords: 3, anchorOnlyDirtyRecords: 3,
             episodeStale: true, embeddingWorkIncompleteRecords: 0, storageMissingShards: 0,
             storageManifestCorrupt: false, storageRecordCountMismatch: false, shardIndexMismatch: false,
             embeddingQueueSourceHealthy: false }
inspection:{ coverage: 'server_snapshot', complete: true, storageSourceHealthy: false, providerCalls: 0 }
```

`reason` 은 `server_inspection_only` 분기에서 정해진다. 그 분기의 선택 사슬은 이랬다.

```js
reason: !inspection.complete ? 'inspection_incomplete'
  : autoPlan?.blocked ? (autoPlan.reason || autoPlan.strategy)
  : plan.episodeStale ? 'episode_index_stale'          // ← 여기로 떨어졌다
  : ...
```

즉 `episode_index_stale` 은 "다른 원인이 없다"는 뜻이 아니라 **"앞의 두 조건이 아니었다"**는
뜻이었다. 실제 차단 원인은 이 분기 앞에서 이미 `server_turn_sync` 를 거부시킨 조건이다.

```js
if (needsSync && !plan.requiresFullRebuild) { ... server_turn_sync ... }
```

## 2. 실제 차단 원인 — 파생 문장 청크 스키마(전체 재구축 요구)

같은 턴 `missingTurns: 1`(현재 채팅 5턴 / 서버 저장 4턴)이므로 `needsSync` 는 참이다. 그런데
`server_turn_sync` 로 가지 못했으므로 `plan.requiresFullRebuild === true` 여야 한다.
원장에는 그 값이 기록되지 않아, 저장소를 직접 읽어 확인했다.

```sql
select value_json from kv where key='vector_rag_memory:scope:6c5euo:records:commit:6ogusr:shard:0000'
```

- 응답 기록 25개 + 파생 에피소드 1개
- `memorySanitizerVersion`: 25개 모두 **4** (= `MEMORY_SANITIZER_VERSION`, 정상)
- `chunkSchemaVersion`: 25개 모두 **없음(0)** 인데 현재 `NARRATIVE_CHUNK_SCHEMA_VERSION` 은 **2**
- manifest: `pluginVersion: '0.9.14'`, `episodeSourceDigest` 는 2026-07-29 값

`requiresFullRebuild` 는 다음 식이다.

```js
requiresFullRebuild = !foreignScope && !manifestCorrupt && sources.length > 0
  && (legacySanitizerRecords > 0 || liveChunkSchemaMismatch > 0 || missingShards > 0 || countMismatch);
```

정제기 버전은 이미 최신이지만 **청크 스키마가 전부 구형**이므로 `liveChunkSchemaMismatch = 25`
→ `requiresFullRebuild = true`. 여기서 두 개의 문제가 겹친다.

1. **원인 오표기**: `requiresFullRebuild` 로 막힌 경우에도 사유는 `episode_index_stale` 로 적혀
   화면이 "파생 에피소드 인덱스"를 가리켰다. 사용자가 무엇을 고쳐야 하는지 알 수 없다.
2. **막다른 길**: 서버 모드에서 실행 가능한 전략은 두 가지뿐이다(`executeMemoryMaintenance`
   45564행: 서버 sync 또는 에피소드 재구축). 전체 재구축은 `HEALTH_LOCAL_MODE_REQUIRED` 로
   거부되고(테스트 `flashback_server_mode_recovery_test` Test 4 가 이를 고정), 에피소드 재구축은
   `embeddingQueueSourceHealthy` 가 `rawStorageStructureHealthy`(청크 불일치 포함)에 막혀 불가.
   결과적으로 **누락 턴 1개조차 동기화되지 않고 기억이 4턴에서 동결**된다.

## 3. 왜 하필 지금인가

`chunkSchemaVersion` 은 현재 writer 가 새로 만드는 기록에만 찍힌다(`buildRecordsFromSources`
27994/28037/28395행). 이 scope 의 기록은 0.9.14 시절(2026-07-29)에 만들어졌고 이후 추가 동기화가
없었으므로 전부 v0 이다. 청크 스키마가 v2 로 올라간 뒤로는 **기존 scope 대부분이 같은 상태**가
될 수 있다 — 서버 모드에서는 그때마다 자동 복구가 막힌다.

## 4. 패치

| 위치 | 변경 |
|---|---|
| `Flashback_Memory.js` plan | `requiresDerivedSchemaRebuildOnly` 추가: `requiresFullRebuild` 이면서 물리 손상(정제기 구버전·누락/손상 샤드·개수 불일치·범위 충돌)이 전혀 없이 **파생 청크 스키마만** 구형인 경우 |
| 서버 전략 분기 | `serverSyncAllowed = needsSync && (!requiresFullRebuild \|\| (requiresDerivedSchemaRebuildOnly && autoPlan?.blocked !== true))`. 다른 권위 차단(아카이브 무결성·영구 기록 누락 등)이 있으면 여전히 막는다 |
| 사유 사슬 | `requiresFullRebuild` 를 `episode_index_stale` 앞에 배치하고 `derived_schema_rebuild_required` / `full_rebuild_required` 로 구분 |
| `recordMaintenanceInspection` | 판정 입력(`requiresFullRebuild`, `requiresDerivedSchemaRebuildOnly`, `legacySanitizerRecords`, `liveChunkSchemaMismatch`, `sanitizerVersionMismatch`, `providerMismatch`, `missingVectors`, `dimensionMismatch`, `liveTurns`, `storedTurns`, `storageCorruptShards`, `externalRecords`)을 디버그에 기록 |
| GUI | `derivedRebuildPending` 이면 "턴 동기화 가능 + 파생 청크 재구축은 남아 있음"을 표시하고, 차단 시에는 문장 청크 스키마가 원인이며 전체 재구축은 로컬 모드에서 실행하라고 안내. 정제기 버전 행의 "전체 재구축 필요" 표기를 실제 원인(정제기 vs 청크)에 맞춤 |
| plan presentation | `server_turn_sync` + `derivedRebuildPending` 전용 배지/헤드라인 |

이 패치는 **서버 물리 재구축을 새로 허용하지 않는다**. 서버 모드가 원래 지원하는 동기화 경로를
과도하게 막고 있던 게이트만 바로잡고, 남은 재구축 요구는 숨기지 않고 표시한다.

## 5. 검증

- 신규 시험 `PROGRAM/tests/flashback_maintenance_derived_chunk_rebuild_test.cjs`
  - 기록에서 `chunkSchemaVersion` 을 제거한 서버 scope + 누락 턴 1개 →
    `requiresFullRebuild true`, `requiresDerivedSchemaRebuildOnly true`,
    `automatic.strategy 'server_turn_sync'`, `blocked false`, `derivedRebuildPending true`
  - 같은 scope 에서 누락 턴이 없으면 → `server_inspection_only`, `blocked true`,
    `reason 'derived_schema_rebuild_required'`(이전 코드의 `episode_index_stale` 아님)
  - 디버그 `maintenanceInspection.counts` 에 판정 입력이 남는지 확인
  - **패치 전 코드에서 이 시험은 실패(RED)**, 패치 후 통과
- 기존 유지보수 시험 묶음(신규 포함 10개 파일, 61개): **61/61 통과**.
  첫 실행에서 `server missing_turn recovery …` 1건이 `HEALTH_SERVER_CONNECTION_REQUIRED` 로
  실패했으나, 같은 파일 단독 2회·2파일 조합(양방향)·전체 묶음 재실행에서 모두 통과했다. 그 시험은
  30ms 창으로 bootstrap 을 의도적으로 겹치게 만드는 시험이라 긴 묶음 부하에서 경합한다(코드 회귀 아님).

## 6. 함께 발견한 별개 문제 (미수정)

`state.warnings` 에 startup 작업 3건이 `FLASHBACK_WRITER_BUSY` 로 실패해 있다.

- `legacy compacted source automatic recovery failed`
- `startup worldline restore / legacy migration scheduling failed`
- `external source retirement failed char:sp4of1|chat:p4gphl`

`flashback_writer_fences` 실측: 당시 alias `hj091` 의 fence 가 `expires_at 1793418244802` 까지
잡혀 있었다(단일 writer 직렬화). 즉 **다른 scope 쓰기가 끝나기 전에 시작한 startup 작업들이
재시도 없이 유실**된다. 유지보수 차단과는 별개 결함이므로 이번 패치에 넣지 않았다.

## 7. 사용자가 직접 할 수 있는 조치

1. 이번 버전에서 **상태 점검 → 실행** 을 누르면 누락 턴 동기화가 실행되어 기억이 5턴으로 늘어난다
   (기존 벡터 재사용, 신규 턴만 임베딩).
2. 파생 청크 스키마 재구축은 서버 모드에서 불가하므로, 원하면 Flashback 저장 모드를 로컬로
   전환한 뒤 전체 재구축을 실행한다(벡터 재사용 비용만 발생). 재구축 없이도 리콜은 계속 동작한다.
