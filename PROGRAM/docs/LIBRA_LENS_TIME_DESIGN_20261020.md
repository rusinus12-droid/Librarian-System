# LIBRA lens memory: story time on each note (design, 2026-10-20)

Status: **design only, not implemented.** It extends `LIBRA_LENS_MEMORY_DESIGN_20261020.md`.
The existing lens handoff is implemented in LIBRA 2.3.181 / RE:TRACE 1.9.90; the time fields and
their provenance described here still need to be added to that path.

## Problem

Some lens notes must never be confused about *when* they happened: health and injuries, pregnancy
and cycles, schedules, promises with dates. Today a note records only the turn range it came from
(`T11–T15`). It records no story date or time.

A prompt can ask the model to write a time into an extra value, but that has three weaknesses:

- **An absolute date may be unavailable inside the span.** If the date was stated earlier and this
  span says "three days later", converting that phrase into a calendar date would require inference.
  The lens must keep "three days later" as the stated time instead of making that conversion.
- **A stated time and a guessed time look the same.** Both are stored as plain text, so a reader
  cannot tell which one to trust.
- **Nothing is shown or recalled as a time.** The card and the recalled line give no time, and
  extra values are short free text with no verification.

## Rule (decided)

**A note's time is whatever the analyzed source states.** If the source turns of the span contain a
date or time expression for the note, the lens copies it exactly. If they do not, the note says
"시점 불명". The model never calculates, converts, completes or guesses a time, and never uses a
date from its own knowledge.

Consequences of the rule:

- The time is stored as text, exactly as written in the chat ("3월 4일 밤", "다음 날 아침",
  "새벽 두 시", "그로부터 사흘 뒤"). It is not parsed into a calendar date, so it works for any
  calendar, real or invented.
- Relative expressions are copied as written, including "다음 날 아침" and "그로부터 사흘 뒤".
  They are known source expressions even when their absolute date is unknown. They are not resolved
  against an earlier time; an unresolved relative expression alone is not a reason to mark a note
  "시점 불명".
- No elapsed-day or week count is computed. A value such as "임신 12주" appears only if the chat
  says it.
- The turn range stays on every note. Order in the lens tab stays the turn order.

## Setting

A lens gets one setting, `trackTime`, off by default. In the editor it is a switch under "근거와
실행": **"원문에 적힌 시점을 함께 기록"**, with the note "원문에 없으면 추측하지 않고 시점 불명으로
표시합니다. 날짜 계산은 하지 않습니다."

It is per lens because the rule changes what a lens stores: a mood or speech-style lens has no use
for it, and forcing a time on it would only produce "불명" notes. The lens design conversation
(`draftLensWithAssistant`) can set it: it is told to turn `trackTime` on when *when* something
happened must not be confused (health, injuries, pregnancy, cycles, schedules, deadlines).

## Data

- **Lens definition.** `trackTime: boolean`. Turning it on or off does not change the instruction
  revision, because it is not part of the instruction text. Records made earlier stay as they are.
- **Item.** For a lens with `trackTime`, each item has `when`: either
  `{ text, ref }` (the time expression and the turn that states it) or `null` (unknown). An item
  also has `whenIssue`, empty or `not_in_source` (see the gate).
- **Record.** `trackedTime: boolean`, the lens setting at run time. This separates two cases that
  must not look alike: a note made while time tracking was off has *no time recorded*, and a note
  made while it was on with `when: null` has *an unknown time*. The first shows no time row; the
  second shows "시점 불명".
- **Run log counts.** `timeStated`, `timeUnknown` and `timeDropped`, only for a tracking lens. The
  trial run and the run log show them. These count accepted items: `timeStated + timeUnknown`
  equals the accepted item count, and `timeDropped` is the subset of `timeUnknown` with
  `whenIssue: "not_in_source"`.

## Model contract

When `trackTime` is on, the item shape gains two fields:

```json
{ "label": "…", "text": "…", "refs": ["t3-a"], "quote": "…", "basis": "…",
  "when": "3월 4일 밤", "whenRef": "t2-u" }
```

The system prompt adds these rules:

- `when` is the date or time expression the source turns state for the moment of this note, copied
  exactly as written. `whenRef` is the turn that contains it.
- If the span states no date or time for the note, `when` and `whenRef` are empty strings.
- Copy a relative expression as it stands, even if its absolute date cannot be determined.
- Choose a time only when the source clearly ties it to this note's event. Do not borrow a date
  from another event, quoted recollection or hypothetical situation that this note is not about. If
  several moments are present and the connection is ambiguous, leave the time empty. Preserve the
  source's distinction between a scheduled event and one that has already happened.
- Never calculate, convert, complete or guess a date or time that the source does not state, and
  never use a date from the model's own knowledge.

The time may be stated in a different turn of the span than the turns the note cites (the date in
turn 1, the event in turn 3). That is why `whenRef` is separate from `refs`.

## Gate

The gate checks the time the same way it checks a quote, against the analyzed span only.

1. Normalize the `when` text: single-line sanitizing, at most 120 characters. Compare it with
   whitespace removed, so "3월4일" and "3월 4일" match.
2. Look for it in the turn named by `whenRef`, then in the turns the note cites, then in any other
   turn of the span.
3. Found: store `when: { text, ref }` with the turn where it was actually found. Store the matched
   source wording after single-line sanitizing, not a model-reformatted spelling. Whitespace
   removal is for comparison only: if the model gives "3월4일" and the source says "3월 4일", the
   stored text is "3월 4일".
4. Not found, or shorter than two characters after normalizing: store `when: null`. If the model
   gave a text that is not in the source, also set `whenIssue: "not_in_source"` and count it in
   `timeDropped`. The model's text is not kept.

A missing or invalid time **never rejects an otherwise accepted note**. The ordinary evidence gate
still decides whether the note itself is admitted. An admitted note with no verified time expression
is stored as "시점 불명". `whenIssue` marks a supplied expression that could not be found in the span;
the discarded expression is not kept in the item or the recall line.

### What this gate proves

This is a literal-source check, not semantic verification of an event's date. A span can say "the
appointment is on March 4" and "the injury happened on March 5". Both dates pass a presence check;
that check alone cannot detect a model assigning March 4 to the injury. `whenRef` identifies the
actual matching turn, but a fallback match elsewhere in the span does not prove the association.

The prompt requires a clear event/time connection and an unknown result when it is ambiguous. The
UI must let the user inspect the time-bearing source and explain that "원문 명시" means the expression
was found in the analyzed source, not that its association with the event was independently verified.
`whenIssue` remains a literal-validation result; an empty value must not be presented as proof of
semantic correctness. This limitation applies to current and inherited notes alike.

## Where it shows

- **Memory tab, note card.** A time row sits between the header and the text:
  - stated: **시점 · 3월 4일 밤** with a green "원문 명시" badge;
  - unknown: **시점 불명** with an amber badge, "확인된 시점 없음", or "원문에서 확인되지 않아 제외"
    when `whenIssue` is set. A missing model value does not prove the source contains no time.
- **"근거 · 출처 보기".** The turn that states the time is listed with the quote's turn ("시점이 적힌
  턴"), even when it is absent from the item's `refs`. Both the quote and the time text are
  highlighted in the source excerpt. The time badge's help text explains the literal-check limit
  above; the source remains available for the user to judge the event/time connection.
- **Lens card in the studio.** A "시점 기록" chip.
- **Trial run.** The result shows "시점 불명 N" next to the quoted, interpreted and rejected counts,
  and each trial card shows its time row. This lets the user judge a lens before saving it.
- **Run log.** The counts of stated, unknown and dropped times appear with the other counts.
- **Recall.** Each recalled record made with `trackedTime: true` includes its stated expression or
  "시점 불명". Use the record's setting at creation, not the lens's current switch:

  ```
  - [lens:건강·몸 상태] (T11–T15 · 시점: 3월 4일 밤 · 부상) 지호의 왼팔에 열상이 생겼다. (원문: "…")
  - [lens:건강·몸 상태] (T16–T20 · 시점 불명 · 회복) 상처가 아물기 시작했다.
  ```

  The verified time text also counts toward relevance, so a question that mentions "3월 4일" can
  match the note; existing relevance floors and budgets still apply. A record made with tracking
  off, or an older record with no `trackedTime`, is recalled as before, with no time part.
- **Sanitizing.** The time text goes through the same one-line sanitizing as every other note text,
  at storage time and again when the line is rendered.

## Behavior with other lens features

- **Older records.** Notes made before `trackTime` was turned on show no time row. They are not
  re-analyzed; "이 구간 다시 분석" can regenerate them with the setting on.
- **Next-session handoff.** The handoff archive (see `LIBRA_LENS_HANDOFF_DESIGN_20261020.md`) carries
  `when`, `whenIssue` and `trackedTime` unchanged, so an inherited note keeps its stated time and its
  unknown marker. The lens definition snapshot also carries `trackTime`.
  - Collect source turns from the union of the item's `refs`, its `quoteRef`, and its non-null
    `when.ref`. The current archive builder collects only `item.refs`; preserving the new fields
    alone would lose time provenance when the date was stated in another turn.
  - The bounded archived excerpts must contain the verified time expression, including a match
    beyond the existing 4,000-character prefix. If quote and time are far apart in one turn, keep
    bounded excerpts covering both. Do not claim a highlight is available when the stored excerpt
    omits it.
  - The successor reads and highlights these archived sources. It never substitutes a
    same-numbered turn from its live chat. Validate `when.ref` against the archived record's source
    range, without requiring it to be in `item.refs`.
  - Apply the same preservation and provenance rules to native chat copy, chained handoff and
    portable export/restore. Keep old records valid without adding fabricated time fields.
- **Pregnancy, cycles and similar tracking.** Use a lens with `trackTime` on, evidence mode
  "해석 허용", and recall mode "최근 기록은 항상" when recent notes from the current chat should be
  eligible without a keyword match. This is eligibility, not a delivery guarantee: item limits and
  lens budgets still apply. Inherited notes remain subject to relevance matching, even in this mode,
  as the handoff design requires. Starting a successor chat therefore does not make a previous
  chat's latest health note automatically eligible. This design does not change that recall rule.
  The time on each note is what the source says; a lens never works out the week or day itself.

## Limits (by design)

- **Only the analyzed span counts.** A time stated in an earlier span is not carried forward. A note
  whose span says "three days later" stores that expression when it refers to the note; its absolute
  date stays unresolved. "시점 불명" applies when there is no verified source expression for the
  note, not merely when an absolute calendar date is unavailable.
- **Literal validation only.** An expression found in the span can still be associated with the
  wrong event by the model. The source badge and the tests must not imply automatic semantic
  verification. Inspect the cited source when that distinction matters.
- **No story-time ordering or date filter.** Times are free text, so the lens tab keeps turn order.
- **One time per note.** A note about an event that spans several moments carries the time of the
  moment the source ties to it. The model is told to pick the one that governs the note.

## Possible later additions (not part of this design)

- A "시점 불명만" filter in the lens tab.
- A reference line "이 앞에서 마지막으로 확인된 시점: … (T12)", computed by code from the lens's
  earlier stated times and shown next to an unknown note. It would be labeled as a reference and
  never used as the note's own time.

## Implementation plan

1. **Engine.** The `trackTime` field and normalization, the prompt contract, the gate, the record
   and run-log fields, the recall line.
2. **Reading and GUI.** Time row, provenance highlights, the editor switch, the card chip, trial and
   run-log counts. Extend handoff/native-copy archive snapshots and validation to include the
   time-bearing turns and bounded excerpts, then verify successor reading and portable round trips.
3. **Assistant.** `trackTime` in the lens design conversation and its before/after comparison.

## Tests to add

- **Gate.** A time copied from the span is stored with the turn where it was found. A time stated in
  another turn of the span is found. A text that is not in the source becomes `null` with
  `not_in_source` and is counted. A whitespace variant matches. A missing time is stored as unknown
  and the note is kept. A lens with `trackTime` off stores no `when` and ignores a model-given one.
  Verify that a whitespace variant stores the matched source wording and that an out-of-range
  `whenRef` cannot cause a read outside the analyzed span.
- **Relative expressions.** "다음 날 아침" and "그로부터 사흘 뒤" are preserved without conversion,
  including when the earlier absolute date is outside the span. A span with no time expression
  yields unknown; an unresolved absolute date alone does not.
- **Several events and dates.** Exercise correct event/time selection and an ambiguous example
  where the controlled model returns no time. Include a separate gate case documenting that an
  in-span date for the wrong event can pass the literal check; this is not a semantic-verification
  test. Check that the UI exposes the matching source and explains the badge's actual guarantee.
- **Prompt.** The time rules appear only for a tracking lens.
- **Records.** `trackedTime` separates "not recorded" from "unknown"; turning the setting on later
  does not rewrite old records or change the instruction revision. A current tracking switch must
  not change the presentation of an older record.
- **Run counts.** `timeStated + timeUnknown` equals the accepted count and dropped times are a
  subset of unknown, in trial results and persisted logs. Tracking-off runs have no time counts.
- **Recall.** The line shows the stated time or "시점 불명" for a tracking lens, and nothing for a
  lens that is not tracking; the time text counts toward relevance; the text is sanitized.
  Inherited notes with no keyword overlap stay ineligible in recent mode; eligible notes still
  fit the unchanged lens budget.
- **Handoff and native copy.** Preserve stated, unknown and untracked records, the lens snapshot,
  and a `when.ref` absent from `item.refs`. Highlight time and quote from archived excerpts after
  handoff, a second handoff, native copy and portable export/restore, with an empty or different
  successor chat. Include a time beyond the old 4,000-character prefix and distant quote/time
  matches in one turn. Check digests/counts and backward compatibility of archives with no time data.
- **Browser.** The time row (stated and unknown), the provenance highlights, the editor switch and
  the trial counts, at 1280 and 390 px.

## Defaults used by this design

1. **Per lens, off by default.** Enable it only for lenses that need time provenance.
2. **An otherwise accepted note without a verified time is kept as "시점 불명".** Missing time does
   not discard the note; the ordinary evidence gate continues to apply.
3. **No carry-forward of earlier times or conversion of relative expressions.** Keep a relative
   expression from the current span as written. The separate reference line under "Possible later
   additions" remains outside this design.
