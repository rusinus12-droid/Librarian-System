'use strict';
// Seed allowed host lore for source-proof and direct-reader tests.
// character.lorebook is the collector surface; chat-local ad hoc fields are not.
const { fixture: baseFixture } = require('./libra_unified_runtime_fixture.cjs');
// Canonical batch utilities shared by source-proof tests.
const { advance, addFact, shiftRefs, artifact } = require('./libra_canonical_batch_fixture.cjs');

// Lore names overlap canonical entities to exercise source admission boundaries.
const NAMED_ENTRY = {
  id: 'lore-named', key: 'lore-named', label: '서재 운영 규정',
  content: '서재는 도서관 안에 있고 기록회가 관리한다. 서재의 은빛 열쇠는 민아가 맡는다.',
  sourceType: 'character', source: 'character', keys: ['서재'], priority: 100,
  enabled: true, constant: true
};
// This entry names no registered entity.
const UNKNOWN_ENTRY = {
  id: 'lore-unknown', key: 'lore-unknown', label: '무관한 기록',
  content: '이 기록에는 등록되지 않은 이름만 있다. 존재하지 않는 인물과 장소를 말한다.',
  sourceType: 'character', source: 'character', keys: ['기록'], priority: 100,
  enabled: true, constant: true
};
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
