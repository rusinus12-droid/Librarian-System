'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const raw = fs.readFileSync(path.join(__dirname, '../plugins/Flashback_Memory.js'), 'utf8');
(async () => {
  const f = await createFixture({ source: raw.replace('_test: { maintenanceResultText,', '_test: { buildUiHtml,buildImportTab,maintenanceResultText,') });
  try {
    const html = await f.api._test.buildUiHtml();
    const routes = ['lab', 'vault', 'care', 'connect', 'log', 'settings'];
    for (const route of routes) {
      assert.ok(html.includes(`data-page="${route}"`), `${route} route exists`);
      assert.ok(html.includes(`data-go="${route}"`), `${route} has navigation`);
    }
    assert.ok(!/data-page="(?:overview|storage|worldline|import|source-edits|restore|provider|server|activity|advanced)"/.test(html), 'no hidden legacy route copies');
    for (const id of ['cleanupSelectedScopesBtn','selectCleanupCandidatesBtn','selectOrphanScopesBtn','storageManagementView','fbSourceEditTitle','fbSourceEditStatus','fbSourceTrackingSettings','fbReanalysisRanges','fbReanalysisRun','maintenanceInspectBtn','clearActivityLogBtn','activityLogList','swallowedDiagList','warningLog']) {
      assert.ok(html.includes(`id="${id}"`), `${id} remains reachable`);
    }
    assert.ok(!f.api._test.buildImportTab().includes('data-portable-backup-host'));
    assert.equal((html.match(/data-portable-backup-host="flashback_memory"/g) || []).length, 1, 'Portable Memory host remains unique');
    assert.ok(html.includes('data-subtabs="v"') && html.includes('data-subtabs="c"') && html.includes('data-subtabs="l"'), 'mockup detail flows remain in six routes');
    assert.ok(!html.includes('suite.js') && !html.includes('data-toast='), 'mockup fake interactions are not shipped');
    assert.ok(html.includes('var(--font-sans)') && html.includes('.menu.is-open .menu__panel'), 'mockup design tokens are present');
    assert.ok(raw.includes("if (activeTab === 'import' || activeTab === 'source-edits') await refreshFlashbackSourceEditPanel()"), 'care route loads source reanalysis inventory');
    console.log('flashback_scope_panels_contract_test: PASS');
  } finally { await f.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
