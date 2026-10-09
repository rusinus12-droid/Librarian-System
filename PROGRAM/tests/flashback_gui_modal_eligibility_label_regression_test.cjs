// Detects outer-Escape leakage, duplicate maintenance admission, busy-state eligibility loss,
// and missing associations by exercising the actual full GUI script in an offline synthetic host.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { create, pause, until } = require('./fixtures/flashback_complete_gui_fixture.cjs');
const results = [];
const evidenceDir = process.env.FLASHBACK_GUI_EVIDENCE_DIR;
const output = process.env.FLASHBACK_GUI_EVIDENCE_LABEL || 'focused';
const saveEvidence = (file, data) => {
  if (!evidenceDir) return;
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, file), JSON.stringify(data, null, 2) + '\n');
};
const sourcePath = process.env.FLASHBACK_GUI_SOURCE;
async function scenario(name, run, options = {}) {
  const s = await create('Flashback', 'Source', { sourcePath, ...options });
  let timeout;
  try {
    await s.open(); await pause(450);
    const details = await Promise.race([run(s), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Scenario did not settle within 12000ms')), 12000); })]);
    assert.equal(s.wire.length, 0, 'synthetic GUI checks must not call network or models');
    assert.deepEqual(s.errors, [], 'GUI should not emit runtime errors');
    results.push({ name, status: 'PASS', sourceSha256: s.sourceSha256, details });
  } catch (error) {
    results.push({ name, status: 'FAIL', sourceSha256: s.sourceSha256, error: error.stack });
  } finally { clearTimeout(timeout); await s.close(); }
  console.log(`${results.at(-1).status}: ${name}${results.at(-1).error ? '\n' + results.at(-1).error : ''}`);
}
function key(s, node, key, options = {}) {
  return node.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
}
async function openMaintenance(s) {
  await s.click('#tab-import');
  const button = s.doc.querySelector('#maintenanceRunBtn'); button.focus(); button.click();
  await until(() => s.doc.querySelector('.vrmDialogBox'), 'maintenance confirmation');
  return button;
}
(async () => {
  await scenario('modal Escape cancels only confirmation and restores opener focus', async s => {
    const writes = s.writes.length, hide = s.calls.hide;
    const button = await openMaintenance(s);
    key(s, s.doc, 'Escape'); await pause(120);
    assert.equal(s.doc.querySelector('.vrmDialogBox'), null, 'Escape must dismiss confirmation');
    assert.equal(s.api.uiStatus().visible, true, 'Escape inside confirmation must preserve the GUI');
    assert.equal(s.calls.hide, hide, 'dialog Escape must not hide the host container');
    assert.equal(s.doc.activeElement, button, 'dialog cancellation restores its opener');
    assert.equal(s.writes.length, writes, 'cancel must not write');
    return { hideDelta: s.calls.hide - hide, writesDelta: s.writes.length - writes, focus: button.id };
  });
  await scenario('rapid maintenance clicks create one confirmation and cancellation releases guard', async s => {
    await s.click('#tab-import');
    const before = s.writes.length, button = s.doc.querySelector('#maintenanceRunBtn');
    button.focus(); button.click(); button.click();
    await pause(80);
    assert.equal(s.doc.querySelectorAll('.vrmDialogBox').length, 1, 'only one maintenance confirmation may exist');
    s.doc.querySelector('.vrmDialogCancel').click(); await pause(80);
    assert.equal(s.doc.querySelectorAll('.vrmDialogBox').length, 0);
    assert.equal(button.disabled, false, 'cancel releases maintenance button');
    button.click(); await until(() => s.doc.querySelector('.vrmDialogBox'), 'confirmation reopened');
    s.doc.querySelector('.vrmDialogCancel').click(); await pause(80);
    assert.equal(s.writes.length, before, 'neither cancellation should write');
    assert.equal(s.api.uiStatus().visible, true);
    return { dialogsAtMost: 1, cancelledTwice: true, writesDelta: s.writes.length - before };
  });
  await scenario('unconfigured embedding actions remain disabled after save and status refresh', async s => {
    await s.click('#tab-provider'); await s.click('#embeddingWorkRefreshBtn');
    const disabled = () => ['embeddingWorkRunBtn', 'embeddingWorkRetryFailedBtn'].map(id => s.doc.getElementById(id).disabled);
    assert.deepEqual(disabled(), [true, true], 'unconfigured actions start disabled');
    await s.click('#tab-advanced'); await s.change('#topK', '13'); await s.click('#saveAdvancedSettingsBtn');
    await s.click('#tab-provider'); await s.click('#embeddingWorkRefreshBtn');
    assert.deepEqual(disabled(), [true, true], 'busy release must preserve model and count eligibility');
    s.doc.querySelector('#embeddingWorkRunBtn').click(); s.doc.querySelector('#embeddingWorkRetryFailedBtn').click();
    await pause(80); assert.equal(s.wire.length, 0);
    return { disabled: disabled(), status: s.doc.getElementById('embeddingWorkStatus').textContent.trim() };
  });
  await scenario('existing field labels are associated with their actual controls', async s => {
    const fields = [...s.doc.querySelectorAll('.vrmDesign .field')].map(field => {
      const label = [...field.children].find(n => n.tagName === 'LABEL');
      const control = [...field.children].find(n => /^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName));
      return label && control ? { label, control } : null;
    }).filter(Boolean);
    assert.ok(fields.length >= 30, 'check original provider, maintenance, and advanced fields');
    const missing = fields.filter(({ label, control }) => ![...control.labels || []].includes(label)).map(({label,control})=>({id:control.id,label:label.textContent.trim()}));
    assert.deepEqual(missing, [], 'all existing field labels should name their matching input');
    return { inspectedFields: fields.length, labels: fields.map(({label,control})=>({id:control.id,label:label.textContent.trim()})) };
  });
  await scenario('existing field descriptions stay separate from accessible names', async s => {
    const fields = [...s.doc.querySelectorAll('.vrmDesign .field')].map(field => {
      const control = [...field.children].find(n => /^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName));
      const note = [...field.children].find(n => n.classList.contains('field-note'));
      return control && note ? { control, note } : null;
    }).filter(Boolean);
    assert.ok(fields.length >= 11);
    const missing = fields.filter(({control,note}) => !note.id || !(control.getAttribute('aria-describedby') || '').split(/\s+/).includes(note.id)).map(({control})=>control.id);
    assert.deepEqual(missing, [], 'field descriptions should be attached through aria-describedby');
    return { describedFields: fields.length };
  });
  await scenario('focused dialog Escape and Tab contain focus without closing the GUI', async s => {
    const button = await openMaintenance(s);
    const ok = s.doc.querySelector('.vrmDialogOk'), cancel = s.doc.querySelector('.vrmDialogCancel');
    assert.equal(s.doc.activeElement, ok);
    key(s, ok, 'Tab'); assert.equal(s.doc.activeElement, cancel, 'Tab wraps to cancel');
    key(s, cancel, 'Tab', { shiftKey: true }); assert.equal(s.doc.activeElement, ok, 'Shift-Tab wraps to confirm');
    const before = s.calls.hide; key(s, ok, 'Escape'); await pause(80);
    assert.equal(s.doc.querySelector('.vrmDialogBox'), null);
    assert.equal(s.api.uiStatus().visible, true); assert.equal(s.calls.hide, before);
    assert.equal(s.doc.activeElement, button);
    return { focusContained: true, focusedEscape: true };
  });
  await scenario('rebuild confirmation and local-repair preview also reject repeated clicks', async s => {
    await s.click('#tab-import');
    for (const mode of ['rebuild', 'reembed']) {
      await s.change('#maintenanceMode', mode);
      const before = s.writes.length, button = s.doc.querySelector('#maintenanceRunBtn');
      button.focus(); button.click(); button.click();
      await until(() => s.doc.querySelector('.vrmDialogBox'), mode + ' dialog'); await pause(80);
      assert.equal(s.doc.querySelectorAll('.vrmDialogBox').length, 1, mode + ' opens one dialog');
      key(s, s.doc.activeElement, 'Escape'); await pause(80);
      assert.equal(s.doc.querySelector('.vrmDialogBox'), null);
      assert.equal(s.api.uiStatus().visible, true);
      assert.equal(s.writes.length, before, mode + ' cancellation must not write');
    }
    return { checkedModes: ['rebuild', 'reembed'], writes: 0 };
  });
  await scenario('configured empty-work controls remain ineligible after saving', async s => {
    await s.click('#tab-provider');
    await s.change('#embeddingProvider', 'openai');
    await s.change('#embeddingModel', 'text-embedding-3-small');
    await s.change('#embeddingAutoProcess', false);
    await s.click('#saveSettingsBtn'); await s.click('#embeddingWorkRefreshBtn');
    assert.match(s.doc.querySelector('#embeddingWorkStatus').textContent, /저장된 모델:/);
    assert.equal(s.doc.querySelector('#embeddingWorkRunBtn').disabled, true, 'configured empty queue cannot run');
    assert.equal(s.doc.querySelector('#embeddingWorkRetryFailedBtn').disabled, true, 'no failed work cannot retry');
    const ids = [...s.doc.querySelectorAll('[id]')].map(n => n.id);
    const descriptions = [...s.doc.querySelectorAll('.field [aria-describedby]')];
    for (const control of descriptions) for (const id of control.getAttribute('aria-describedby').split(/\s+/).filter(Boolean)) {
      assert.equal(ids.filter(value => value === id).length, 1, 'description target is unique: ' + id);
    }
    return { configured: true, emptyQueueDisabled: true, descriptionTargetsUnique: true };
  });
  await scenario('busy save and asynchronous panel refresh keep embedding controls disabled', async s => {
    await s.click('#tab-provider'); await s.click('#embeddingWorkRefreshBtn');
    let release, blocked = false;
    const gate = new Promise(resolve => { release = resolve; });
    const storage = s.host.pluginStorage, write = storage.setItem;
    storage.setItem = async (key, value) => { blocked = true; await gate; return write(key, value); };
    const button = s.doc.querySelector('#saveSettingsBtn'); button.click();
    let pendingRefresh;
    try {
      await until(() => blocked, 'held settings write');
      for (const id of ['embeddingWorkRefreshBtn', 'embeddingWorkRunBtn', 'embeddingWorkRetryFailedBtn']) {
        assert.equal(s.doc.getElementById(id).disabled, true, 'busy state disables ' + id);
      }
      pendingRefresh = s.api.refreshUi('provider'); await pause(80);
      for (const id of ['embeddingWorkRefreshBtn', 'embeddingWorkRunBtn', 'embeddingWorkRetryFailedBtn']) {
        assert.equal(s.doc.getElementById(id).disabled, true, 'refresh cannot reenable busy ' + id);
      }
    } finally { release(); storage.setItem = write; }
    if (pendingRefresh) await pendingRefresh;
    await until(() => !s.doc.querySelector('#saveSettingsBtn').disabled, 'settings save finished');
    assert.equal(s.doc.querySelector('#embeddingWorkRunBtn').disabled, true);
    assert.equal(s.doc.querySelector('#embeddingWorkRetryFailedBtn').disabled, true);
    return { busyRefreshRemainedDisabled: true, afterReleaseIneligible: true };
  });
  await scenario('all ten views and controls preserve their original surface and navigation', async s => {
    const tabs = [...s.doc.querySelectorAll('.nav-item[data-tab]')];
    assert.equal(tabs.length, 10);
    const surfaces = [];
    for (const tab of tabs) {
      tab.click(); await pause(120);
      const id = tab.dataset.tab, panel = s.doc.getElementById('panel-' + id);
      assert.ok(panel?.classList.contains('active'), id + ' remains reachable');
      assert.equal(tab.getAttribute('aria-selected'), 'true');
      const controls = [...panel.querySelectorAll('input,select,textarea,button')].map(n => ({tag:n.tagName,id:n.id,name:n.name,type:n.type,text:n.tagName === 'BUTTON' ? n.textContent.trim() : undefined}));
      surfaces.push({ id, label: tab.textContent.trim(), controls });
    }
    saveEvidence(output + '-surface.json', surfaces);
    saveEvidence(output + '-surface-labels.json', [...s.doc.querySelectorAll('.vrmDesign label')].map(n => n.textContent.trim()));
    const before = s.calls.hide; key(s, s.doc, 'Escape'); await pause(100);
    assert.equal(s.api.uiStatus().visible, false, 'Escape without a dialog still closes the GUI');
    assert.equal(s.calls.hide, before + 1);
    await s.open(); await pause(120);
    assert.equal(s.api.uiStatus().visible, true);
    assert.equal(s.doc.querySelectorAll('.vrmDesign').length, 1, 'reopen preserves one GUI root');
    return { views: surfaces.map(x=>x.id), totalControls: surfaces.reduce((n,x)=>n+x.controls.length,0), reopen: true };
  });
  saveEvidence(output + '.json', { generatedAt: new Date().toISOString(), results });
  const failed = results.filter(x => x.status !== 'PASS');
  console.log(JSON.stringify({ passed: results.length-failed.length, failed: failed.length }));
  process.exitCode = failed.length ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
