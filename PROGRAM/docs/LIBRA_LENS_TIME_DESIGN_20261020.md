# LIBRA lens memory: story time on each note (design, 2026-10-20)

Status: **design only, not implemented.** It extends `LIBRA_LENS_MEMORY_DESIGN_20261020.md`.

## Problem

Some lens notes must never be confused about *when* they happened: health and injuries, pregnancy
and cycles, schedules, promises with dates. Today a note records only the turn range it came from
(`T11–T15`). It records no story date or time.

A prompt can ask the model to write a time into an extra value, but that has three weaknesses:

- **The model does not know the date outside the span.** A lens reads one span of turns. If the date
  was stated in an earlier span and this span says "three days later", the model has to guess.
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
- Relative expressions are copied as written. They are not resolved against an earlier time.
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
  trial run and the run log show them.

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
3. Found: store `when: { text, ref }` with the turn where it was actually found.
4. Not found, or shorter than two characters after normalizing: store `when: null`. If the model
   gave a text that is not in the source, also set `whenIssue: "not_in_source"` and count it in
   `timeDropped`. The model's text is not kept.

A missing or invalid time **never rejects the note.** The note is still true and useful. It is
stored as "시점 불명", so the reader sees the gap instead of losing the note. `whenIssue` marks the
case where the model tried to state a time the source does not contain, which is the one case worth
the user's attention.

## Where it shows

- **Memory tab, note card.** A time row sits between the header and the text:
  - stated: **시점 · 3월 4일 밤** with a green "원문 명시" badge;
  - unknown: **시점 불명** with an amber badge, "원문에 시점 없음", or "원문에서 확인되지 않아 제외"
    when `whenIssue` is set.
- **"근거 · 출처 보기".** The turn that states the time is listed with the quote's turn ("시점이 적힌
  턴"), and both the quote and the time text are highlighted in the source excerpt.
- **Lens card in the studio.** A "시점 기록" chip.
- **Trial run.** The result shows "시점 불명 N" next to the quoted, interpreted and rejected counts,
  and each trial card shows its time row. This lets the user judge a lens before saving it.
- **Run log.** The counts of stated, unknown and dropped times appear with the other counts.
- **Recall.** A tracking lens always states its time in the recalled line, so the model is never left
  to assume one:

  ```
  - [lens:건강·몸 상태] (T11–T15 · 시점: 3월 4일 밤 · 부상) 지호의 왼팔에 열상이 생겼다. (원문: "…")
  - [lens:건강·몸 상태] (T16–T20 · 시점 불명 · 회복) 상처가 아물기 시작했다.
  ```

  The time text also counts toward relevance, so a question that mentions "3월 4일" finds the note.
  A note from a lens with time tracking off is recalled as before, with no time part.
- **Sanitizing.** The time text goes through the same one-line sanitizing as every other note text,
  at storage time and again when the line is rendered.

## Behavior with other lens features

- **Older records.** Notes made before `trackTime` was turned on show no time row. They are not
  re-analyzed; "이 구간 다시 분석" can regenerate them with the setting on.
- **Next-session handoff.** The handoff archive (see `LIBRA_LENS_HANDOFF_DESIGN_20261020.md`) carries
  `when`, `whenIssue` and `trackedTime` unchanged, so an inherited note keeps its stated time and its
  unknown marker.
- **Pregnancy, cycles and similar tracking.** Use a lens with `trackTime` on, evidence mode
  "해석 허용", and recall mode "최근 기록은 항상", so the latest notes are always sent even when the
  input shares no word with them. The time on each note is what the source says; a lens never works
  out the week or day itself.

## Limits (by design)

- **Only the analyzed span counts.** A time stated in an earlier span is not carried forward. A note
  whose span only says "three days later" is stored as "시점 불명", not as a guess. This is the price
  of never guessing.
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
   run-log counts.
3. **Assistant.** `trackTime` in the lens design conversation and its before/after comparison.

## Tests to add

- **Gate.** A time copied from the span is stored with the turn where it was found. A time stated in
  another turn of the span is found. A text that is not in the source becomes `null` with
  `not_in_source` and is counted. A whitespace variant matches. A missing time is stored as unknown
  and the note is kept. A lens with `trackTime` off stores no `when` and ignores a model-given one.
- **Prompt.** The time rules appear only for a tracking lens.
- **Records.** `trackedTime` separates "not recorded" from "unknown"; turning the setting on later
  does not rewrite old records or change the instruction revision.
- **Recall.** The line shows the stated time or "시점 불명" for a tracking lens, and nothing for a
  lens that is not tracking; the time text counts toward relevance; the text is sanitized.
- **Browser.** The time row (stated and unknown), the provenance highlights, the editor switch and
  the trial counts, at 1280 and 390 px.

## To confirm

1. **Per lens, off by default** (assumed above). The alternative is on for every lens.
2. **A note without a time is kept as "시점 불명"** (assumed above). The alternative is to discard it,
   which loses true notes.
3. **No carry-forward of earlier times** (assumed above, to avoid any guess). The reference line under
   "Possible later additions" could be added if unknown notes turn out to be common.
