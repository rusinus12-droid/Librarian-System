'use strict';
// Fixture for the Stage 2 lore reference link suite.
//
// `libra_unified_runtime_fixture` seeds canonical memory but no lore, so every lore-link assertion would
// run against an empty corpus and pass vacuously (measured: allowedLoreCount 0, and all nine assertions
// passing on empty arrays). This fixture adds an allowed lorebook through the host surface the plugin's
// own collector actually reads.
//
// MEASURED, not guessed: seven candidate surfaces were tried in `_lore_source_probe.cjs` and only
// `character.lorebook` reached `collectRisuLorebookCandidates` — `chat.localLore`, `chat.globalLore`,
// `chat.lorebook`, `character.loreSettings.lorebook` and `chat.data.characterBook.entries` all left the
// allowed corpus empty. Seeding through the wrong surface would have kept the suite vacuous.
//
// The lore text deliberately reuses entity names the fixture's canonical artifact already registered
// (서재/도서관/기록회/은빛 열쇠/민아), so a reference match has something real to find.
const { fixture: baseFixture } = require('./libra_unified_runtime_fixture.cjs');
// Re-exported so a suite can commit a SECOND batch: a link expansion needs at least two memories that
// share an entity before it can reach anything, and a single-batch fixture cannot express that.
const { advance, addFact, shiftRefs, artifact } = require('./libra_evidence_link_index_fixture.cjs');

// The entity names the base fixture registers. A lore entry that names them is what a reference match
// must find; one that names none of them must produce no link at all.
const NAMED_ENTRY = {
  id: 'lore-named', key: 'lore-named', label: '서재 운영 규정',
  content: '서재는 도서관 안에 있고 기록회가 관리한다. 서재의 은빛 열쇠는 민아가 맡는다.',
  sourceType: 'character', source: 'character', keys: ['서재'], priority: 100,
  enabled: true, constant: true
};
// Names an entity that is NOT in the registry. This must never become a link.
const UNKNOWN_ENTRY = {
  id: 'lore-unknown', key: 'lore-unknown', label: '무관한 기록',
  content: '이 기록에는 등록되지 않은 이름만 있다. 존재하지 않는 인물과 장소를 말한다.',
  sourceType: 'character', source: 'character', keys: ['기록'], priority: 100,
  enabled: true, constant: true
};
// Two registry entities cannot both own this string, so a mention must be HELD, not resolved.
// (Built by the caller through `ambiguousEntry` when it seeds two same-named entities.)

const fixture = async (options = {}) => {
  const f = await baseFixture(options);
  // The surface that actually feeds the collector (see the measurement note above).
  f.character.lorebook = [NAMED_ENTRY, UNKNOWN_ENTRY];
  const baseRun = f.run;
  return {
    ...f,
    namedEntry: NAMED_ENTRY,
    unknownEntry: UNKNOWN_ENTRY,
    // Seed an extra lore entry that names a same-named pair; the caller supplies the content.
    withLoreEntry(entry) { f.character.lorebook = [...f.character.lorebook, entry]; return entry; },
    run: baseRun
  };
};

module.exports = { fixture, NAMED_ENTRY, UNKNOWN_ENTRY, advance, addFact, shiftRefs, artifact };
