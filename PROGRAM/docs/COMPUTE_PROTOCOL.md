# Librarian System Compute Protocol 1.2

상태: 구현 기준 문서  
작성 기준일: 2026-09-03  
적용 범위: Librarian System 백엔드와 LIBRA, HAYAKU, Flashback Memory, LIA 소유 플러그인. RE:TRACE는 Storage 관리만 사용한다.

## 1. 목적과 비목표

Compute Protocol은 플러그인의 단일 JavaScript 배포 형식, GUI, RisuAI 훅, 데이터 소유권을 유지하면서 결정론적이고 순수한 계산 일부를 Librarian System 서버의 Worker pool에 위임하는 선택적 프로토콜이다.

서버 결과는 항상 **비정본 계산 후보(non-canonical candidate)** 다. 서버는 플러그인의 canonical key, worldline, branch, persona, prompt injection 또는 최종 채택 상태를 직접 변경하지 않는다. 입력 스냅샷 확정, binding 생성, 결과 재검증, 최종 채택과 영구 저장은 owner 플러그인이 수행한다.

다음은 이 프로토콜의 비목표다.

- iframe 안의 임의 JavaScript 클로저, DOM 또는 RisuAI API 프록시를 서버에서 실행하지 않는다.
- 임의 코드, `eval`, 모듈 경로, 파일 경로, shell 명령을 요청으로 받지 않는다.
- provider credential을 기본적으로 서버로 이동하지 않는다.
- 서버가 없을 때 계산이 불가능한 `remote_only` 모드를 만들지 않는다.
- Storage Protocol 1.9의 opaque data ownership을 변경하지 않는다.

## 2. 필수 불변식

1. 모든 등록 operation에는 플러그인 안의 local executor가 있어야 한다.
2. Compute mode는 사용자가 별도로 고르지 않는다. 정식 Storage mode가 `plugin_only`이면 `local`, `server_only`이면 `prefer_server`로 고정된다. `mirror`는 전환 단계이며 이동 중에는 기존 정본 모드의 연산 정책을 유지한다. 과거 미러 설정은 전환 완료 전까지 기존 `prefer_server` 호환 정책을 유지한다.
3. 서버가 꺼졌거나 자동 bootstrap 또는 Worker가 실패해도 `local`과 `prefer_server`의 local fallback은 유지된다.
4. 서버 후보는 operation, namespace, algorithm fingerprint, input digest, binding echo, result digest, result shape 검증을 통과해야 한다.
5. branch, revision, nonce, parent, reroll, persona binding처럼 의미가 있는 현재성 판단은 플러그인이 재검증한다.
6. Compute token에는 storage read/write 권한이 없고 Storage token에는 compute 권한이 없다.
7. Compute Plane은 다섯 canonical namespace SQLite 파일을 읽거나 쓰지 않는다.

## 3. Compute mode

| 모드 | 채택 결과 | 네트워크 | 실패 동작 |
|---|---|---|---|
| `local` | local executor | 0회 | local 오류를 호출자에게 전달 |
| `prefer_server` | 검증된 직접 응답 또는 현재 binding과 일치하는 검증 캐시 후보 | 서버 요청 또는 background Job | 직접 요청 실패 또는 cache miss에서는 local executor를 정확히 한 번 실행 |

인식되는 공식 실행 모드는 위 두 가지뿐이다. 과거 `shadow`, 알려지지 않은 값과 `remote_only` 계열 값은 `local`로 정규화된다.

Compute mode는 Storage mode에서 파생되는 읽기 전용 정책이다.

| 현재 스코프 Storage mode | 저장 위치 | 파생 Compute mode |
|---|---|---|
| `plugin_only` | RisuAI pluginStorage/로컬 저장소 | `local` |
| `server_only` | Librarian System DATA 영구 정본 | `prefer_server` |

저장 위치 이동과 기존 미러 설정의 완료 조건은 [저장 모드 전환 계약](STORAGE_MODE_TRANSITION_CONTRACT.md)을 따른다.

주의할 점은 다음과 같다.

- Storage가 `plugin_only`이면 Storage 및 Compute 네트워크 호출은 모두 0회다.
- Compute가 `prefer_server`여도 서버 연결 또는 capability bootstrap에 실패하면 계산은 local로 복귀한다.
- Storage가 `server_only`인 상태에서 서버 전체가 꺼지면 계산 자체는 local fallback이 가능하지만, 해당 플러그인의 정본 저장·조회는 Storage의 fail-closed 정책 때문에 실패할 수 있다. local 계산 가능성과 server-only 데이터 가용성을 동일한 보장으로 해석하면 안 된다.

## 4. 서버 활성화와 Worker 수

서버 Compute Plane은 기본 설정에서 활성화된다. 새 스코프의 Storage 기본값은 `plugin_only`이므로 연산도 `local`이다. 해당 스코프의 서버 단독 전환이 완료되면 플러그인이 `prefer_server`를 사용한다. 별도 Compute selector, token 또는 pairing key 입력은 없다.

- 서버 비활성화: `--no-compute` 또는 server config의 `computeEnabled: false`
- Worker 고정: `--compute-workers 1..16` 또는 `computeWorkers: 1..16`
- `computeWorkers: 0`: 자동 선택
- 자동 pool 크기: `min(4, max(1, availableParallelism - 1))`, 최종 범위 1..16

네 플러그인의 작업을 물리적으로 동시에 네 개 실행해야 한다면 `computeWorkers: 4` 이상을 명시한다. 자동값은 CPU 논리 병렬도가 4인 시스템에서 3이 될 수 있고, Worker가 1개이면 queue 병행 접수는 가능하지만 CPU 실행은 직렬이다.

Worker별 기본 V8 resource limit은 old generation 192 MiB, young generation 32 MiB, stack 4 MiB다.

## 5. 자동 인증

서버는 loopback HTTP(`127.0.0.1`, `localhost`, `::1`)에만 바인딩한다.

Compute가 활성화된 첫 서버 준비 시 token 서명에만 사용하는 서버 내부 비밀이 다음 경로에 생성된다.

`DATA/config/compute-signing-key.txt`

파일은 가능한 플랫폼에서 `0600` 모드로 원자적으로 기록된다. 기존 파일이 32자 미만이면 덮어쓰지 않고 Compute만 fail-closed로 비활성화하며 Storage Plane은 계속 시작한다. 이 값은 플러그인에 전달하거나 사용자가 입력하는 pairing 값이 아니다.

이전 1.0 구현의 `compute-pairing-key.txt`가 있고 새 signing key가 아직 없으면 서버는 기존 값을 내부 signing key로 한 번 이관해 token 연속성을 보존한다. 기존 파일은 자동 삭제하지 않지만 이후 플러그인 인증에는 사용되지 않는다.

Compute bootstrap 절차는 다음과 같다.

1. 플러그인이 설정된 loopback URL의 `POST /v1/compute/bootstrap`을 직접 호출한다.
2. 공식 owner plugin ID, plugin version과 namespace를 보낸다.
3. 서버는 plugin ID가 소유한 namespace와 요청 namespace가 같은지 확인한다.
4. 서버는 내부 signing key로 30분 TTL의 `mscompute1` bearer token을 발급한다.
5. SDK가 token을 캐시하고 만료·403 시 bootstrap을 한 번 자동 재시도한다.

Compute 인증 자체는 Storage capability token을 재사용하지 않고 전용 `POST /v1/compute/bootstrap`을 사용한다. 다만 Compute 호출 여부는 Storage mode에서 파생되고, 통합 GUI의 연결 확인은 Storage와 Compute 연결을 순서대로 확인한다. 사용자가 token이나 secret을 복사할 단계는 없다.

필수 bootstrap header:

```text
X-Memory-Suite-Plugin: <official plugin id>
X-Memory-Suite-Plugin-Version: <plugin version>
Content-Type: application/json
```

Compute token의 principal은 `roles: ["compute"]`, `readNamespaces: []`, `writeNamespaces: []`다. token signing key는 Storage runtime token과 별도로 보관되는 서버 내부 key에서 유도된다. signing key는 HTTP 응답에 포함되지 않는다.

자동 bootstrap의 신원 경계는 Storage bootstrap과 동일한 `loopback + 공식 plugin ID` 신뢰 모델이다. plugin ID 헤더 자체는 암호학적 플러그인 서명이 아니므로, 동일 사용자 환경에서 실행되는 악성 로컬 프로세스까지 구분하는 인증으로 해석하면 안 된다.

## 6. HTTP API

| Method | Route | 의미 | 정상 상태 |
|---|---|---|---|
| `GET` | `/bootstrap` | Storage 전용 연결; Compute 연결에는 필요 없음 | 200 |
| `POST` | `/v1/compute/bootstrap` | 공식 owner ID로 compute-only token 자동 발급 | 200 |
| `GET` | `/v1/compute/capabilities` | namespace별 operation, limit, pool 상태 조회 | 200 |
| `POST` | `/v1/compute/execute` | 짧은 동기 계산 제출 및 결과 대기 | 200 |
| `POST` | `/v1/compute/jobs` | 비동기 job 제출 | 202 |
| `GET` | `/v1/compute/jobs/{jobId}` | job 상태 조회 | 200 |
| `GET` | `/v1/compute/jobs/{jobId}/result` | 완료 결과 조회 | 200, 미완료 425 |
| `POST` | `/v1/compute/jobs/{jobId}/cancel` | queue 또는 실행 중 job 취소 | 200 |

`/v1/compute/bootstrap`을 제외한 Compute route에는 compute bearer token과 plugin ID가 필요하며 공식 client는 plugin version header도 함께 보낸다. 다른 namespace의 제출은 403으로 거부하고, 다른 namespace 또는 존재하지 않는 job 조회는 존재 여부를 숨기기 위해 404로 처리한다.

## 7. 요청 envelope

`execute`와 `jobs`는 같은 요청 본문을 사용한다.

```json
{
  "namespace": "flashback",
  "operation": "flashback.hash-embedding-batch.v1",
  "operationId": "flashback_hash_550e8400-e29b-41d4-a716-446655440000",
  "algorithmFingerprint": "0beced005ede9fec5b1ba181f740440daf47184ad321301bcb3fab9c2ff7b3ed",
  "input": {
    "texts": ["example"],
    "dimensions": 384
  },
  "inputDigest": "<stable-json sha256>",
  "binding": {
    "schema": "memory-suite.flashback.hash-embedding-binding.v1",
    "pluginVersion": "<current plugin version>",
    "algorithmFingerprint": "0beced005ede9fec5b1ba181f740440daf47184ad321301bcb3fab9c2ff7b3ed"
  },
  "lane": "interactive",
  "deadlineMs": 1450
}
```

`operationId`는 `[A-Za-z0-9._:-]` 12..240자다. `lane`은 `interactive`, `background`, `maintenance` 중 하나다. 서버는 key 정렬 stable JSON의 UTF-8 SHA-256으로 `inputDigest`와 digest들을 계산한다. 순환 객체, non-finite number, plain JSON이 아닌 값은 거부한다.

`binding`은 owner가 결과 현재성을 판정하는 불변 스냅샷이다. operation 성격에 따라 branch/revision/source digest/nonce/parent/reroll/persona ID를 넣는다. 서버는 binding 의미를 해석하거나 변경하지 않고 그대로 echo한다.

## 8. 결과 envelope과 채택

성공 결과의 핵심 필드는 다음과 같다.

```json
{
  "schema": "memory-suite.compute.result.v1",
  "jobId": "cmp_<random>",
  "operationId": "<request operationId>",
  "namespace": "flashback",
  "operation": "flashback.hash-embedding-batch.v1",
  "algorithmFingerprint": "<request fingerprint>",
  "inputDigest": "<verified input digest>",
  "binding": {},
  "result": {},
  "resultDigest": "<stable-json sha256>",
  "timing": {
    "queueMs": 0,
    "workerMs": 0,
    "totalMs": 0
  }
}
```

클라이언트 bridge는 다음 순서로 검증한다.

1. response schema와 필수 객체 확인
2. operationId, namespace, operation, algorithm fingerprint, input digest exact match
3. binding stable-JSON exact match
4. result를 다시 canonicalize하여 result digest exact match
5. operation별 result shape validator 실행
6. owner binding provider 또는 validator로 현재 상태 재확인
7. 모든 검증 후에만 candidate 채택

binding이 늦은 결과 도착 사이에 바뀌면 결과는 `MEMORY_SUITE_COMPUTE_BINDING_STALE`로 폐기한다.

## 9. 멱등성

멱등성 key는 `namespace + operationId`다.

- 같은 operationId와 같은 execution fingerprint이면 기존 job 또는 결과를 반환한다.
- 같은 operationId에 operation, algorithm fingerprint, input digest 또는 binding이 달라지면 409 `compute_operation_id_payload_conflict`다.
- execution fingerprint는 namespace, operation, algorithm fingerprint, input digest, binding으로 계산한다.

Job과 operation index는 메모리에만 유지된다. 서버 재시작 또는 retention prune 뒤에는 같은 operationId의 과거 실행을 기억하지 못한다. 따라서 이 멱등성은 영구 transaction receipt가 아니라 현재 서버 프로세스의 retained-job 범위 보장이다.

## 10. 병렬 실행과 공정성

모든 owner plugin bridge는 서로 독립적이며 전역 client mutex가 없다. 여러 `execute` 요청은 동시에 접수할 수 있고 shared Worker pool의 빈 slot 수만큼 병렬 실행된다.

서버 scheduler는 다음 규칙을 적용한다.

1. lane 우선순위는 `interactive` → `background` → `maintenance`다.
2. 같은 lane에서는 namespace별 queue를 round-robin한다.
3. 대기 중인 다른 namespace가 아직 active slot을 갖지 못했다면 이미 active인 namespace가 다음 slot을 독점하지 못한다.
4. pool이 2개 이상이면 maintenance가 최대 `poolSize - 1`개만 점유하여 하나의 slot을 비-maintenance 작업에 남긴다.
5. deadline admission은 같은 lane과 더 높은 우선순위 lane의 선행 queue만 계산한다. background/maintenance backlog 때문에 새 interactive 요청을 미리 429로 거부하지 않는다.
6. queue 포화 또는 해당 우선순위의 선행 작업을 고려해 deadline 내 시작이 불가능하면 429와 local fallback 권고를 반환한다.
7. 기본 15초 이상 기다린 background/maintenance queue는 다음 빈 slot에서 한 단계씩 aging 승격될 수 있다. 같은 lane의 namespace round-robin과 maintenance slot 보호는 그대로 적용된다.
8. aging으로 lower lane을 한 번 dispatch한 직후에는 다음 dispatch를 strict lane 우선순위로 복원한다. 따라서 지속적인 lower-lane backlog가 interactive를 역으로 기아시키지 않는다.

lane 우선순위와 aging은 대기 queue의 다음 dispatch에 적용되는 비선점형 규칙이다. 이미 Worker에서 실행 중인 background/maintenance 작업을 interactive 도착만으로 종료하지 않으며, interactive는 다음 Worker가 비는 시점에 strict 우선 또는 aged dispatch 뒤 복원 우선으로 선택된다.

aging threshold는 scheduler 생성 시 `schedulerAgingThresholdMs`로 조정할 수 있고 기본값은 15,000 ms다. stats에는 lane별 `oldestWaitMs`와 `agingThresholdMs`가 포함된다. 사용자 대화 경로는 계속 interactive, 대형 인덱스 재구축은 background/maintenance로 분리해야 한다.

## 11. 기본 제한

| 항목 | 기본값 |
|---|---:|
| request body | 8 MiB |
| result | 8 MiB |
| binding | 64 KiB |
| queued jobs | 256 |
| queued request bytes | 32 MiB |
| retained jobs | 1024 |
| retained result bytes | 64 MiB |
| job retention | 15분 |
| minimum deadline | 25 ms |
| execute global maximum | 30초 |
| async job global maximum | 5분 |
| execute default | 1.5초 |
| async job default | 60초 |
| shutdown grace | 1.5초 |

실제 deadline은 global limit과 operation별 `maxDeadlineMs` 중 더 작은 값이다. 현재 production operation의 최대값은 모두 30초이므로 async job도 해당 operation에서는 30초를 넘지 않는다.

Compute client 공통 기본값은 전체 deadline 1.8초, local reserve 350 ms, probe timeout 1.8초다. 입력/결과 8 MiB, binding 64 KiB, JSON depth 64, JSON node 1,000,000을 client에서도 먼저 검사한다. SDK 0.3.3은 비동기 `submitJob/getJobStatus/getJobResult/waitForJob/cancelJob`, 검증된 메모리 derived cache와 bounded direct `execute`를 제공한다. 제품 wrapper는 현재 요청 크기에 맞춘 더 짧은 deadline/local reserve를 지정할 수 있다.

## 12. Job 취소와 보존

Job 상태는 `queued`, `running`, `succeeded`, `failed`, `cancelled`, `expired`다.

- queued 취소는 scheduler queue에서 제거한다.
- running 취소와 deadline 초과는 해당 Worker를 종료하고 새 Worker로 교체한다.
- terminal job 취소 요청은 `cancelAccepted: false`와 현재 상태를 반환한다.
- cancel은 cooperative checkpoint 방식이 아니므로 실행 중인 Worker의 다른 상태를 보존하지 않는다. Worker는 한 번에 한 job만 실행한다.
- Job과 결과는 `memory_only`이며 서버 재시작 시 사라진다.
- 플러그인 unload 시 SDK는 알고 있는 미완료 Job에 cancel을 병렬로 보내고 짧은 grace 뒤 fetch, timer와 cache를 정리한다.
- 동기 `/v1/compute/execute`의 클라이언트 연결이 응답 전에 끊어지면 서버는 같은 namespace와 operationId로 접수된 작업을 자동 취소한다.

## 13. Operation allowlist

현재 production registry는 다음 operation만 허용한다.

| Operation | Namespace | 핵심 제한 |
|---|---|---|
| `flashback.hash-embedding-batch.v1` | flashback | 최대 512 texts, 총 2,000,000 chars, dimensions 64..4096, 총 vector cell 262,144 |
| `lia.world-lore-rerank.v2` | lia | 최대 600 entries, query+entry text 총 2,000,000 chars, topK 1..100, 결과는 ID/position/score/reason candidate만 반환 |
| `libra.recall-bm25f.v1` | libra | 최대 64 canonical candidates, query 500,000 chars, query+8 sparse fields 총 6,000,000 chars, 결과는 ID/position/raw/normalized/evidence score만 반환 |
| `hayaku.sparse-rrf-fusion.v1` | hayaku | 최대 256 rows, sparse 7개/fallback 6개 유한 score signal, k/blend/epsilon 범위 검증, 결과는 position/ID/RRF score candidate만 반환 |
| `common.sha256-batch.v1` | 5개 namespace | 최대 10,000 strings, 총 UTF-8 4 MiB |
| `common.vector-rank.v1` | flashback/hayaku/libra/lia | query 최대 4096차원, candidates 20,000, cost 2,000,000, topK 1000 |

`memory-suite.test.spin.v1`은 명시적인 test option에서만 registry에 나타나며 production capability에는 포함되지 않는다.

Worker는 registry의 순수 함수만 호출한다. Compute 모듈은 namespace repository, SQLite 또는 filesystem API를 사용하지 않는다. 단, 서버 시작 시 내부 signing key와 일반 diagnostics는 DATA의 config/log에 기록될 수 있으므로 “DB 무변경”은 다섯 canonical namespace SQLite에 대한 보장이다.

## 14. Flashback hash pilot

첫 production pilot은 `flashback.hash-embedding-batch.v1`이다.

- 플러그인의 기존 `hashEmbeddingBatchLocal`은 browser Worker를 우선 사용하고 실패 시 기존 main-thread `hashEmbedding`으로 복귀한다.
- 얇은 `hashEmbeddingBatch` wrapper만 Compute Bridge를 호출한다.
- `plugin_only`에서 파생된 `local`은 기존 결과와 반환 형태인 vectors-only contract를 유지한다.
- `mirror` 또는 `server_only`에서 파생된 `prefer_server`는 검증된 서버 vectors를 사용하며 장애 시 동일 local executor를 정확히 한 번 호출한다.
- algorithm fingerprint는 `0beced005ede9fec5b1ba181f740440daf47184ad321301bcb3fab9c2ff7b3ed`로 고정되어 있다.

## 15. LIA World Lore direct-execute pilot

LIA 0.26.61은 `lia.world-lore-rerank.v2`를 bounded direct execute로 사용한다.

- 배포 플러그인은 계속 단일 JS이며 기존 `rerankLoreEntries` local 함수가 남아 있다.
- 입력은 정규화된 lore ID, key, comment, content, source, score와 World Lore query뿐이다. 원본 RisuAI 객체, Persona DB, asset 또는 provider credential은 보내지 않는다.
- 서버는 selected/rejected candidate의 position, lore ID, protection, score, reason만 반환한다.
- LIA가 원래 lore 객체에 candidate를 다시 materialize하며 서버는 GUI나 Persona DB를 수정하지 않는다.
- `plugin_only`에서는 Compute 네트워크가 0회다.
- `mirror` 또는 `server_only`의 `prefer_server`는 최대 1.2초의 interactive 요청을 사용하되 local 실행을 위해 최대 350 ms를 남긴다.
- 서버 응답은 scope, character, chat, persona, lore inventory digest, query digest와 topK가 여전히 같은지 재검증한 뒤 같은 요청에서만 채택한다.
- 서버·플러그인 재시작, timeout 또는 binding 변경 시 서버 후보를 폐기하고 local로 정확히 한 번 계산한다.
- algorithm fingerprint는 `cbd91cc90d01c8fc052669390badab3d0c2c7a52c4b6c314ac2ca61716fc7a75`다.

## 16. LIBRA Recall BM25F direct-execute pilot

LIBRA 2.3.20은 `libra.recall-bm25f.v1`을 canonical-memory hydration 이후 sparse arm 점수 계산에만 사용한다.

- 기존 `bm25fScores` local 함수와 8개 field weight, length normalization, K1, Korean bigram/tokenization은 플러그인에 그대로 남아 있다. 일본어·중국어는 순수 CJK 장문 전체를 강한 단일 토큰으로 사용하지 않고 Han/Hiragana/Katakana script run 내부의 제한형 bigram을 사용한다.
- 입력은 query와 현재 후보의 canonical ID 및 `summary`, `recall_keys`, `characters_relations`, `narrative_open_threads`, `chronology`, `world_scene`, `facts_uncertainty`, `full_text`뿐이다.
- 서버는 입력 순서를 유지한 compact score candidate만 반환하고 RRF, gate, MMR, passage 선택과 prompt injection은 수행하지 않는다.
- `mirror` 또는 `server_only`의 `prefer_server`는 최대 1.5초의 interactive 요청을 사용하되 local 실행을 위해 최대 400 ms를 남긴다. LIBRA는 응답 뒤 현재 scope, character/chat, U+A branch digest와 manifest signature를 다시 확인한다.
- branch/reroll, manifest, query 또는 candidate field가 달라지면 서버 후보를 폐기하고 local scorer를 정확히 한 번 사용한다.
- `plugin_only`에서는 capability probe와 Compute 네트워크가 0회다.
- algorithm fingerprint는 `dea19e8a1c43caf8050d8225b15bf5a0d755a9974a56d22b996b4c4826c120fd`다.

## 17. HAYAKU sparse RRF direct-execute pilot

HAYAKU 3.0.42는 `hayaku.sparse-rrf-fusion.v1`을 composite recall의 최종 sparse-channel RRF 결합에만 사용한다. Recovery Journal의 누락 확인창은 Compute 경로와 무관한 독립 UI이며, 확인 전에는 원장 GUI를 자동으로 마운트하지 않는다. 독립 UI를 표시할 수 없으면 복구 호출을 시작하지 않고 저널을 pending으로 유지한다.

- 기존 `applyRrfFusion` 동기 함수는 같은 pure local kernel을 호출하는 facade로 남아 있으며 일반 `searchIndexSparseHybrid`와 모든 fallback에서 사용할 수 있다.
- 서버 입력에는 owner row 전체가 아니라 position, 파생 ID, base score와 sparse/fallback signal 숫자만 포함된다.
- 서버는 RRF signal 선택, stable rank, max normalization과 blend를 계산하고 compact score candidate만 반환한다.
- retrieval gate, graph closure, recall preference/stability, packet cohesion, transition bundle, conflict coverage, axis 선택과 prompt injection은 HAYAKU가 계속 수행한다.
- `mirror` 또는 `server_only`의 `prefer_server`는 최대 900 ms의 interactive 요청을 사용하되 local 실행을 위해 최대 200 ms를 남긴다. scope, character/chat hash, visible transcript snapshot, clone fingerprint, worldline revision/head, query와 row digest가 모두 같은 응답만 채택한다.
- 편집·리롤·롤백·worldline drift 뒤의 늦은 결과는 폐기하고 local RRF를 정확히 한 번 실행한다. `local`에서는 capability probe와 Compute 네트워크가 0회다.
- algorithm fingerprint는 `7f32e8b10fdd34e8356af70e40ad90d3c48e6fda132080046a807db0ea3ec58f`다.

## 18. 오류와 fallback

Compute 오류 응답은 `memory-suite.compute.error.v1`이며 다음 fallback 정보를 포함한다.

```json
{
  "ok": false,
  "schema": "memory-suite.compute.error.v1",
  "error": "<reason>",
  "code": "<CODE>",
  "fallback": {
    "recommended": "local",
    "reason": "<reason>",
    "retryAfterMs": 250
  }
}
```

Client는 연속 원격 실패 2회 후 circuit을 열고 기본 5초부터 지수 cooldown을 적용하며 최대 60초로 제한한다. half-open probe가 성공하면 닫는다. 자동 bootstrap 실패, operation 미지원, fingerprint 불일치, queue 포화, timeout, 서버 종료, stale binding은 canonical mutation으로 승격하지 않으며 local 또는 무채택으로 끝난다.
