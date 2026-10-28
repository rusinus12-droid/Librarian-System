'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const hostFactory = require('./fixtures/libra_gui_memory_dom_host.cjs');

const sourcePath = path.join(__dirname, '../plugins/LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

// 1. Static contract verification
assert(
  source.includes('const inspectLibraMemoryMaintenance = async () => {'),
  'LIBRA must define inspectLibraMemoryMaintenance'
);

assert(
  source.includes('const runLibraMemoryMaintenance = async (mode = \'auto\', options = {}) => {'),
  'LIBRA must define runLibraMemoryMaintenance'
);

assert(
  source.includes('const openLibraMemoryMaintenanceDialog = async () => {'),
  'LIBRA must define openLibraMemoryMaintenanceDialog'
);

assert(
  source.includes('LibraMemoryCore.inspectMemoryMaintenance = inspectLibraMemoryMaintenance;'),
  'LibraMemoryCore must expose inspectMemoryMaintenance'
);

assert(
  source.includes('LibraMemoryCore.runMemoryMaintenance = runLibraMemoryMaintenance;'),
  'LibraMemoryCore must expose runMemoryMaintenance'
);

assert(
  source.includes('async inspectMemoryMaintenance() { return await inspectLibraMemoryMaintenance(); },'),
  'publicApi must expose inspectMemoryMaintenance'
);

assert(
  source.includes('async runMemoryMaintenance(mode = \'auto\', options = {}) { return await runLibraMemoryMaintenance(mode, options); },'),
  'publicApi must expose runMemoryMaintenance'
);

// Check UI integration points
assert(
  source.includes("text:'⚡ 상태 점검·복구',dataset:{bookMemoryMaintenance:'true'}"),
  'Worldline view must provide ⚡ 상태 점검·복구 button'
);

// One-touch recovery reuses the existing cold start / canonical / reanalysis / embedding paths.
assert(
  source.includes("runLibraMemoryMaintenance('full', { preflight: p, auxiliary: true, onProgress: view.update })"),
  'Maintenance dialog must run one-touch recovery through runLibraMemoryMaintenance'
);
assert(
  source.includes('await LibraMemoryCore.reanalyzeSelectedRanges({ ...inventory, ranges })'),
  'Micro and lens gaps must be recovered through the shared reanalysis path'
);

assert(
  source.includes("text: '상태 점검 및 자동 복구', onClick: () => { void openLibraMemoryMaintenanceDialog(); }"),
  'Desk banner must provide 상태 점검 및 자동 복구 button'
);

assert(
  source.includes("text: '상태 점검 및 자동 복구', onClick: () => void openLibraMemoryMaintenanceDialog()"),
  'Canonical Archive management banner must provide 상태 점검 및 자동 복구 button'
);

assert(
  source.includes("text:'⚡ 상태 점검 및 자동 복구',onClick:()=>{overlay.remove();void openLibraMemoryMaintenanceDialog();}"),
  'State dialog actions must offer ⚡ 상태 점검 및 자동 복구 button'
);

assert(
  source.includes("text:'⚡ 원스톱 상태 점검 및 자동 복구'"),
  'Settings recovery actions must include ⚡ 원스톱 상태 점검 및 자동 복구 card'
);

assert(
  source.includes("data-open=\"dlg-maintenance\""),
  'Reading Desk page-actions must include dlg-maintenance button'
);

async function run() {
  const host = await hostFactory.create('LIBRA', 'Full', {
    initialChat: [
      { role: 'user', data: '안녕 리브라' },
      { role: 'assistant', data: '안녕하세요!' }
    ]
  });

  try {
    // 2. Functional publicApi test
    const plan = await host.api.inspectMemoryMaintenance();
    assert.equal(plan.schema, 'libra.memory_maintenance_plan.v1');
    assert.equal(typeof plan.healthy, 'boolean');
    assert.equal(typeof plan.liveTurns, 'number');
    assert.equal(typeof plan.stateThroughTurn, 'number');
    assert.equal(typeof plan.remainingTurns, 'number');
    assert.equal(typeof plan.savedRangesCount, 'number');
    assert.equal(typeof plan.missingRangesCount, 'number');
    assert.equal(typeof plan.failedRangesCount, 'number');
    assert.equal(typeof plan.coldStartNeeded, 'boolean');
    assert.ok(Array.isArray(plan.issues));

    const result = await host.api.runMemoryMaintenance('auto', { preflight: plan });
    assert.equal(result.schema, 'libra.memory_maintenance_result.v1');
    assert.equal(result.status, 'completed');
    assert.ok(Array.isArray(result.actionsTaken));
    assert.ok(typeof result.durationMs === 'number');

    // 3. UI test
    await host.open();
    const doc = host.doc;

    // Verify desk page action exists
    const deskAction = doc.querySelector('[data-open="dlg-maintenance"], [data-action="maintenance"]');
    assert(deskAction, 'Reading desk must contain maintenance button');

    // Open maintenance dialog via publicApi
    await host.api.openMemoryMaintenanceDialog();
    const overlay = doc.querySelector('#dlg-maintenance');
    assert(overlay, 'Maintenance overlay #dlg-maintenance must be created in DOM');
    assert(overlay.classList.contains('is-open'), 'Maintenance overlay must have is-open class');

    // Verify dialog content
    const title = overlay.querySelector('h2');
    assert(title && title.textContent.includes('기억 상태 점검'), 'Dialog must have maintenance title');

    // Verify integrated memory model summary
    const modelSummary = overlay.querySelector('[aria-label="기억 작성 모델 설정"], [data-memory-model="analysis"]');
    assert(modelSummary, 'Dialog must integrate memory model summary');

    // Verify integrated navigation buttons
    const buttons = Array.from(overlay.querySelectorAll('button'));
    const hasRangeBtn = buttons.some(b => b.textContent.includes('기억 생성 구간 선택'));
    const hasReanalysisBtn = buttons.some(b => b.textContent.includes('원문 재분석'));
    assert(hasRangeBtn, 'Dialog must contain entry to 기억 생성 구간 선택');
    assert(hasReanalysisBtn, 'Dialog must contain entry to 원문 재분석');

    // The retired Reading Desk progress card is integrated into the dialog.
    assert(overlay.querySelector('[data-memory-progress="true"] [data-memory-state-progress="true"]'), 'Dialog must integrate memory progress');
    assert(overlay.querySelector('[data-memory-model-save="analysis"]'), 'Dialog keeps the Librarian preset save control');

    const fullBtn = overlay.querySelector('button.btn--primary[data-maintenance-full]');
    assert(fullBtn, 'Auto recovery is the primary dialog action');
    assert.equal(fullBtn.textContent.trim(), '자동 복구 실행');
    await hostFactory.pause(50);
    assert.equal(overlay.querySelector('[data-maintenance-targets]')?.dataset.maintenanceTargets, 'ready', 'recovery targets are listed before running');

    const autoBtn = overlay.querySelector('button[data-maintenance-auto]');
    assert(autoBtn, 'Auto recovery button must exist in dialog');
    assert.equal(autoBtn, fullBtn, 'Single unified auto recovery button');

    // One-touch auto recovery: cost/target confirmation first, then live steps, then completion.
    fullBtn.click();
    await hostFactory.pause(50);
    const confirm = doc.querySelector('#dlg-product-confirm');
    assert(confirm, 'Auto recovery must ask for confirmation first');
    assert.match(confirm.textContent, /모델 생성 호출 약 \d+회/, 'confirmation states the expected model calls');
    assert.match(confirm.textContent, /미크로 누락 \(1턴\)/, 'confirmation lists the Micro target');
    assert.equal(overlay.querySelector('h2').textContent.includes('완료'), false, 'nothing runs before confirmation');
    confirm.querySelector('[data-operation-confirm-execute]').click();
    let finished = false;
    for (let i = 0; i < 100 && !finished; i++) {
      await hostFactory.pause(50);
      finished = overlay.querySelector('h2')?.textContent.includes('완료');
    }
    assert(finished, 'Auto recovery reaches its completion view');

    // Verify completion actions provide entry points
    const completionButtons = Array.from(overlay.querySelectorAll('button'));
    assert(completionButtons.some(b => b.textContent.includes('기억 생성 구간 선택')), 'Completion must offer range selection button');
    assert(completionButtons.some(b => b.textContent.includes('원문 재분석')), 'Completion must offer reanalysis button');

    console.log('libra_memory_maintenance_auto_recovery_test: PASS');
  } finally {
    await host.close();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
