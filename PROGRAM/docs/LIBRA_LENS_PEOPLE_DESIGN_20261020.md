# LIBRA lens memory: people on each note (2026-10-20)

Status: **implemented on `feature/custom-memory-lenses` (LIBRA 2.3.184; initially 2.3.183).** It extends
`LIBRA_LENS_MEMORY_DESIGN_20261020.md` and follows the same rules as
`LIBRA_LENS_TIME_DESIGN_20261020.md`.

## Problem

Some lenses, such as a body-signal or health lens, follow facts that belong to particular people.
A chat often has several people in it, and whose symptom it was must not be confused. The user does
not want to name the people in advance, or run one lens or one model call per person.

## Rule (decided)

One lens, one model call per run, several people. Each note says whose note it is, using names
the chat text itself writes. Otherwise it says "인물 불명". The code checks every name against the
source and never guesses one.

## Setting

`trackSubject` per lens, off by default. The editor switch is "등장인물별로 구분해 기록". The design
assistant turns it on for lenses about people's bodies, moods, relationships or possessions, and
never proposes one lens per person. Turning it on or off does not change the instruction revision
or older records.

## Data

- Item fields:
  - `who`: an array of up to four `{ name, ref, role }`. `role` is `named`, `user` or `char`.
  - `whoIssue`: `''` or `'not_in_source'`.
- Record field: `trackedSubject`. Every display follows the record's own setting, not the lens's
  current switch, as with `trackedTime`.
- Run counts: `subjectNamed + subjectUnknown` equals the accepted count. `subjectDropped` counts
  notes that had at least one name removed.

## Model contract

The "People" prompt block and the `who`/`whoRef` schema fields appear only for a tracking lens. The
model:

- copies each name as written;
- uses `"user"` for the user's own first person in a user turn;
- uses `"char"` for the character's own first person in an AI turn (the prompt names the character);
- writes one note per person, and lists several names only when the same fact applies to each;
- leaves `who` empty when the owner is unclear: a pronoun that could mean more than one person, or
  "both" or "everyone" without names;
- never merges people and never uses a name the source does not contain.

## Gate

- **Named person.** The name must be in the analyzed span. The search tries `whoRef`, then the
  note's refs, then every turn of the span. Matching ignores whitespace, then tries NFKC.
  - The stored name is the matched source wording, and `ref` is the turn where it was found.
  - A ref outside the span is never read.
- **Not a name.** Pronouns and group words (그녀, 나, 모두, she, …) and one-character names are
  dropped.
- **"user" / "char".** Accepted only when the note cites a user turn or an AI turn. The character's
  own name also maps to "char" when it is not written in the span.
  - The user's first person is stored as "사용자", because the persona name is not part of the chat
    context the lens reads.
- **Unverified names** are dropped and flagged with `whoIssue`. The note is kept, and becomes
  "인물 불명" if no name remains.
- **Same wording, different people.** Two notes with the same wording about different people are
  separate notes, with distinct item ids and deduplication keys.

### What this gate proves

It proves the name is written in the analyzed source. It does not prove the fact belongs to that
person: with two people in one paragraph, a model that swaps them still passes. The provenance fold
highlights the name in its turn so the user can check it.

## Grouping (read time only)

Records are never rewritten. When notes are read (lens tab, recall), names are grouped as follows:

1. A written name that is the name or an alias of **exactly one** people card (read only) joins
   that card, which shows its card name with "원문: …" beside it.
2. `user` and `char` group by role.
3. Any other name groups by its core name: the written form without a trailing honorific
   ("서윤 선생님" and "서윤", "지호씨" and "지호"). See "Name boundaries" below.

A name that matches two people cards is never merged. A people card added later, or a different
successor chat, regroups old notes without changing them.

## Where it shows

- **Note card.** A "인물" row above the time row, showing:
  - the names;
  - "사용자 1인칭" or "캐릭터 1인칭" badges;
  - "인물 불명" with "확인된 인물 없음" or "원문에서 확인되지 않아 제외";
  - "확인되지 않은 이름 제외" when only some names were dropped.
- **Provenance fold.** Lists the name turn ("이름이 적힌 턴 (지호)") and highlights the name.
- **Lens tab rail.** Person chips are built from the notes, with counts, with "인물 불명" last. A
  chip filters the list, and search also matches names.
- **Studio.** A "인물 구분" chip, a "인물 불명 N" trial badge, and named/unknown/dropped counts in
  the run log.
- **Recall.** `(T1–T5 · 인물: 지호 · 시점: … · 약속)` or `인물 불명`.
  - Written names and the people card's name and aliases count toward relevance.
  - Same-worded notes about different people are not deduplicated against each other.

## Handoff, native copy, portable

Archive excerpts include each named person's turn and keep the name inside the bounded excerpt.
The archive validator checks `trackedSubject`, the `who` shape and range, that each name turn has
an excerpt, and `whoIssue`. Archives without people data stay valid.

## Limits

- The literal check above is not a semantic one.
- The user's first person is grouped as "사용자". A persona name written in a turn groups separately
  unless a people card links it.
- At most four people per note. The per-run note limit is unchanged.

## Validation

- `tests/libra_lens_story_people_runtime_test.cjs`:
  - Gate cases: named, other turn, whitespace, two people with the same wording, a shared fact,
    the four-name cap, invented names, pronouns, partial drops, user/char, the character's name,
    an out-of-range ref.
  - Counts, prompt gating, and independence from time.
  - Read-time grouping with an unambiguous and an ambiguous people card; stored wording unchanged.
  - Recall line and relevance.
  - Record setting versus the current switch.
  - Handoff twice, portable restore, and native copy.
- `tests/browser/libra_lens_story_people_browser_test.cjs`: the person rows, the chips and their
  filter, the name highlight, the studio chip and the editor switch at 1280 and 390 px, with no
  touching buttons or horizontal overflow.

Model replies are controlled fixtures. These checks prove the gate and the plumbing, not how well a
live model attributes facts to people.

### 2.3.184 corrections

- Common English object/possessive/reflexive pronouns and Japanese/Korean pronouns are excluded
  alongside subject pronouns. They keep the note as unknown, with the existing dropped-name count.
  Exclusion uses a complete normalized word, so names such as `Hera` remain valid.
- Compatibility matching stores and highlights the original name rather than its NFKC spelling.
  Time-bearing and name-bearing excerpts beyond the old source prefix survive archive readback.
- `tests/libra_lens_story_identity_runtime_test.cjs` covers these cases through public owner APIs;
  `tests/browser/libra_lens_story_source_browser_test.cjs` covers inherited highlights using exact
  Full/Min bytes. These are deterministic checks of the known pronoun rules and literal matching,
  not a general semantic name classifier.

## Name boundaries (2.3.185)

**Definition.** A person is anyone the story treats as an individual: a name or nickname, a
kinship or job title used for one person ("할머니", "카페 사장님"), or a named animal ("콩이",
"나비").

**The gate accepts or rejects names as follows.** The prompt states the same rules.

| Case | Example | Rule |
|---|---|---|
| Grammar glued to a name | "민아가", "지호랑", "지호야" | Stored as "민아" / "지호" when the span also writes the bare name with a different ending. A name only ever written with the ending ("수진이") stays whole. |
| Several people in one string | "지호와 민아", "Emma and Leo", "민아, 지호" | Split into separate people. Each part is checked on its own. |
| Honorifics | "서윤 선생님", "지호씨", "준형 군" | Stored as written. Grouped by the core name. Attached titles (씨, 님, 선생님, さん…) may follow without a space. One-syllable titles that are also name syllables (형, 군, 양) need a space, so "준형" stays a name. |
| Title whose head is a place or relation | "카페 사장님", "옆집 언니" | The whole phrase is the name; it is never reduced to "카페". |
| Pronouns, group and indefinite words | "그녀", "모두", "사람들", "누군가" | Not people. |
| Demonstrative descriptions | "그 아이", "저 남자", "어느 손님" | Not people. |
| Places, organizations, ships | "한빛병원", "한빛병원 응급실", "은하카페", "검은 장미 호" | Not people, unless a person title closes the phrase ("은하카페 사장님"). |
| Registry non-people | a people-registry entity of type place/item/organization | Not a person when the registry has no person with that name. |
| Hypothetical, wish, comparison, hearsay | "수진이었다면 …", "소문으로는 민준이 …" | Not people (prompt rule). The literal gate cannot detect these. |

**Measuring with a live model.** `tools/rag_eval/libra_lens_live_eval.cjs --only names,health`
records, per probe, the names the model returned before the gate and the names stored after it.
The probes are in `libra_lens_live_corpus.json`. The runs on 2026-10-20 could not reach the chat
model (HTTP 401), so these rules rest on the corpus cases and deterministic tests. The live
section is to be repeated when a valid key is available.

**Tests.** `tests/libra_lens_name_boundary_runtime_test.cjs` covers each row through the real
plugin, plus grouping by core name and the prompt text.
