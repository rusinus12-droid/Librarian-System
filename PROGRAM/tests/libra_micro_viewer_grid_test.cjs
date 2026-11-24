'use strict';
// Micro Memory Viewer grid redesign & Book turn evidence grid test:
// - Default flat multi-column claim card grid + compact 2-column turn rail tiles with claim counts
// - Switching between flat grid, kind grouping, and actor/target grouping + kind filter pills
// - Compact State admission panel, collapsible quote toggle, header turn steppers, rail mode toggle
// - Canonical chapter turn evidence wrapped in .micro-evidence-grid
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

async function setupGridDom() {
  const dom = new JSDOM('<!doctype html><html><body><main id="host"></main></body></html>', { pretendToBeVisual: true });
  const h = await createLibraVmHarness({}, {
    getCurrentCharacterIndex: async () => 0,
    getCurrentChatIndex: async () => 0,
    getCharacter: async () => ({ id: 'c1', chaId: 'c1', name: '민아', chatPage: 0, chats: [{ id: 'chat1', name: 'Chat 1', message: [] }] }),
    getChat: async () => ({ id: 'chat1', name: 'Chat 1', message: [] }),
    getDatabase: async () => ({ personas: [], selectedPersona: '', characters: [], plugins: [] })
  }, {
    transformSource: src => src.replace(
      '  const publicApi = Object.freeze({',
      '  globalThis.__microGridTest = { Gui, microReaderState, buildBookMicroReaderProjection, buildBookTurnEvidenceSection, loadMicroReaderDetail };\n  const publicApi = Object.freeze({'
    ),
    contextGlobals: {
      document: dom.window.document,
      window: dom.window,
      MutationObserver: dom.window.MutationObserver,
      requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
      cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window)
    }
  });

  const ui = h.context.__microGridTest;
  const hostEl = dom.window.document.getElementById('host');
  let detailRequests = [];

  h.context.__LIBRA__ = {
    ...h.api,
    readActiveMicroMemoryForTurn: async turn => {
      detailRequests.push(Number(turn));
      return {
        status: 'verified',
        record: {
          scopeKey: ui.microReaderState().scopeKey,
          worldlineId: 'main',
          turn: Number(turn),
          analysisStatus: 'verified',
          analysisRevisionId: `rev-${turn}`,
          claims: [
            {
              changeKind: 'event',
              text: '민아가 서재 안쪽 금고 문을 조심스럽게 열었다.',
              actor: '민아',
              target: '서재',
              temporalRole: 'current',
              certainty: 'confirmed',
              evidence: { role: 'assistant', messageId: `t${turn}-a`, exactQuote: '민아가 서재 안쪽 금고 문을 조심스럽게 열었다. ' + '세부 묘사가 이어지는 아주 긴 인용문 테스트입니다.' }
            },
            {
              changeKind: 'person',
              text: '민아는 오른쪽 손목의 통증을 느꼈다.',
              actor: '민아',
              target: '',
              temporalRole: 'current',
              certainty: 'confirmed',
              stateIntent: { domain: 'character', field: 'condition', target: { entityName: '민아' }, operation: 'set', value: '손목 통증' },
              evidence: { role: 'assistant', messageId: `t${turn}-a`, exactQuote: '오른쪽 손목의 통증을 느꼈다' }
            },
            {
              changeKind: 'relation',
              text: '민아는 지호에게 금고 열쇠를 맡겼다.',
              actor: '민아',
              target: '지호',
              temporalRole: 'current',
              certainty: 'uncertain',
              epistemicStatus: 'reported',
              stateIntent: { domain: 'relationship', field: 'value', target: { subjectName: '민아', targetName: '지호' }, operation: 'set', value: '열쇠 위탁' },
              evidence: { role: 'user', messageId: `t${turn}-u`, exactQuote: '지호에게 열쇠를 맡겨 두었다' }
            },
            {
              changeKind: 'world',
              text: '서재의 촛불이 꺼지고 정적만 남았다.',
              actor: '',
              target: '서재',
              temporalRole: 'historical',
              certainty: 'confirmed',
              stateIntent: { domain: 'world', field: 'condition', target: { entityName: '서재' }, operation: 'set', value: '소등됨' },
              evidence: { role: 'assistant', messageId: `t${turn}-a`, exactQuote: '서재의 촛불이 꺼지고' }
            }
          ]
        }
      };
    },
    readMicroStateAdmissionForTurn: async (_turn, _scope, revision) => ({
      status: 'verified',
      analysisRevisionId: revision,
      decisions: [
        { claimIndex: 1, status: 'admitted', disposition: 'state' },
        { claimIndex: 2, status: 'pending', reason: 'state_value_not_source_bound' }
      ]
    })
  };

  ui.Gui.visible = true;
  ui.Gui.bookPage = 'memory';
  ui.Gui.bookMemoryKind = 'micro';

  const reader = ui.microReaderState();
  Object.assign(reader, {
    loaded: true,
    loading: false,
    hostWorldlineId: 'main',
    totalTurns: 5,
    selectedTurn: 5,
    items: [
      { turn: 5, status: 'verified', analysisStatus: 'verified', claimCount: 4, summary: '금고 문을 열고 열쇠를 맡김' },
      { turn: 4, status: 'verified', analysisStatus: 'verified', claimCount: 2, summary: '서재에 도착해 열쇠를 확인함' }
    ],
    detail: {
      status: 'verified',
      record: (await h.context.__LIBRA__.readActiveMicroMemoryForTurn(5)).record,
      admission: await h.context.__LIBRA__.readMicroStateAdmissionForTurn(5, reader.scopeKey, 'rev-5')
    }
  });
  detailRequests = [];

  const render = () => {
    const projected = ui.buildBookMicroReaderProjection();
    hostEl.replaceChildren(projected);
    return hostEl;
  };

  return { h, dom, ui, reader, render, getDetailRequests: () => detailRequests };
}

test('Micro Memory Viewer defaults to grid card layout & 2-column turn rail tiles with grouping, filtering, quote toggle, and turn steppers', async t => {
  const ctx = await setupGridDom();
  t.after(async () => {
    ctx.ui.Gui.visible = false;
    await ctx.h.cleanup?.();
    ctx.dom.window.close();
  });

  // 1. Default view renders grid layout + compact 2-column turn rail + claim count chips + compact state bar
  let root = ctx.render();
  assert.equal(ctx.reader.viewMode, 'grid');
  assert.equal(ctx.reader.railMode, 'grid');
  const railList = root.querySelector('[data-micro-turn-layout="grid"]');
  assert.ok(railList && railList.classList.contains('is-grid'), 'turn rail defaults to 2-column tile grid');
  assert.equal(railList.querySelectorAll('.micro-turn__count').length, 2);
  assert.match(railList.querySelector('[data-micro-reader-turn="5"]').textContent, /4건/);

  assert.ok(root.querySelector('[data-micro-state-admission="pending"] .micro-state-bar__top'), 'compact horizontal state bar top rendered');
  const flatGrid = root.querySelector('[data-micro-claim-grid="flat"]');
  assert.ok(flatGrid, 'flat multi-column claim card grid rendered by default');
  assert.equal(flatGrid.querySelectorAll('[data-micro-reader-claim]').length, 4);
  assert.equal(flatGrid.querySelector('[data-micro-reader-claim="2"]').dataset.microClaimKind, 'relation');
  assert.ok(flatGrid.querySelector('[data-micro-reader-claim="2"]').classList.contains('is-uncertain'));

  // 2. Clicking a quote toggles .is-expanded
  const firstQuote = root.querySelector('[data-micro-reader-claim="0"] [data-micro-quote-toggle="true"]');
  assert.ok(firstQuote && !firstQuote.classList.contains('is-expanded'));
  firstQuote.click();
  assert.equal(ctx.reader.expandedQuotes['5:0'], true);
  root = ctx.render();
  assert.ok(root.querySelector('[data-micro-reader-claim="0"] [data-micro-quote-toggle="true"]').classList.contains('is-expanded'));
  root.querySelector('[data-micro-reader-claim="0"] [data-micro-quote-toggle="true"]').click();
  assert.equal(ctx.reader.expandedQuotes['5:0'], false);

  // 3. Switch to kind grouping ('분류별 묶음')
  root.querySelector('[data-micro-toolbar] [data-micro-seg-option="kind"]').click();
  assert.equal(ctx.reader.viewMode, 'kind');
  root = ctx.render();
  assert.ok(root.querySelector('[data-micro-grouped-by="kind"]'));
  assert.equal(root.querySelectorAll('[data-micro-group-kind]').length, 4);
  assert.equal(root.querySelectorAll('[data-micro-group-kind] .micro-claim-grid').length, 4);

  // 4. Switch to actor grouping ('주체·대상별') and apply kind filter pill
  root.querySelector('[data-micro-toolbar] [data-micro-seg-option="actor"]').click();
  assert.equal(ctx.reader.viewMode, 'actor');
  root = ctx.render();
  const actorRoot = root.querySelector('[data-micro-grouped-by="actor"]');
  assert.ok(actorRoot);
  const minaGroup = actorRoot.querySelector('[data-micro-group-actor="민아"]');
  assert.ok(minaGroup && minaGroup.querySelectorAll('[data-micro-reader-claim]').length === 3);
  const serjaeGroup = actorRoot.querySelector('[data-micro-group-actor="서재"]');
  assert.ok(serjaeGroup && serjaeGroup.querySelectorAll('[data-micro-reader-claim]').length === 1);

  root.querySelector('[data-micro-kind-filter="relation"]').click();
  assert.equal(ctx.reader.kindFilter, 'relation');
  root = ctx.render();
  assert.equal(root.querySelectorAll('[data-micro-reader-claim]').length, 1);
  root.querySelector('[data-micro-kind-filter="all"]').click();
  assert.equal(ctx.reader.kindFilter, 'all');

  // 5. Switch rail layout to list mode & step to previous turn via header button
  root.querySelector('.micro-rail__subhead [data-micro-seg-option="list"]').click();
  assert.equal(ctx.reader.railMode, 'list');
  root = ctx.render();
  const listRail = root.querySelector('[data-micro-turn-layout="list"]');
  assert.ok(listRail && !listRail.classList.contains('is-grid'));

  const prevBtn = root.querySelector('[data-micro-prev-turn="4"]');
  const nextBtn = root.querySelector('[data-micro-next-turn="0"]');
  assert.ok(prevBtn && !prevBtn.disabled);
  assert.ok(nextBtn && nextBtn.disabled, 'latest turn disables next turn button');
  prevBtn.click();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(ctx.getDetailRequests().includes(4), 'header prev button loads T4 detail');

  // 6. Book chapter turn evidence section wraps details cards in .micro-evidence-grid
  const section = ctx.ui.buildBookTurnEvidenceSection({ memoryId: 'mem-1', turnRange: { start: 1, end: 2 } }, {
    status: 'ready',
    turns: [
      { turn: 1, analysisStatus: 'verified', text: '1턴 근거', sourceSpans: [{ messageId: 't1-a', exactQuote: '원문1' }] },
      { turn: 2, analysisStatus: 'minimum_source_bound', text: '2턴 원문', sourceSpans: [{ messageId: 't2-a', exactQuote: '원문2' }] }
    ]
  });
  const gridNode = section.querySelector('[data-micro-evidence-grid="true"]');
  assert.ok(gridNode && gridNode.classList.contains('micro-evidence-grid'));
  assert.equal(gridNode.querySelectorAll('details[data-micro-turn]').length, 2);
});
