# LIBRA Lens Memory: Final Design Specification (2026-10-20)

## 1. Why & Core Principles

Prompt Studio previously edited the Librarian (canonical) analysis prompt. That had two structural problems:

- **Risk.** A custom instruction could break canonical JSON/contract compliance, stop new memory from being saved, or inject plausible-sounding hallucinations into canonical State and people cards.
- **Little effect.** User-requested observations that did not fit the canonical contract's fixed fields (`entities`, `facts`, `stateBindings`) were either squeezed into generic fact text or dropped during admission.

**The solution is strict separation:**
1. **The canonical prompt is locked.** It can be viewed read-only, never edited.
2. **User instructions run as separate lenses.** Each lens has its own model call, its own storage namespace, its own admission gate, and its own recall budget.
3. **One-way authority flow.** A lens can never write to canonical memory, State, or people cards. Optionally, a lens may receive the same turn range's canonical facts as read-only context.

---

## 2. Finalized Design Decisions

| # | Area | Final Decision |
|---|---|---|
| 1 | **Canonical prompt** | **Locked (read-only).** The 19 editable sections, Easy prompt settings, and Librarian addendum are removed from execution. Any legacy custom prompt/profile is reset to the built-in canonical prompt and archived read-only (no migration wizard; Lens Memory is treated as a clean new feature). |
| 2 | **Lens definition scope vs. record scope** | **Global definitions + Per-scope records.** Lens definitions (up to **5** active/paused slots) and their instruction revision history are stored in global plugin settings for reuse across chats (with optional per-scope enable/pause override). Generated lens records, run logs, and raw responses are stored per chat scope (`…:scope:<scope>:lens:<lensId>:…`). |
| 3 | **Slot limit & Trash** | At most **5** lenses in `active` or `paused` status. Deleting a lens moves it to **trash (`trashed`)**, freeing the slot while hiding its records from GUI lists and recall. Trashed lenses can be **restored** (if active + paused < 5) or **permanently deleted** (local + server). |
| 4 | **Evidence levels** | Relaxed compared to canonical memory, but **`refs` (real turns in the analyzed range) are mandatory**. Supports `quoted` (exact quote match in referenced turn), `interpreted` (valid `refs` + `basis`, stored when `evidenceMode === 'interpretive'`), and `rejected` (missing/out-of-range `refs` or mode violation). |
| 5 | **Extra fields (`extra`)** | Any model output fields beyond `{ text, label, refs, quote, basis }` are sanitized and preserved verbatim under `item.extra`, rendered as key-value (`kv`) pairs on lens cards. |
| 6 | **Provenance & Instruction revisions** | Every edit to `instruction` produces a new content-hashed `instructionRevision` and appends the previous instruction to `revisionHistory`. Existing records are never overwritten; records from older revisions display an **"이전 지침으로 생성"** badge and an expandable diff against the current instruction. |
| 7 | **Raw model responses** | Kept in a bounded ring buffer of the **most recent N runs** per lens per scope (default **20**, configurable). Older raw responses are evicted while run summaries and admitted records remain. |
| 8 | **Recall budget & Projection boundary** | Lens memory uses its own recall source kind (`lens`) and a **dedicated budget capped at 20–25% of the dynamic recall budget** (e.g., max 2,400–3,000 chars out of the 12,000-char ceiling, guaranteeing 75–80% for canonical memory), divided among recall-enabled lenses by `recall.share`. Injected blocks carry a explicit non-canonical header (`[LIBRA LENS MEMORY — PERSPECTIVE NOTES (NON-CANONICAL)]`) and per-item tags (`[lens:<name>]` or `[lens:<name> · 해석]`). |

---

## 3. Architecture & Reference Patterns (World Additional / User DLC Integration)

```
chat turns ─┬─▶ canonical analysis (locked prompt) ─▶ canonical memory ─▶ State, people cards
            ├─▶ Micro analysis (existing)          ─▶ Micro memory
            └─▶ lens 1..5 (separate call per lens) ─▶ lens admission gate ─▶ lens memory (per scope & lens)

recall search ◀── canonical (75–80% budget) · Micro · lens (20–25% separate budget, share-weighted)
```

We adopt six battle-tested mechanisms from the reference `WorldAdditionalCore` / `UserDlcCore` architecture:

1. **Non-Canonical Projection Boundary (`WmResultProjection` pattern)**
   - Before injecting any lens item into the prompt, the runtime verifies that the record's `scopeKey`, `worldlineId`, and source revision (`sourceRevisionId` / `sourceDigest`) match the active chat worldline.
   - The injected block explicitly declares that lens notes are user-defined perspective notes and **never override canonical memory or State on conflict**.
2. **In-Flight Source Revision Guard (`lensSourceToken` + Micro binding)**
   - Before dispatching a lens model call for a turn range, LIBRA captures a `lensSourceToken` containing `{ scopeKey, worldlineId, sessionEpoch, turnRange, sourceRevisionId, sourceDigest }`.
   - When the async model call returns, LIBRA re-verifies the token against the current completed-turn receipts / Micro head. If the user regenerated, swiped, deleted, or branched while the call was in flight, the response is discarded (`stale_source_revision`) without touching storage.
3. **Two-Phase Preview & Trial Run (`preview → commit` pattern)**
   - **OOC Creation / Edit Preview:** Creating or editing a lens via OOC generates an in-memory draft showing `before → after` field diffs (`instruction`, `labels`, `evidenceMode`, `canonicalContext`) without mutating saved settings until the user clicks **Apply**.
   - **Trial Run on Recent Range:** From the lens editor or OOC panel, the user can run a 1-call **Trial Run** on the most recent completed batch. The output passes through the real lens admission gate and renders a preview card showing `quoted`, `interpreted`, `rejected` (with reasons), and `extra` fields—without writing to storage.
4. **Human-Readable Korean Admission & Recall Diagnostics (`REJECT_REASON_LABELS` pattern)**
   - Every rejected item in a run record and every filtered candidate in the Recall Viewer records a machine code paired with a clear Korean diagnostic label (see Section 5 & Section 8).
5. **Structured `extra` Key-Value Card Rendering (`udlc-kv` pattern)**
   - User lenses often ask for custom structured facets (e.g., `clueStatus`, `subtext`, `intensity`, `counterparty`). Admitted items store these in `extra` (bounded to max 12 keys, scalar/short-array values) and render them as clean key-value rows inside the lens card.
6. **Revision History & Inline Diff Preservation**
   - Editing a lens increments its revision and archives the prior `{ instructionRevision, instruction, updatedAt }` entry in `revisionHistory` (up to 20 entries) so any older lens record can render an exact side-by-side/inline diff against the current instruction.

---

## 4. Data Schemas

### 4.1 Global Lens Registry (`libra.lens_registry.v1`)

Stored in global plugin settings (runtime `lens_registry`). There are no per-scope overrides: a per-scope copy could silently shadow the global definitions.

```json
{
  "schema": "libra.lens_registry.v1",
  "maxActivePausedSlots": 5,
  "rawResponseRingLimit": 20,
  "recallBudgetRatio": 0.22,
  "recallMaxChars": 2600,
  "lenses": [
    {
      "schema": "libra.lens_definition.v1",
      "lensId": "lens_foreshadow",
      "name": "떡밥·복선 추적",
      "description": "미해결 단서, 수상한 사물, 나중에 회수될 발언을 기록",
      "instruction": "장면에서 스쳐 지나간 단서, 대답을 회피한 질문, 원인이 밝혀지지 않은 이상 현상을 찾아 기록하라.",
      "instructionRevision": "rev_9c41e02b",
      "revisionHistory": [
        {
          "revision": "rev_1a00bc11",
          "instruction": "미해결 단서와 복선을 찾아 기록하라.",
          "updatedAt": 1760000000000
        }
      ],
      "labels": ["떡밥", "단서", "회수됨", "의문"],
      "evidenceMode": "interpretive",
      "connection": { "presetName": "" },
      "cadence": { "mode": "every_batch", "everyNBatches": 1 },
      "canonicalContext": true,
      "recall": { "enabled": true, "share": 1 },
      "status": "active",
      "createdAt": 1760000000000,
      "updatedAt": 1760050000000,
      "trashedAt": null
    }
  ],
  "archivedLegacyPrompts": {
    "archivedAt": 1760000000000,
    "profiles": {}
  }
}
```

- **Slot rule:** `lenses.filter(l => l.status === 'active' || l.status === 'paused').length <= 5`.
- **`connection.presetName`:** `""` uses the default canonical analysis preset; otherwise binds to the named provider preset in `settings.providers`.
- **`cadence.mode`:** `'every_batch'` (runs after every canonical 5-turn batch), `'every_n_batches'` (runs every $N \in [2, 4]$ canonical batches, so one run covers at most 20 turns), or `'manual'` (runs only when triggered from the GUI).

### 4.2 Lens Output Contract (Model Response)

The model is instructed to return a minimal JSON object:

```json
{
  "items": [
    {
      "text": "그녀는 지하실 열쇠의 행방을 묻자 시선을 피하며 찻잔만 만지작거렸다.",
      "label": "단서",
      "refs": ["t12-a"],
      "quote": "그녀는 대답 대신 찻잔만 만지작거렸다.",
      "basis": "열쇠의 위치를 알고 있으면서 대답을 회피하는 반응",
      "target": "엘레나",
      "clueStatus": "미해결"
    }
  ]
}
```

- **Required fields:** `text` (non-empty string) and `refs` (non-empty array of turn IDs within the analyzed range, e.g. `["t12-u", "t12-a"]`).
- **Evidence fields:** `quote` (exact substring from one of the referenced turns) and/or `basis` (short explanation of how the referenced turns support the item).
- **Open fields (`extra`):** Any additional keys (`target`, `clueStatus`, etc.) are extracted into `extra: { target: "엘레나", clueStatus: "미해결" }`.
- **Tolerant wrapper parsing:** Accepts markdown code fences, preambles, or a single top-level wrapper object (e.g., `{ "lens": { "items": [...] } }`), matching canonical admission's envelope unwrapping.

### 4.3 Scoped Lens Record (`libra.lens_memory.v1`)

One record per `(scopeKey, lensId, turnRange)`:

```json
{
  "schema": "libra.lens_memory.v1",
  "recordId": "lrec_lens_foreshadow_t11_t15_r1",
  "lensId": "lens_foreshadow",
  "lensNameSnapshot": "떡밥·복선 추적",
  "instructionRevision": "rev_9c41e02b",
  "scopeKey": "memory-suite:libra:char:...",
  "worldlineId": "wl_main",
  "sessionEpoch": 1,
  "turnRange": { "start": 11, "end": 15 },
  "sourceRevisionId": "srev_...",
  "sourceDigest": "sha256_...",
  "canonicalContextIncluded": true,
  "runId": "lrun_1760050012345_lens_foreshadow",
  "createdAt": 1760050012345,
  "items": [
    {
      "itemId": "litem_0",
      "text": "그녀는 지하실 열쇠의 행방을 묻자 시선을 피하며 찻잔만 만지작거렸다.",
      "label": "단서",
      "evidenceLevel": "quoted",
      "refs": ["t12-a"],
      "quote": "그녀는 대답 대신 찻잔만 만지작거렸다.",
      "basis": "열쇠의 위치를 알고 있으면서 대답을 회피하는 반응",
      "extra": {
        "target": "엘레나",
        "clueStatus": "미해결"
      }
    }
  ]
}
```

### 4.4 Scoped Lens Run Record & Raw Ring (`libra.lens_run_log.v1`)

```json
{
  "schema": "libra.lens_run_log.v1",
  "runId": "lrun_1760050012345_lens_foreshadow",
  "lensId": "lens_foreshadow",
  "instructionRevision": "rev_9c41e02b",
  "scopeKey": "memory-suite:libra:char:...",
  "turnRange": { "start": 11, "end": 15 },
  "sourceRevisionId": "srev_...",
  "sourceDigest": "sha256_...",
  "trigger": "scheduled_batch",
  "provider": "openai",
  "presetName": "RisuAI 보조 모델",
  "model": "gpt-4.1-mini",
  "canonicalContextIncluded": true,
  "startedAt": 1760050010000,
  "finishedAt": 1760050012345,
  "elapsedMs": 2345,
  "status": "ok",
  "counts": {
    "totalParsed": 3,
    "quoted": 1,
    "interpreted": 1,
    "rejected": 1
  },
  "rejectedItems": [
    {
      "index": 2,
      "textPreview": "왕국의 북부 경비대가 반란을 준비 중이다.",
      "refs": ["t99-a"],
      "reasonCode": "out_of_range_ref",
      "reasonLabel": "분석 범위 밖의 턴 참조"
    }
  ],
  "extraKeysPreserved": ["target", "clueStatus"],
  "rawResponseAvailable": true
}
```

---

## 5. Evidence Gate & Diagnostic Reason Codes

Every item returned by the model is classified deterministically by the Lens Admission Gate:

| Evidence Level | Condition | Storage & Recall Treatment |
|---|---|---|
| **`quoted`** | `refs` are non-empty and all exist in the analyzed turn range; `quote` is non-empty and matches a normalized substring of at least one referenced turn. | Stored. Eligible for normal lens recall (full evidence weight `1.0`). |
| **`interpreted`** | `refs` are non-empty and all exist in the analyzed turn range; `quote` is absent or not an exact substring, **and** `basis` (or `quote` used as rationale) is non-empty. | Stored **only when `evidenceMode === 'interpretive'`**. Eligible for lens recall with lower rank weight (`0.78`) and explicit **`· 해석`** tag. Rejected in `strict` mode. |
| **`rejected`** | Fails any requirement above. | **Never stored in lens memory.** Recorded in `run.rejectedItems[]` with a reason code and Korean label. |

### Standard Rejection & Skip Reason Labels

| Code | Korean Label (GUI) | Trigger |
|---|---|---|
| `empty_text` | `내용이 비어 있음` | `item.text` is missing or whitespace-only |
| `missing_refs` | `근거 턴(refs) 누락` | `item.refs` is missing or empty |
| `out_of_range_ref` | `분석 범위 밖의 턴 참조` | `item.refs` names a turn ID not in the analyzed batch |
| `strict_mode_quote_required` | `인용 전용 모드 · 원문 인용 불일치` | `evidenceMode === 'strict'` and `quote` does not match the referenced turn text |
| `missing_basis_for_interpretation` | `해석 근거(basis) 누락` | `quote` does not match verbatim and `basis` is empty |
| `duplicate_item` | `동일 구간 중복 항목` | Identical normalized `(label, text, refs)` in the same run |
| `stale_source_revision` | `원문 변경으로 폐기됨` | Source turns changed while the lens model call was in flight |

---

## 6. Storage Keys & Server Sync (RETRACE Integration)

All per-scope lens keys follow the standard LIBRA scoped key convention so they automatically participate in server mirroring, server-only mode, and JSON portable backups:

- `…:scope:<scope>:lens:head` — Active lens catalog index & source-binding head for the scope (`libra.lens_scope_head.v1`)
- `…:scope:<scope>:lens:<lensId>:records` — Admitted `libra.lens_memory.v1` records keyed by range (`t<start>-t<end>`)
- `…:scope:<scope>:lens:<lensId>:runs` — Run summary log (`libra.lens_run_log.v1[]`)
- `…:scope:<scope>:lens:<lensId>:raw` — Bounded ring buffer of the most recent $N$ (default 20) raw model responses

### RETRACE Server Management & Trash Lifecycle
- **RETRACE category:** Keys matching `:lens:` are classified and displayed as **"렌즈 기억" (Lens Memory)** in RETRACE inventory, sync status, and backup summaries.
- **Soft Delete (Trash):** Moving a lens to trash sets `status: 'trashed'` and `trashedAt: Date.now()`. It immediately stops scheduled runs, hides its records from the Memory tab, excludes them from Recall, and frees one of the 5 active/paused slots.
- **Restore:** Available from the Trash view when `active + paused < 5`. Restores `status: 'paused'` (or previous status) and re-exposes all existing scoped records.
- **Permanent Delete:** Removes the lens definition from `lensRegistry` and deletes `:lens:<lensId>:records`, `:lens:<lensId>:runs`, and `:lens:<lensId>:raw` across both local storage (`pluginStorage` / `local`) and the remote server via RETRACE verified remove.

---

## 7. Recall & Prompt Injection

### 7.1 Indexing & Retrieval
- Admitted lens items from active (and paused, if `recall.enabled === true`) lenses whose `sourceDigest` / `sourceRevisionId` match the active worldline are indexed under `sourceKind: 'lens'`.
- Sparse anchor/keyword scoring and optional dense embedding scoring run alongside canonical recall, with an evidence-level multiplier (`quoted: 1.0`, `interpreted: 0.78`) and a slight tie-break preference (`+0.03`) for items matching the lens's current `instructionRevision`.

### 7.2 Separate Budget & Share Allocation
- Lens recall **never consumes canonical recall budget**.
- By default, the lens recall budget ceiling is **22% of the active dynamic recall character budget** (clamped to at most **2,600 chars** when canonical budget is up to 12,000 chars).
- Across all recall-enabled lenses with candidate matches, each lens $i$ receives a character allocation proportional to its `recall.share`:
  $$\text{Budget}_i = \text{Budget}_{\text{lens}} \times \frac{\text{share}_i}{\sum_j \text{share}_j}$$
- Unused budget from a lens with fewer matches redistributes to other lenses with remaining high-scoring candidates.

### 7.3 Prompt Injection Block Format
```text
[LIBRA LENS MEMORY — PERSPECTIVE NOTES (NON-CANONICAL)]
아래 항목은 사용자가 정의한 별도 관점(렌즈) 기록입니다. 정본 기억(Canonical Memory)이나 현재 상태(State)와 충돌할 경우 언제나 정본 기억이 우선합니다.
- [lens:떡밥·복선 추적] (T11–T15 · 단서) 그녀는 지하실 열쇠의 행방을 묻자 시선을 피하며 찻잔만 만지작거렸다. (원문: "그녀는 대답 대신 찻잔만 만지작거렸다.")
- [lens:떡밥·복선 추적 · 해석] (T11–T15 · 의문) 열쇠의 위치를 알고 있으면서 대답을 회피하는 반응으로 보인다.
```

### 7.4 Recall Viewer Diagnostics
`buildLibraRecallViewerPanel` displays a dedicated **"렌즈 기억 리콜"** section showing:
- Injected lens items (`lensName`, `turnRange`, `evidenceLevel`, `score`, `charCount`, `instructionRevision` status).
- Excluded candidate diagnostics (`lens_paused`, `recall_disabled`, `share_budget_exceeded`, `stale_source_revision`, `below_score_floor`).

---

## 8. GUI Design

### 8.1 Memory Screen: "렌즈" (Lens) Tab
- **Canonical, State, and People views remain untouched.**
- **Top Filter Bar:**
  - Lens chips: `전체` (All) and one chip per lens (`떡밥·복선 추적 (12)`, `감정선 (8)` …)
  - Evidence filter: `전체` | `인용 확인만` | `해석 포함`
- **Lens Item Card:**
  - Header badges: Lens name, Turn range (`T11–T15`), Label (`단서`), Evidence badge (`인용 확인` in green / `해석` in amber), and **`이전 지침으로 생성`** badge if `item.instructionRevision !== lens.instructionRevision`.
  - Body: `item.text`, followed by `extra` key-value pairs rendered in a compact grid (`target: 엘레나 · clueStatus: 미해결`).
  - Expandable Provenance Detail (`근거 · 출처 보기`):
    - Referenced turn IDs (`refs`), verbatim `quote` highlighted against the source turn text, or `basis` explanation.
    - Model/preset used, run timestamp, whether canonical context was included.
    - If created with an earlier instruction: side-by-side / inline diff between the record's instruction revision and the lens's current instruction.

### 8.2 Lens Manager (Prompt Studio Replacement)
1. **Header & Slot Counter:** Shows `활성·일시중지 렌즈 N / 5` and quick buttons: `+ 새 렌즈 만들기`, `템플릿에서 시작`, `휴지통 (M)`.
2. **Lens Cards:**
   - Status toggle (`활성` / `일시중지`), Recall toggle (`리콜 ON/OFF` + 비중), Evidence mode badge (`인용만` / `해석 허용`), Cadence (`매 배치` / `N배치마다` / `수동`), Item count, Last run status badge.
   - Actions: `편집`, `최근 구간 지금 분석`, `실행 기록`, `휴지통으로 이동`.
3. **Lens Editor & OOC Builder:**
   - Fields: Name, Description, Instruction (`textarea`), Suggested Labels, Evidence Mode, AI Connection Preset, Cadence, Canonical Context toggle, Recall ON/OFF & Share.
   - **OOC Assistant ("대화로 렌즈 만들기 / 다듬기"):** Conversational helper that proposes a complete lens draft or edits an existing lens, showing a `변경 전 → 변경 후` preview card before applying.
   - **Trial Run ("최근 구간 시험 실행"):** Runs the current draft instruction once on the latest completed turn range and displays the exact admitted (`quoted` / `interpreted`) and `rejected` items without saving to storage.
4. **Run Log View (per lens):**
   - Lists the most recent runs: timestamp, turn range, model, counts (`저장 N · 제외 M`), and expandable rejection reasons.
   - Button to view the **Raw Model Response** (for the most recent $N=20$ runs; older runs show `"원문 응답 보관 기간 지남"`).
   - Button: **"이 구간 다시 분석"** (re-runs the lens on that specific turn range and replaces that range's record for this lens).
5. **Trash View:**
   - Lists trashed lenses with their trashed timestamp and stored record count in the current scope.
   - Actions: **`복원`** (blocked with a clear notice if active + paused is already 5) and **`영구 삭제`** (deletes definition and all local + server records for that lens).
6. **Locked Canonical Prompt Viewer:**
   - Collapsible read-only card at the bottom: **"기본 기억 분석기 지침 보기 (잠금 · 읽기 전용)"**.

---

## 9. Implementation Phases & Verification Plan

### Phase 1: Foundation & Storage
- Lock the canonical prompt in `LIBRA.js`; archive any existing custom prompt profile read-only and reset canonical analysis to the built-in contract.
- Implement `libra.lens_registry.v1`, `libra.lens_definition.v1`, content-hashed `instructionRevision`, and `revisionHistory`.
- Implement scoped storage keys (`:lens:head`, `:lens:<lensId>:records`, `:lens:<lensId>:runs`, `:lens:<lensId>:raw`) and register the **"렌즈 기억"** category in `RETRACE.js`.
- Build the Lens Execution Job & Admission Gate (`quoted` / `interpreted` / `rejected` + `extra` preservation + `lensSourceToken` in-flight revision guard + 20-run raw response ring buffer).

### Phase 2: Recall & Memory GUI
- Integrate `lens` source kind into LIBRA Recall with a separate 20–25% budget pool, share weighting, non-canonical header formatting, and Recall Viewer diagnostics.
- Add the **"렌즈"** tab to the Memory screen with lens/evidence filter chips, `extra` KV rendering, provenance detail, and instruction revision diff view.

### Phase 3: Lens Studio, OOC & Trial Run
- Replace the editable Prompt Studio sections with the **Lens Studio** (5-slot manager, starter templates, run log viewer, range re-analysis, trash restore/permanent delete, and read-only canonical prompt fold).
- Repurpose the OOC builder for **"새 렌즈 만들기"** and **"이 렌즈 다듬기"** with `before → after` preview and 1-call **Trial Run** on the latest turn range.

### Verification Suite
- **Canonical Lock & Isolation:** Verify no code path can alter the canonical system prompt, and verify that a failing, malformed, or hostile lens output leaves canonical memory, State, and people cards byte-identical.
- **Admission Gate:** Unit tests for `quoted` vs. `interpreted` vs. `rejected`, `strict` vs. `interpretive` mode, out-of-range `refs` rejection, and `extra` field preservation.
- **Provenance & Ring Buffer:** Verify `instructionRevision` hashing, `"이전 지침으로 생성"` badge + diff after instruction edit, and raw response eviction after $N=20$ runs.
- **Lifecycle & Micro Invalidation:** Verify regeneration, swipe, deletion, and worldline branching invalidate affected lens records; verify 5-slot limit enforcement and Trash restore/permanent delete (local + server).
- **Recall Boundary:** Verify lens items stay within their separate budget, carry `[lens:<name>]` / `[lens:<name> · 해석]` labels, and never leak trashed or stale-revision records.

---

## 10. Implementation status (LIBRA 2.3.180, RETRACE 1.9.89)

This section records what the code does where it refines or departs from the sections above.

### Canonical lock
- `compileMemoryPromptProfile` always uses the built-in profile for the Librarian stage. The request, the read-only viewer and the debug APIs all compile through it.
- Custom profiles, Easy settings, OOC guidance and the Librarian addendum stay in storage untouched. That is the read-only archive.
- **No migration wizard.** The Lens Studio's "새 렌즈" view lists the archived texts under "이전에 쓰던 분석 지침", each with "이 지침으로 렌즈 만들기".
- The old Librarian configuration review no longer blocks canonical analysis. Its candidates are shown in the same archive list.
- The old Prompt Studio editor is no longer reachable. The prompt dialog hosts the Lens Studio.

### Engine
- **Provider call.** `callTask('lens_analysis', system, user, { taskKind: 'lens_analysis', presetName, maxTokens, temp, jsonMode })`. An empty lens connection uses the Librarian connection.
- **Evidence gate.**
  - A quote must be at least 6 characters and appear in a *referenced* turn.
  - An item may carry `refs` as an array or a single string. Every ref must name a turn in the range.
  - At most 12 items are stored per run.
  - Codes beyond §5: `item_limit_exceeded`, `not_an_object` and `parse_error`. All codes have Korean labels.
  - Duplicates within a run are rejected as `duplicate_item`.
- **Text sanitizing.** Every stored and recalled text field is reduced to one line. Tags, `[LIBRA …]` and `[SYSTEM …]`-style headers are removed, so a note can never close the evidence wrapper or pose as an instruction.
- **Records.**
  - Keyed by `<worldlineId>:t<start>-t<end>`.
  - A run that admits nothing, or fails, never replaces an existing record. The run log says `keptPreviousRecord`.
  - At most 400 records per lens per chat; the oldest are pruned.
  - The run log keeps 40 entries. The raw ring keeps 20 (configurable 5–50).
- **Concurrency.** All read-modify-write of one chat's lens keys goes through a per-scope queue.
- **Scheduling.**
  - A canonical commit only queues lens runs. A separate queue runs them one at a time after the commit, so lenses never hold the canonical job.
  - A lens new to a chat starts at the committed batch and does not back-fill history.
  - A lens that missed batches catches up on at most three.
  - A job whose chat is no longer open is dropped; the next commit in that chat catches it up.
  - Re-committed ranges are re-run only when the source or the instruction revision changed.
- **Registry.**
  - Normalization is idempotent.
  - The instruction revision is always the hash of the instruction text sent to the model.
  - A lens beyond five active/paused slots moves to the trash (`trashReason: slot_overflow`) instead of being dropped.
  - Create and restore refuse with `LENS_SLOTS_FULL`.
  - Restore returns the lens paused.
  - Permanent delete removes the lens's keys in every chat through the storage bridge (server copies included), then the definition.

### Recall
- **Budget.** `min(recallMaxChars, canonical evidence budget × 0.22)`, default cap 2,600 characters. Below 400 characters, no lens block is sent.
- **Placement.** The lens block is appended after the canonical packet and dropped whole if the classic block would exceed its ceiling. Canonical evidence is never reduced.
- **Relevance floor.**
  - A note needs words in common with the current input: one for short inputs, two for longer ones.
  - A lens whose recall mode is "recent" also sends its two most recent records.
- **Eligible lenses.** Paused lenses with recall on are recalled; trashed lenses never are.
- **Deadline.** The lens step runs inside the recall deadline guard.
- **Recall viewer.** It shows whether the lens block was delivered or dropped for length.
- **Semantic lane and the unified engine (2.3.185).** Lens notes are also matched by meaning in
  the canonical embedding space. A note already said by the delivered canonical/Micro text is
  skipped. See `LIBRA_LENS_RECALL_ENGINE_20261020.md`.

### GUI
- **Lens Studio** (the dialog behind "맞춤 기억 렌즈"). Four views:
  - **내 렌즈.** Cards with status, evidence, cadence, recall and this chat's counts. Actions: edit, analyze the latest 5 turns, pause/resume, trash.
  - **새 렌즈.** A design conversation with a draft, a trial run and create; starter templates; a blank lens; the archived instructions.
  - **휴지통.** Restore and permanent delete with confirmation.
  - **기본 분석기.** The locked canonical prompt, read-only.
- **Editor.** Grouped fields:
  - basics
  - instruction, with the version history
  - evidence and execution
  - recall
  
  A sticky action bar holds trial run, refine by conversation, revert and save. Below it are this chat's run log, the raw response and "이 구간 다시 분석".
- **Memory › 렌즈 기억.**
  - Lens filter, evidence filter, search and a range-run box.
  - Item cards with label, evidence, "이전 지침으로 생성" and "원문 변경됨" badges, the quote or basis, and extra values.
  - "근거 · 출처 보기": the source turn with the quote highlighted, model, time, canonical context, and the instruction diff.

### Server storage
- Lens records, run logs, raw responses and the per-chat head are scope keys and follow the chat's storage mode, like canonical memory. They are written to the server in server-only and mirror modes, and permanent delete removes the server copies.
- The plugin-wide storage-mode discovery classifies `:lens:` keys as chat-scope records (2.3.180). Before this, they were reported as unresolved and blocked the switch.
- Lens definitions live in runtime settings with the other LIBRA settings, which stay on the device.

### Done since the first version
- Story time on each note (the date or time the source states, or "시점 불명") — `LIBRA_LENS_TIME_DESIGN_20261020.md` (2.3.182).
- People on each note: one lens tracks several people by the names the source writes, or "인물 불명" — `LIBRA_LENS_PEOPLE_DESIGN_20261020.md` (2.3.183).
- Meaning-based lens recall in the canonical embedding space, the place of lens notes in the unified memory engine, and name boundaries — `LIBRA_LENS_RECALL_ENGINE_20261020.md` (2.3.185).
- RE:TRACE next-session handoff and native copy carry lens notes — `LIBRA_LENS_HANDOFF_DESIGN_20261020.md` (2.3.181).

### Not yet done
- RETRACE shows lens keys as "[렌즈 기억]" in a scope's detail. It has no separate lens category in inventory or sync summaries.

### Tests
- `tests/libra_custom_memory_lens_runtime_test.cjs`: gate, normalization, provider call shape, isolation, kept records, trial, concurrency, recall, the stale guard, slots and trash.
- `tests/libra_custom_memory_lens_pipeline_runtime_test.cjs`: the locked canonical prompt, a pending lens call not holding the canonical job, the queued run, delivery with a valid response context, and trash exclusion.
- `tests/browser/libra_lens_studio_browser_test.cjs`: the studio and memory tab at 1280 and 390 px, including button spacing and overflow.


### Starter templates (13)

The Lens Studio's "템플릿으로 시작" lists thirteen presets. The first five are the original ones. The next eight turn on the time and people switches where the subject needs them:

| Template | Evidence | 시점 | 인물 | Canonical context |
|---|---|---|---|---|
| 몸 상태 · 건강 기록 | strict | on | on | off |
| 약속 · 일정 | strict | on | on | off |
| 관계 변화 · 호감도 | interpretive | off | on | on |
| 소지품 · 획득 · 분실 | strict | on | on | off |
| 비밀 · 누가 무엇을 아는가 | interpretive | off | on | on |
| 세계관 규칙 · 설정 점검 | interpretive | off | off | on |
| 캐릭터 대사 습관 · 금기어 | strict | off | on | off |
| 갈등 · 긴장 곡선 | interpretive | on | off | on |

Only the body-condition lens has been measured with a live model (see `LIBRA_LENS_RECALL_ENGINE_20261020.md`). All thirteen now also pass scripted provider trials through `runLensForRange` (their own instruction and source refs, one provider call, accepted source-bound evidence), alongside definition/switch/label and create/trash/purge checks. Chromium checks all thirteen preset entries and button spacing at 1280 and 390 px. These scripted trials do not measure the other seven presets' live-model response quality.
