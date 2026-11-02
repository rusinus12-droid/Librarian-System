# RisuAI Compatibility Gate

## 1. 목적 및 게이트 분리 원칙

`RisuAI Compatibility Gate`는 Librarian-System의 기존 `Release Builder Gate`(`PROGRAM/tools/build_distribution.cjs` 및 `.github/workflows/release-builder-gate.yml`)와 역할을 엄격히 분리한 **독립 형제 게이트(Sibling Gate)**다.

```text
Release Builder Gate
  └─ Librarian 자체의 릴리즈 아티팩트 생성, 미니파이, 업데이터/마이그레이션, DATA 프라이버시, 패키지 무결성 검증

RisuAI Compatibility Gate
  └─ Librarian 6개 릴리즈 아티팩트와 고정된(Pinned) RisuAI upstream 호스트 계약의 정합성 및 Storage Authority 불변조건 검증
```

공식 릴리즈(`.github/workflows/manual-release.yml`)는 두 게이트가 모두 `PASS`일 때만 버전 커밋, 태그 생성, GitHub Release 발행을 진행한다.

---

## 2. 지원 RisuAI 기준점 (Upstream Source-of-Truth & Pin)

- **Upstream Repository**: `kwaroran/Risuai`
- **Pinned Commit**: `ea61945f9038e0189807d075f55f4e66ab7e98bf`
- **Lock File**: `PROGRAM/contracts/risuai/upstream-lock.json` (`schema: "librarian.risu-upstream-lock.v1"`)

PR/릴리즈 게이트는 매 실행마다 RisuAI `main` 최신 커밋을 자동 추적하지 않는다. 외부 저장소의 임의 변경으로 인해 Librarian PR 결과가 비결정적으로 흔들리는 것을 방지하기 위해, 반드시 `upstream-lock.json`에 고정된 커밋과 추적 대상 5개 파일의 SHA-256 해시를 기준으로 검증한다.

### 추적 대상 Upstream 파일 (Tracked Files)

| Upstream 경로 | SHA-256 (`ea61945f...`) | 계약 역할 |
|---|---|---|
| `src/ts/plugins/apiV3/risuai.d.ts` | `ddca6852e1e655afe9ed229ad95f0bb3c815b01ee75f089db779401d7cc43a3a` | RisuAI Plugin API v3 표면(시그니처, 인자, 반환 타입, deprecated 여부) |
| `src/ts/plugins/apiV3/v3.svelte.ts` | `9e4df9238965375dbccebf6eb8fb06117b1d9f866c20e4b40c263b55a4a0a40b` | `makeRisuaiAPIV3` 런타임 구현 및 19개 핵심 semantic fingerprint |
| `src/ts/plugins/plugins.svelte.ts` | `c9441c23f84d53e0c4304fa8d96afe11d8883ff29579fedb65ad7956d97b5461` | v3 헤더 파서(`//@name`, `//@api`, `//@version`, `//@arg`, `//@allowed-ipc`), 라이프사이클 |
| `src/ts/plugins/pluginSafeClass.ts` | `9a8de9a6565aacf5bf60d1fa2ea0ddb6d70b63323f60e71e466ce3823cdcdbf9` | `SafeLocalStorage`(문자열 전용) 및 `SafeLocalPluginStorage`(JSON 직렬화 localforage) |
| `src/ts/process/pluginStorageStore.ts` | `55d1394f04dfa0c2dc76fd2b0d5981be3fd728ba05cf3912b29ba6aeacb154ca` | `PluginStorageStore` JSON 직렬화, 예약 키(`_coldpluginIndex`, `_coldplugin`) 보호 |

---

## 3. Librarian RisuAI API Usage Inventory

`PROGRAM/tools/risu_api_usage_inventory.cjs`는 Acorn AST 및 스코프 분석을 사용하여 6개 배포 플러그인(`HAYAKU`, `Flashback`, `LIBRA`, `LIA`, `RETRACE`, `GRADIA`)이 실제로 사용하는 RisuAI 호스트 API를 자동 추출한다.

- **추적 별칭**: `Risuai`, `RisuAI`, `risuai`, `risuApi`, `risuAPI`, `globalThis[alias]`, 호스트 어댑터 래퍼 함수 및 배열.
- **실사용 RisuAI v3 API (45개)**:
  - `addPluginChannelListener`, `addProvider`, `addRisuChatListener`, `addRisuReplacer`, `addRisuScriptHandler`, `alert`, `alertConfirm`, `alertError`, `apiVersion`, `apiVersionCompatibleWith`, `checkCharOrder`, `createMutationObserver`, `getArg`, `getArgument`, `getChar`, `getCharacter`, `getCharacterFromIndex`, `getChatFromIndex`, `getColorScheme`, `getCurrentCharacterIndex`, `getCurrentChatIndex`, `getDatabase`, `getFetchLogs`, `getLocalPluginStorage`, `getRootDocument`, `getRuntimeInfo`, `hideContainer`, `loadPlugins`, `log`, `nativeFetch`, `onUnload`, `pluginStorage`, `postPluginChannelMessage`, `registerBodyIntercepter`, `registerButton`, `registerSetting`, `removeRisuChatListener`, `removeRisuReplacer`, `removeRisuScriptHandler`, `requestPluginPermission`, `risuFetch`, `runLLMModel`, `safeLocalStorage`, `setArg`, `setArgument`, `setCharacter`, `setCharacterToIndex`, `setChatToIndex`, `setDatabase`, `setDatabaseLite`, `showContainer`, `unregisterBodyIntercepter`, `unregisterUIPart` 중 플러그인 실사용 45개 항목.
- **명시적 Allowlist (`allowlistedOptionalProbes`, 17개)**:
  - `typeof api?.X === 'function'` 가드로 보호된 레거시/포크 호환용 선택적 프로브(`removePluginChannelListener`, `unregisterSetting`, `getChat`, `promptInput` 등).
- **게이트 불변조건**:
  - 소스 또는 미니파이된 릴리즈 아티팩트에서 `api-surface.json`에 매핑되지 않은 신규 RisuAI API가 감지되면 정적 검증(`UNMAPPED_RISUAI_API_USAGE`)과 계약 기반 런타임 호스트(`UNMAPPED_RISUAI_API_CALL`) 양쪽에서 즉시 실패한다.

---

## 4. Compatibility Pack 구조 및 계약 추출/검증

`PROGRAM/contracts/risuai/` 디렉터리는 RisuAI 전체 소스를 복제(vendoring)하지 않고, 고정된 upstream 커밋에서 추출·검토한 Librarian 전용 호환성 계약만 보관한다.

```text
PROGRAM/contracts/risuai/
├── upstream-lock.json           # 고정 커밋 및 5개 upstream 파일 SHA-256
├── api-surface.json             # risuai.d.ts 추출 71개 호스트 API + 45개 실사용 API 계약
├── runtime-semantics.json       # v3.svelte.ts 등 19개 핵심 구현 블록의 정규화 AST/코드 지문
├── plugin-loader-contract.json  # 6개 플러그인 헤더, //@arg 스키마, //@version 500B 제한
├── storage-contract.json        # pluginStorage / safeLocalStorage / getLocalPluginStorage 의미론
├── ipc-contract.json            # 양방향 //@allowed-ipc 토폴로지 (14개 허용 쌍)
└── replay/                      # H06 시나리오 (Product-Path 1개 + Host-Contract 3개 + Contract-Fixture 4개)
    ├── [Host-Contract] H06-01.json  # output 리스너 스냅샷 격리, messageIndex=-1 무시, 이어쓰기 대체 (RisuAI host chat listener)
    ├── [Product-Path]  H06-02.json  # 네이티브 브랜치 T12 분기 및 부모/형제 스코프 오염 방지 (실제 Librarian Native branch capability)
    ├── [Contract-Fix]  H06-03.json  # RETRACE 양방향 IPC A→B→C 핸드오프 및 조상 불변성 fixture 검증
    ├── [Host-Contract] H06-04.json  # 포터블 아카이브 클린 복원 및 SHA-256 무결성 검증 (RisuAI host pluginStorage manifest)
    ├── [Contract-Fix]  H06-05.json  # 엔티티 분리 후 원문 수정 시 stale basis 교정 중단 fixture 검증
    ├── [Host-Contract] H06-06.json  # 선택 구간 재분석 및 실행 중 채팅 전환 펜싱 (RisuAI runLLMModel & chat index fence)
    ├── [Contract-Fix]  H06-07.json  # 미완료 작업 재로드 및 GC 중 내구성 핀(pin) 보호 fixture 검증
    └── [Contract-Fix]  H06-08.json  # 통합 읽기 세션(Unified Authority Snapshot) 및 stale 주입 펜싱 fixture 검증
```

> [!NOTE]
> H06는 실제 제품 경로(`librarian_product_path_replay`: H06-02), 호스트 계약 재생(`host_contract_replay`: H06-01, 04, 06), 그리고 인조 픽스처 불변조건 검증(`contract_fixture_validation`: H06-03, 05, 07, 08)의 3단계로 엄격히 구분하여 보고서에 기록하며, 실제 제품 경로가 아닌 항목을 과장하여 표현하지 않는다.

### Semantic Drift 정책

`PROGRAM/tools/risu_contract_verifier.cjs`는 타입 선언(`risuai.d.ts`)만 보지 않고, `v3.svelte.ts`, `plugins.svelte.ts`, `pluginSafeClass.ts`, `pluginStorageStore.ts`의 19개 핵심 의미론 단위(정규화된 코드 해시 및 필수 패턴)를 대조한다. 타입 선언이 동일하더라도 런타임 구현이 변경되면 `RISUAI_UPSTREAM_SEMANTIC_DRIFT`로 감지한다.

---

## 5. Storage Authority 분리 원칙

**RisuAI Compatibility Gate와 Contract-Backed Host는 Storage Authority를 소유하지 않는다.**

- `PROGRAM/tools/risu_contract_host.cjs`는 RisuAI 호스트 프리미티브(`pluginStorage`, `safeLocalStorage`, `getLocalPluginStorage`, `nativeFetch`, IPC, 훅, 권한, UI 등록)만 제공한다.
- 실제 정본 위치(`plugin_only` vs `server_only`)의 결정과 라우팅은 오직 기존 Librarian Storage SDK(`PROGRAM/sdk/MemorySuiteStorageClient.source.js`, `MemorySuiteStorageClient.libra.source.js`)와 실제 데이터 서버(`PROGRAM/server/server.cjs`)가 수행한다.

### 5.1 `plugin_only` 계약
- Owner canonical write는 contract-backed `risuai.pluginStorage`에 기록되며, readback이 일치해야 한다.
- `plugin_only` 상태에서 owner canonical 데이터로 인해 Librarian 서버 요청(`/v1/kv/*`)이 단 1회라도 발생하면 `PLUGIN_ONLY_SERVER_CANONICAL_REQUEST_FORBIDDEN`으로 실패한다.
- Librarian 서버가 오프라인이어도 모든 로컬 정본 읽기/쓰기가 정상 동작해야 한다.

### 5.2 `server_only` 계약 및 Fail-Closed 불변조건
- `server_only` 검증은 가짜(fake) 서버를 만들지 않고, 실제 `PROGRAM/server/server.cjs`(`createMemorySuiteServer`)와 임시 SQLite `DATA` 디렉터리를 구동하여 수행한다.
- Owner canonical write는 `nativeFetch`를 통해 실제 서버에 기록되며, 서버 readback 및 64자 SHA-256 digest가 검증되어야 한다.
- `server_only` 활성 상태에서 owner canonical 데이터가 로컬 `pluginStorage`에 기록되면 `SERVER_ONLY_LOCAL_CANONICAL_WRITE_FORBIDDEN`으로 실패한다.
- **Server Failure Fail-Closed**: `server_only` 상태에서 서버가 오프라인/연결 불가일 때 읽기/쓰기는 반드시 fail-closed로 거부되어야 하며, `plugin_only`로 묵시적 폴백하거나 로컬 `pluginStorage`에 canonical write를 수행하면 `SERVER_ONLY_OFFLINE_FALLBACK_FORBIDDEN`으로 실패한다.

### 5.3 Storage Mode 전환 계약 (`PROGRAM/docs/STORAGE_MODE_TRANSITION_CONTRACT.md` 준수)
- `plugin_only -> server_only`: 전환 완료(cutover) 전에는 `plugin_only`가 정본 권한을 유지하고, 동기화 및 검증 완료 후에만 `server_only`가 정본 권한을 획득한다.
- `server_only -> plugin_only`: 로컬 복원이 실패하면 cutover가 거부되고 `server_only` 정본 권한이 그대로 유지되어야 하며, `restorePluginStorage()` 검증 완료 후에만 `plugin_only`로 전환된다.
- 기존 스토리지 회귀 스위트(`storage_modes_test.cjs`, `storage_mode_owner_parity_audit_test.cjs`, `storage_mode_special_parity_gates_test.cjs`, `storage_mirror_transition_retirement_test.cjs`)를 게이트 내부에서 함께 실행하여 기존 계약을 보존한다.

### 5.4 Storage Owner Matrix 및 LIA Local-Only 정책
- **Server-backed Owners Matrix**: `libra`, `hayaku`, `flashback` 3개 오너 모두에 대해 계약 기반 호스트 아래에서 `plugin_only` (서버 요청 0), `server_only` (로컬 canonical 쓰기 0, 서버 다이제스트 검증), `server_only + offline fail-closed` 불변조건을 각각 동일하게 검증한다.
- **LIA Local-Only**: LIA는 스토리지 정책이 `local_only`로 고정되어 있으므로, `plugin_only`는 정상 동작하고 `server_only` 전환 시도는 `LOCAL_ONLY_OWNER_POLICY`로 거부됨을 확인한다.
- **RE:TRACE**: 일반 canonical KV storage owner matrix에 포함하지 않으며 전용 매니저/핸드오프 불변조건을 유지한다.

---

## 6. GitHub Actions 워크플로 구조

```text
.github/workflows/
├── release-builder-gate.yml       # 기존 Release Builder Gate (변경 없음)
├── _risu-compatibility-check.yml  # 재사용 가능한 RisuAI Compatibility Check 워크플로
├── risu-compatibility-gate.yml    # PR / main push / 수동 실행용 RisuAI Compatibility Gate
├── risu-upstream-drift.yml        # 주간 스케줄 및 수동 실행용 RisuAI upstream main 드리프트 모니터
└── manual-release.yml             # risu-compatibility-gate 통과 필수 + Release Builder 통과 후 릴리즈 발행
```

### Manual Release SHA Fencing
Manual Release 워크플로는 검증 대상 커밋과 배포 커밋의 동일성을 보장하기 위해 2중 SHA Fence를 수행한다.
1. **Fence #1 (시작 시점)**: Compatibility Gate 검증 SHA(`github.sha`)와 `origin/main` 최신 커밋이 일치하는지 확인하고 해당 exact SHA를 체크아웃한다. 중간에 다른 커밋이 머지된 경우 fail-closed로 즉시 중단한다.
2. **Fence #2 (커밋 생성 직전)**: 릴리즈 빌더 및 회귀 테스트 통과 후 버전 커밋 생성 직전에 다시 `origin/main`과 검증 SHA의 일치 여부를 재확인한다.
3. **Artifact Runtime Verification**: 빌드 직후 실행되는 단계는 upstream 재검증이 아니라 새 버전 메타데이터가 반영된 실제 릴리즈 아티팩트와 기존 검토된 계약 간 런타임 호환성만 확인한다.

---

## 7. Actual-Host 경계 및 비주장(Non-Claims) 원칙

이 게이트의 통과(`PASS`)는 다음을 의미한다:

> "Librarian 릴리즈 아티팩트가 고정된 지원 대상 RisuAI 소스에서 추출·검토된 호스트 계약을 준수하며, 결정론적 호환성 테스트 아래에서 Librarian Storage Authority 계약을 보존한다."

이 게이트는 실제 RisuAI 브라우저 GUI나 WebView `iframe` 전송 계층을 구동하지 않으며(`actualRisuAiGuiExecuted: false`), 모든 제3자 플러그인 조합이나 라이브 LLM 출력 품질을 보증한다고 과장하지 않는다.

---

## 8. 지원 RisuAI 버전(Pin) 갱신 절차

RisuAI upstream 버전을 갱신할 때는 자동 갱신을 금지하고 반드시 아래 절차를 따른다.

1. **드리프트 확인**:
   ```bash
   node PROGRAM/tools/risu_contract_verifier.cjs --upstream-dir /path/to/Risuai --drift-check
   ```
2. **변경 검토**:
   - `changedFiles`, `missingUsedApis`, `signatureChanges`, `semanticDrift` 항목을 검토한다.
3. **계약 재추출**:
   ```bash
   node PROGRAM/tools/risu_contract_extractor.cjs \
     --upstream-dir /path/to/Risuai \
     --commit <NEW_40_CHAR_COMMIT_SHA>
   ```
4. **전체 호환성 게이트 및 회귀 테스트 실행**:
   ```bash
   node --test PROGRAM/tests/risu_compatibility_gate_test.cjs
   node PROGRAM/tools/risu_compatibility_gate.cjs --upstream-dir /path/to/Risuai
   ```
5. **매니페스트 및 체크섬 갱신 후 PR 제출**:
   - `PROGRAM/contracts/risuai/*` 변경분을 스테이징하고 `update_manifest.cjs` 및 `update_checksums.cjs`를 실행한 뒤 코드 리뷰를 거쳐 병합한다.
