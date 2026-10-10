# LIBRA 2.3.24 · Librarian Book UX integration patch

## Scope
- UI/navigation patch only. No Canonical Memory, Current Head, correction journal, provider, embedding, storage, or response pipeline schemas were replaced.
- Existing 12-workspace shared router remains intact for compatibility/deep links/tests.
- New six-surface Book shell is the mounted presentation layer: Reading Desk / Memory / People / World / Story / Settings.

## 1:1 bridges
- Memory → existing read/context/manage Memory Hub.
- People → Character Current Head + directional Relationship Current Head; UI-only composition, no data-model merge.
- World → existing World Current Head current/structure/evidence/correction shell.
- Story → Current Narrative, Narrative Direction, structure, evidence/correction.
- Settings Room → Settings + Pipeline + Agents + Custom/Prompt Studio/OOC/Skill Router + Execution Logs.
- Quick Settings → response-family settings + Input Writer + Memory Agents + AI + Embedding + Server using the existing actual builders.

## Mobile
- Dedicated five-item bottom navigation.
- Single-column Book page, chapter rails stay horizontally scrollable through the existing responsive reader rules.
- Drawer becomes full-width.

## Safety
- Shared navigation/deep-link contract is retained.
- Directional Relationship authority remains separate from Character authority.
- Narrative Direction remains separate from current Narrative facts.
- No mock-only style controls were added to runtime settings. GRADIA continues to use its real current Quick Settings/Prompt Studio contracts.
