'use strict';
// Exact production presentation functions, synthetic plans and DOM. Engine/host
// execution is covered separately by the live-job GUI contracts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.resolve(__dirname, '../plugins/Flashback_Memory.js'), 'utf8');
function setup() {
  const dom = new JSDOM('<div id="maintenancePlan"></div><span id="maintenancePlanBadge"></span>');
  let dialog;
  const context = vm.createContext({
    Runtime: {}, formatNumber: value => String(Number(value) || 0), formatCostSummary: () => '단가 미설정',
    text: value => String(value || ''), NARRATIVE_CHUNK_SCHEMA_VERSION: 1, FLASHBACK_SHARD_INDEX_VERSION: 1,
    escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    getGuiNode: id => dom.window.document.getElementById(id),
    guiDialog: async (_message, options) => { dialog = options; }
  });
  const slice = (start, end) => {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert(a >= 0 && b > a); return source.slice(a, b);
  };
  vm.runInContext(slice('  const maintenanceStrategyText =', '  // Zero-vector fault isolation:') +
    slice('  const maintenancePlanPresentation =', '  // Client-side text filter') +
    slice('  const showMaintenanceInspectionModal =', '  const showMaintenanceCompletionModal =') +
    ';globalThis.ui={render:renderMaintenancePlanInUi,build:buildImportTab,diagnose:showMaintenanceInspectionModal};', context);
  return { dom, doc: dom.window.document, ui: context.ui, dialog: () => dialog };
}
const base = { inspection: { complete: true, coverage: 'plugin_only' }, healthy: false,
  automatic: { strategy: 'embedding_queue', blocked: false }, embeddingWorkIncompleteRecords: 2,
  embeddingWorkPendingRecords: 2, missingTurns: 0, changedTurns: 0 };

test('main primary entry and manual controls remain; detail rows retain labels and open state', () => {
  const f = setup(); try {
    f.doc.body.insertAdjacentHTML('beforeend', f.ui.build());
    const entry = f.doc.querySelector('#maintenanceInspectBtn');
    assert(entry.classList.contains('btn--primary'));
    assert.equal(entry.textContent, '상태 점검 및 자동 복구');
    assert(f.doc.querySelector('#maintenanceMode')); assert(f.doc.querySelector('#maintenanceRunBtn'));
    assert.equal(f.doc.querySelector('#maintenancePlanRunBtn'), null);
    f.ui.render(base);
    const target = f.doc.querySelector('#maintenancePlan');
    const rows = Object.fromEntries([...target.querySelectorAll('dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]));
    assert.match(rows['재임베딩 작업'], /재임베딩 대기 2/);
    assert.match(rows['자동 복구 경로'], /재임베딩 대기 벡터 처리/);
    assert.match(rows['종합 판정'], /재임베딩이 끝나지 않은/);
    assert.match(rows['저장소 모드'], /로컬 저장소 기준/);
    assert.equal(f.doc.querySelector('#maintenancePlanBadge').textContent, '재임베딩 미완료');
    const fold = target.querySelector('details'); assert.equal(fold.open, false); fold.open = true;
    f.ui.render({ ...base, requiresFullRebuild: true }); assert.equal(target.querySelector('details').open, true);
    assert(entry.classList.contains('btn--primary'), 'inspection never demotes the top entry');
  } finally { f.dom.window.close(); }
});

test('incomplete inspection never fabricates zero counts, a healthy verdict or an executable recovery', () => {
  const f = setup(); try {
    f.ui.render({ healthy: true, inspection: { complete: false, coverage: 'server_snapshot', reasons: ['size_limit'] }, automatic: { strategy: 'server_inspection_only', blocked: true } });
    assert.equal(f.doc.querySelector('#maintenancePlanBadge').textContent, '점검 미완료');
    const values = [...f.doc.querySelectorAll('.plan-grid > div')].slice(0, 6).map(node => node.textContent);
    assert(values.every(value => value.endsWith('미확인')));
    assert.match(f.doc.querySelector('#maintenancePlan').textContent, /크기 제한/);
    assert.doesNotMatch(f.doc.querySelector('#maintenancePlan').textContent, /0원|정상 일치|실행 버튼을 누르면/);
  } finally { f.dom.window.close(); }
});

test('server queue costs, unverified credentials and nonhealthy matching turns remain distinct', () => {
  const f = setup(); try {
    f.ui.render({ ...base, inspection: { complete: true, coverage: 'server_snapshot', credentialStatus: 'unverified' } });
    const text = f.doc.querySelector('#maintenancePlan').textContent;
    assert.match(text, /모델 호출과 사용량이 발생할 수/); assert.match(text, /미검증 · 점검에서 읽지 않음/);
    assert.doesNotMatch(text, /0원|정상 일치|확인됨 · 서버/);
    const pending = [...f.doc.querySelectorAll('.plan-grid > div')].find(node => node.textContent.includes('미완료 임베딩'));
    assert(pending.hasAttribute('style'));
    f.ui.render({ ...base, embeddingWorkIncompleteRecords: 0, automatic: { strategy: 'server_inspection_only', blocked: true }, inspection: { complete: true, coverage: 'server_snapshot' } });
    assert.equal(f.doc.querySelector('#maintenancePlanBadge').textContent, '실행 차단');
    assert.doesNotMatch(f.doc.querySelector('#maintenancePlan').textContent, /정상 일치|실행 버튼을 누르면/);
    f.ui.render({ ...base, healthy: true, embeddingWorkIncompleteRecords: 0, automatic: { strategy: 'no_action', blocked: false } });
    assert.equal(f.doc.querySelector('#maintenancePlanBadge').textContent, '정상 확인');
  } finally { f.dom.window.close(); }
});

test('diagnosis popup follows producer health and allowed action rather than inferring health from zero missing turns', async () => {
  const f = setup(); try {
    for (const complete of [false, true]) {
      const plan = { ...base, embeddingWorkIncompleteRecords: 0, automatic: { strategy: 'server_inspection_only', blocked: true },
        inspection: { complete, coverage: 'server_snapshot', credentialStatus: 'unverified' } };
      f.ui.render(plan); await f.ui.diagnose(plan);
      const dialog = f.dialog();
      assert.equal(dialog.actionBtn, null);
      assert(dialog.badgeHtml.includes(f.doc.querySelector('#maintenancePlanBadge').textContent));
      assert.doesNotMatch(dialog.bodyHtml, /완벽하게 일치|모든 대화 턴이 서버에 정상/);
      if (!complete) assert.equal((dialog.bodyHtml.match(/>미확인<\/span>/g) || []).length, 4);
    }
    await f.ui.diagnose({ ...base, inspection: { complete: true, coverage: 'server_snapshot' } });
    assert.match(f.dialog().actionBtn.text, /재임베딩 대기/);
    await f.ui.diagnose({ ...base, missingTurns: 2, automatic: { strategy: 'server_turn_sync', blocked: false }, inspection: { complete: true, coverage: 'server_snapshot' } });
    assert.match(f.dialog().actionBtn.text, /누락 턴 동기화/);
  } finally { f.dom.window.close(); }
});
