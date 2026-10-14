'use strict';
// N01 GUI display adapter — verification at the level that can actually be demonstrated:
//
//  1. The display-only DTO is functional: absent before a recall, complete/partial after one, it names
//     the window, the read path, the adoption and the unread regions, and it carries NO dispatch field.
//  2. The GUI card is wired to that DTO and exposes stable hooks, so the diagnostics screen cannot show
//     a number the DTO did not produce.
//
// NOT verified here (recorded as a gap in the plan, not claimed): the mounted-DOM rendering of that
// card. The jsdom harness used by the other GUI suites does not reach this diagnostics section at all —
// the pre-existing '마지막 실행 상태' card next to it is equally absent there — so a rendered-DOM proof
// needs a harness that opens this section, which this suite deliberately does not fake.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, QUOTE } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');

const pluginPath = path.join(__dirname, '..', 'plugins', 'LIBRA.js');
const results = [];
const test = async (name, run) => { await run(); results.push(name); };

(async () => {
  const x = await fixture({ mode: 'plugin_only' });
  try {
    const api = x.f.r.api;
    await test('N01: the display view is absent before a recall and complete after one', async () => {
      const before = api.getMemoryRecallDiagnosticsView();
      assert.equal(before.schema, 'libra.recall_diagnostics_view.v1');
      assert.equal(before.authority, 'display_only');
      assert.equal(before.present, false);
      assert.equal(before.state, 'absent');
      await api.previewUnifiedMemoryRecall({ queryText: QUOTE, unifiedEngineMode: 'unified' });
      const view = api.getMemoryRecallDiagnosticsView();
      assert.equal(view.present, true);
      assert.equal(view.state, 'complete');
      assert.equal(view.engine.mode, 'unified');
      assert.equal(view.engine.qualification, 'unqualified_until_E3_E4');
      assert.ok(view.read.pages > 0 && view.read.bytes > 0 && view.read.budget > 0);
      assert.ok(view.read.roles.some(role => role.role === 'query_anchor_access' && role.pages > 0));
      assert.ok(view.read.frontierSteps >= 0);
      assert.ok(view.adoption.admitted > 0);
      assert.equal(JSON.stringify(view.adoption.families), JSON.stringify([...view.adoption.families].sort()), 'families are reported sorted');
      assert.ok(view.adoption.packetChars <= view.adoption.maxCharacters, 'the packet budget must be respected in the view');
    });

    await test('N01: a window-bounded recall reads as partial and names what it did not read', async () => {
      await api.previewUnifiedMemoryRecall({ queryText: QUOTE, unifiedEngineMode: 'unified', unifiedWindow: { limit: 1 } });
      const view = api.getMemoryRecallDiagnosticsView();
      assert.equal(view.state, 'partial');
      assert.ok(view.unread.length > 0, 'unread regions must be listed');
      for (const region of view.unread) assert.ok(region.cursorKey.length > 0 && region.kind.length > 0);
      assert.ok(view.read.stopReason.length > 0, 'the stop reason must be visible');
      assert.equal(view.window.limit, 1);
      assert.equal(view.window.projectionComplete, false);
    });

    await test('N01 negative control: the display view never carries dispatch authority', () => {
      const view = api.getMemoryRecallDiagnosticsView();
      for (const forbidden of ['modelDispatchEligible', 'dispatchVerification', 'authorized', 'authorityGranted']) {
        assert.equal(Object.prototype.hasOwnProperty.call(view, forbidden), false, 'the view must not carry ' + forbidden);
      }
      assert.equal(view.authority, 'display_only');
      const serialized = JSON.stringify(view);
      assert.equal(/dispatchEligible"\s*:\s*true/.test(serialized), false, 'no serialized dispatch grant may appear');
    });

    await test('N02: the display view states which families have a vector producer and what was admitted', () => {
      const view = api.getMemoryRecallDiagnosticsView();
      const declared = view.representation.declared;
      assert.deepEqual([...declared.map(unit => unit.family)], ['canonical', 'micro', 'state', 'lore']);
      assert.equal(declared.find(unit => unit.family === 'canonical').vectorToday, true);
      assert.equal(declared.find(unit => unit.family === 'canonical').producer, 'owner_projection');
      for (const family of ['micro', 'state', 'lore']) {
        assert.equal(declared.find(unit => unit.family === family).vectorToday, false, family + ' must be declared vectorless');
      }
      assert.ok(view.representation.actual, 'the actual semantic state must be reported, not implied');
      assert.ok(String(view.representation.actual.status).length > 0);
      assert.equal(view.representation.actual.backgroundEmbeddingStarted, false, 'no background embedding may be started');
      assert.deepEqual([...view.representation.actual.vectorlessFamilies].sort(), ['lore', 'micro', 'state']);
      assert.ok(Array.isArray(view.representation.actual.rejected));
      const serialized = JSON.stringify(view.representation);
      assert.equal(/"(vector|entries|embedding)"\s*:/.test(serialized), false, 'the display view must not carry vector payloads');
    });

    await test('N01: the GUI card is built from that view and exposes stable hooks', () => {
      const source = fs.readFileSync(pluginPath, 'utf8');
      assert.ok(source.includes("dataset: { recallDiagnostics: 'true', recallDiagnosticsState: String(view.state) }"),
        'the card must expose data-recall-diagnostics / data-recall-diagnostics-state');
      assert.ok(source.includes('const view = LibraMemoryCore.getMemoryRecallDiagnosticsView();'),
        'the card must render the view rather than recomputing numbers');
      for (const line of ['읽은 경로: page ', '역할: ', '채택: ', '미독', '엔진: ']) {
        assert.ok(source.includes(line), 'the card must show: ' + line);
      }
      assert.ok(source.includes("guiEl('h3', { text: '읽은 경로 · 시점 · 미독' })"), 'the card must be titled');
      assert.ok(source.includes("recallRepresentation: 'true'"), 'the card must expose the representation line (N02)');
      // The card reads budgets alongside the numbers, so a partial window cannot look complete.
      assert.ok(source.includes('${view.read.bytes}/${view.read.budget} bytes'), 'the read line must show bytes against the budget');
    });
  } finally { await x.cleanup(); }

  console.log(JSON.stringify({ suite: 'libra_recall_diagnostics_view', passed: results.length, tests: results }));
})().catch(error => { console.error('RECALL DIAGNOSTICS VIEW FAILED', error.code || '', error.message); process.exit(1); });
