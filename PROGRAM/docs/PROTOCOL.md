# Librarian System Storage Protocol 1.9

현재 운영 모드는 `plugin_only` / `server_only` 두 가지입니다. `mirror`는 전환 단계와 과거 레코드 호환 값입니다. [저장 모드 전환 계약](STORAGE_MODE_TRANSITION_CONTRACT.md)이 새 설정·인계의 상위 계약입니다.

## 목표

Storage Protocol은 플러그인 데이터의 의미와 독립적인 영구 저장 계약입니다. 서버는 value를 JSON-serializable opaque 값으로 취급합니다. 플러그인 고유 schema, recall, handoff 의미는 owner 플러그인이 소유합니다.

선택적 연산 위임은 이 저장 계약과 권한 토큰을 공유하지 않습니다. Compute API, 로컬 fallback, Worker pool과 candidate 채택 계약은 별도 [COMPUTE_PROTOCOL.md](COMPUTE_PROTOCOL.md)를 따릅니다.

## 호환성

- protocol major가 다르면 쓰기를 중단합니다.
- minor/server version은 정확히 일치할 필요가 없습니다.
- SDK는 필요한 capability의 존재를 확인합니다.

필수 capability:

```text
kv.v1
keys.v1
revision.v1
digest.v1
idempotency.v1
tombstone.v1
readback.v1
namespace-integrity.v1
```

선택 진단 capability:

```text
server-diagnostics.v1
manager-diagnostics.v1
diagnostic-events.v1
diagnostic-log-rotation.v1
scoped-capability-auth.v1
shutdown-backup.v1
recovery-safe-mode.v1
restore-journal.v1
backup-scrub.v1
generational-backup-retention.v1
scope-catalog-fallback.v1
keys-pagination.v1
server-batch-read.v1
server-batch-read-budget.v1
interactive-storage-soft-cap.v1
```

진단 capability가 없는 이전 서버에서도 core 저장 기능은 계속 사용할 수 있습니다. 이 경우 디버그 export에는 `unsupported`/offline 진단 상태만 들어갑니다.

관리 capability:

```text
backup.v1
integrity.v1
restore.v1
program-data-separation.v1
portable-data-folder.v1
automatic-data-migration.v1
server-namespace-read.v1
handoff-sync-proof.v1
scope-manager.v1
```

## Namespace와 Space

Namespace:

```text
flashback
hayaku
libra
lia
retrace
```

Space:

```text
plugin
local
```

각 namespace는 독립 SQLite DB를 사용합니다. space는 기존 pluginStorage와 device-local storage의 논리적 구분입니다.

## Bootstrap

```http
GET /bootstrap
X-Memory-Suite-Plugin: libra
X-Memory-Suite-Plugin-Version: 1.0.98
```

응답에는 실제 listen 주소에 맞는 loopback URL, plugin ID에 결속된 bearer capability token, protocol과 capability가 들어갑니다. bootstrap은 별도 key 없이 공식 plugin ID만 허용하고 서버의 master token을 반환하지 않습니다. plugin ID 헤더는 암호학적 신원 증명이 아니므로 이 계약은 loopback·동일 사용자 로컬 신뢰 경계를 전제로 합니다.

일반 owner token은 자기 namespace만 읽고 쓸 수 있습니다. RE:TRACE primary token은 manager API와 전체 namespace 읽기가 가능하지만 peer namespace의 일반 KV 쓰기는 허용되지 않습니다. `flashback_hayaku_bridge:peer:<owner-id>` token은 지정된 peer namespace 읽기 전용입니다. `X-Memory-Suite-Admin`이나 `X-Memory-Suite-Manager` 헤더만 추가해서 권한을 높일 수 없습니다.

관리도구는 bootstrap을 사용하지 않습니다. 로컬 `DATA/runtime-token.txt`를 읽을 수 있는 관리도구만 master token과 admin header를 함께 보내 backup, restore, shutdown API를 사용합니다.

## KV 읽기·쓰기·삭제

```http
GET /v1/kv/get?namespace=libra&space=plugin&key=...
POST /v1/kv/set
POST /v1/kv/remove
GET /v1/kv/keys?namespace=libra&space=plugin&prefix=...
```

쓰기 예:

```json
{
  "namespace": "libra",
  "space": "plugin",
  "key": "libra:v1:...",
  "value": {},
  "operationId": "libra_set_...",
  "expectedRevision": 0
}
```

- 같은 operation ID와 같은 payload는 기존 receipt를 반환합니다.
- 같은 operation ID에 다른 payload를 보내면 409 conflict입니다.
- migration의 create-only write는 `expectedRevision: 0`을 사용합니다.
- 삭제는 행 제거가 아니라 revision이 증가한 tombstone입니다.
- 서버는 transaction 안에서 readback을 검증하고 SDK는 별도 GET으로 value/revision/digest를 다시 확인합니다.

### Key pagination과 batch-read budget (Protocol 1.9 / SDK 1.8.13)

기존 무페이지 `keys`와 `get-many` 요청은 호환성을 위해 유지됩니다. 새 SDK는 응답 크기를 제한하기 위해 opt-in 페이지 모드를 우선 사용합니다.

```http
GET /v1/kv/keys?namespace=libra&space=plugin&prefix=...&paged=1&limit=500&cursor=...
```

페이지 응답의 `page.nextCursor`가 존재하면 같은 namespace, space, prefix에만 이어서 요청할 수 있습니다. cursor는 prefix와 결속되며 다른 prefix에 재사용하면 400으로 거부됩니다. `limit` 기본값은 500, 서버 상한은 2000입니다. SQL `LIKE`의 `%`, `_`, `\`는 literal prefix가 되도록 escape됩니다.

```http
POST /v1/kv/get-many
```

```json
{
  "namespace": "libra",
  "space": "plugin",
  "keys": ["..."],
  "paged": true,
  "cursor": 0,
  "maxResponseBytes": 4194304
}
```

- 기본 응답 예산은 4 MiB, 최소 256 KiB, 서버 상한은 8 MiB입니다. 서버는 SQLite `value_bytes`를 먼저 확인해 oversized record를 JSON 파싱 전에 우회합니다.
- 예산에 도달하면 `page.nextCursor`로 이어 받습니다.
- 단일 record 하나가 예산보다 큰 경우 서버는 그 key를 `oversizedKeys`로 표시하고 SDK는 해당 record만 개별 `GET /v1/kv/get`으로 읽습니다.
- 구 SDK의 무페이지 `get-many`는 기본 4 MiB를 넘으면 413을 반환하여 서버 이벤트 루프가 무제한 JSON 파싱·직렬화에 묶이지 않게 합니다.

### Interactive value soft cap

SDK는 단일 value의 JSON 직렬화 크기가 4 MiB를 넘으면 서버 mutation 전에 `MEMORY_SUITE_INTERACTIVE_VALUE_TOO_LARGE`로 차단합니다. 서버도 HTTP body 단계에서 같은 경로를 413 `interactive_storage_request_too_large_use_shards`로 거부합니다. 이는 정본 형식을 자동으로 쪼개는 migration이 아니며, 큰 데이터는 각 owner가 이미 사용하는 shard/manifest 구조로 저장해야 합니다. 작은 설정·상태와 기존 shard record의 의미는 바뀌지 않습니다.

## Backup/Restore

관리 요청은 bearer token 외에 `X-Memory-Suite-Admin: 1`을 요구합니다. Backup은 SQLite snapshot, scope catalog, `PRAGMA integrity_check`, SHA-256, record count를 manifest에 기록합니다. Restore는 요청 DB 전체와 scope catalog를 staging 검증한 뒤 pre-restore backup을 만들고 원자 교체합니다. 교체 단계가 실패하면 실제로 이동·설치된 파일만 역순으로 되돌리고, 선택 복원은 해당 namespace의 catalog 항목만 같은 백업 시점으로 복원합니다.

0.2.12부터 restore는 durable transaction journal을 사용합니다. 다음 phase가 `DATA/migrations/restore-transaction.json`에 기록됩니다.

```text
PREPARED → INSTALLED → VERIFIED → COMMITTED
```

COMMITTED 이전에 프로세스가 종료되면 다음 기동에서 원래 DB로 rollback합니다. COMMITTED 이후에 종료되면 새 DB를 유지하고 temp/rollback 잔재만 정리합니다. DB 손상으로 정상 서버가 시작되지 않을 경우 Recovery Safe Mode는 admin backup/scrub/restore API만 제공하고 plugin storage API는 차단합니다.

관리 API 추가:

```text
POST /v1/admin/backups/scrub
POST /v1/admin/restore/plan
POST /v1/admin/restore
POST /v1/admin/libra/native-archive-repair/plan
POST /v1/admin/libra/native-archive-repair/execute
```

LIBRA native-copy의 상속 Micro 아카이브 본문이 사라졌고 원본 scope가 이미 공식 삭제된 경우, 관리자는 삭제 영수증의 `backupId`, 대상 `targetScopeKey`, 누락된 `targetArchiveKey`로 선별 복구 계획을 만들 수 있습니다. 서버는 삭제 표지와 pre-delete 백업의 SHA-256/SQLite 무결성, 백업·현재 대상 manifest의 archive ref, 본문 digest, 누락 상태를 검증합니다. 실행은 대상 archive 키 한 개만 조건부로 쓰고 물리 재조회합니다. 전체 namespace를 복원하거나 구형 native-copy 완료 영수증을 승격하지 않습니다. 응답의 `nativeCopyCompleteness: pending_revalidation`과 `reloadRequired: true`를 확인하고 LIBRA의 별도 완전성 검증을 수행해야 합니다.

오프라인 복원은 서버 API가 아니라 로컬 admin CLI가 같은 backup scrub/journal/quarantine 계약을 사용합니다.

## Credential 정책

SDK route와 서버 모두 credential-like key를 차단합니다. 일반 설정 payload 안의 secret 분리는 각 owner 플러그인의 기존 credential 계층이 담당합니다.

## PROGRAM/DATA 분리

PROGRAM은 교체 가능한 실행 계층이고 DATA는 영구 계층입니다. DATA layout 1과 DB schema 1을 지원합니다. 더 새로운 DATA를 오래된 PROGRAM이 열면 쓰기 없이 중단합니다.

## Scope-routed storage contract (SDK 1.8.13)

0.2.7부터 저장 방식은 플러그인 전체가 아니라 owner 플러그인의 **논리 스코프별**입니다.

```text
scope A → plugin_only
scope B → server_only
scope C → server_only
```

- 새 스코프 기본값은 항상 `plugin_only`입니다.
- `memory_suite_server_url`은 플러그인 전역입니다.
- `memory_suite_server_mode` ARG는 0.2.6 전역 모드의 일회성 이전 슬롯일 뿐입니다.
- 기존 전역 모드는 최초 활성 스코프 하나에만 가져온 뒤 ARG를 plugin_only로 초기화합니다.

### Scope routing registry

```text
schema: memory-suite.scope-routing.v1
local:  __memory_suite_internal_scope_routes_v1__:<namespace>
server: __memory_suite_scope_routes_v1__:<namespace>
```

registry는 pluginStorage와 device-local storage에 작은 복사본을 두고 서버에도 best-effort 동기화합니다. 현재 스코프 payload 삭제 대상에서 제외합니다. 서버가 꺼져도 server_only 정책을 기억하므로 로컬로 묵시적 fallback하지 않습니다.

### Key route 종류

```text
scope  — 현재 또는 명시된 채팅 스코프 소유 payload
shared — 여러 스코프가 공동 사용하는 archive/index/infrastructure
global — provider/runtime/UI 설정 등 플러그인 전역 자료
```

- `scope`만 현재 스코프 sync/restore/delete sweep에 포함됩니다.
- `shared`는 서버-backed 스코프가 있을 때 정상 접근 경로에서 보수적으로 mirror될 수 있지만 한 스코프 삭제에는 포함되지 않습니다.
- `global`은 plugin_only로 유지하며 스코프 모드 영향을 받지 않습니다.

### Scoped container projection

LIA처럼 legacy JSON에 여러 스코프가 들어 있는 container는 서버에서 다음 opaque key로 분리합니다.

```text
<logical-key>::memory-suite-scope:v1:<encoded-scope-id>
```

owner mapper가 현재 스코프 부분만 project/merge/remove합니다. 서버는 container 의미를 해석하지 않습니다.

### 세 모드

- `plugin_only`: 해당 스코프는 RisuAI 저장소만 사용합니다.
- 기존 `mirror`: 전환 미완료 상태로 읽으며 단독 목적지 선택이 필요합니다. 호환 read repair는 유지합니다.
- `server_only`: 해당 스코프는 서버 권위이며 서버 OFF 시 scope I/O가 fail-closed합니다.

`required`는 legacy `server_only`, `off`는 legacy `plugin_only` alias입니다.

### 안전한 스코프 모드 전환

`plugin_only → server_only`는 대상 스코프만 inventory하고 서버 baseline → readback/digest → settle pass → namespace integrity를 모두 통과한 뒤 mode를 확정합니다. 그동안 기존 plugin_only가 정본입니다.

`server_only → plugin_only`는 대상 스코프 서버 자료를 local에 복원하고 readback을 검증한 뒤 mode를 바꿉니다.

### 전역 서버 URL 변경 안전장치

서버 URL은 모든 스코프가 공유하므로 서버-backed 스코프가 하나라도 남아 있으면 GUI/API `configureConnection`이 `MEMORY_SUITE_SERVER_URL_IN_USE`로 URL 변경을 차단합니다. 모든 알려진 스코프를 plugin_only로 전환한 뒤에만 주소를 바꿀 수 있습니다. 이 정책은 스코프가 서로 다른 DATA 루트로 갈라지는 것을 방지합니다.

## Server connection GUI와 background job (SDK 1.8.13)

활성 owner 플러그인 5종이 동일한 `mountConnectionPanel(container)`을 사용합니다. 패널은 현재 스코프 표시, 서버 주소, 무설정 연결 테스트, 현재 스코프 모드 전환, 수동 동기화, 서버→local 복구, guarded local delete와 실시간 job telemetry를 제공합니다.

`memory-suite.sync-job.v1` receipt에는 phase, items, bytes, elapsed, last activity, retries/failures, current key/action이 들어갑니다. 패널을 닫아도 작업은 계속되며 미완료 receipt는 reload 후 재검사됩니다. 이미 일치하는 record는 다시 전송하지 않습니다.

서버 연결 확인과 routing registry 서버 hydration은 UI/hook 등록을 막지 않는 best-effort 비동기 작업입니다. server_only + server OFF에서도 GUI는 유지되고 scope memory I/O만 fail-closed합니다.

## RE:TRACE handoff contract

RE:TRACE는 owner별 `ensureHandoffReady()` proof를 사용합니다.

- plugin_only: 서버 불필요
- mirror 또는 진행 중인 저장 전환: 신규 인계 차단, 단독 목적지 전환 완료 필요
- server_only: namespace integrity 확인

RE:TRACE는 peer payload를 직접 rewrite하지 않고 owner-led prepare/adopt/verify를 사용합니다. source session은 불변이어야 합니다.

## Scope catalog와 orphan management

RE:TRACE manager 요청은 `X-Memory-Suite-Manager: retrace`와 plugin ID `flashback_hayaku_bridge`를 요구합니다.

- scope index 교체
- cross-scope reference 해결
- active / referenced_ancestor / orphan_candidate / unverified 분류
- pin 보호
- deletion plan/execute

누락 채팅 스코프는 자동 삭제하지 않습니다. active/orphan deletion은 owner가 대상 스코프를 local에 복원하고 plugin_only로 전환했다는 receipt, DB integrity, 완전한 coverage, revision/digest 조건과 deleted-scope backup을 요구합니다. referenced ancestor, inbound reference, unverified, pinned, incomplete scope는 fail-closed합니다.

RE:TRACE 1.9.65는 활성 5개 namespace(Flashback, HAYAKU, LIBRA, LIA, RE:TRACE)만 인식하며, 디버그 내보내기에서도 manager 전용 API로 이 다섯 namespace의 서버 진단만 수집합니다. 과거 GRADIA 파일은 열거나 삭제하지 않습니다.


## 서버 진단 계약

일반 owner 플러그인:

```http
GET /v1/diagnostics?namespace=libra&scopeId=...&limit=500
Authorization: Bearer <runtime token>
X-Memory-Suite-Plugin: libra
X-Memory-Suite-Plugin-Version: 1.0.85
X-Memory-Suite-Scope-Id: <encoded scope id>
X-Memory-Suite-Storage-Mode: mirror
```

서버는 요청 플러그인의 고유 namespace만 허용합니다. 다른 namespace를 요청하면 403입니다.

RE:TRACE manager:

```http
GET /v1/manager/diagnostics?limit=1000&includeTextLogs=1
X-Memory-Suite-Manager: retrace
X-Memory-Suite-Plugin: flashback_hayaku_bridge
```

응답에는 다음만 포함합니다.

```text
server version / protocol / uptime / maintenance state
namespace integrity and record counts
recent structured diagnostic events
log retention / rotation statistics
connected plugin IDs and versions
optional redacted bounded tails from startup.log / startup-error.log / server.log (RE:TRACE manager only)
```

진단 event에는 raw value, RP/메모리 본문, 원본 key, token, Authorization header를 넣지 않습니다. scope와 key는 SHA-256 앞 16자리 해시와 key 종류로만 표시합니다. 일반 플러그인은 자기 namespace·현재 scope의 구조화된 journal만, RE:TRACE는 manager 권한으로 전체 namespace와 선택적인 process text log tail을 조회합니다.

진단 로그 파일:

```text
DATA/logs/server-debug.jsonl
DATA/logs/server-debug.1.jsonl
...
```

현재 파일은 4 MiB를 넘기기 전에 순환하며 최대 5개 파일을 보존합니다. 메모리 ring은 최근 2,000 events, 한 번의 export는 최대 1,000 events로 제한합니다.

RE:TRACE manager가 `includeTextLogs=1`을 요청하면 서버는 `startup.log`, `startup-error.log`, `server.log`가 존재할 때 각 파일의 최근 최대 240줄·약 32,000자 tail을 `textLogs`로 반환합니다. 일반 `/v1/diagnostics` 응답은 이 파라미터와 무관하게 `textLogs: []`, `textLogsManagerOnly: true`를 반환합니다. 전체 파일은 반환하지 않으며 Bearer/API key/authorization/secret/password/credential 패턴은 `[REDACTED]` 처리합니다.

서버가 오프라인이거나 진단 capability가 없는 이전 서버여도 SDK 1.8.13은 디버그 export를 실패시키지 않고 구조화된 offline/unsupported 상태를 반환합니다. plugin_only에서는 명시적인 연결 테스트가 아닌 예약 진단 때문에 서버 요청을 만들지 않습니다.


## 0.3.32 선택 capability: conditional-batch.v1

동일 namespace 조건부 다중 키 쓰기와 원자 operation receipt는 `POST /v1/kv/batch`를 사용한다. 자세한 strict precondition/권한/실패 계약은 [SERVER_CONDITIONAL_BATCH_06.md](SERVER_CONDITIONAL_BATCH_06.md)를 따른다. 기존 Protocol 1.9 reader/writer API는 유지한다. 이 추가가 LIBRA unified server/mirror 개방을 뜻하지 않는다.
