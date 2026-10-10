'use strict';
// FEATURE-FIRST normal portable transfer and malformed/no-write smoke only. No broad privacy qualification.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { loadGui } = require('./libra_management_gui_integration_test.cjs');
const { profile } = require('./wm-analysis-preset-test-support.cjs');
const KEY = 'LMAI_Config', plain = x => JSON.parse(JSON.stringify(x));
const seed = () => ({ useLLM: false, llm: profile('legacy'), llmPresets: { a: profile('model-a', { headers: { Authorization: 'synthetic-local-header' }, customJSON: { secret: 'synthetic-local-extra' } }) }, llmDefaultPreset: 'a', debug: false,
  injectionBudgetPreset: 'custom', injectionBudgetMaxTokens: 1600, hmeAssociativeGraphMode: 'deep', rpLongTermMemoryEnabled: false, rpLongTermLongTtl: 777,
  embed: { provider: 'openai', model: 'embed-a', key: 'synthetic-local-embed-key', url: 'https://synthetic.invalid/embed', enabled: false },
  wmStorageAuthority: { mode: 'dual', token: 'synthetic-authority-token' }, migrationPending: { private: 'synthetic-private' }, unknownSibling: { keep: 0 } });
const observations = [];
const open = store => loadGui({ nativeInitialization: true, observeCommonAnalysis: true, args: { use_llm: 'false' }, store });
const node = (f, id) => f.w.document.querySelector('#lmai-overlay').querySelector(id);
const selectFile = async (f, value) => { const raw = typeof value === 'string' ? value : JSON.stringify(value); await node(f, '#settings-file-input').onchange({ target: { files: [{ name: 'portable.json', size: Buffer.byteLength(raw), text: async () => raw }] } }); };
const until = async (fn, label) => { const end = Date.now() + 5000; while (!fn()) { assert(Date.now() < end, label); await new Promise(r => setTimeout(r, 5)); } };

test('sanitized saved settings download and previewed import preserve local secrets and authority through fresh init', async () => {
  const store = new Map([[KEY, JSON.stringify(seed())]]), f = await open(store); let fresh;
  try {
    const schema = f.w.LibraSettingsSchema;
    assert.equal(typeof schema.buildPublicExport, 'function', 'portable allowlist serializer implemented');
    const envelope = plain(schema.buildPublicExport(JSON.parse(store.get(KEY))));
    assert.equal(envelope.schema, 'wm.portable-settings'); assert.equal(envelope.version, 1);
    const text = JSON.stringify(envelope);
    for (const forbidden of ['synthetic-test-only','synthetic-local-header','synthetic-local-extra','synthetic-local-embed-key','synthetic.invalid','synthetic-authority-token','synthetic-private','customJSON','headers','wmStorageAuthority','migrationPending']) assert(!text.includes(forbidden), forbidden);
    assert.equal(envelope.settings.useLLM, false); assert.equal(envelope.settings.injectionBudgetMaxTokens, 1600);
    let blob; f.w.URL.createObjectURL = value => { blob = value; return 'blob:synthetic-only'; }; f.w.URL.revokeObjectURL = () => {};
    await node(f, '#btn-export-settings-file').onclick(); assert(blob && blob.size > 0); assert.equal(f.calls.writes.length, 0);
    envelope.settings.debug = true; envelope.analysis.presets.find(p => p.name === 'a').model = 'model-a-new';
    const before = plain(JSON.parse(store.get(KEY)));
    await selectFile(f, envelope); assert.equal(f.calls.writes.length, 0); assert.equal(node(f, '#btn-apply-settings-import').disabled, false);
    assert.match(node(f, '#settings-import-preview').textContent, /debug|프리셋/);
    await node(f, '#btn-apply-settings-import').onclick();
    await until(() => node(f, '#settings-transfer-status').dataset.state === 'saved', 'verified import settles');
    const saved = JSON.parse(store.get(KEY));
    assert.equal(saved.debug, true); assert.equal(saved.llmPresets.a.model, 'model-a-new'); assert.equal(saved.llmPresets.a.key, before.llmPresets.a.key);
    assert.deepEqual(saved.llmPresets.a.headers, before.llmPresets.a.headers); assert.deepEqual(saved.llmPresets.a.customJSON, before.llmPresets.a.customJSON);
    assert.equal(saved.llmPresets.a.url, before.llmPresets.a.url); assert.equal(saved.embed.key, before.embed.key); assert.equal(saved.embed.enabled, false);
    assert.deepEqual(saved.wmStorageAuthority, before.wmStorageAuthority); assert.deepEqual(saved.migrationPending, before.migrationPending); assert.deepEqual(saved.unknownSibling, before.unknownSibling);
    assert.equal(saved.useLLM, false); assert.equal(saved.rpLongTermLongTtl, 777); assert.equal(saved.injectionBudgetMaxTokens, 1600); assert.equal(f.calls.hostWrites.length, 0);
    fresh = await open(store); assert.equal(fresh.api.MemoryEngine.CONFIG.useLLM, false); assert.equal(fresh.api.MemoryEngine.CONFIG.llmPresets.a.key, before.llmPresets.a.key);
    observations.push({ case: 'sanitized download/preview/merge/fresh init', settingsWrites: f.calls.writes.filter(x => x.key === KEY).length, hostWrites: f.calls.hostWrites.length });
  } finally { fresh?.close(); f.close(); }
});

test('portable new profile is pending with no inherited credentials and malformed files do not write', async () => {
  const store = new Map([[KEY, JSON.stringify(seed())]]), f = await open(store);
  try {
    assert.equal(typeof f.w.LibraSettingsSchema.buildPublicExport, 'function', 'portable allowlist serializer implemented');
    const portable = plain(f.w.LibraSettingsSchema.buildPublicExport(JSON.parse(store.get(KEY))));
    portable.settings.useLLM = true;
    portable.analysis.presets.push({ name: 'new-local', provider: 'ollama', model: 'local-model', requestFormat: 'chat_completions', enabled: true });
    portable.analysis.selectedPreset = 'new-local';
    await selectFile(f, portable); await node(f, '#btn-apply-settings-import').onclick();
    await until(() => node(f, '#settings-transfer-status').dataset.state === 'saved', 'pending-profile import settles');
    const saved = JSON.parse(store.get(KEY)), incoming = saved.llmPresets['new-local'];
    assert.equal(incoming.key, ''); assert.equal(incoming.url, ''); assert.equal(incoming.headers, undefined); assert.equal(incoming.customJSON, undefined);
    assert.equal(incoming.portableConnectionPending, true); assert.equal(incoming.portableNoInheritance, true); assert.equal(saved.useLLM, false); assert.equal(saved.llmDefaultPreset, 'new-local');
    const resolution = f.common.resolveCommonAnalysisPreset({ ...f.api.MemoryEngine.CONFIG, useLLM: true }); assert.equal(resolution.ok, false); assert.equal(resolution.reason, 'selected_preset_unconfigured');
    const before = store.get(KEY), writes = f.calls.writes.length, live = JSON.stringify(f.api.MemoryEngine.CONFIG);
    for (const malformed of ['{', { ...portable, version: 999 }, { ...portable, settings: { ...portable.settings, debug: 'true' } }, { ...portable, settings: { ...portable.settings, wmStorageAuthority: {} } }, { ...portable, analysis: { ...portable.analysis, presets: [{ name: 'x', provider: 'custom', model: 'm', key: 'synthetic-incoming-secret' }] } }, seed()]) {
      await selectFile(f, malformed); assert.equal(f.calls.writes.length, writes); assert.equal(store.get(KEY), before); assert.equal(JSON.stringify(f.api.MemoryEngine.CONFIG), live); assert.equal(node(f, '#btn-apply-settings-import').disabled, true);
    }
    observations.push({ case: 'pending profile/paused gate/malformed-no-write', settingsWrites: f.calls.writes.filter(x => x.key === KEY).length, rejectedMalformedInputs: 6, hostWrites: f.calls.hostWrites.length });
  } finally { f.close(); }
});
test.after(() => { if (process.env.WM_BASIC_CHECKPOINT) fs.writeFileSync(path.join(process.env.WM_BASIC_CHECKPOINT, 'BASIC-SMOKE-OBSERVATIONS.json'), JSON.stringify({ observations, limits: 'Two FEATURE-FIRST nominal/rejected-malformed cases only. No broad privacy review, failure/race matrix, independent review, regression, real host or Full/Min qualification.' }, null, 2) + '\n'); });
