'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadGui } = require('../wm/tools/libra_management_gui_integration_test.cjs');
let artifact;
async function sourceArtifact() {
  if (process.env.LIBRA_GUI_TEST_DIST) return process.env.LIBRA_GUI_TEST_DIST;
  if (!artifact) {
    artifact = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wm-world-save-gui-')), 'LIBRA_World_Manager.js');
    fs.writeFileSync(artifact, (await require('../wm/tools/build-portable.cjs').assemblePortableSource()).code);
  }
  return artifact;
}
test('WM upper and lower world-save controls have unique IDs and each reaches the owned save path', async () => {
  process.env.LIBRA_GUI_TEST_DIST = await sourceArtifact();
  const f = await loadGui({ nativeInitialization: true, store: new Map() });
  try {
    await f.click('[data-tab="world"]');
    const ids = [...f.overlay.querySelectorAll('[id]')].map(n => n.id);
    assert.equal(new Set(ids).size, ids.length, 'all controls have unique IDs');
    const world = f.overlay.querySelector('#tab-world');
    const fields = [...world.querySelectorAll('button')].filter(n => /세계관 (필드 )?저장/.test(n.textContent));
    const corrections = [...world.querySelectorAll('button')].filter(n => /사용자 교정 저장|세계관 보정 저장/.test(n.textContent));
    assert.equal(fields.length, 2); assert.equal(corrections.length, 2, 'both action locations remain');
    const clickAndSettle = async button => {
      const handler = button.onclick; let completion;
      button.onclick = event => { completion = handler.call(button, event); };
      button.click(); await completion;
      button.onclick = handler;
    };
    const savedWorld = () => JSON.parse(f.canonicalPayload().entries.find(row => row.comment === 'lmai_world_graph').content).nodes[0][1];
    for (const [i, button] of fields.entries()) {
      assert.equal(typeof button.onclick, 'function');
      f.overlay.querySelector('#world-node-name').value = 'Synthetic world ' + i;
      const before = f.calls.writes.length + f.calls.hostWrites.length;
      await clickAndSettle(button);
      assert(f.calls.writes.length + f.calls.hostWrites.length > before, 'field action reaches persistence');
      assert.equal(savedWorld().name, 'Synthetic world ' + i);
    }
    for (const [i, button] of corrections.entries()) {
      assert.equal(typeof button.onclick, 'function');
      f.overlay.querySelector('#world-user-correction').value = 'Synthetic correction ' + i;
      const before = f.calls.writes.length + f.calls.hostWrites.length;
      await clickAndSettle(button);
      assert(f.calls.writes.length + f.calls.hostWrites.length > before, 'correction action reaches persistence');
      assert.equal(savedWorld().meta.userWorldCorrection, 'Synthetic correction ' + i);
    }
    const tabs = [...f.overlay.querySelectorAll('[data-view-tab]')];
    assert.equal(tabs.length, 11, 'all existing primary WM views remain');
    for (const button of tabs) {
      await f.click(button);
      assert.equal(button.getAttribute('aria-selected'), 'true');
      assert(f.overlay.querySelector('#tab-' + button.dataset.viewTab).classList.contains('on'));
    }
  } finally { f.close(); }
});
