# LIBRA lens memory: recall engine and the unified memory engine (2026-10-20)

Status: **implemented on `feature/custom-memory-lenses` (LIBRA 2.3.185).** It extends
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
4. **No double delivery.** A lens note whose text is at least 85% covered by the delivered
   canonical/Micro text is skipped. The covered share is counted in character bigrams, and the
   recall viewer shows "정본·Micro 기억에 이미 같은 내용".
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
  label · text · names · time. The vectors are stored at `…:lens:<lensId>:vectors`.
  - Each vector is stored as int8 with a scale: about 1.4 KB for 1024 dimensions, instead of about
    20 KB as JSON floats.
  - Entries are keyed by note and by a hash of the embedded text, so an edited or re-run note is
    embedded again.
  - Inherited notes are embedded in the successor chat the same way.
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

Status on 2026-10-20: the embedding provider answered. The chat-model key (Ollama Cloud) was
rejected with HTTP 401, so the chat-model sections have not been measured yet. The name rules
below are built from the corpus's boundary cases and the observed model output shapes, and are
covered by deterministic tests until the live run is repeated.

## Tests

- `tests/libra_lens_semantic_recall_runtime_test.cjs`:
  - the compact vector store, with no duplicate embedding of an unchanged note;
  - a paraphrase recalled by meaning only with embeddings on, unrelated input not recalled, and the
    query cache reused;
  - delivered-memory coverage;
  - outage fallback and profile-change repair;
  - inherited vectors and purge;
  - the studio switch;
  - the actual request hook delivering a meaning-only note.
