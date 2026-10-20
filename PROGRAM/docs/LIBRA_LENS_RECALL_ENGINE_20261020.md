# LIBRA lens memory: recall engine and the unified memory engine (2026-10-20)

Status: **implemented on `feature/custom-memory-lenses` (LIBRA 2.3.188; initially 2.3.185).** It extends
`LIBRA_LENS_MEMORY_DESIGN_20261020.md` §7.

## What was missing

Lens recall matched words only. A note was a candidate when it shared one character bigram with
the input (two for longer inputs). It was not connected to the embedding settings that canonical
memory and Micro already use. A paraphrase ("할머니 관절은 괜찮으셔?" for "무릎이 쑤신다") or a
synonym ("심장 박동" for "맥박") found nothing. The lens block was also built without looking at
what canonical recall had just delivered, so a lens note could repeat a canonical sentence and
spend the lens budget twice.

## Place in the unified memory engine

| Layer | Authority | Produced by | Recall path | Budget |
|---|---|---|---|---|
| Canonical memory | Fact (highest) | Librarian per 5 turns | Unified graph (lexical + vectors) | Canonical evidence budget |
| State tracking | Current state of people, places and objects | State pipeline from canonical | Unified graph | Inside the canonical packet |
| Micro memory | Per-turn detail | Micro writer | Unified graph (Micro vectors) | Inside the canonical packet |
| **Lens notes** | **Perspective, non-canonical** | Lens runs after a canonical commit | **Lens lane (lexical + vectors)** | Own share: `min(recallMaxChars, canonical budget × ratio)` |

Rules that hold the layers together:

1. **Precedence.** Canonical memory, then State, then Micro, then lens notes. The lens block
   arrives last under its own header ("PERSPECTIVE NOTES (NON-CANONICAL)") and is dropped whole if
   the classic block would exceed its ceiling. Lens notes never reduce canonical evidence.
2. **One query.** The lens lane uses the same current-input text the unified recall resolved
   (`queryBundle.currentText`). Lens notes are never written into canonical memory, State or
   people cards.
3. **One embedding space.** The lens lane reads the canonical embedding settings. Vectors are
   compared only when their embedding profiles (provider, model and dimensions) are equal.
4. **Conservative duplicate delivery.** Skip only an exact note sentence already present in
   delivered canonical/Micro text. When people/time are tracked, their verified identity must
   also be written inside that sentence. Unknown or separately stored identity and extra values
   keep the note eligible; body-text similarity alone cannot establish that the same event was
   delivered. This preserves, for example, yesterday's Jiho note when today's Mina note has the
   same symptom wording. The viewer still reports "정본·Micro 기억에 이미 같은 내용" for a verified
   duplicate. The lens budget remains unchanged.
5. **Shared identity.** People on lens notes are grouped through the people registry that State
   maintains (read only). Names the registry knows only as places or objects are not people.
6. **Lifecycle.** Lens vectors are ordinary `:lens:<id>:` scope keys:
   - they follow the storage mode;
   - they are exported with the scope;
   - permanent lens deletion removes them;
   - they are excluded from the handoff source fingerprint, so a background write cannot fail a
     handoff.

## Semantic lane

- **Document vectors.** After a lens run stores notes, each note's text is embedded:
  label · text · names · time. `…:lens:<lensId>:vectors` holds a `libra.lens_vector_store.v2`
  index; immutable `:vectors:page:<digest>` values hold `libra.lens_vector_page.v1` pages.
  - Each vector is stored as int8 with a scale: about 1.4 KB for 1024 dimensions, instead of about
    20 KB as JSON floats.
  - Entries are keyed by note and by a hash of the embedded text, so an edited or re-run note is
    embedded again.
  - Inherited notes are embedded in the successor chat the same way.
  - Index and pages are each bounded to 192 KiB of serialized UTF-8, below the storage SDK's
    4 MiB default and 256 KiB minimum interactive-value limits. The 4,000-note logical limit
    does not become a single oversized value.
  - Publish a checkpoint after each complete batch of at most 32 notes, writing pages before
    the index. A later provider/write failure retains earlier batches; retry and restart reuse
    them. Concurrent refresh callers share one job, and purged lenses cannot publish late pages.
  - Existing v1 single-key stores remain readable and migrate without re-embedding valid vectors.
    Missing/corrupt pages alone are rebuilt; pruning/profile changes remove replaced pages.
- **Query vector.** The request hook starts the lens query embedding while canonical recall runs
  (`prewarmLensQuery`). The provider's query cache coalesces the two, so lens recall waits on at
  most one embedding round trip, bounded to 2.5 s.
- **Scoring.** A note is a candidate when either of these holds:
  - it passes the lexical floor, or
  - its cosine is at least `LENS_SEMANTIC_FLOOR` (0.42).

  Relevance is the larger of the lexical share and the semantic share. The semantic share reaches
  its full 0.6 at `LENS_SEMANTIC_HIGH` (0.60). Evidence level, recency, ordering, per-lens shares
  and item limits are unchanged.
- **Self-repair.** Missing vectors (a new profile, a successor chat, an older note) are refreshed
  in the background, and that request uses what is there.

Pre-merge regression checks in 2.3.188 use controlled providers: different people/time, unknown
identity, Japanese names containing と, failed-provider and failed-index checkpoints, v1 migration,
missing-page repair, and concurrent refresh/purge. The real HTTP/SQLite server was also checked in
`server_only` and `mirror` with 125 synthetic stored runs × 24 notes (3,000 × 1024D): the logical
store exceeds 4 MiB while each value stays within 192 KiB, restart makes no new provider calls,
and permanent deletion removes every page. These checks do not extend the live-model quality
figures below to a new corpus or model.
- **Fail-open cases.** Each of these falls back to lexical recall, and the recall viewer says so:
  - embeddings are off;
  - the query embedding fails or times out;
  - the vectors were made in another embedding profile;
  - the studio switch "의미가 비슷한 렌즈 기억도 회상" is off.

## Calibration (live embeddings)

`tools/rag_eval/libra_lens_live_eval.cjs --only goldrecall` stores the hand-written gold notes of
`libra_lens_live_corpus.json` (20 notes about 7 people and a dog across 10 turns). It then runs
10 queries, lexical only and then hybrid, with `voyage-4-large` (1024 dimensions):

| | Lexical only | Hybrid |
|---|---|---|
| Queries answered (8 with a relevant note, 2 negative) | 6 / 10 | 8 / 10 |
| Paraphrase queries answered (6) | 2 | 4 |

Every query/note pair was scored; 22 of the 200 pairs are relevant.

| Threshold | Precision | Recall | F1 |
|---|---|---|---|
| 0.36 | 0.72 | 0.82 | 0.77 |
| 0.40–0.42 | 0.90 | 0.82 | **0.86** |
| 0.44 | 0.94 | 0.68 | 0.79 |
| 0.50 | 0.90 | 0.41 | 0.56 |

The relevant pairs had a median cosine of 0.48 and a 90th percentile of 0.59. The other pairs had
a 90th percentile of 0.31, a 99th of 0.42 and a maximum of 0.53. `FLOOR` = 0.42 and `HIGH` = 0.60
follow from this.

Remaining misses:

- "강아지는 이제 괜찮아?" fails because the note says "콩이" and the text never says it is a dog.
  No lens-side signal can link them.
- "오늘 저녁 메뉴" matches the time text "저녁에는" lexically.

The corpus is small, so these numbers set a sensible default and are not a general benchmark.

## Live model evaluation

`tools/rag_eval/libra_lens_live_eval.cjs` runs every lens feature against a real chat model and
real embeddings:

- the five starter templates;
- strict vs interpretive gates, and the trial run;
- design-assistant settings (trackTime/trackSubject);
- the body-signal lens scored against 18 gold facts for people, time and forbidden names;
- four name-boundary probes;
- recall on the live notes.

Run it with `RAG_EVAL_LLM_URL`/`_KEY`/`_MODEL` and `RAG_EVAL_EMBED_URL`/`_KEY`/`_MODEL`. Reports
and model logs must be written outside the repository.

### Results (2026-10-20, `deepseek-v4.1-flash` via Ollama Cloud, `voyage-4-large`, temperature 0)

| Feature | Result |
|---|---|
| Starter templates (5 × 3 runs, 2 spans each) | Every successful response parsed, and the gate rejected no notes. Some runs returned nothing because the provider took more than 120 s (see below). |
| Strict vs interpretive (3 runs) | Strict kept 4 quoted notes each time; interpretive kept 6, all quoted. Both found the Monday appointment. |
| Trial run | Stored nothing (3/3). |
| Design assistant (4 requests × 3) | 12/12 set the expected `trackTime`/`trackSubject`. It also turns people on for speech and promise lenses. |
| Body-signal lens: 18 gold facts × 3 runs | Fact recall 1.00, owner accuracy 1.00, time accuracy 1.00. No place, hypothetical person or pronoun was stored as a person. |
| Recall on the live notes (10 queries) | Lexical 7/10, hybrid 9/10. |
| Name probes (4 × 3 runs) | See `LIBRA_LENS_PEOPLE_DESIGN_20261020.md`. |

**What the first live run found and changed (2.3.186).** Before these fixes, the body-signal lens
scored fact recall 0.89–0.94 and owner accuracy 0.94–1.00.

- **Cut notes.** A five-turn span with eight people produced 13–14 notes, and the cap of 12
  silently cut the latest turn (the menstrual-cycle facts). The cap is now 24 per run, and the
  prompt states it.
- **Owner confusion.** The model sometimes recorded a symptom under the person who diagnosed it
  ("한서윤 선생님은 … 편도가 부었다고 진단"). The prompt now defines `who` as the person the fact
  is about, not the one who observed, measured, diagnosed, reported or said it.
- **Persona name.** The user's first person ("나") and the persona's name ("민아") were two
  people. The user's persona name is now read from the host (the chat's bound persona, else the
  selected one), so "user" is stored under that name and groups with it.
- **Copy slip in a quote.** "일찍" was copied as "일찾", which rejected a whole note. A quote within
  10% edits of a span of a cited turn is replaced by that span, so the stored quote is still the
  source's own text; a quote that differs in meaning is still rejected.
- **Bare surname.** "김" for "간호사 김 선생" is stored as "김 선생" (3/3); a bare surname without a
  titled phrase in the span is not a person.

**Provider latency.** 9 of 30 template runs ended at exactly 120 s, the lens call timeout, while
the cloud model was slow. Such a run is recorded as failed and stores nothing; canonical memory is
unaffected. This was provider latency, not a gate or parse failure: every response that arrived
parsed.

**Limits.** This is one synthetic corpus with one model, so the numbers show the pipeline works
end to end and the boundary rules hold. They are not a general accuracy benchmark. Grouping still
needs a people card to join "서윤", "한서윤" and "한 선생님".

## Live data → GUI (2.3.187)

`tools/rag_eval/libra_lens_live_gui_check.cjs` checks that what a real model writes reaches the
screen. It works in three steps:

1. **Generate.** On the test VM host, the real chat model and real embeddings write notes for a
   body-signal lens (time and people on) and the "떡밥·복선 추적" template. The corpus chat yields
   38–41 notes about 8 people, 13–15 of them with a stated time. A people-and-promise lens on a
   chat with canonical memory yields 8–10 notes.
2. **Load.** That storage is loaded into the shipped plugin in Chromium.
3. **Compare.** Every displayed value is compared with the engine's own `inspectScopeLenses`
   view, at 1280 and 390 px.

It checks:

- **Lens tab cards.** One card per note. Text, label and quote match. The person row has the
  grouped names, the "원문: …" written form and the user badge, or shows unknown. The time row has
  the source wording or "시점 불명".
- **Lens tab chips and search.** Chips use the engine's grouping and counts, and each chip
  filters to its notes. Search by a person's name finds their notes.
- **Provenance.** Every provenance fold highlights the quote, the time and the names in the turns
  the engine recorded.
- **Studio.** Lens cards carry the "시점 기록" and "인물 구분" chips. Each lens's run log shows the
  saved, time and people counts of every run.
- **Recall.** The real request hook (`beforeRequest`) delivers the lens lines, carrying people and
  time, with the semantic lane ready on live embeddings. The recall viewer counts and lists the
  same notes, with score, meaning score, people and time.
- **Layout.** No horizontal overflow, no touching buttons and no page errors.

What it found and fixed:

- **Squeezed text in the recall viewer.** On a 390 px screen, the lens rows in "현재 턴 리콜 상세"
  squeezed the note text into a one-character column. The shared `.row` is a three-column grid;
  lens recall rows now stack in one column. The check measures that no row child is narrower than
  half the panel.
- **English key names.** Extra values showed the templates' machine keys ("clueStatus", "holder",
  "target"). The keys stay as stored; the card now shows Korean labels ("단서 상태", "당사자",
  "대상"), with the key in the tooltip.
- **People and time missing from the recall viewer.** The viewer rows now show each delivered
  note's people and time, which the prompt line already carried.

Results: 54/54 checks passed on the final run (`deepseek-v4.1-flash`, `voyage-4-large`). Two
checks were corrected in the checker itself, not in the GUI: a name or time that lies inside the
highlighted quote is shown by the quote's mark, and the run log lives in each lens's editor.

## Tests

- `tools/rag_eval/libra_lens_live_gui_check.cjs` (live, above). The `libra_lens_studio_browser_test`
  also checks the Korean label of a known extra key.
- `tests/libra_lens_semantic_recall_runtime_test.cjs`:
  - the compact vector store, with no duplicate embedding of an unchanged note;
  - a paraphrase recalled by meaning only with embeddings on, unrelated input not recalled, and the
    query cache reused;
  - delivered-memory coverage;
  - outage fallback and profile-change repair;
  - inherited vectors and purge;
  - the studio switch;
  - the actual request hook delivering a meaning-only note.
