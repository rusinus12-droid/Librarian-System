'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const hostFactory = require('./fixtures/libra_gui_memory_dom_host.cjs');

const sourcePath = path.join(__dirname, '../plugins/LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

// 1. Static contract verification
assert(
  source.includes("reanalyzeTurn:String(row.startTurn)"),
  'LIBRA.js must tag range row reanalyze buttons with reanalyzeTurn'
);

assert(
  source.includes("showLibraSourceReanalysisDrawer({kind:'canonical',startTurn:row.startTurn,endTurn:row.endTurn})"),
  'Range row reanalyze button must invoke showLibraSourceReanalysisDrawer with exact turn bounds'
);

assert(
  source.includes("id:'seg-reana'"),
  'Range selection dialog must provide seg-reana button'
);

async function run() {
  const host = await hostFactory.create('LIBRA', 'Full', {
    initialChat: [
      { role: 'user', data: '1' }, { role: 'assistant', data: '1' },
      { role: 'user', data: '2' }, { role: 'assistant', data: '2' },
      { role: 'user', data: '3' }, { role: 'assistant', data: '3' },
      { role: 'user', data: '4' }, { role: 'assistant', data: '4' },
      { role: 'user', data: '5' }, { role: 'assistant', data: '5' }
    ]
  });

  try {
    await host.open();
    await hostFactory.pause(250);
    const doc = host.doc;

    // Open canonical range drawer via desk or direct open
    const rangeOpenBtn = doc.querySelector('[data-open="dlg-range"]');
    assert(rangeOpenBtn, 'Should have range drawer opener button');
    rangeOpenBtn.click();
    await hostFactory.pause(100);

    const rangeOverlay = doc.querySelector('#dlg-range');
    assert(rangeOverlay && rangeOverlay.classList.contains('is-open'), 'dlg-range should be open');

    // Find row reanalyze button
    const reanaBtn = rangeOverlay.querySelector('button[data-reanalyze-turn="1"]');
    assert(reanaBtn, 'Should find reanalyze button for turn 1 in range dialog');
    assert.equal(reanaBtn.textContent.trim(), '재분석');

    // Bottom action button check
    const bottomReanaBtn = rangeOverlay.querySelector('#seg-reana');
    assert(bottomReanaBtn, 'Should find seg-reana bottom button');

    // Click row reanalyze button
    reanaBtn.click();
    await hostFactory.pause(120);

    // Dialog range should close and reanalysis drawer should open
    assert(!doc.querySelector('#dlg-range'), 'dlg-range should be closed after clicking reanalyze');
    const reanaOverlay = doc.querySelector('#dlg-libra-source-reanalysis');
    assert(reanaOverlay && reanaOverlay.classList.contains('is-open'), 'dlg-libra-source-reanalysis should be open');

    const canonicalTab = reanaOverlay.querySelector('[data-reanalysis-kind="canonical"]');
    assert(canonicalTab && canonicalTab.classList.contains('is-on'), 'Canonical tab should be active');

    console.log('libra_canonical_range_reanalyze_button_test: PASS');
  } finally {
    await host.close();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
