# Librarian System 서버 연산 구현 보고서 및 후속 계획

저장 모드 관련 과거 판정은 2026-09-30의 [저장 모드 전환 계약](STORAGE_MODE_TRANSITION_CONTRACT.md)으로 대체된다. 정식 운영 모드는 `plugin_only`와 `server_only`이며, 미러는 전환 단계와 기존 자료의 호환 처리로만 해석한다.

작성 기준일: 2026-09-03  
범위: Compute Plane, Storage 스코프 정책 통합, 네 Owner의 bounded direct execute  
판정: **현재 스코프의 저장 방식 하나가 저장과 연산을 함께 결정한다. `plugin_only`는 로컬 연산, `mirror`와 `server_only`는 검증된 서버 연산 우선과 로컬 fail-open을 사용한다. 독립 Compute selector와 `shadow`는 제거되었다.**

## 1. 요구사항 반영 결과

### 서버 없이 플러그인 단독 연산

충족했다. Storage SDK가 현재 스코프를 `memory-suite.scope-execution-policy.v1`로 봉인하고, `plugin_only`를 `local`, `mirror`와 `server_only`를 `prefer_server`로 매핑한다. `local`은 Compute bootstrap이나 fetch를 호출하지 않는다. `prefer_server`도 서버·자동 인증·operation·deadline·검증 중 하나가 실패하면 동일 local executor를 정확히 한 번 실행한다.

Flashback 파일럿은 기존 browser Worker → main thread fallback 경로를 `hashEmbeddingBatchLocal`로 보존하고, 그 앞에 얇은 `hashEmbeddingBatch` Compute wrapper만 둔다. LIA는 기존 `rerankLoreEntries`, LIBRA는 기존 BM25F field projection과 local scorer, HAYAKU는 기존 `applyRrfFusion` facade와 sparse recall 경로를 보존한다. `prefer_server`는 현재 요청을 bounded `execute`로 위임하고 실패하면 각 local kernel을 정확히 한 번 실행한다. `local` 기본값에서는 네 플러그인 모두 Compute 네트워크가 0회다.

### LIBRA, HAYAKU, Flashback, LIA 동시 사용

구조적으로 병렬 실행이 가능하다. 네 플러그인의 bridge 호출은 서로 직렬화되지 않으며 서버는 하나의 shared Worker pool에서 여러 namespace job을 동시에 실행한다. 같은 lane에서 namespace round-robin과 첫 slot 보호가 적용되어 한 플러그인이 pool을 독점하지 못한다. interactive admission은 background/maintenance backlog를 자기 deadline 선행량으로 계산하지 않는다. 0.3.11부터 15초 aging이 lower lane의 무기한 대기를 막고, aged dispatch 다음 strict-priority 복원이 interactive 역기아를 막는다.

단, RisuAI가 같은 모델 요청의 `beforeRequest` 플러그인 훅을 순차적으로 await하는 경계는 바뀌지 않는다. 따라서 서로 다른 시점이나 background에서 동시에 제출된 작업은 병렬 실행되지만, 동일 요청의 네 foreground 작업이 반드시 동시에 서버에 도착한다고 보장하지 않는다.

다만 네 작업의 **물리적 4-way 동시 실행**을 보장하려면 `computeWorkers: 4` 이상을 설정해야 한다. 기본 `0`은 자동 선택이며 `min(4, availableParallelism - 1)`이므로 CPU 논리 병렬도가 4인 시스템에서는 Worker 3개가 된다. Worker 1개에서도 동시 접수와 공정 queue는 유지되지만 실행은 직렬이다.

### 단일 JS·GUI·훅·소유권 유지

충족 방향으로 구현했다. Compute SDK는 Flashback, LIA, LIBRA와 HAYAKU canonical source 안에 각각 한 번 embed되어 배포 플러그인은 계속 단일 JavaScript 파일이다. RisuAI 훅, GUI, branch/worldline/persona 소유권과 최종 저장은 플러그인에 남는다. 서버는 allowlist 순수 함수의 candidate만 반환한다.

## 2. 구현 전 전체 백업

구현 전 workspace 전체를 UTF-8 entry name을 보존하는 ZIP으로 백업하고, source와 archive의 모든 entry를 SHA-256으로 대조했다.

| 증거 | 값 |
|---|---|
| archive | `backups/20260828-143400_before_compute_plane_full_workspace.zip` |
| manifest | `backups/20260828-143400_before_compute_plane_full_workspace.manifest.csv` |
| verification | `backups/20260828-143400_before_compute_plane_full_workspace.verification.json` |
| archive SHA-256 | `1084bd74196d240eb5aba2b830fb133450aad00e9a9593a6623aa290aadce867` |
| source files / archive files | 730 / 730 |
| source total bytes | 996,381,103 |
| archive bytes | 397,996,598 |
| per-entry SHA-256 | verified |
| missing / mismatch / extra | 0 / 0 / 0 |
| Unicode entry names | preserved |

이 백업은 DATA와 runtime/auth 계열 민감 자료까지 포함한 로컬 복구용 전체 백업이다. 배포 ZIP 또는 외부 공유물로 사용하면 안 된다.

2차 구현 직전에는 `backups` 자체만 제외한 현재 workspace 310개 파일을 `backups/20260828-164532_before_lia_compute_jobs_full_workspace.zip`으로 다시 백업했다. 원본/ZIP 310개 항목의 SHA-256을 모두 대조했으며 missing/mismatch/extra는 0, archive SHA-256은 `9026450d5b5c9c16cffaab3fec3e9540ec0b5b3fdf672455b23487341aa29674`다.

3차 LIBRA 구현 직전에는 `backups` 자체만 제외한 현재 workspace 314개 파일을 `backups/20260828-174740_before_libra_bm25f_compute_full_workspace.zip`으로 백업했다. 원본/ZIP 314개 항목의 SHA-256을 모두 대조했으며 missing/mismatch/extra는 0, archive SHA-256은 `3540d5f8997c58bef4cafae6f1bea8b9bde4a07dd14eef274773601c439dedb4`다.

4차 HAYAKU 구현 직전에는 `backups` 자체만 제외한 현재 workspace 318개 파일, 813,260,408 bytes를 `backups/20260828-181455_before_hayaku_rrf_compute_full_workspace.zip`으로 백업했다. 원본/ZIP 318개 항목의 SHA-256을 모두 대조했으며 missing/mismatch/extra는 0, archive SHA-256은 `855990fa7f0f7e10efff632ec8245f7e93984a9a6dd51f15e82e665709a1e018`다.

5차 4-namespace 통합 부하 fixture 구현 직전에는 `backups` 자체만 제외한 현재 workspace 322개 파일, 813,459,366 bytes를 `backups/20260828-232242_before_four_namespace_compute_load_full_workspace.zip`으로 백업했다. 원본/ZIP 322개 항목의 SHA-256을 모두 대조했으며 missing/mismatch/extra는 0, archive SHA-256은 `1ee36f428bda5fade0ee5cc6f3513810e4013ef583a8914ae00c7001517502ed`다.

6차 Worker matrix/flood 구현 직전에는 `backups` 자체만 제외한 현재 workspace 324개 파일, 813,498,217 bytes를 `backups/20260828-234411_before_compute_worker_matrix_flood_full_workspace.zip`으로 백업했다. 원본/ZIP 324개 항목의 SHA-256을 모두 대조했으며 missing/mismatch/extra는 0, archive SHA-256은 `15caba8f5c8a41f73cb773f5f85739ea42e80f4bc71f5881aa52cc64b3ce0c61`다.

이번 current-request 패치 직전에는 PROGRAM, PLUGINS, root `SHA256SUMS.txt`와 `plan.md` 216개 항목을 `backups/20260829-001513_before_compute_review_patch_program_plugins.zip`으로 백업했다. archive 크기는 5,875,741 bytes이고 SHA-256은 `eceecf91ffcfcac4aeb6073fa20bf3171580c89727365f7a83b601f6654d0a6b`다.

## 3. 실제 구현 파일

### Compute client와 얇은 bridge

- `PROGRAM/sdk/MemorySuiteComputeClient.source.js`
  - Compute SDK v0.3.4
  - 실행 모드는 `local`, `prefer_server` 두 개이며 remote-only와 `shadow`는 없음
  - stable JSON input/result digest
  - operation/fingerprint/binding/result 검증
  - deadline의 일부를 local fallback에 예약
  - circuit breaker, auth 1회 재bootstrap, unload 미완료 Job 자동 cancel과 lifecycle dispose
  - 병렬 호출을 직렬화하지 않음
  - async Job 제출/상태/result/cancel과 memory-only verified derived cache
  - `execute`: 현재 요청의 bounded server candidate와 local reserve/fallback
  - `executeCachedOrLocal`: query-independent background derived cache용으로 계속 제공
- `PROGRAM/tools/sync_embedded_sdk.cjs`
  - Flashback, LIA, LIBRA와 HAYAKU에 Compute SDK를 정확히 한 번 embed하고 source/배포본 동기화할 수 있도록 확장
- `PROGRAM/tools/check_sdk_sync.cjs`
  - Flashback/LIA/LIBRA/HAYAKU Compute SDK marker와 canonical SDK exact sync 검증

### 서버 Compute Plane

- `PROGRAM/server/compute/contracts.cjs`
  - schema, stable JSON digest, lane/namespace/ID 검증, 기본 limit
- `PROGRAM/server/compute/registry.cjs`
  - namespace별 operation allowlist와 algorithm fingerprint
- `PROGRAM/server/compute/compute_worker.cjs`
  - allowlist operation만 실행하는 Worker entry
- `PROGRAM/server/compute/worker_pool.cjs`
  - 재사용 Worker pool, deadline/cancel 시 Worker retire 및 재생성, resource limit
- `PROGRAM/server/compute/fair_scheduler.cjs`
  - lane 우선순위, namespace round-robin, maintenance slot 제한, lane-aware admission 선행량
- `PROGRAM/server/compute/compute_plane.cjs`
  - job 접수, 실행, idempotency, retention, status/result/cancel, graceful close
- `PROGRAM/server/server.cjs`
  - Compute bootstrap/token/routes/health/CORS/launcher options와 동기 execute 연결 중단 취소

### Flashback 파일럿

- `PROGRAM/plugins/Flashback_Memory.js`
  - v1.0.25, 현재 Flashback 스코프의 Storage mode로 Compute route를 결정
  - 독립 Compute mode/pairing argument 없음
  - 기존 `hashEmbeddingBatchLocal` 보존
  - `flashback.hash-embedding-batch.v1` bridge 등록
  - result shape와 vector norm 검증
  - unload 시 Compute Bridge dispose

### LIA World Lore 파일럿

- `PROGRAM/plugins/LIA_Persona_Linker.js`
  - v0.26.61, 현재 LIA 스코프의 Storage mode로 Compute route를 결정
  - `lia.world-lore-rerank.v2`의 plain JSON snapshot과 compact candidate result
  - `prefer_server`는 현재 요청을 최대 1.2초 interactive execute로 위임하고 local에 최대 350 ms를 보존
  - scope/character/chat/persona/lore inventory/query/topK readback
  - 원래 lore 객체 materialization과 preview/result 채택은 LIA가 수행
  - unload 시 미완료 Job cancel과 fetch/cache/bridge dispose

### LIBRA Recall BM25F 파일럿

- `PROGRAM/plugins/LIBRA.js`
  - v2.3.20, 현재 LIBRA 스코프의 Storage mode로 Compute route를 결정
  - 기존 `bm25fScores`, 8개 field weight/length normalization, K1과 tokenizer를 local pure seam으로 보존
  - `prefer_server`는 현재 요청을 최대 1.5초 interactive execute로 위임하고 local에 최대 400 ms를 보존
  - scope/character/chat/U+A branch digest/manifest signature/query/candidate digest readback
  - 서버 결과는 ID/position/raw/normalized/evidence score candidate뿐이며 RRF/gate/MMR/passage/prompt 채택은 LIBRA가 수행
  - unload 시 미완료 Job cancel과 fetch/cache/bridge dispose

### HAYAKU sparse RRF 파일럿

- `PROGRAM/plugins/HAYAKU_Locator_Continuity.js`
  - v3.0.40, 현재 HAYAKU 스코프의 Storage mode로 Compute route를 결정하며 Recovery Journal 확인은 원장 GUI와 분리된 경량 오버레이로 표시; 독립 UI를 표시할 수 없으면 pending을 유지하고 호출하지 않음
  - 기존 RRF 수식과 동기 `applyRrfFusion` facade를 local pure seam으로 보존
  - composite recall의 RRF 호출만 `hayaku.sparse-rrf-fusion.v1` bounded interactive wrapper로 연결
  - `prefer_server`는 현재 요청을 최대 900 ms 위임하고 local에 최대 200 ms를 보존
  - scope/character-chat hash/visible transcript snapshot/clone fingerprint/worldline revision-head/query/row digest readback
  - 서버 결과는 position/파생 ID/RRF score candidate뿐이며 graph closure, packet cohesion, transition/conflict coverage, axis 선택과 prompt 채택은 HAYAKU가 수행
  - unload 시 미완료 Job cancel과 fetch/cache/bridge dispose

### 설정과 launcher

- `PROGRAM/tools/prepare_data.cjs`
  - `computeEnabled: true`, `computeWorkers: 0` 기본 config 보강
- `PROGRAM/tools/platform_launcher.cjs`
  - config 검증과 `--no-compute`, `--compute-workers` 전달

## 4. 주요 설계 결정

### 서버가 정본을 쓰지 않는다

Compute Worker는 registry 순수 함수만 실행하고 SQLite, namespace repository, filesystem을 import하지 않는다. 결과는 Memory Plane에 쓰지 않고 HTTP candidate로만 반환한다. `compute_server_integration_test`는 실행 전후 다섯 namespace DB digest가 같음을 확인한다.

서버 내부 signing key 생성과 일반 server diagnostics는 DATA config/log에 기록될 수 있다. 따라서 보장 범위는 “Compute operation이 canonical namespace SQLite를 변경하지 않는다”이다. signing key를 사용자가 복사하거나 입력하는 UI는 없고 구현하지 않았다.

### Storage와 Compute 인증을 분리한다

Storage token은 Compute route에서 거부되고 Compute token은 Storage route에서 거부된다. Compute token은 Storage runtime token과 별도인 서버 내부 signing key로 발급하며 30분 뒤 만료된다. principal은 compute role만 갖고 read/write namespace 배열은 비어 있다. 플러그인은 pairing 입력이나 Storage capability 없이 공식 owner ID로 Compute bootstrap을 직접 호출한다.

### 영구 job queue를 만들지 않는다

현재 job과 결과는 derived state이므로 메모리에만 둔다. canonical 데이터 손상과 복구 복잡도를 줄이는 대신 서버 재시작 시 job/result/idempotency record가 사라진다. 장기 maintenance job의 재시작 복구가 필요해지는 시점에 canonical store와 분리된 별도 derived job DB를 검토한다.

### local을 제품 본체로 유지한다

서버 kernel이 local kernel의 대체 원본이 아니다. 각 플러그인의 현재 알고리즘은 local executor로 남고, 동일 fingerprint의 서버 kernel은 선택적 가속기다. 이 경계 덕분에 서버 미작동, queue 포화, 자동 bootstrap 실패, 버전 불일치에서 기존 기능을 보존한다.

## 5. 네 플러그인 병렬 사용 분석

| 플러그인 | 현재/다음 서버 후보 | 플러그인에 남을 소유권 | 권장 lane |
|---|---|---|---|
| Flashback Memory | **현재 연결:** hash embedding batch. 다음: vector candidate rank/MMR | capture journal, worldline, durable capture, prompt injection | recall은 interactive, 재색인은 background |
| LIBRA | **현재 연결:** hydrated canonical candidate의 Recall BM25F sparse score. 다음: deterministic shortlist/packing | beforeRequest batch 현재성, branch, manifest, RRF/gate/MMR, provider 호출, candidate adoption/readback | bounded interactive execute + local fallback |
| HAYAKU | **현재 연결:** composite recall의 sparse RRF fusion. 다음: BM25F corpus/더 큰 composite kernel | visible U+A identity, nonce/parent/reroll, finalized binding, graph/packet/selection, Other Ax 호출 | bounded interactive execute + local fallback |
| LIA | **현재 연결:** World Lore query/rerank와 정규화된 순위 projection | persona binding, exact batch 현재성, Persona DB/asset 변경, provider key | bounded interactive execute + local fallback |

RE:TRACE는 네 플러그인 동시 사용을 조정하는 manager/검증자이므로 첫 CPU offload보다 read-only scope/archive catalog와 digest graph 검증이 적합하다. owner IPC, 사용자 승인과 durable handoff 완료 판정은 계속 RE:TRACE에 둔다.

### 병렬성의 실제 경계

- pool slot 수만큼 서로 다른 플러그인 operation이 동시에 실행된다.
- 동일 lane에서는 waiting namespace에 첫 active slot을 우선 제공한다.
- maintenance는 pool 전체를 차지할 수 없다.
- 기본 15초 aging은 지속적인 interactive 부하에서도 background/maintenance에 한 slot을 제공하고, aged dispatch 다음 strict priority 복원은 interactive 역기아를 차단한다.
- 큰 input을 네 플러그인이 동시에 보내면 32 MiB queue byte limit과 Worker별 heap limit이 먼저 작동할 수 있다.

따라서 4-plugin 동시 운용의 권장 초기값은 Worker 4, interactive payload 소형화, 장기 색인 작업 background/maintenance 분리, plugin별 p95 queue/worker/total 시간 계측이다.

## 6. 현재 production operation

### Flashback hash embedding batch

Operation: `flashback.hash-embedding-batch.v1`  
Fingerprint: `0beced005ede9fec5b1ba181f740440daf47184ad321301bcb3fab9c2ff7b3ed`

Local과 서버 모두 FNV-1a UTF-16 code-unit hash, lower-case tokenization, token 및 2..4 character gram, 최대 4,000 grams, length weight, L2 normalization을 사용한다.

Server limit은 texts 512개, 총 2,000,000 chars, dimensions 64..4096, 총 vector cell 262,144다. plugin wrapper는 기존 vectors-only 반환 계약을 유지한다.

### LIA World Lore rerank

Operation: `lia.world-lore-rerank.v1`  
Fingerprint: `1d0bc7d9f29addbf2f7f4dadb16945920ac80502958262d90567359a141dc1bd`

Local과 서버는 같은 tokenization, protection rule, lexical/domain/legacy/protection 가중치와 stable input-position tie-break를 사용한다. 서버는 최대 600개의 정규화 entry와 총 2,000,000 chars를 받고 compact candidate만 반환한다. LIA는 결과 position/lore ID를 원래 객체와 다시 대조하여 materialize하고, Persona DB나 asset을 서버가 변경하지 못하게 한다.

### LIBRA Recall BM25F

Operation: `libra.recall-bm25f.v1`  
Fingerprint: `dea19e8a1c43caf8050d8225b15bf5a0d755a9974a56d22b996b4c4826c120fd`

Local과 서버는 같은 NFKC/lower/zero-width 정규화, Unicode word token, Korean bigram, Han/Hiragana/Katakana script-run bigram, 전체 token 상한 1,600개, query unique token 160개, 8개 field weight와 length normalization, K1 1.2, exponential evidence projection을 사용한다. 순수 CJK 장문 전체는 강한 단일 토큰에서 제외한다. 서버는 최대 64개 후보와 총 6,000,000 chars를 받고 입력 순서의 compact score candidate만 반환한다. LIBRA가 현재 branch와 manifest를 재확인하고 기존 RRF 이후 경로에만 점수를 합친다.

### HAYAKU sparse RRF fusion

Operation: `hayaku.sparse-rrf-fusion.v1`  
Fingerprint: `7f32e8b10fdd34e8356af70e40ad90d3c48e6fda132080046a807db0ea3ec58f`

Local과 서버는 sparse 7개 독립 signal 또는 legacy fallback 6개 signal을 선택하고 stable input-position rank, `k=60`, max normalization, `blend=0.12`, 1.35 boost/clamp와 4자리 breakdown을 사용한다. 서버는 최대 256개 row의 숫자 projection만 받고 compact score candidate를 반환한다. HAYAKU가 현재 visible transcript와 worldline을 재확인하고 packet cohesion 이후 선택 경로에만 점수를 합친다.

### Common kernel

`common.sha256-batch.v1`과 `common.vector-rank.v1`도 registry에 있지만, 현재 네 플러그인의 제품 경로 중 이 common kernel을 직접 채택하는 bridge는 아직 없다. 이를 “네 플러그인 연산 이전 완료”로 계산하지 않는다.

## 7. 남은 라이브 검증

### 1단계: Flashback

1. `plugin_only`의 zero-network와 기존 recall/capture 회귀를 확인한다.
2. `mirror`와 `server_only`에서 검증된 서버 vector 채택과 서버 장애 시 로컬 1회 복귀를 확인한다.
3. server off, queue full, timeout, Worker crash, unload를 실제 RisuAI에서 확인한다.

### 2단계: LIA World Lore

1. `worldLoreQuery`와 `rerankLoreEntries` 입력을 plain JSON snapshot으로 분리했다.
2. scope/character/chat/persona와 lore inventory/query digest를 owner binding에 포함했다.
3. 서버는 ranked candidate와 score reasons만 반환한다.
4. LIA가 현재 binding을 재확인하고 원래 lore 객체에 materialize한 뒤에만 preview/result에 사용한다.
5. 실제 RisuAI에서 plugin-only/mirror/server-only 및 lore/persona 변경 중 늦은 결과 폐기를 검증해야 한다.

### 3단계: LIBRA BM25F

1. Recall Catalog hydration 이후의 `bm25fScores`를 더 작은 pure seam으로 고정했다.
2. query와 canonical 후보 ID/8개 sparse field를 plain JSON snapshot으로 만든다.
3. 서버는 점수 후보만 반환하고 weighted RRF와 passage offset 경계는 LIBRA에 남겼다.
4. scope/character/chat, U+A branch digest와 active manifest signature를 LIBRA가 재검증한 뒤에만 현재 서버 응답을 채택한다.
5. 실제 RisuAI에서 plugin-only/mirror/server-only 및 reroll/manifest 변경 중 늦은 결과 폐기를 검증해야 한다.

### 4단계: HAYAKU RRF

1. sparse/fallback rank signal과 base score만 입력으로 하는 RRF fusion pure seam을 분리했다.
2. visible transcript snapshot, clone fingerprint, scope와 worldline revision/head는 계산 input과 분리된 owner binding에 둔다.
3. 서버는 position/ID/RRF score breakdown candidate만 반환한다.
4. HAYAKU가 현재 visible transcript와 worldline identity를 재확인하고 불일치 결과를 폐기한다.
5. 실제 RisuAI에서 plugin-only/mirror/server-only 및 edit/reroll/rollback 중 늦은 결과 폐기를 검증해야 한다.

### 5단계: 통합 부하 시험 — Worker matrix와 flood/bounded soak 완료

1. `compute_four_namespace_product_load_test.cjs`는 테스트용 spin이 아니라 Flashback hash embedding, LIA World Lore, LIBRA BM25F와 HAYAKU sparse RRF를 각 3회씩 총 12개 background Job으로 제출한다.
2. Worker 4개에서 5회 연속 실행한 결과 모두 네 namespace의 Worker 실행 구간이 실제로 겹쳐 `peakNamespaces=4`였다.
3. 각 실행에서 첫 round의 서버 결과와 같은 실제 local kernel 결과를 exact 비교하고, Compute 실행 전후 canonical SQLite 본체와 WAL digest가 모든 namespace에서 같음을 확인한다.
4. Compute 부하 중 Storage health와 기존 KV read가 완료되며 보강 후 8회 표본의 Storage 왕복은 3.34~36.61 ms였다.
5. 5회 표본의 operation별 worker p95 범위는 Flashback 43~45 ms, LIA 43~44 ms, LIBRA 53~54 ms, HAYAKU 2~3 ms였다. 이는 현재 localhost fixture의 작은 표본이지 live RisuAI 성능 보장이 아니다.
6. 공용 `compute_product_load_fixture.cjs`로 실제 네 kernel 입력, compute-only identity, 제출/상태/result, local parity, SQLite+WAL digest와 timing 집계를 재사용한다.
7. Worker 1/2/4/8 matrix에서 12 jobs의 peak namespace 수는 각각 1/2/4/4였고 처리량 계수는 첫 집중 실행에서 0.764/1.136/1.378/1.448이었다. Worker 8은 Worker 4보다 증가가 작고 RSS peak delta가 커 현재 자동 상한 4를 변경하지 않는다. 단일 host·단일 실행의 상대값이므로 일반 성능 보장은 아니다.
8. Worker 2개를 실제 Flashback background 8 jobs로 채운 뒤 HAYAKU interactive를 제출한 반복 6회에서 interactive queue는 6~8 ms, total은 16~19 ms였고 매번 대기 중인 다음 Flashback job보다 먼저 시작했다. 이는 이미 실행 중인 background를 중단한 것이 아니라 다음 빈 slot의 비선점 우선순위다.
9. 이어서 실제 네 kernel 6 waves/24 jobs의 bounded soak를 수행해 686.71~724.13 ms에 완료했고 peakJobs/peakNamespaces는 2/2였다. flood와 bounded soak 전체에서 canonical SQLite+WAL은 불변이며 RSS peak delta 표본은 322.45~390.57 MiB였다.
10. 0.3.11에서 scheduler aging과 aged-dispatch 뒤 strict-priority 복원을 추가했다. 장시간 soak, 장기 retention/prune 뒤 RSS, 실제 RisuAI hook p95/p99와 weighted deficit scheduling 필요성은 후속 계측 대상으로 남는다.

## 8. 자동시험 경계

다음 시험은 현재 workspace에서 Node로 다시 실행하여 모두 PASS를 확인했다.

- `compute_bridge_test.cjs`
- `compute_background_job_cache_test.cjs`
- `compute_bridge_server_integration_test.cjs`
- `compute_failure_isolation_test.cjs`
- `compute_token_key_separation_test.cjs`
- `compute_hash_embedding_parity_test.cjs`
- `compute_server_integration_test.cjs`
- `compute_worker_pool_parallel_test.cjs`
- `compute_four_namespace_product_load_test.cjs`
- `compute_product_worker_matrix_test.cjs`
- `compute_product_flood_latency_test.cjs`
- `compute_graceful_shutdown_test.cjs`
- `launcher_compute_config_contract_test.cjs`
- `flashback_hash_embedding_batch_pilot_test.cjs`
- `lia_world_lore_compute_pilot_test.cjs`
- `lia_world_lore_compute_server_integration_test.cjs`
- `libra_recall_bm25f_compute_pilot_test.cjs`
- `libra_recall_bm25f_compute_server_integration_test.cjs`
- `libra_recall_bm25f_product_server_integration_test.cjs`
- `hayaku_sparse_rrf_compute_pilot_test.cjs`
- `hayaku_sparse_rrf_compute_server_integration_test.cjs`
- `hayaku_sparse_rrf_product_server_integration_test.cjs`

이 시험들이 확인한 경계는 다음과 같다.

- `plugin_only`의 local zero-network와 server-off local fallback
- `plugin_only → local`, `mirror/server_only → prefer_server` 스코프 정책
- bounded direct execute, 검증된 현재 응답 채택과 local fallback
- LIA World Lore local/server exact parity, 현재 binding 재검증과 원래 lore 객체 materialization
- LIBRA BM25F local/server exact parity, 현재 요청 server 채택, branch 변경 시 local fallback
- HAYAKU sparse RRF 기존 수식/local/server exact parity, 현재 요청 server 채택, visible transcript/worldline 변경 시 local fallback
- pairing header 없이 Compute endpoint에 직접 자동 인증. 통합 GUI와 미러 제품 경로는 Storage 연결도 함께 확인
- 30분 Compute token의 자동 재bootstrap과 Storage token 상호 거부
- 구 pairing 파일은 플러그인 입력 없이 서버 내부 signing key로 이관하고 원본을 보존
- 실제 Compute server와 bridge 계약
- Compute/Storage token key 분리와 cross-namespace 차단
- Flashback hash Unicode/dimension exact parity
- 같은 operationId replay와 다른 payload 409
- namespace DB digest 불변
- Worker pool의 실제 overlap, namespace 공정성, maintenance slot 제한
- 네 실제 product kernel 12-job 부하에서 4-namespace overlap, exact local/server parity, queue/worker/total timing과 Storage read 응답
- Worker 1/2/4/8 실제 연산 matrix, physical peak concurrency와 RSS 계측
- 한 namespace background flood 중 다른 namespace interactive next-slot 우선과 24-job bounded soak
- graceful shutdown과 bounded Worker 종료
- launcher compute config 검증

LIBRA BM25F background Compute 연결 후 `PROGRAM/tests`의 전체 120개 시험을 같은 workspace에서 다시 실행했다. 결과는 `114 PASS / 5 FAIL / 1 TIMEOUT`이며 새 LIBRA/Compute 시험과 기존 Compute 시험은 모두 PASS했다. 전체 실행 원문은 workspace root의 `FULL_TEST_EXECUTION_LOG_20260828_LIBRA_BM25F_COMPUTE_0.3.2.txt`에 보존했다.

HAYAKU sparse RRF background Compute 연결 후 전체 시험은 123개로 늘었다. 같은 workspace에서 다시 실행한 결과는 `117 PASS / 5 FAIL / 1 TIMEOUT`이며, 신규 HAYAKU 3개 시험과 기존 Compute 시험은 모두 PASS했다. HAYAKU 관련 19개 집중 회귀도 `19/19 PASS`였다. 전체 실행 원문은 workspace root의 `FULL_TEST_EXECUTION_LOG_20260828_HAYAKU_RRF_COMPUTE_0.3.3.txt`에 보존했다.

4-namespace 실제 product-kernel 부하 fixture는 동일 host에서 5회 연속 PASS했다. 세 round의 local 직렬 등가 시간 대비 Worker 4개의 실제 서버 처리량 계수는 HTTP/JSON/queue 비용을 포함해 1.35~1.41배였고, server wall time은 282.56~293.77 ms였다. 이 수치는 회귀 fixture 입력에만 해당하며 실사용 대화나 다른 CPU의 성능값으로 일반화하지 않는다.

집중 반복, Compute 묶음과 전체 회귀를 합치면 보강된 4-namespace fixture는 8회 연속 PASS했다. fixture 추가 후 `PROGRAM/tests`의 전체 124개 시험 결과는 `118 PASS / 5 FAIL / 1 TIMEOUT`이며 새 시험을 포함한 Compute 시험 10개는 모두 PASS했다. 전체 실행 원문은 workspace root의 `FULL_TEST_EXECUTION_LOG_20260828_FOUR_NAMESPACE_LOAD_0.3.3.txt`에 보존했다.

Worker matrix와 flood/bounded-soak 시험 추가 후 전체 시험은 126개다. 결과는 `120 PASS / 5 FAIL / 1 TIMEOUT`이며 Compute 시험 12개는 모두 PASS했다. 비통과 6개는 직전 기준선과 동일하며 전체 실행 원문은 workspace root의 `FULL_TEST_EXECUTION_LOG_20260828_WORKER_MATRIX_FLOOD_0.3.3.txt`에 보존했다.

0.3.4 current-request 패치에서는 LIBRA/HAYAKU/LIA의 실제 product runtime이 첫 `prefer_server` 호출부터 `/v1/compute/execute`의 검증된 응답을 채택하고, 연결 실패 시 local을 정확히 한 번 실행하는 계약으로 바뀌었다. 동기 execute 연결 중단 취소, unload Job 취소, lane-aware interactive admission, 수동 Compute credential argument 부재를 집중 시험으로 검증했다. 최종 전체 126개 회귀 결과는 기존 기준선과 같은 `120 PASS / 5 FAIL / 1 TIMEOUT`이며 원문은 workspace root의 `FULL_TEST_EXECUTION_LOG_20260829_CURRENT_REQUEST_COMPUTE_0.3.4.txt`에 보존한다.

0.3.5는 제품 표시명을 `Librarian System`으로 전환하고 단일 크로스 플랫폼 clean 배포 빌더를 추가했다. `memory-suite.*` schema, `MEMORY_SUITE_*` 환경변수/헤더, `MemorySuite*` SDK 함수와 저장 키는 기존 DATA/플러그인 호환성을 위해 유지한다. 빌더는 현재 DATA를 읽거나 복사하지 않고 fresh-distribution DATA만 생성하며, token/signing key/SQLite/WAL/SHM/scope catalog/log/migration/backup을 거부한다. ZIP은 UTF-8 이름과 POSIX 실행 권한을 직접 기록하고 archive readback으로 content digest와 mode를 검증한다. Windows 자동 런타임 설치는 x64와 ARM64를 공식 SHA-256으로 구분한다.

후속 코드 리뷰에서는 PROGRAM 고정 top-level allowlist와 민감 파일 deny 규칙, clean config/layout exact schema 검증, 필수 배포 시험, 시험 후 체크섬 재검증을 추가했다. ZIP readback은 EOCD 경계, UTF-8 재인코딩, portable name collision, 중앙/로컬 header 일치, entry bounds·gap·overlap까지 확인한다. Windows 런타임 설치기는 검증된 `22.16.0` 외의 버전 입력을 거부한다.

0.3.5 개칭 직후 전체 회귀는 128개 중 `123 PASS / 4 FAIL / 1 TIMEOUT`이었다. 후속 코드 리뷰에서 Windows가 읽기 전용 파일 핸들의 `FlushFileBuffers`를 `EPERM`으로 거부한다는 원인을 재현했다. Restore staging 파일을 바꾸지 않으면서 쓰기 권한을 갖는 `r+` 핸들로 `fsync`하도록 수정해 내구성 장벽을 유지했고, 관련 5개 시험을 모두 복구했다. 최종 전체 회귀는 `128 PASS / 0 FAIL / 0 TIMEOUT`이며 원문은 workspace root의 `FULL_TEST_EXECUTION_LOG_20260829_LIBRARIAN_SYSTEM_CODE_REVIEW_0.3.5.txt`에 보존한다.

0.3.6은 네 Compute owner 플러그인의 Server 페이지에 공용 GUI mode control을 추가한다. 설정은 플러그인 전역이며 Storage mode와 독립적이고, 사용자 token·pairing 입력 없이 기존 자동 Compute bootstrap을 사용한다. 모드 적용은 비로컬 모드에서 background probe를 한 번 예약하고 명시적인 연결 확인만 forced probe를 수행한다. LIBRA는 fullscreen host RPC와 canonical job status 조회를 첫 paint/navigation의 선행 조건에서 제거하고, Server 페이지의 Storage/Compute mount를 독립적으로 예약한다.

0.3.6 최종 정적·mock·server integration 회귀는 `129 PASS / 0 FAIL / 0 TIMEOUT`이다. 여기에는 GUI 비차단 계약, 네 namespace 병렬 Worker 부하, Compute 자동 인증과 credential 분리, server failure 격리, plugin_only 네트워크 0회, Storage/Compute server integration, 배포 레이아웃과 체크섬 검증이 포함된다. 실제 RisuAI Tauri 창에서 패치 후 체감 first paint와 실제 사용자 DATA/provider 동작은 별도 live 검증 경계로 남는다.

0.3.7은 RE:TRACE 서버 데이터 관리의 스코프 다중 선택·보존 증명·조건부 삭제와 검증 기반 복구 페어링을 추가한다. 복구 페어링은 안정적으로 두 번 확인한 RisuAI 채팅 목록, 현재 열린 정확한 대상 chat ID, 같은 캐릭터, 메시지 수와 제한된 대화 지문을 검증한 뒤에만 기록한다. 모든 대상 삭제는 각각의 Owner가 정확한 서버 키를 pluginStorage/local에 복원하고 durable readback을 증명한 뒤에만 계획된다. 페어링은 원본 레코드를 추측한 대상 스키마로 재작성하지 않으며 원본과 복원 사본을 보존한다.

Owner capability 탐색은 저장 모드의 비동기 조회를 기다리지 않고 캐시된 상태를 사용한다. RE:TRACE의 명시적 서버 새로고침은 짧은 bootstrap 실패 캐시와 분리된 최대 5초 연결 검사를 먼저 수행하며, HAYAKU Owner 응답이 없더라도 서버 namespace의 읽기 전용 색인은 생략하지 않는다. Flashback 색인은 GUI registry 요약을 우선 사용하고 대형 manifest를 목록 판정용으로 선취하지 않는다.

0.3.7 최종 정적·mock·localhost server integration 회귀는 `130 PASS / 0 FAIL / 0 TIMEOUT`이다. 원문은 package 바깥의 `FULL_TEST_EXECUTION_LOG_20260829_SCOPE_MANAGER_0.3.7.txt`에 보존한다. 실제 RisuAI Tauri 화면에서 개인 DATA를 이용한 페어링·다중 삭제·체감 로딩 시간은 수행하지 않았으며 별도 live 승인 경계로 남는다.

0.3.8은 Flashback 1.0.12의 스코프 레지스트리 안전 경계를 보강한다. GUI hydration은 manifest가 물리적으로 존재한다고 확인된 경우에만 이름·카운트·업데이트 시각을 write-through하며, 연결 실패나 빈 조회는 기존 메타데이터를 낮추지 않는다. 한 Storage transport 실패 뒤에는 같은 화면의 나머지 manifest 연속 스캔을 중단한다. 명시적 `목록 검사·복구`는 서로 다른 epoch에서 두 번 연속 부재가 확인된 항목만 registry-only로 분류하고, 삭제 직전 manifest 및 scope/vector 물리 키 재검사와 registry readback을 통과한 경우에만 레지스트리 행을 제거한다. 이 경로는 canonical 기억·샤드·벡터 키를 삭제하지 않는다.

0.3.8 최종 정적·helper behavior·mock·localhost server integration 회귀는 `131 PASS / 0 FAIL / 0 TIMEOUT`이다. 전체 실행 원문은 package 바깥의 `FULL_TEST_EXECUTION_LOG_20260829_FLASHBACK_SCOPE_REGISTRY_0.3.8.txt`에 보존한다. 실제 RisuAI Tauri 화면과 개인 DATA에 대한 목록 복구·정리 동작은 수행하지 않았으며 별도 live 승인 경계로 남는다.

0.3.9는 RE:TRACE 1.9.62와 Flashback 1.0.13을 통해 서버 공유 레지스트리 한 줄만 남은 순수 빈 껍데기를 별도로 처리한다. RE:TRACE는 동일 entry fingerprint에서 두 번 연속 manifest·scope key·local vector key·tombstone 부재를 확인하기 전에는 `확인 불가`로 유지한다. 검증된 껍데기는 복구 페어링에서 제외하고, Flashback Owner가 서버를 다시 두 번 검사하며 local pluginStorage/vector 저장소에도 물리 데이터가 없음을 증명한다. 현재 스코프와 server_only는 차단되고, 로컬 공유 레지스트리의 형제 행 readback을 통과한 뒤에만 기존 서버 DB 백업·revision/digest 조건부 rewrite가 실행된다.

0.3.9 최종 정적·helper behavior·mock·localhost server integration 회귀는 `131 PASS / 0 FAIL / 0 TIMEOUT`이다. 전체 실행 원문은 package 바깥의 `FULL_TEST_EXECUTION_LOG_20260829_FLASHBACK_EMPTY_SERVER_SHELL_0.3.9.txt`에 보존한다. clean 크로스 플랫폼 배포본은 개인 DATA를 읽거나 복사하지 않은 상태로 생성하고 ZIP 내부 체크섬·UTF-8 파일명·Unix 실행 권한을 재검증한다. 실제 RisuAI Tauri 화면에서 개인 DATA의 빈 껍데기를 삭제하는 동작은 수행하지 않았으며 별도 live 승인 경계로 남는다.

## 9. 수정된 baseline과 미검증 경계

### 기존 Windows restore 실패의 수정

구현 전 전체 실행 로그 `FULL_TEST_EXECUTION_LOG_89.partial.txt`부터 반복되던 아래 다섯 비통과 결과는 이번 코드 리뷰에서 원인을 분리하고 수정했다.

- Windows restore `fsync`의 `EPERM: operation not permitted` 계열: 읽기 전용 `r` 핸들을 `r+`로 변경한 뒤 `admin_offline_restore_test.cjs`, `recovery_safe_mode_test.cjs`, `server_integration_test.cjs`, `server_restore_safety_test.cjs`, `restore_sigkill_recovery_test.cjs`가 모두 PASS한다.
- 기존 `launcher_safety_regression_test.cjs`의 Windows-host Android path simulation 실패는 target-platform POSIX path 정규화로 수정되어 현재 PASS한다. 실제 `/storage`, `/sdcard`와 Termux 내부 허용 경계를 다시 검증한다.

Compute 전용 시험, 복구 시험, `cross_platform_launcher_test.cjs`, `launcher_safety_regression_test.cjs`, `distribution_builder_test.cjs`, `librarian_system_brand_contract_test.cjs`, `distribution_metadata_coherence_test.cjs`를 포함한 현재 CJS 회귀 219개는 모두 PASS한다. 별도 LIBRA Narrative JS 계약시험 2개도 모두 PASS한다. 이 결과에는 Storage scope 정책의 `plugin_only → local`, `mirror/server_only → prefer_server` 매핑, 네 Owner의 제품 호출부, localhost Compute 서버 통합, plugin-only 네트워크 격리, SDK exact sync와 배포 레이아웃 검사가 포함된다. 배포 metadata 시험은 실제 플러그인·SDK 헤더, Compute operation/fingerprint, `program-manifest.json`, 최상위 설치 안내와 패키지 안내가 서로 다르면 빌드를 차단한다.

공식 배포 도구는 개인 DATA를 포함하지 않는 clean ZIP을 생성하고, ZIP 해제본에서 SDK sync·배포 레이아웃·Storage/Compute 정적 및 런타임 정책 시험을 다시 통과시켰다. 빌드 보고서 SHA-256과 실제 ZIP readback도 일치한다.

### 수행하지 않은 검증

- 실제 RisuAI Web/Tauri/PocketRisu에서 네 플러그인 동시 설치
- 실제 committed-output/beforeRequest lifecycle의 지연과 순서
- 실사용 대화에서 branch/reroll 도중 늦은 서버 결과 폐기
- 실제 provider/embedding endpoint 및 billing
- 네 plugin workload의 장시간 soak, memory pressure와 live p95/p99 latency
- GUI에서 스코프별 저장·연산 통합 설정의 최종 사용자 경험

따라서 현재 증거는 정적 계약, Node fixture/mock, 실제 localhost server 통합과 Worker 병렬성까지다. live RisuAI 동작을 검증 완료로 표현하면 안 된다.

## 10. 버전 상태

Compute Protocol 문서 버전은 1.2이고 Compute SDK 소스는 v0.3.4다.

현재 canonical source는 Librarian System 서버 `0.3.17`, Storage SDK `1.8.14`, Compute SDK `0.3.4`, Flashback `1.0.25`, LIA `0.26.61`, LIBRA `2.3.24`, HAYAKU `3.0.42`, RE:TRACE `1.9.65`다. 서버 API와 operation kernel은 변경하지 않았다. `program-manifest.json`과 source `SHA256SUMS.txt`는 변경 가능한 실사용 DATA를 제외한다.

## 결론

요청한 방향인 “플러그인의 단일 JS 형식·GUI·훅·소유권을 유지하고 계산 호출부에 얇은 bridge만 추가”하는 기반은 구현되었다. 서버를 끄면 기존 local 계산이 남고, 서버를 켜면 shared Worker pool에서 namespace 공정성을 적용해 병렬 계산할 수 있다.

현재 완료 범위는 공통 Compute Plane, Storage 스코프별 실행 정책, 통합 설정 GUI, bounded direct execute와 local fallback, 비동기 Job/검증 캐시, Flashback hash, LIA World Lore, LIBRA Recall BM25F, HAYAKU sparse RRF 파일럿이다. 사용자 token·pairing·독립 Compute mode 입력 경로는 없다. 다음 단계는 실제 RisuAI에서 plugin-only/mirror/server-only 전환과 장애 복귀를 확인하는 것이다.

---

## 0.3.11 성능·추론 안정화 구현

현재 canonical source는 Librarian System Server `0.3.17`, Storage Protocol `1.9`, Storage SDK `1.8.14`, Compute Protocol `1.2`, Compute SDK `0.3.4`, Flashback `1.0.25`, HAYAKU `3.0.42`, LIBRA `2.3.24`, LIA `0.26.61`, RE:TRACE `1.9.65`다.

Storage read는 namespace·space·prefix-bound key pagination(기본 400, 최대 1000)과 4 MiB 기본 batch response budget(256 KiB–8 MiB)을 사용한다. 예산보다 큰 단일 record는 SQLite byte metadata로 JSON 파싱 전에 분류해 개별 GET으로 회수하며, 4 MiB를 넘는 단일 interactive mutation은 owner shard/manifest 사용을 요구한다. 기존 무페이지 요청은 호환되지만 대형 무페이지 batch 응답은 413으로 제한한다.

Compute scheduler는 기본 15초 aging과 aged-dispatch 뒤 strict-priority 복원을 적용한다. RE:TRACE 서버 스코프 관리 화면은 60개씩 DOM을 렌더링하며, Flashback·HAYAKU·LIBRA portable JSON 작업은 가능한 환경에서 Blob Worker와 transferable UTF-8 buffer를 사용한다.

LIBRA 정본과 SGA는 물리 호출·wall time·input/output/reasoning/total token 전역 예산을 사용한다. provider fallback과 artifact repair는 단계별 한 번의 corrective ledger를 공유하며, ito는 초기 호출 뒤 JSON·schema·hash·적용 오류를 합친 authoritative repair 한 번만 수행한다. optional ito 실패 시 직전 유효 draft를 보존한다.

세부 계약과 검증 범위는 `IMPLEMENTATION_0.3.11.md`에 정리한다. 실제 개인 RisuAI Tauri 세션의 Performance trace는 별도 live 검증 경계로 남는다. 최종 CJS 회귀는 138개 전부 PASS했으며 실패와 timeout은 없었다.
