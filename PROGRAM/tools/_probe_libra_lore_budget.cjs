'use strict';
// Does response_lore_max_chars actually change what the SGA prompt carries?
//
// The earlier probe reported the budget as ineffective — but it measured the wrong thing: the fixture
// supplies no lorebook, so the lore material was empty and every budget produced the same (empty)
// result. That says nothing about the parameter. This probe builds real lore records through the
// plugin's own indexer, ranks them with its own ranker, then renders the stage view the SGA prompt uses
// at three budgets and compares the actual rendered material.
//
// Where the budget is applied (measured): responseLoreBuildStageView at 20418. It scales per stage —
// AIDE stages and memory ITO stages get 0.62x, input_writer gets 0.72x, everything else the full
// budget — so a change must show up as a different rendered length, not merely a different setting.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const OUT = process.env.LIBRA_LORE_BUDGET_OUT || '/tmp/libra_lore_budget.json';

const instrument = source => {
  const coreAnchor = '      debugApplyDraftPatchOperations: (draftValue, edits = []) =>';
  const publicAnchor = "    debugSgaPatchOperations(draft = '', edits = [])";
  for (const [name, value] of [['core', coreAnchor], ['public', publicAnchor]]) {
    if (source.split(value).length !== 2) throw new Error(`the ${name} anchor must be unique`);
  }
  return source
    .replace(coreAnchor,
      '      loreInternals: { responseLoreIndexRecord, responseLoreRankRecords, responseLoreAdaptiveSelect, responseLoreBuildStageView, responseLoreStageDef },\n' +
      coreAnchor)
    .replace(publicAnchor,
      '    loreInternals(){ return LibraMemoryCore.loreInternals; },\n' +
      publicAnchor);
};

// Distinct entries, each long enough that the budget has something to cut.
const ENTRY_COUNT = 120;
const entry = index => ({
  id: `lore-${index}`,
  name: `정본 항목 ${index}`,
  keys: [`열쇠${index}`, `서재${index}`],
  content: `정본 항목 ${index}의 내용입니다. ${`세부 설명 ${index}번 항목이 이어집니다. `.repeat(6)}`,
  namespace: 'character',
  priority: 10,
  activationMode: 'unified'
});

const CURRENT = '이제 열쇠는 돌려줬어. 다음 절차를 위해 잠깐 다시 맡아줄 수 있어?';
const TERMINAL = '지호가 열쇠를 민아에게 반환했다. 서재에는 봉인이 남아 있다.';
const SUPPORT = '열쇠 서재 봉인 절차 민아 지호';

(async () => {
  const out = { capturedAt: new Date().toISOString(), entryCount: ENTRY_COUNT };
  const f = await fixture({ transformSource: instrument });
  try {
    await f.run();
    const api = f.r.api;
    const I = api.loreInternals();
    for (const name of ['responseLoreIndexRecord', 'responseLoreRankRecords', 'responseLoreBuildStageView', 'responseLoreAdaptiveSelect']) {
      assert.equal(typeof I[name], 'function', `${name} must be reachable`);
    }

    const records = Array.from({ length: ENTRY_COUNT }, (_, index) => I.responseLoreIndexRecord(entry(index))).filter(Boolean);
    out.recordsIndexed = records.length;
    assert.ok(records.length > 0, 'the indexer must produce records from real entries');

    const settings = await api.getLibraMemorySettings();
    const snapshot = { characterId: 'unified-char', chatId: 'unified-chat', scopeKey: 'lore-budget' };
    const commonIds = new Set();

    const renderAt = (maxChars, stageId) => {
      const withBudget = { ...settings, responseLoreMaxChars: maxChars, response_lore_max_chars: maxChars, responseLoreEnabled: true };
      const ranked = I.responseLoreRankRecords({
        records, currentQuery: CURRENT, terminalQuery: TERMINAL, supportQuery: SUPPORT,
        coverageQuery: CURRENT, stageId: 'shared', activeLore: [], hostSelectedLore: []
      });
      const adaptive = I.responseLoreAdaptiveSelect(ranked, withBudget, stageId);
      const query = [CURRENT, TERMINAL, SUPPORT].join('\n\n');
      const view = I.responseLoreBuildStageView({ ranked, adaptive, stageId, snapshot, settings: withBudget, commonIds, query });
      // The rendered block is what a prompt would carry; find it across the view's own shape.
      const rendered = JSON.stringify(view);
      return {
        rankedRows: Array.isArray(ranked?.rows) ? ranked.rows.length : null,
        adaptiveCount: Array.isArray(adaptive) ? adaptive.length : (adaptive?.selected ? adaptive.selected.length : null),
        viewChars: rendered.length,
        // The view's own accounting: these are the fields the budget is supposed to move.
        selectedCount: view?.selectedCount ?? null,
        usedChars: view?.usedChars ?? null,
        maxChars: view?.maxChars ?? null,
        promptChars: view?.promptChars ?? null,
        promptBlockChars: String(view?.promptBlock || '').length,
        available: view?.available === true,
        droppedCount: Array.isArray(view?.dropped) ? view.dropped.length : (view?.dropped ?? null),
        keys: Object.keys(view || {}).slice(0, 16)
      };
    };

    // Three budgets, on a stage that takes the full budget and on one that scales it.
    out.perBudget = {};
    for (const stageId of ['sga_shadow', 'sga_character_aide', 'input_writer']) {
      out.perBudget[stageId] = {};
      for (const maxChars of [12000, 4000, 1200]) {
        out.perBudget[stageId][maxChars] = renderAt(maxChars, stageId);
      }
    }

    // The decisive comparison: does the rendered material change with the budget?
    const distinct = stage => new Set([12000, 4000, 1200].map(b => JSON.stringify(out.perBudget[stage][b]))).size;
    out.budgetChangesRendering = {
      sga_shadow: distinct('sga_shadow'),
      sga_character_aide: distinct('sga_character_aide'),
      input_writer: distinct('input_writer')
    };
    out.budgetEffective = Object.values(out.budgetChangesRendering).some(n => n > 1);

    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ ok: true, out: OUT, ...out }, null, 1));

    assert.ok(out.recordsIndexed > 0, 'real lore records must exist for this measurement to mean anything');
    assert.ok(out.budgetEffective, `the budget must change the rendered material (${JSON.stringify(out.budgetChangesRendering)})`);
  } finally {
    await f.r.cleanup();
  }
  console.log('libra_lore_budget_test: PASS');
})().catch(error => {
  console.error(error?.stack || error);
  console.log('libra_lore_budget_test: FAIL');
  process.exitCode = 1;
});
