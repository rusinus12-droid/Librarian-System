'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');

const PROGRAM = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(PROGRAM, 'plugins/Flashback_Memory.js'), 'utf8');

function createMiniDom() {
  const registry = new Map();
  function makeNode(tag = 'div') {
    const attrs = new Map();
    let html = '';
    const node = {
      tagName: tag.toUpperCase(),
      id: '',
      open: false,
      hidden: false,
      className: '',
      children: [],
      setAttribute(name, value) {
        attrs.set(String(name), String(value));
        if (name === 'id') {
          this.id = String(value);
          registry.set(this.id, this);
        }
      },
      getAttribute(name) { return attrs.get(String(name)) ?? null; },
      querySelector(selector) {
        if (selector.startsWith('#')) return registry.get(selector.slice(1)) || null;
        if (selector.startsWith('[')) {
          const inner = selector.slice(1, -1);
          const match = html.match(new RegExp(inner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          return match ? { textContent: '' } : null;
        }
        return null;
      },
      querySelectorAll(selector) {
        if (selector === '#maintenancePlanDetails') return [];
        return [];
      },
      set innerHTML(val) {
        html = String(val);
        const ids = html.matchAll(/\bid="([^"]+)"/g);
        for (const m of ids) {
          if (!registry.has(m[1])) {
            const child = makeNode('div');
            child.id = m[1];
            registry.set(m[1], child);
          }
        }
        const dtMatches = [...html.matchAll(/<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/g)];
        this._dts = dtMatches.map(([, k, v]) => ({ textContent: k, nextElementSibling: { textContent: v } }));
      },
      get innerHTML() { return html; }
    };
    return node;
  }
  const maintenancePlan = makeNode('div');
  maintenancePlan.setAttribute('id', 'maintenancePlan');
  const maintenancePlanBadge = makeNode('span');
  maintenancePlanBadge.setAttribute('id', 'maintenancePlanBadge');
  const maintenanceManualCard = makeNode('details');
  maintenanceManualCard.setAttribute('id', 'maintenanceManualCard');
  return { registry, maintenancePlan, maintenancePlanBadge, maintenanceManualCard };
}

test('unified maintenance hub consolidates plan, embedding work, execution, manual, and same-space reuse', async () => {
  const f = await createFlashback(PROGRAM, { waitForLoaded: true });
  try {
    const html = await f.api._test.buildUiHtml();
    assert.ok(!html.includes('data-subtab="mig"'), 'standalone 벡터 재사용 subtab is removed from 임베딩 · 서버');
    assert.ok(!html.includes('data-subpanel="mig"'), 'standalone mig subpanel is removed');
    assert.ok(html.includes('data-subtab="emb"') && html.includes('data-subtab="srv"'), 'connect retains emb and srv subtabs');

    const importStart = html.indexOf('<section id="panel-import"');
    const reanalyzeStart = html.indexOf('<div data-subpanel="reanalyze"');
    assert.ok(importStart > 0 && reanalyzeStart > importStart, 'panel-import exists inside care tab');
    const importHtml = html.slice(importStart, reanalyzeStart);

    for (const id of [
      'maintenanceInspectBtn',
      'maintenanceAutoBtn',
      'maintenancePlanBadge',
      'maintenancePlan',
      'embeddingWorkStatus',
      'embeddingWorkRefreshBtn',
      'embeddingWorkRunBtn',
      'embeddingWorkRetryFailedBtn',
      'maintenanceExecutionCard',
      'maintenanceExecutionBadge',
      'maintenanceManualCard',
      'sameSpaceEligibleCount',
      'sameSpaceUnknownCount',
      'sameSpacePreviewBtn',
      'sameSpaceApplyBtn',
      'sameSpaceStatus',
      'maintenanceMode',
      'maintenanceRunBtn',
      'maintenanceArchiveRunBtn'
    ]) {
      assert.ok(importHtml.includes(`id="${id}"`), `#${id} is consolidated inside #panel-import`);
    }

    assert.match(importHtml, /<details id="maintenanceExecutionCard" class="fold"/);
    assert.doesNotMatch(importHtml, /<details id="maintenanceExecutionCard"[^>]*\bopen\b/);
    assert.match(importHtml, /<details id="maintenanceManualCard" class="fold"/);
    assert.doesNotMatch(importHtml, /<details id="maintenanceManualCard"[^>]*\bopen\b/);

    const allIds = Array.from(html.matchAll(/\sid="([^"]+)"/g), m => m[1]);
    const dupes = allIds.filter((id, idx) => allIds.indexOf(id) !== idx);
    assert.deepEqual(dupes, [], 'no duplicate element IDs across full UI HTML');
  } finally {
    await f.cleanup();
  }
});

test('renderMaintenancePlanInUi and showMaintenanceInspectionModal automatically propose free same-space vector reuse', async () => {
  const dom = createMiniDom();
  let dialog;
  const context = vm.createContext({
    Runtime: {},
    formatNumber: value => String(Number(value) || 0),
    formatCostSummary: () => '단가 미설정',
    text: value => String(value || ''),
    NARRATIVE_CHUNK_SCHEMA_VERSION: 1,
    FLASHBACK_SHARD_INDEX_VERSION: 1,
    escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    getGuiNode: id => dom.registry.get(id) || null,
    setNodeText: (id, value) => {
      const node = dom.registry.get(id);
      if (node) node.textContent = String(value);
    },
    applyVerifiedEmbeddingMigration: async () => ({ ok: true, migrated: 2 }),
    refreshUi: async () => {},
    guiAlert: async () => {},
    guiDialog: async (_message, options) => { dialog = options; }
  });
  const slice = (start, end) => {
    const a = SOURCE.indexOf(start);
    const b = SOURCE.indexOf(end, a);
    assert.ok(a >= 0 && b > a, `anchors missing: ${start} .. ${end}`);
    return SOURCE.slice(a, b);
  };
  vm.runInContext(
    slice('  const maintenanceStrategyText =', '  // Zero-vector fault isolation:') +
    slice('  const maintenanceServerStorageVerified =', '  const maintenanceCompletionTitle =') +
    slice('  const maintenancePlanPresentation =', '  // Client-side text filter') +
    slice('  const showMaintenanceInspectionModal =', '  const showMaintenanceCompletionModal =') +
    ';globalThis.ui={presentation:maintenancePlanPresentation,render:renderMaintenancePlanInUi,diagnose:showMaintenanceInspectionModal};',
    context
  );

  const plan = {
    inspection: { complete: true, coverage: 'plugin_only' },
    healthy: true,
    automatic: { strategy: 'no_action', blocked: false },
    embeddingWorkIncompleteRecords: 0,
    missingTurns: 0,
    changedTurns: 0,
    sameSpacePreview: { rows: [{ id: 'a' }, { id: 'b' }], unknown: [] }
  };

  const verdict = context.ui.presentation(plan);
  assert.equal(verdict.label, '무료 벡터 재사용 가능');
  assert.match(verdict.headline, /2개/);

  context.ui.render(plan);
  assert.match(dom.maintenancePlan.innerHTML, /id="maintenanceSameSpaceProposal"/);
  assert.match(dom.maintenancePlan.innerHTML, /data-same-space-quick-apply="1"/);
  assert.match(dom.maintenancePlan.innerHTML, /기존 벡터 2개 무료 이어 쓰기/);
  assert.equal(dom.maintenancePlanBadge.textContent, '무료 벡터 재사용 가능');
  assert.equal(dom.maintenanceManualCard.open, true, 'manual/reuse fold opens when reusable vectors exist');

  await context.ui.diagnose(plan);
  assert.ok(dialog.actionBtn, 'inspection modal offers direct action button for free vector reuse');
  assert.equal(dialog.actionBtn.text, '기존 벡터 2개 무료 이어 쓰기');
  assert.match(dialog.bodyHtml, /무료 벡터 재사용 가능 · API 호출 0/);
});
