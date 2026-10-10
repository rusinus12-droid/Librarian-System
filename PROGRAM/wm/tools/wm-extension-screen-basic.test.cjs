'use strict';
// FEATURE-FIRST nominal UI consolidation only; no real model, host, rendering or broad regression qualification.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { loadGui } = require('./libra_management_gui_integration_test.cjs');
const { profile } = require('./wm-analysis-preset-test-support.cjs');
const KEY = 'LMAI_Config';
const seed = () => ({ useLLM: false, llm: profile('legacy'), llmPresets: { a: profile('existing') }, llmDefaultPreset: 'a', debug: false,
  worldAdditionalEnabled: false, worldAdditionalMode: 'off', worldAdditionalMaxPerRequest: 4,
  injectionBudgetPreset: 'custom', injectionBudgetMaxTokens: 1600, hmeAssociativeGraphMode: 'deep', rpLongTermLongTtl: 777,
  unknownSibling: { retained: 0 } });
const observations = [];
const open = store => loadGui({ nativeInitialization: true, observeCommonAnalysis: true, args: { use_llm: 'false' }, store });
const node = (f, selector) => f.overlay.querySelector(selector);
const until = async (fn, label) => { const end = Date.now() + 5000; while (!fn()) { assert(Date.now() < end, label); await new Promise(r => setTimeout(r, 5)); } };

test('one extension screen provides automatic/direct navigation and preserves existing settings, drafts and data', async () => {
  const store = new Map([[KEY, JSON.stringify(seed())]]), f = await open(store);
  let modelCalls = 0;
  try {
    f.common.LLMProvider.call = async () => { modelCalls++; throw Error('nominal UI smoke forbids model execution'); };
    const raw = store.get(KEY), live = JSON.stringify(f.api.MemoryEngine.CONFIG);
    const additional = JSON.stringify(f.api.WorldAdditionalCore.getState()), dlc = JSON.stringify(f.api.UserDlcCore.getState());
    const primary = node(f, '#tab-world-additional');
    assert.equal(node(f, '.side-link[data-tab="world-additional"]').textContent.trim(), '✚확장');
    assert.equal(node(f, '.side-link[data-tab="wa-auto"]'), null); assert.equal(node(f, '.side-link[data-tab="udlc"]'), null);
    assert.deepEqual(Array.from(primary.querySelectorAll('[data-additional-tab]')).map(n => n.dataset.additionalTab), ['auto', 'direct']);
    assert.match(node(f, '#extension-auto-tab').textContent, /자동 추가/); assert.match(node(f, '#extension-direct-tab').textContent, /직접 추가/);
    assert.equal(node(f, '#tab-wa-auto').closest('.panel'), primary); assert.equal(node(f, '#tab-udlc').closest('.panel'), primary);
    assert.equal(node(f, '#tab-work').parentNode, primary.parentNode, 'following material-work panel is not nested in extension');
    const ids = Array.from(primary.querySelectorAll('[id]')).map(n => n.id);
    assert.equal(ids.length, new Set(ids).size, 'no duplicated IDs in the consolidated extension screen');
    await f.click('.side-link[data-tab="world-additional"]');
    assert(primary.classList.contains('on')); assert(node(f, '#extension-direct-pane').classList.contains('on'));
    node(f, '#udlc-unified-request').value = 'A fictional archive';
    node(f, '#udlc-world-request').value = 'Keep this detailed input';
    await f.click('#extension-auto-tab');
    assert(node(f, '#tab-wa-auto').classList.contains('on')); assert.equal(node(f, '#tab-wa-auto').hidden, false);
    assert.equal(node(f, '#extension-direct-pane').hidden, true); assert.equal(node(f, '#extension-auto-tab').getAttribute('aria-selected'), 'true');
    for (const pane of ['world', 'active', 'log', 'entities']) { await f.click('[data-wa-tab="'+pane+'"]'); assert(node(f, '[data-wa-pane="'+pane+'"]').classList.contains('on')); }
    assert.equal(node(f, '[data-wa-tab="user-dlc"]'), null, 'obsolete cross-screen tab removed');
    await f.click('#btn-refresh-world-additional');
    await f.click('#extension-direct-tab');
    assert.equal(node(f, '#udlc-unified-request').value, 'A fictional archive'); assert.equal(node(f, '#udlc-world-request').value, 'Keep this detailed input');
    for (const pane of ['entity', 'world']) { await f.click('[data-udlc-tab="'+pane+'"]'); assert(node(f, '[data-udlc-pane="'+pane+'"]').classList.contains('on')); }
    await f.click('[data-udlc-unified-kind="world"]'); assert.match(node(f, '#udlc-unified-request').value, /함정/);
    await f.click('.side-link[data-tab="settings"]');
    assert.deepEqual(Array.from(node(f, '#tab-settings').querySelectorAll('[data-settings-group]')).map(n => n.dataset.settingsGroup), ['ai', 'memory', 'story']);
    assert(node(f, '#btn-export-settings-file').closest('#tab-work')); assert(node(f, '#btn-import-settings-file').closest('#tab-work'));
    assert.equal(typeof f.w.LibraSettingsSchema.buildPublicExport, 'function');
    await f.click('.side-link[data-tab="world-additional"]'); assert(primary.classList.contains('on'));
    assert.equal(store.get(KEY), raw); assert.equal(JSON.stringify(f.api.MemoryEngine.CONFIG), live);
    assert.equal(JSON.stringify(f.api.WorldAdditionalCore.getState()), additional); assert.equal(JSON.stringify(f.api.UserDlcCore.getState()), dlc);
    assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.hostWrites.length, 0); assert.equal(modelCalls, 0);
    observations.push({ case: 'unified screen/navigation/draft and setting preservation', settingsWrites: 0, hostWrites: 0, modelCalls });
  } finally { f.close(); }
});

test('existing automatic-injection setting still saves from the unified screen and reopens without touching siblings', async () => {
  const store = new Map([[KEY, JSON.stringify(seed())]]), f = await open(store); let fresh;
  try {
    const before = JSON.parse(JSON.stringify(f.w.LibraSettingsSchema.forStorage(JSON.parse(store.get(KEY)))));
    await f.click('.side-link[data-tab="world-additional"]'); await f.click('#extension-auto-tab');
    node(f, '#swamax').value = '5'; node(f, '#swamax').dispatchEvent(new f.w.Event('change', { bubbles: true }));
    await until(() => node(f, '#settings-auto-save-status').dataset.state === 'saved', 'existing setting save settles');
    const saved = JSON.parse(store.get(KEY));
    assert.equal(saved.worldAdditionalMaxPerRequest, 5);
    for (const key of ['useLLM','worldAdditionalEnabled','worldAdditionalMode','injectionBudgetPreset','injectionBudgetMaxTokens','hmeAssociativeGraphMode','rpLongTermLongTtl','unknownSibling','llmPresets','llmDefaultPreset']) assert.deepEqual(saved[key], before[key], key);
    fresh = await open(store); await fresh.click('.side-link[data-tab="world-additional"]'); await fresh.click('#extension-auto-tab');
    assert.equal(node(fresh, '#swamax').value, '5'); assert.equal(node(fresh, '#s-use-llm').checked, false);
    assert.equal(f.calls.hostWrites.length + fresh.calls.hostWrites.length, 0);
    observations.push({ case: 'existing setting save/fresh reopen', settingsWrites: f.calls.writes.filter(x => x.key === KEY).length, hostWrites: 0 });
  } finally { fresh?.close(); f.close(); }
});
test.after(() => { if (process.env.WM_BASIC_CHECKPOINT) fs.writeFileSync(path.join(process.env.WM_BASIC_CHECKPOINT, 'BASIC-SMOKE-OBSERVATIONS.json'), JSON.stringify({ observations, limits: 'Two nominal synthetic GUI cases only. No actual model/host, GUI visual inspection, full semantic, dirty-navigation edge matrix, regression, independent review or Full/Min equivalence.' }, null, 2)+'\n'); });
