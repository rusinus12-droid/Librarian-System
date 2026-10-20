# LIBRA lens memory: design (2026-10-20, draft for implementation)

## Why

Prompt Studio used to edit the Librarian (canonical) analysis prompt. This had two problems:

- **Risk.** A bad instruction could stop new memory from being saved, or put plausible but wrong values into the current State and the people cards.
- **Little effect.** Information the user asked for had to fit the canonical contract's fixed fields. It ended up inside fact text, or was lost.

The fix is to split the two. The canonical prompt is locked. User instructions run as separate **lenses**. Each lens has its own model call, its own storage and its own recall source. A lens can never write to canonical memory, State or the people cards.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Canonical prompt | Locked. It can be viewed, never edited. |
| 2 | Number of lenses | Several, at most **5** per user. The GUI stays simple. |
| 3 | Evidence | Relaxed: interpretations are allowed, but each item must name real source turns. See *Evidence levels*. |
| 4 | Provenance | Every lens record shows how it was made. See *Provenance*. |
| 5 | Deleting a lens | The lens and its records move to a **trash** (hidden, out of recall). They can be restored there or deleted permanently there. |
| 6 | Raw model responses | Keep only the **most recent N runs** per lens (default 20). |
| 7 | Records after a lens instruction changes | Keep them unchanged and mark them with a **"이전 지침으로 생성"** (made with an earlier instruction) badge. They are not re-analyzed automatically. |

## Architecture

```
chat turns ─┬─▶ canonical analysis (locked prompt) ─▶ canonical memory ─▶ State, people cards
            ├─▶ Micro analysis (existing)          ─▶ Micro memory
            └─▶ lens A, lens B, …  (one call each)  ─▶ lens memory (per lens)

recall search ◀── canonical · Micro · lens (own source kind, own budget)
```

- **Flow is one way.** Lenses never write to canonical memory, State or the people cards. A lens may receive the canonical facts of the same range as read-only context.
- **Failures are isolated.** A failed lens leaves canonical analysis and the other lenses alone.
- **Built on Micro.** Micro memory is the template: a separate provider job, its own schema and head, and its own recall kind with a lower authority label. Lens memory reuses Micro's binding to source revisions. That binding invalidates records on regeneration, swipe, deletion and worldline branching.

## Canonical lock

- **Prompt Studio changes role.** It stops editing the Librarian prompt: the 19 sections, Easy settings and the Librarian addendum are removed. It becomes the lens manager.
- **The canonical prompt stays visible.** "최종 프롬프트 보기" (view final prompt) shows it read-only.
- **Migrating old custom profiles.** On first start after the change, users with a customized memory profile see a one-time question: "이 지침을 렌즈로 옮길까요?" (move this guidance into a lens?).
  - **Yes:** a lens is created from the profile's custom text.
  - **Either answer:** the canonical prompt returns to the built-in profile. The old profile is archived read-only.
- **Defences kept.** The output-contract reassertion becomes unnecessary once no custom text reaches the canonical prompt. Admission vocabulary normalization (2.3.178) stays, because models drift without custom instructions too.

## Lens definition

| Field | Meaning |
|---|---|
| `lensId`, name, description | e.g. "떡밥 추적" (foreshadowing tracker), "감정선" (emotional arc) |
| instruction | The user's text, typed or built with OOC. Every edit creates a new **instruction revision**, identified by a content hash. |
| labels (optional) | Suggested item labels, e.g. `떡밥` (foreshadowing), `회수됨` (paid off). Without them the model labels freely. |
| evidence mode | `strict` stores only quoted items. `interpretive` also stores interpreted items. |
| connection | An existing AI preset. The default is the canonical connection. |
| cadence | Every canonical batch, every N batches, or manual only. |
| canonical context | When on, the range's canonical facts are passed read-only. This helps interpretive lenses at the cost of extra tokens. |
| recall | On or off, plus this lens's share of the lens recall budget. |
| status | `active`, `paused`, `trashed` |

- **Separate calls.** Each lens is its own call. Combining lenses would be cheaper, but one failure would fail them all and provenance would blur.
- **Limit.** At most 5 lenses, counting active and paused. Trashed lenses do not count.

### Output contract (deliberately small)

```json
{ "items": [ { "text": "…", "label": "…", "refs": ["t12-a"], "quote": "…", "basis": "…" } ] }
```

- **Fixed fields.** Only `text` and `refs` are required.
- **Interpreted items** must also give `basis`, a short reason.
- **Other fields are kept, not dropped.** Any other field is stored verbatim under `extra`. Unlike canonical memory, a lens exists to hold what the user asked for.
- **Light parsing.** The parser accepts code fences, preambles and a single wrapper object, as canonical admission now does.

## Evidence levels

| Level | Condition | Use |
|---|---|---|
| `quoted` | `quote` matches the text of a referenced turn exactly | Normal recall |
| `interpreted` | `refs` name real turns in the analyzed range, but there is no matching quote. `basis` is present. | Recalled with an "해석" (interpretation) mark and a lower rank. Stored only in `interpretive` mode. |
| rejected | `refs` is missing, or names turns outside the range or that do not exist | Not stored. Listed in the run record with the reason. |

**Refs stay mandatory.** Without them a fabricated item could be recalled as memory, and its provenance could not be shown.

## Storage

- **Record.** One lens record per (lens, analyzed range). It is bound to the source revision the same way Micro records are.
- **Record fields:**
  - `schema: libra.lens_memory.v1`
  - `lensId`, `instructionRevision`
  - `scopeKey`, `turnRange`, `sourceDigest`, `sourceRevisionId`
  - `items[]`, each with an evidence level, refs, quote, basis and `extra`
  - `run` (see *Provenance*)
- **Instruction revisions.** Stored once per content hash, so records can always show the instruction they were made with.
- **Keys.** `…:scope:<scope>:lens:<lensId>:…`, for the lens definition, revisions, records, the run log and raw responses. The keys sync to the server like the other scope keys. RETRACE server management lists them as "렌즈 기억" (lens memory).
- **Raw responses.** A ring of the most recent N runs per lens (default 20, adjustable). Older raw responses are removed. Records and run summaries stay.

### Trash

- **Deleting a lens** sets it to `trashed`. Its records are hidden from the GUI lists and excluded from recall. Nothing is erased.
- **The trash view** lists trashed lenses with their record counts and the time they were trashed. From there a lens can be:
  - **restored**, which brings back the lens and its records
  - **deleted permanently**, which removes the definition, revisions, records, run log and raw responses, both locally and on the server
- **Trash does not hold the 5-lens slots.** If restoring would exceed 5 active and paused lenses, the user must pause or trash another lens first.

## Provenance

Every lens run stores a run record. Every item links to it.

- **Lens and instruction.** The lens name and the instruction revision used. If it differs from the current revision, the record shows the badge **"이전 지침으로 생성"** and a diff against the current instruction.
- **Model.** The connection and model name, the time, and the analyzed turn range.
- **Context.** Whether canonical context was included.
- **Each item.** Its evidence level and refs. Quoted text is highlighted in the source turn.
- **Admission result.** Items stored, items rejected (with reasons), and fields kept under `extra`.
- **Raw response.** Kept while the run is within the most recent N runs. After that it shows "원문 응답 보관 기간 지남" (raw response no longer kept).

An instruction change does not touch existing records. They keep their revision and get the badge. Re-analysis happens only when the user asks for it, from the run log ("이 구간 다시 분석", re-analyze this range).

## GUI

**Memory screen: one "렌즈" (lens) tab.** Canonical, State and people views are unchanged.
- **Filter.** Lens chips at the top: 전체 (all) and one per lens.
- **List rows.** Each row shows:
  - the item text
  - the label
  - the turn range
  - an evidence icon (quoted or interpreted)
  - the earlier-instruction badge when it applies
- **Detail.** Selecting an item opens its provenance.

**Lens manager (Prompt Studio).**
- **Lens cards.** Each card shows status, the last run result, the item count and an edit button.
- **Edit view.**
  - instruction
  - settings
  - OOC conversation
  - trial run on a recent range (one model call; the result is not saved)
- **Run log.** One line per run: time, range, stored and rejected counts, and errors. A raw response can be opened while it is kept. Re-analyze is offered per range.
- **Trash.** A separate view inside the manager.
- **Final prompt.** The canonical prompt is shown read-only.

## Recall

- **Indexing.** Lens items are indexed as their own source kind, `lens`, with the existing sparse and embedding retrieval.
- **Budget.** Lens items have a separate injection budget, divided between lenses by their recall share. Lens items never take canonical budget.
- **Injection label.** Each injected item names its lens and evidence level, e.g. `[lens:떡밥 추적 · 해석]`. The block header says these are user-defined analyses, and that canonical memory wins on conflict.
- **Exclusions.** Trashed lenses, paused lenses with recall off, and records with stale source revisions are never recalled.
- **Recall viewer.** It lists the lens items injected into each request.

## OOC

- **Two entry points.** "새 렌즈 만들기" (new lens) and "이 렌즈 고치기" (edit this lens).
- **Freer than before.** With no canonical contract to protect, OOC may suggest labels, an evidence mode, and whether canonical context is needed.
- **Trial run.** Before saving, OOC can run a trial on a recent range. The user sees the items the lens would produce, and can judge its effect before committing.

## Cost

- **Model calls.** One extra call per active lens per scheduled run. Cadence, pausing and a cheaper connection per lens control the cost. With no lenses, the cost is zero.
- **Storage.** Records and run summaries are small. Raw responses are the large part, which is why only the most recent N are kept.

## Phases

1. **Foundation.**
   - Canonical lock and migration prompt
   - Lens definitions and instruction revisions
   - Lens run job, built on the Micro job and binding
   - Output parsing and evidence levels
   - Run records, raw-response ring, trash state
2. **Visibility.**
   - Lens tab with provenance detail
   - Recall integration and recall-viewer rows
   - RETRACE listing and permanent deletion through the server
3. **Convenience.**
   - Lens manager: cards, run log, trash view
   - OOC entry points and trial run
   - Live-model measurement with and without lenses

## Tests to add

- **Lock.** No path changes the canonical system prompt, and migration resets it.
- **Isolation.** A failing, malformed or hostile lens leaves canonical memory, State and the people cards byte-identical.
- **Evidence levels.**
  - quoted vs interpreted vs rejected
  - strict mode stores quoted items only
  - refs outside the range are rejected
- **Provenance.**
  - The record shows its instruction revision.
  - The badge appears after an edit.
  - Raw responses are evicted after N runs.
- **Lifecycle.**
  - Regeneration, swipe, deletion and branching invalidate lens records, as for Micro.
  - Trash: hide, restore, and permanent delete (local and server).
  - The 5-lens limit holds, and restoring enforces it.
- **Recall.**
  - Lens items stay within their own budget.
  - Lens items are labelled.
  - Trashed and stale records never appear.
- **Browser.** The lens tab, provenance detail, manager, trash and OOC trial run.
