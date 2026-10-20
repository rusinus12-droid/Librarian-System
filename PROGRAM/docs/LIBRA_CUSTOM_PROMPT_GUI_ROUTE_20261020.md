# LIBRA: custom prompts and the route to the GUI (2026-10-20, LIBRA 2.3.178)

## The concern

Prompt Studio, the Librarian addendum and OOC guidance change what the Librarian memory analyzer is told. The concern was that a custom instruction might cut the route from the model's answer to the memory shelf, the people cards and the current-State view:

- New data the instruction asks for would have nowhere to go.
- Added or replaced instructions might make the GUI stop showing data correctly.

## How it was checked

1. **Admission probe.** A valid Librarian answer was rewritten the way custom instructions make models answer. Each variant was then passed through the real parser, record admission and validator. 19 variants were tried, for example:
   - Korean labels for certainty, time and domain
   - a Korean entity type
   - a new relationship axis such as "호감도", or a numeric score
   - a claim kind the contract does not have ("emotion")
   - the whole object wrapped in `{"artifact": …}`, a preamble and a code fence
   - notes added to State bindings
   - extra fields
   - a translated quote
2. **End-to-end run.** `tests/libra_custom_prompt_gui_route_runtime_test.cjs` runs the real analysis and commit with an active custom profile. It compares the stored memory and State against the same answer written in plain contract vocabulary.

## What broke, and the fix

| Custom-instruction effect | Before | Now |
|---|---|---|
| Certainty/time written in Korean ("확정", "현재") | Every fact rejected; the whole five-turn batch failed, so the GUI showed no new memory | Mapped to the contract value |
| Domain written in Korean ("관계", "세계") | Those facts rejected | Taken from the claim kind, which fixes the domain |
| Entity type/kind in Korean ("인물", "장소") | Entity rejected, and every fact about that person dropped with it | Mapped (person / world + kind) |
| Relationship axis outside the list ("호감도", "애정") | Relationship fact rejected; the people card lost it | Mapped to a contract axis (e.g. affection); unknown axes become `other` |
| Relationship value as a number (score) | Rejected | The fact's own qualitative sentence is used |
| A claim kind the contract lacks ("emotion", "foreshadowing") | Fact dropped | Mapped when it names an existing kind (emotion → current condition). Otherwise, when it is about a person, it is kept as an evidence-bound character note, which never becomes a State field. About anything else it stays rejected, since an event would add an invented entry to the chronology. |
| `{"artifact": {...}}` wrapper | Whole batch failed | Wrapper removed before the schema is read |
| Notes added to a State binding | Binding dropped; current State not updated | Extra keys dropped, binding kept |
| Extra fields (importance, tags) | Kept the facts, but reported "기억 부분 저장" (partial save) | Same storage; the message says every fact was kept and lists the dropped items |
| Translated or paraphrased evidence quote | Rejected | Still rejected. The evidence rule is not relaxed. |

Only vocabulary is mapped. Evidence quotes, references, IDs and every later check are unchanged. Each mapping is recorded in the admission report, and the completion message counts them as "표기 보정" (vocabulary corrections).

## Keeping new information visible

- **Reassertion.** The output-contract reassertion sent after a customized profile tells the model where to put information that has no field: in the fact text of the closest existing kind. It also tells the model to keep relationship values qualitative.
- **Prompt Studio checks.** The checks flag requests for scores, new items or tags. They suggest writing "사실 문장에 함께 적어 줘" ("include it in the fact sentence") instead.

## OOC guidance (Prompt Studio by conversation)

- **Analyzer limits.** The conversation and compile prompts now know that the target is the Librarian memory analyzer, and what guidance may and may not change.
  - It may change what to notice, how much detail to keep, and how conservative to be.
  - It may not change the format, fields, claim kinds, evidence quoting or language.
  - When the user asks for something outside these limits, the OOC says so and offers the closest form that works.
- **Section rule.** The compile step sees the section's built-in rule, so it does not repeat it.
- **Preview check.** The preview runs the same checks as the section editor. Risky guidance is flagged before saving.
- **After saving.** "최종 프롬프트에서 확인" (check in the final prompt) opens the final prompt. The section editor and the final prompt follow the profile OOC just saved and activated, unless the editor holds unsaved edits of another profile. The final-prompt view says which profile it shows.
- **Wording.** It now speaks of memory guidance, not creative guidance.

## Tests

- `tests/libra_custom_prompt_gui_route_runtime_test.cjs`: the real analysis and commit with an active custom profile. Korean vocabulary and wrapped/annotated answers store the same memory and State as plain answers. A score and a new kind are kept, and the request carries the reassertion.
- `tests/browser/libra_prompt_studio_ooc_browser_test.cjs` (Chromium, scripted model replies): start, talk, preview, save, saved guidance in the final prompt and in the next Librarian request, and a flagged risky preview.
- `debugWritePromptOverrides` now clears the cached settings like every product save, so the next request uses the written profiles.
