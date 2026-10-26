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

    const autoBtn = overlay.querySelector('button.btn--primary');
    assert(autoBtn, 'Auto recovery button must exist in dialog');

    // Click auto recovery button
    autoBtn.click();
    await hostFactory.pause(100);

    // After recovery, completion view is rendered
    const completionTitle = overlay.querySelector('h2');
    assert(completionTitle.textContent.includes('완료'), 'Completion view must show completion title');

    console.log('libra_memory_maintenance_auto_recovery_test: PASS');
  } finally {
    await host.close();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
