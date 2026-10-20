# LIBRA AI settings layout, box hierarchy and Prompt Studio (2026-10-20, LIBRA 2.3.177)

## 1. AI settings: presets next to the selected connection

**Before.** Everything in the "생성 AI 프리셋" (generation AI presets) card was stacked vertically:
- the preset list
- the buttons
- the "전역 기본 AI 연결" (global default AI connection) fold
- a long "선택한 연결 상세" (selected connection detail) fold with ungrouped fields

**Now.**
- **Two columns.** The preset list sits on the left and the selected connection on the right. The list stays in view while the detail scrolls.
- **Grouped fields.** The detail is split into three groups:
  - 기본 정보 (basics): name, default connection
  - 연결 (connection): provider, URL, model, API key
  - 생성 설정 (generation): temperature, max output tokens, timeout
  - Expert fields and actions follow the groups.
- **Narrow layouts.** Below about 560 px of card width, the columns stack. Inside a narrow detail column, fields use one column.
- **RisuAI auxiliary connection.** Its detail opens in the same detail column.

## 2. Clearer boxes across the GUI

There are three surface levels: page, card, and inset panel.
- **Cards** have a firmer border, a soft shadow and a ruled-off header.
- **Inset panels** inside a card have their own tint and border. These are folds, lists, tables, notes and field groups.
- **Open folds** show a tinted header and a light body.

Neighbouring boxes no longer blend into the card around them.

## 3. Prompt Studio

### Does it conflict with the GUI viewers?

**It cannot put malformed data into a viewer.** Every analysis result goes through the canonical artifact parser and validator before any viewer shows it. The output contract always comes first in the system prompt, and Prompt Studio text cannot replace it.

**It can still affect what the viewers show, in two ways:**
- **No new memory.** Asking for prose, markdown or another language, or blanking a core rule, makes analysis fail. The memory shelf then shows no new memory.
- **Wrong values.** Asking to "always mark facts confirmed" passes validation but skews certainty, time role and State bindings. The current-state and people viewers then show wrong values.

**The Prompt Studio GUI itself does not clash with the viewers.** It uses its own dialog and IDs, its storage keys are not shared with the viewers, and a refresh rebuilds only its own panel.

### Defects fixed

| # | Defect | Fix |
|---|---|---|
| 1 | The runtime lock was compiled but never sent. The request used only the profile body, so user text had the last word in the system prompt. | A customized profile (a non-default profile, or a Librarian addendum) ends the system prompt with an output-contract reassertion. The default profile is sent unchanged. The preview uses the same composition. |
| 2 | Easy settings wrote to retired Ariadne section IDs, which normalization dropped. Only the "narrative" checkbox and the free-text addendum took effect. | Easy settings write to the Librarian lenses: `complete`, `uncertain`, `relation`, `time`, `world`, `narrative`. "적용될 내용" (what will be applied) lists the real additions. |
| 3 | The "final prompt" preview showed a stale "ito patch" lock line and left out the real contract, the analyzer addendum and the NSFW block. | "최종 프롬프트 · 점검" (final prompt · check) shows the system prompt exactly as sent. It is split into locked blocks (contract, NSFW, reassertion) and the editable profile, followed by the user-message layout and a copy button. |
| 4 | Saving a prompt saved every other unsaved setting, such as AI preset edits. | Prompt Studio saves write only the prompt overrides. Other pending edits stay unsaved for the main save bar. |
| 5 | The OOC target catalog repeated the 19 memory sections for retired Planner, SGA and Input Writer domains. This filled the 220-target cap, and phantom saves reported success. | Only the memory domain is offered. |
| 6 | The OOC prompt called itself "Creative Guidance". | The wording describes memory guidance for the Librarian analyzer. |
| 7 | There was no sign of unsaved section edits. | A "저장 안 된 변경" (unsaved changes) badge and a changed-section count appear. |

### New and reorganized

- **Jump bar.** It links to 간편 설정 (Easy settings), 대화로 만들기 (build by conversation, OOC), 구역 편집 (section editing), 최종 프롬프트 · 점검 (final prompt · check) and 가져오기 · 내보내기 (import · export). Each link shows that area's state: changed count, warnings, or applied.
- **Section editing.** Each of the 19 sections is its own fold. Only changed or flagged sections start open. "모든 구역 기본으로" (reset all sections to default) resets the draft.
- **Checks before saving.** These are flagged:
  - a blanked section
  - a replaced core rule
  - instructions that change the output format or language
  - instructions to force certainty or to guess
  - instructions to ignore the rules
  - instructions to continue the scene
  
  Each warning says what the user would see in the viewers.
- **Hidden single choices.** A domain button or stage select with only one option is no longer shown.

### Tests

- `tests/libra_prompt_studio_dispatch_contract_runtime_test.cjs`: the dispatched system prompt carries the reassertion only when the profile is customized, and the dispatch code builds the same prompt.
- `tests/browser/libra_prompt_studio_browser_test.cjs` (real Chromium):
  - the Easy options survive normalization
  - the checks flag the right edits
  - a prompt save leaves an unsaved AI preset unsaved
  - the dialog shows the jump bar, 19 section folds, and locked and editable blocks
- `tests/libra_prompt_studio_ooc_default_targets_test.cjs` now expects the memory domain only, with 19 targets.
- The shared browser host and the OOC GUI fixture start past the first-setup quick-connect popup. That popup has its own tests. Before this change, it blocked every click in those harnesses.
