'use strict';
// Recall diagnostics display adapter for the State-first engine.
//
//  1. The display-only DTO is absent before a recall. After one it states what was read against
//     what exists, how the question was classified, how the budget was shared, and what was not
//     read. It carries no dispatch field.
//  2. The GUI card renders that DTO and exposes stable hooks, so the diagnostics screen cannot
//     show a number the DTO did not produce.
//
// Not verified here: the mounted-DOM rendering of the card. The jsdom harness used by the other
// GUI suites does not open this diagnostics section.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, QUOTE } = require('./fixtures/libra_direct_memory_reader_fixture.cjs');

const pluginPath = path.join(__dirname, '..', 'plugins', 'LIBRA.js');
const results = [];
const test = async (name, run) => { await run(); results.push(name); };

(async () => {
  const x = await fixture({ mode: 'plugin_only', pauseAutomaticAnalysis: true, microCount: 12,
    microText: turn => `민아는 은빛 열쇠 기록${turn}을 준호에게 남겼다.` });
  try {
    const api = x.f.r.api;
    await test('the display view is absent before a recall and describes the search after one', async () => {
      const before = api.getMemoryRecallDiagnosticsView();
      assert.equal(before.schema, 'libra.recall_diagnostics_view.v2');
      assert.equal(before.authority, 'display_only');
      assert.equal(before.present, false);
      assert.equal(before.state, 'absent');
      await api.previewUnifiedMemoryRecall({ queryText: QUOTE });
      const view = api.getMemoryRecallDiagnosticsView();
      assert.equal(view.present, true);
      assert.equal(view.engine.mode, 'state_first');
      assert.equal(view.corpus.mode, 'direct_existing_records');
      assert.ok(['current', 'history', 'detail', 'mixed'].includes(view.plan.intent));
      assert.equal(view.plan.lensSharePercent, 40);
      assert.ok(view.read.canonical <= view.read.canonicalTotal && view.read.micro <= view.read.microTotal);
      assert.equal(view.read.microIndexKnown, view.read.microTotal, 'every turn’s stored search summary was screened');
      assert.equal(view.axes.map(row => row.axis).join(','), 'characters,relationships,world,narrative');
      assert.ok(view.adoption.admitted > 0);
      assert.equal(JSON.stringify(view.adoption.families), JSON.stringify([...view.adoption.families].sort()), 'families are reported sorted');
      assert.ok(view.adoption.packetChars <= view.adoption.maxCharacters, 'the packet budget must be respected in the view');
      assert.ok(view.pointInTime.headFreshness.length > 0);
    });

    await test('a candidate-bounded recall reads as partial and names what it did not read', async () => {
      await api.previewUnifiedMemoryRecall({ queryText: '은빛 열쇠 기록' });
      const view = api.getMemoryRecallDiagnosticsView();
      assert.ok(view.read.microMatches > view.read.microMatchesRead, 'more turns matched than the candidate limit allows');
      assert.equal(view.state, 'partial');
      assert.ok(view.unread.some(row => row.kind === 'micro_candidates' && /^\d+\/\d+$/.test(row.reason)), 'the unread Micro share must be listed');
      assert.equal(view.read.stopReason, 'candidate_budget');
    });

    await test('negative control: the display view never carries dispatch authority', () => {
      const view = api.getMemoryRecallDiagnosticsView();
      for (const forbidden of ['modelDispatchEligible', 'dispatchVerification', 'authorized', 'authorityGranted']) {
        assert.equal(Object.prototype.hasOwnProperty.call(view, forbidden), false, 'the view must not carry ' + forbidden);
      }
      assert.equal(view.authority, 'display_only');
      const serialized = JSON.stringify(view);
      assert.equal(/dispatchEligible"\s*:\s*true/.test(serialized), false, 'no serialized dispatch grant may appear');
      assert.equal(/"(text|renderedText|vector|embedding)"\s*:/.test(serialized), false, 'the display view carries counts, not memory text or vectors');
    });

    await test('the GUI card is built from that view and exposes stable hooks', () => {
      const source = fs.readFileSync(pluginPath, 'utf8');
      assert.ok(source.includes("dataset: { recallDiagnostics: 'true', recallDiagnosticsState: String(view.state) }"),
        'the card must expose data-recall-diagnostics / data-recall-diagnostics-state');
      assert.ok(source.includes('const view = LibraMemoryCore.getMemoryRecallDiagnosticsView();'),
        'the card must render the view rather than recomputing numbers');
      for (const line of ['읽은 후보: 정본 ', '질문 분류: ', '축별 선택: ', '배분: ', '채택: ', '미독', '엔진: ']) {
        assert.ok(source.includes(line), 'the card must show: ' + line);
      }
      assert.ok(source.includes("guiEl('h3', { text: '읽은 경로 · 시점 · 미독' })"), 'the card must be titled');
      // Read counts are shown against their totals, so a bounded search cannot look complete.
      assert.ok(source.includes('Micro ${view.read.micro}/${view.read.microTotal}'), 'the read line must show candidates against totals');
      for (const retired of ['durable_common_index', 'request_local_corpus', 'frontier ${', 'view.window']) {
        assert.equal(source.includes(retired), false, 'the card no longer shows the retired graph reader field: ' + retired);
      }
    });
  } finally { await x.cleanup(); }

  console.log(JSON.stringify({ suite: 'libra_recall_diagnostics_view', passed: results.length, tests: results }));
})().catch(error => { console.error('RECALL DIAGNOSTICS VIEW FAILED', error.code || '', error.message); process.exit(1); });
