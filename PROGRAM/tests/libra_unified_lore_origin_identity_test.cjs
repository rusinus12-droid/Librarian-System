'use strict';
// DEFECT 2 REGRESSION — the unified lore merge must not delete same-id entries from different origins.
//
// MEASURED DEFECT (before this fix): unifiedLoreIdentity keyed on `id` alone, so a character lore
// and a module lore both carrying id:'shared-id' collapsed to one — 2 active lores became 1 and the
// character body was silently dropped.
//
// The invariant: SAME id + SAME origin merges (no duplicate injection), SAME id + DIFFERENT origin
// stays separate (nothing is lost).
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const expose = source => {
  const coreAnchor = '      getUnifiedStorageStatus,';
  const publicAnchor = "    async getUnifiedStorageStatus() {";
  assert.equal(source.split(coreAnchor).length, 2, 'core anchor must be unique');
  assert.equal(source.split(publicAnchor).length, 2, 'public anchor must be unique');
  return source
    .replace('      candidates,\n      activeLore,\n      actualChatContext,',
      '      candidates,\n      activeLore,\n      reviewActiveLore: activeLore,\n      actualChatContext,')
    .replace(coreAnchor, '      reviewLore: settings => loadRisuContextSnapshot(settings, []),\n' + coreAnchor)
    .replace(publicAnchor,
      '    reviewLore(settings) { return LibraMemoryCore.reviewLore(settings); },\n' + publicAnchor);
};

const summarize = list => (list || []).map(x => ({
  id: x.id, sourceType: x.sourceType ?? x.source ?? '', moduleKey: x.moduleKey ?? '', content: x.content
}));

(async () => {
  const rows = [];
  const f = await fixture({ transformSource: expose });
  try {
    // A character lore and a module lore sharing the SAME id, with different bodies, both always-active.
    f.character.globalLore = [{ id: 'shared-id', key: 'always', alwaysActive: true, content: 'CHARACTER_LORE_BODY', comment: 'ch' }];
    f.r.context.risuai.getDatabase = async fields => {
      const db = {
        personas: [], selectedPersona: '', characters: [f.character], plugins: [],
        modules: [{ id: 'review-module', name: 'review-module', enabled: true, lore: [{ id: 'shared-id', key: 'always', alwaysActive: true, content: 'MODULE_LORE_BODY', comment: 'mo' }] }],
        enabledModules: ['review-module']
      };
      return Array.isArray(fields) ? Object.fromEntries(fields.map(k => [k, db[k] ?? null])) : db;
    };

    const lore = await f.r.api.reviewLore({ selectedModuleLoreIds: ['review-module'], turnWindow: 8 });
    rows.push({
      case: 'different origins, same id',
      candidates: summarize(lore.candidates),
      activeLore: summarize(lore.activeLore),
      activeCount: (lore.activeLore || []).length
    });

    // SAME origin, same id, appearing twice: must merge.
    f.character.globalLore = [
      { id: 'dup-id', key: 'always', alwaysActive: true, content: 'DUP_BODY_ONE', comment: 'c1' },
      { id: 'dup-id', key: 'always', alwaysActive: true, content: 'DUP_BODY_TWO', comment: 'c2' }
    ];
    f.r.context.risuai.getDatabase = async fields => {
      const db = { personas: [], selectedPersona: '', characters: [f.character], plugins: [], modules: [], enabledModules: [] };
      return Array.isArray(fields) ? Object.fromEntries(fields.map(k => [k, db[k] ?? null])) : db;
    };
    const lore2 = await f.r.api.reviewLore({ selectedModuleLoreIds: [], turnWindow: 8 });
    rows.push({
      case: 'same origin, same id',
      activeLore: summarize(lore2.activeLore),
      activeCount: (lore2.activeLore || []).length
    });
  } finally { await f.r.cleanup(); }

  console.log(JSON.stringify({ rows }, null, 1));

  const different = rows[0];
  const same = rows[1];

  // 1. Different origins must BOTH survive — this is the exact line the pre-fix code crossed.
  assert.equal(different.activeCount, 2,
    `a character lore and a module lore sharing an id must both stay active `
    + `(got ${different.activeCount}: ${different.activeLore.map(x => x.content).join(' / ')})`);
  const bodies = different.activeLore.map(x => x.content);
  assert.ok(bodies.some(b => String(b).includes('CHARACTER_LORE_BODY')),
    'the character lore body must survive the merge');
  assert.ok(bodies.some(b => String(b).includes('MODULE_LORE_BODY')),
    'the module lore body must survive the merge');

  // 2. Same origin with the same id still merges, so nothing is injected twice.
  assert.equal(same.activeCount, 1,
    `two entries with the same id AND the same origin must merge to one `
    + `(got ${same.activeCount}: ${same.activeLore.map(x => x.content).join(' / ')})`);

  process.stdout.write('libra_unified_lore_origin_identity_test: PASS\n');
})().catch(e => { process.stderr.write(`${e.stack || e}\n`); process.exitCode = 1; });
