# 남은 작업 정리 — 2026-10-31

이 문서는 2026-10-31 세션을 마치며 **아직 끝나지 않은 일**과 **어떻게 하면 되는지**를 정리한 인계 문서입니다.
이 커밋은 문서만 추가합니다. 아래에 적힌 코드 변경은 아직 아무도 하지 않았습니다.

- 기준 커밋: `488f79f` (GRADIA 0.28.12 / LIBRA 2.6.14 / Flashback 1.3.15)
- 작업 트리에는 외부 작업자가 남긴 **커밋되지 않은 변경**이 있습니다(§1.2). 이 문서는 그 변경을 커밋하지 않습니다.
- `DATA/data-layout.json`은 실행 중에 바뀌는 파일이라 커밋하지 않습니다.

---

## 1. 외부 작업자 작업 리뷰 결과

### 1.1 이미 커밋된 `488f79f` (NSFW 지침 3종 교체, 인풋 후보 전달 결속)

| 항목 | 판단 | 해야 할 일 |
|---|---|---|
| `DATA/data-layout.json`이 커밋에 들어감 | 문제 | 이 파일은 실행 중에 바뀝니다. 다음 커밋에서 되돌리거나, 앞으로 stage하지 않도록 주의합니다. |
| 수동 복사(`onManualCopied`)가 매번 `onValidate`를 다시 부름 | **UX 퇴행** | 사용자는 "복사 후 전송을 눌러도 검증한다며 오래 기다린다"는 문제를 고쳐 달라고 했습니다. 이전 패치는 60초 안에 같은 본문을 이미 검증했으면(`freshVerification`) 다시 묻지 않았는데, 이번 커밋이 그 재사용을 없앴습니다. §2.4에서 정책을 정해야 합니다. |
| NSFW 지침 섹션 수 | 확인 필요 | 본문은 9개 섹션(§0–§8)인데, 커밋 설명과 일부 주석은 8개라고 적혀 있습니다. `NSFW_SECTION_EXCLUSIONS_BY_PHASE`가 단계마다 의도한 섹션을 빼는지 한 번 더 확인합니다. |
| 섹션 계약 전문 교체, 프롬프트 미리보기 동기화 | 양호 | `gradia_nsfw_preview_sync_gui_test.cjs`가 통과합니다. |

### 1.2 커밋되지 않은 변경 (작업 트리)

#### GRADIA — 분석 JSON 복구 (`relaxedJsonParse` 계열)

- **추가된 것**
  - `extractAllJsonObjectStrings`, `repairTruncatedJsonObject`, `repairUnescapedJsonQuotes`
  - `fallbackParseAnalysisSchema(raw, stageName)`
  - `relaxedJsonParse(raw, expectedStage)`: 후보 추출 → 잘린 JSON 보정 → 정규식 fallback
- **시험**: `tests/gradia_analysis_json_robustness_test.cjs` (추적되지 않은 파일)이 5/5 통과합니다.

위험 요소 (커밋 전에 반드시 고칠 것):

1. **가짜 beat를 만들어 냄.**
   - `fallbackParseAnalysisSchema`는 `beats`가 없으면 `'Causal continuity and character reaction beat 1..3'`이라는 자리표시자를 넣고 `ok: true`를 돌려줍니다.
   - 그러면 모델이 계획을 내지 않았는데도 계획이 있는 것처럼 다음 단계로 넘어가고, 초안이 의미 없는 beat를 따르게 됩니다.
   - **고칠 방향**: beat가 없으면 `null`을 돌려주거나 `ok: false`와 이유 코드를 돌려주어, 재시도·중단 경로를 타게 합니다.
2. **잘림 감지를 우회함.**
   - `analysisContractIssue`가 이제 `relaxedJsonParse`가 실패할 때만 잘림을 검사합니다. 잘린 출력을 보정해서 파싱에 성공하면, 잘렸다는 사실이 사라집니다.
   - **고칠 방향**: 원문으로 잘림(`finish_reason`/닫히지 않은 괄호)을 **먼저** 판정해 기록하고, 보정은 그다음에 합니다. 잘린 상태로 보정된 결과는 `truncatedRepaired: true` 표시를 달아 경고합니다.
3. **공용 파서라서 영향 범위가 너무 넓음.**
   - `relaxedJsonParse`의 호출 지점은 17262, 19974, 23468, 23496, 25629, 25656, 25915, 25969, 26018, 26109, 26222, 26269, 27076, 28620 등입니다.
   - 여기에는 AIDE 패치(`replace_draft` 포함)와 인풋 작성기도 들어 있습니다. 잘린 `replace_draft`를 "보정"해서 적용하면 **초안 뒷부분이 조용히 잘린 채 저장**됩니다.
   - **고칠 방향**: 잘린 JSON 보정과 schema fallback은 분석 단계(`ANALYSIS_SCHEMA`)에만 허용합니다. 패치·초안 교체·인풋 후보에는 기존 엄격 파싱을 유지합니다. 예를 들면 `relaxedJsonParse(raw, stage, { allowTruncatedRepair: stage is analysis })`처럼 선택적으로 켭니다.
4. **시험 추가.**
   - 잘린 `replace_draft`가 거부되는지
   - beat가 없는 분석이 재시도로 가는지
   - 잘린 분석이 잘림 경고를 남기는지

#### LIBRA — micro memory 예산, 느슨한 파싱, 리콜 예산 프리셋 GUI

- **변경 내용**
  - micro_memory 토큰 범위를 [4096, 12288]로 바꿈
  - micro 호출 `maxTokens 8192` / `reasoningBudgetCapTokens 4096`
  - envelope 파싱 실패 시 `relaxedJsonParse(candidateText) || relaxedJsonParse(raw)`로 재시도하고 `!envelope`를 확인함
  - `RECALL_BUDGET_PRESETS` 버튼(약 93747행)
- **판단**: 양호합니다. `relaxedJsonParse`는 LIBRA 클로저(644–101398행) 안에 있어 스코프 문제는 없습니다.
- **남은 일**
  - 시험이 없습니다. envelope fallback 시험과 프리셋 버튼이 설정값을 바꾸는지 보는 GUI 시험을 추가합니다.
  - 토큰 상한을 올린 만큼 비용과 지연도 늘어납니다. 릴리스 노트에 적습니다.

#### Flashback — 임베딩 작업 경계 스코프 전달

- **변경 내용**
  - `readEmbeddingWorkBoundary(options)`의 스코프 결정 순서: `options.scope` → `Runtime.currentScope`(scopeKey 일치) → `resolveCurrentScopeIdentityBundle` → `{ scopeKey }` → 그래도 없으면 `FLASHBACK_SCOPE_UNAVAILABLE`
  - `schedulePendingEmbeddingWork`와 `processPendingEmbeddingQueue`가 `scope`를 넘깁니다.
- **판단**: 대체로 양호합니다. "Embedding work does not match its retained source before scope rebinding" 문제를 고치는 방향이 맞습니다.
- **남은 일**
  - 마지막 fallback인 `{ scopeKey }`에는 신원(identity) 정보가 없습니다. 이 경로로 경계를 읽으면 rebinding 검증이 다시 실패하거나, 반대로 검증이 약해질 수 있습니다. 다음 둘 중 하나를 정합니다.
    - identity 없이는 경계를 읽지 않고 다음 예약으로 미루기 (권장)
    - 진단 로그를 남기고 진행하기
  - 위 경로들의 시험이 없습니다. `flashback_native_runtime_fixture.cjs`로 "scope 전달됨 / currentScope 일치 / identity 없음" 세 경우를 추가합니다.

---

## 2. 남은 작업 목록

### 2.1 GRADIA 인풋 작성기 — 기억 병행 읽기 (최우선)

**현상**

- 인풋 후보가 뜨기까지 기억 준비만 **62.9–77초**가 걸립니다.
- 디버그 로그에는 strict owner check가 9회, 합계 84.9초, 평균 9.4초, 최대 12.1초로 찍혀 있습니다.

**원인**

- 다중 owner 읽기 세션(`openReadSession`의 다중 owner 분기, `plugins/GRADIA.js` 약 38150행)이 owner(LIBRA → HAYAKU → Flashback)를 **하나씩 차례로** 엽니다.

```js
try{for(const owner of selectedOwners){
  const remainingCorpus=Math.max(1,maxCorpusBytes-corpusBytes);
  const remainingRaw=Math.min(7*remainingCorpus+2097152,7*maxCorpusBytes+2097152-rawBytes);
  const read=await openLibraReadSession(scopes[owner],{...readOptions,owner, ...});
  ...
}
```

- 열기 전체 시간이 세 owner 시간의 합이 됩니다.
- 남은 예산(`remainingCorpus`)을 앞 owner가 쓴 만큼 줄여 넘기기 때문에, 지금 구조로는 병렬로 바꿀 수 없습니다.
- 반면 `assertCurrent`는 이미 `Promise.all`로 병렬입니다. 열기 단계만 직렬로 남아 있습니다.

**바꿀 방법**

1. **예산을 미리 나눕니다.**
   - 고정 분할: owner 수 `n`에 대해 `perOwnerCorpus = Math.floor(maxCorpusBytes / n)`
   - 가중 분할: LIBRA·Flashback에 더 주는 방식도 가능합니다. 예: Flashback 8 MiB 서버 상한에 비례
   - raw 상한도 같은 비율로 나눕니다: `perOwnerRaw = Math.floor((7*maxCorpusBytes+2097152) / n)`
   - 나눈 예산의 합은 기존 전체 상한을 넘지 않아야 합니다. 기존의 합계 검사(`corpusBytes>maxCorpusBytes`, `metadataBytes>10485760`, `rawBytes>7*maxCorpusBytes+2097152`, `dependencyCount>4096+owners.length`)는 **모두 연 뒤에** 그대로 수행합니다.
2. **동시에 엽니다.**

   ```js
   const settled = await Promise.allSettled(selectedOwners.map(owner =>
     openLibraReadSession(scopes[owner], {...readOptions, owner,
       source: owner==='libra' ? readOptions.source : 'server_logical_read',
       maxCorpusBytes: perOwnerCorpus, maxRawBytes: perOwnerRaw})));
   const reads = settled.filter(r => r.status==='fulfilled').map(r => r.value);
   const failed = settled.find(r => r.status==='rejected');
   if (failed) { for (const read of reads) read.close?.(); throw failed.reason; }
   ```

   - `Promise.all`이 아니라 **`allSettled`**를 씁니다. 하나가 실패해도 이미 열린 세션을 모두 닫아야 하기 때문입니다. 지금의 `catch`는 `reads` 배열만 닫는데, 병렬로 바꾸면 실패 시점에 아직 `reads`에 들어가지 않은 세션이 남을 수 있습니다.
3. **집계는 `selectedOwners` 순서대로 합니다.**
   - 병렬로 열어도 `items`, `revisions`, `sourceByOwner` 배열은 `selectedOwners` 순서를 따라야 합니다. 그래야 `evidenceRevision` 해시가 매번 같습니다. `reads[index]`와 `selectedOwners[index]`가 대응한다는 가정이 `sourceByOwner`에 이미 있습니다.
   - owner별 검사(`item.source.namespace!==owner`, `dataInstanceId` 일치)도 그대로 둡니다.
4. **예산 부족을 처리합니다.** 고정 분할 때문에 한 owner가 자기 몫을 넘으면 `LIB_READ_CORPUS_BUDGET_EXCEEDED`가 이전보다 쉽게 날 수 있습니다. 선택지는 둘입니다.
   - (권장) 서버가 owner별로 잘라서 돌려주므로(`maxCorpusBytes`) 넘는 일은 드뭅니다. 시험으로 확인만 합니다.
   - 넘은 owner만 남은 예산으로 한 번 더 읽는 2차 패스를 둡니다.
5. **unified_engine 경로를 유지합니다.** LIBRA는 plugin IPC(`unifiedReadProvider`)로, 나머지는 `server_logical_read`로 엽니다. 두 경로는 서로 독립이므로 병렬로 열어도 됩니다. `describe()` 확인은 지금처럼 열기 전에 한 번만 합니다.
6. **시험을 추가합니다.** 기반은 `tests/fixtures/gradia_input_writer_unified_fixture.cjs`입니다.
   - 세 owner에 각각 지연(예: 300ms)을 주고, 전체 열기 시간이 합이 아니라 최댓값에 가까운지 확인합니다.
   - 한 owner가 실패하면 나머지 세션의 `close`가 모두 불리는지 확인합니다.
   - owner 응답 순서를 섞어도 `evidenceRevision`이 같은지 확인합니다.
   - 예산 합계 초과 시 기존과 같은 오류 코드가 나는지 확인합니다.

**기대 효과**

- 열기 단계가 `Σ owner 시간`에서 `max owner 시간`으로 줄어듭니다.
- 다만 owner check 하나가 평균 9.4초이므로, 이것만으로는 수십 초가 남습니다. 2.2와 2.3을 함께 해야 체감이 됩니다.

### 2.2 owner별 소요 시간 계측

- 지금 로그에는 "strict owner checks 9 / 합계 / 평균 / 최대"만 있고, **어느 owner가 느린지**가 없습니다.
- `libEvidenceCheckStats`에 owner별로 `open`과 `assertCurrent`의 횟수·합계·최대를 기록하고, 디버그 복사 내용에 넣습니다.
- 2.1과 2.3의 효과를 재려면 이 계측이 먼저 있어야 합니다. 2.1보다 먼저 하거나 같이 합니다.

### 2.3 LIBRA 현재성 검증 비용 줄이기

- 지금까지의 관측으로는 LIBRA의 그래프/렌즈 검증(`assertCurrent`)이 owner check 지연의 대부분일 가능성이 큽니다. 2.2로 확인해야 합니다.
- **방향**
  - 현재성 검증을 "다시 읽고 비교"에서 **revision 비교**로 바꿉니다. LIBRA 쪽이 쓰기마다 올리는 단조 revision(또는 manifest digest)을 돌려주게 하고, GRADIA는 그 값이 열 때와 같은지만 확인합니다.
  - 이미 있는 coalescing(`assertCurrent({coalesce:true})`, `LIB_EVIDENCE_RECHECK_COALESCE_MS=1500`)의 적용 범위를 넓힐 수 있는지 봅니다. 단, **최종 복사 직전 검사는 coalesce하지 않습니다.** "최종 검토 중 원문 변경" 시험이 이 조건을 지킵니다.

### 2.4 수동 복사 재검증 정책 결정

- **현재 동작** (`488f79f` 이후): "직접 복사 후 계속"이나 Ctrl/Cmd+C로 전체를 복사하면 매번 `onValidate`(약 10초)를 다시 실행합니다.
- **사용자 요청**: 복사 후 오래 기다리지 않게 해 달라는 것이었습니다.
- **결정해야 할 것**
  - (A) 직전 60초 안에 **같은 본문**을 검증했으면 재사용합니다(`VERIFIED_COPY_REUSE_MS`). 이전 패치의 방식입니다.
  - (B) 지금처럼 매번 검증하되, 진행 표시를 분명히 하고 coalesce를 허용합니다.
- 권장은 (A)입니다. 본문이 바뀌면 재사용하지 않으므로 안전 조건은 유지됩니다.
- 결정한 쪽으로 `gradia_input_writer_memory_fallback_test.cjs`의 수동 복사 시험을 맞춥니다.

### 2.5 GRADIA 분석 JSON 복구 안전장치

§1.2 GRADIA의 위험 요소 1–4를 고친 뒤에 커밋합니다. 정리하면 다음과 같습니다.

- 잘림 판정을 보정보다 먼저 합니다.
- beat를 지어내지 않습니다.
- 잘린 JSON 보정은 분석 단계에만 허용합니다. 패치, `replace_draft`, 인풋 후보에는 허용하지 않습니다.

### 2.6 LIBRA·Flashback 미커밋 변경 마무리

§1.2의 "남은 일"(시험 추가, Flashback `{scopeKey}` fallback 정책)을 끝낸 뒤 커밋합니다.

### 2.7 버전·매니페스트·실기 확인

- **버전 올림**: 플러그인 헤더 2/4행과 `PLUGIN_VERSION` 행을 바꿉니다(GRADIA 939행, LIBRA 1562행, Flashback 1488행, HAYAKU 992행). 아래 파일도 맞춥니다.
  - `README.md`
  - `0_설치_안내.txt`
  - `PROGRAM/PACKAGE_CONTENTS.txt`
  - `PROGRAM/처음_읽어주세요.txt`
  - `update-manifest.json`
- **매니페스트**: 새 파일을 먼저 stage한 다음, `PROGRAM`에서 아래 두 명령을 실행합니다.

  ```bash
  node tools/update_manifest.cjs
  ```

  ```bash
  node tools/update_checksums.cjs
  ```

- **실기 확인** (RisuAI)
  - 인풋 작성기: 후보가 뜨기까지 걸리는 시간, 선택 → 최종 검토 → 복사가 바로 진행되는지, iframe 클립보드 정책으로 막혔을 때 수동 복사 경로가 동작하는지
  - SHADOW 초안 방식과 NSFW 지침 설정이 기본 설정과 같게 보이는지
  - Flashback 자동 점검 및 복구가 scope rebinding 오류 없이 끝나는지

### 2.8 시험 현황

§3을 참고합니다. 이번 세션 이전부터 있던 실패(HEAD에서도 실패)는 이번 작업과 관계없지만, 따로 정리할 대상입니다.

---

## 3. 시험 현황 (작업 트리 vs HEAD)

> **미완료 측정.** 작업 트리 전체 sweep(시험 파일 147개 + `tests/gradia` 34개, `--test-concurrency=4`)은 도중에 정리했습니다. HEAD와의 같은 조건 비교는 하지 못했습니다. 아래는 그때까지 확인된 사실입니다.

**작업 트리 sweep 중간 집계**: 파일 단위로 통과 40, 실패 24 (나머지는 아직 돌지 않음)

실패한 파일 (작업 트리):

- Flashback 점검
  - `flashback_maintenance_inspection_authority_test`
  - `flashback_maintenance_legacy_argument_inspection_test`
  - `flashback_maintenance_readonly_inspection_test`
  - `flashback_single_turn_maintenance_runtime_test`
- `tests/gradia` (묶음 실행)
- LIBRA recall
  - `libra_associative_recall_3mode_parity_test`
  - `libra_associative_recall_mutations`
  - `libra_main_memory_recall_currentness_test`
  - `libra_main_memory_recall_successor_delivery_test`
- `libra_input_writer_phase06_post_adoption_p1_test`
- LIBRA micro
  - `libra_micro_book_gui_contract_test`, `libra_micro_book_gui_runtime_test`
  - `libra_micro_inherited_same_turn_conflict_test`, `libra_micro_inherited_t5_conflict_3mode_test`
  - `libra_micro_manual_archive_3mode_test`
  - `libra_micro_multi_predecessor_state_3mode_test`
  - `libra_micro_native_copy_decisions_test`
  - `libra_micro_portable_graph_3mode_test`, `libra_micro_portable_predecessor_3mode_test`
  - `libra_micro_stage_retry_test`
  - `libra_micro_state_admission_3mode_test`, `libra_micro_state_frontier_3mode_test`
  - `libra_micro_storage_3mode_test`
  - `libra_micro_timeline_t1t3t5_test`

**이전 부분 비교에서 HEAD에서도 실패로 확인된 것** (이번 변경과 무관한 기존 실패):

- LIBRA (HEAD와 작업 트리 목록이 같음)
  - `libra_micro_multi_predecessor_state_3mode_test`, `libra_micro_state_admission_3mode_test`, `libra_micro_state_frontier_3mode_test`
  - `libra_book_state_progress_test`, `libra_current_state_view_runtime_test`
  - `libra_memory_graph_{assembly,patch_runtime,semantic_runtime,store_runtime}_test`
  - `libra_phase_d_v5_state_scope_commit_boundary_test`, `libra_world_manager_state_3mode_parity_test`
- 별도 묶음의 HEAD 실패
  - `libra_input_writer_phase06_post_adoption_p1_test`, `libra_micro_native_copy_decisions_test`, `libra_receipt_sparse_micro_frontier_test`
  - 개별 시험 "malformed or truncated writer JSON is not retried and cannot persist its derived content"도 HEAD에서 실패합니다. §1.2의 JSON 복구 작업과 직접 관련이 있으니, 2.5 때 함께 봅니다.
- Flashback 시작 시험
  - "actual startup authority …" / "actual final await …" 28건과 "startup defers a missing retired-only vector dependency" 1건이 HEAD와 작업 트리 모두에서 실패합니다.

**아직 판정하지 못한 것 (다음 작업자가 확인할 것)**

1. 작업 트리에서만 보인 LIBRA micro 실패가 새 실패인지 확인해야 합니다. 대상은 `book_gui_*`, `inherited_*`, `manual_archive`, `portable_*`, `stage_retry`, `storage_3mode`, `timeline_t1t3t5` 등입니다.
   - 외부 LIBRA 변경(micro 토큰 범위 [4096,12288], `maxTokens 8192`, envelope 느슨한 파싱)이 원인일 수 있습니다.
   - 예: `libra_micro_storage_3mode_test`는 "the frontier reports the analytically produced turns (got [])"로 실패합니다.
   - HEAD의 `plugins/LIBRA.js`로 바꿔 같은 파일만 다시 돌려서 비교합니다(`--test-concurrency=1` 권장).
2. Flashback 점검 4종과 LIBRA recall 4종도 같은 방법으로 HEAD와 비교합니다.
3. `tests/gradia` 묶음은 개별 파일로 다시 돌려 어떤 시험이 실패하는지 확인합니다.
4. 실행 환경: `NODE_PATH=$PWD/build-support/node_modules` (jsdom). 동시 실행 4에서는 시간 의존 시험이 흔들릴 수 있으니, 실패한 파일은 단독으로 다시 확인합니다.

**이번 세션에 추가·확인된 GRADIA 시험** (단독 실행에서 통과):

- `gradia_shadow_draft_mode_gui_test`
- `gradia_nsfw_preview_sync_gui_test`
- `gradia_input_writer_memory_fallback_test`
- `gradia_analysis_json_robustness_test` (미추적, 5/5)

---

## 4. 권장 순서

1. 2.2 owner별 계측 → 2.1 병행 읽기 (함께 PR 하나)
2. 2.5 JSON 복구 안전장치 → 외부 GRADIA 변경 커밋
3. 2.6 LIBRA·Flashback 시험 보강 → 커밋
4. 2.4 수동 복사 정책 결정 → 반영
5. 2.3 LIBRA revision 기반 검증 (LIBRA·GRADIA 양쪽 계약 변경이라 별도 PR)
6. 2.7 버전·매니페스트·실기 확인
