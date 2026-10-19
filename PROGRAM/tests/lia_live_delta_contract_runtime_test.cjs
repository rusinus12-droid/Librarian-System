'use strict';

// Exercise the real non-strict Ollama transport, admission, commit and GUI.
// Only host HTTP is intercepted; no provider or validation function is replaced.
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createFixture } = require('./fixtures/lia_native_runtime_fixture.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const hashText = value => {
  const text = String(value || ''); let hash = 2166136261;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `${(hash >>> 0).toString(36)}-${text.length}`;
};
const state = value => ({ key: 'rescue-goal', category: 'goal', value, durability: 'persistent', confidence: 90, evidence: ['Explicit USER rescue goal'] });
const valid = { summary: 'Rescue remains unresolved', liveState: [state('Rescue Brin before dawn')], coreCandidates: [], ignoredTransient: [] };
const durable = f => JSON.stringify([...f.values].filter(([key]) => /liaPersonaLinkerLivePersona|liaPersonaLinkerPersonaProof/.test(key)).sort(([a], [b]) => a.localeCompare(b)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(test, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (test()) return; await sleep(20); }
  throw Error('Timed out: ' + label);
}

(async () => {
  let response = valid, openUI, requests = 0, storageKey;
  const expose = source => {
    const anchor = '      getLiveSyncCaptureState:';
    assert.ok(source.includes(anchor));
    const instrumented = source.replace(anchor, '      runDeltaContractManual: () => runManualLivePersonaAnalysis(),\n' + anchor);
    return process.env.LIA_DELTA_MIN === '1'
      ? require('terser').minify_sync(instrumented, { compress: { defaults: true, unsafe: false, passes: 3 }, mangle: { toplevel: true, properties: false } }).code
      : instrumented;
  };
  const f = await createFixture('official', { transformSource: expose, configureApi(api, { values }) {
    storageKey = [...values.keys()].find(key => key.startsWith('liaPersonaLinkerLivePersonaScopeV2::'));
    const binding = JSON.parse(values.get(storageKey));
    binding.liveState = [state('Existing unresolved rescue goal')];
    values.set(storageKey, JSON.stringify(binding));
    const index = JSON.parse(values.get('liaPersonaLinkerLivePersonaIndexV2'));
    index.entries[binding.scopeKey].digest = hashText(values.get(storageKey));
    values.set('liaPersonaLinkerLivePersonaIndexV2', JSON.stringify(index));
    values.set('dynamicPersonaLorebookGeneratorLLMConfig', JSON.stringify({ provider: 'ollama_cloud', endpoint: 'https://fixture.invalid/v1/chat/completions', model: 'fixture-model', apiKey: 'fixture-key', maxCompletionTokens: 8192 }));
    api.registerSetting = async (_name, callback) => { openUI = callback; return true; };
    api.nativeFetch = async (url, init) => {
      assert.equal(String(url), 'https://fixture.invalid/v1/chat/completions', 'only intercepted fixture HTTP is allowed');
      requests++;
      const body = JSON.parse(init.body);
      assert.equal(body.response_format.type, 'json_object', 'test the non-strict provider route');
      const prompt = body.messages.map(row => typeof row.content === 'string' ? row.content : JSON.stringify(row.content)).join('\n');
      assert.match(prompt, /liveState and coreCandidates must be arrays/);
      assert.match(prompt, /"liveState":\{"type":"array"/);
      assert.match(prompt, /"required":\["key","category","value","durability","confidence","evidence"\]/);
      const content = typeof response === 'string' ? response : JSON.stringify(response);
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  } });
  let dom;
  const cases = [];
  try {
    const invalid = [];
    const change = (name, edit) => { const value = clone(valid); edit(value); invalid.push({ name, value }); };
    invalid.push({ name: 'real-model category object and missing summary', value: { liveState: { currentGoals: ['Rescue Brin'], injuries: ['Fractured wrist'] }, coreCandidates: [], ignoredTransient: [] } });
    invalid.push({ name: 'non-JSON response', value: 'not JSON' });
    invalid.push({ name: 'non-object root', value: [] });
    change('missing summary', value => delete value.summary);
    change('wrong summary type', value => value.summary = []);
    for (const field of ['liveState', 'coreCandidates', 'ignoredTransient']) {
      change('missing ' + field, value => delete value[field]);
      change('object instead of ' + field, value => value[field] = {});
      change('null instead of ' + field, value => value[field] = null);
    }
    change('mixed valid and invalid states', value => value.liveState.push({ category: 'goal' }));
    change('null state', value => value.liveState = [null]);
    for (const field of ['key', 'category', 'value', 'durability', 'confidence', 'evidence']) change('missing state ' + field, value => delete value.liveState[0][field]);
    change('object state value', value => value.liveState[0].value = { text: 'Rescue Brin' });
    change('blank state value', value => value.liveState[0].value = '   ');
    change('unknown durability', value => value.liveState[0].durability = 'permanent');
    for (const confidence of [-1, 101, 90.5, '90']) change('invalid confidence ' + JSON.stringify(confidence), value => value.liveState[0].confidence = confidence);
    change('non-array evidence', value => value.liveState[0].evidence = 'user');
    change('non-string evidence item', value => value.liveState[0].evidence = [{}]);
    change('state overflow', value => value.liveState = Array.from({ length: 25 }, (_, i) => ({ ...state('Goal ' + i), key: 'goal-' + i })));
    const core = { field: 'motivation', value: 'Protect family', confidence: 90, authority: 'user', evidence: ['Explicit USER commitment'], rationale: 'Repeated commitment' };
    for (const field of Object.keys(core)) change('missing core ' + field, value => { value.coreCandidates = [clone(core)]; delete value.coreCandidates[0][field]; });
    change('invalid core authority', value => value.coreCandidates = [{ ...core, authority: 'model' }]);
    change('invalid core confidence', value => value.coreCandidates = [{ ...core, confidence: 101 }]);
    change('invalid core evidence', value => value.coreCandidates = [{ ...core, evidence: 'user' }]);
    change('invalid core rationale', value => value.coreCandidates = [{ ...core, rationale: {} }]);
    change('mixed valid and invalid core', value => value.coreCandidates = [core, null]);
    change('core overflow', value => value.coreCandidates = Array.from({ length: 13 }, () => clone(core)));
    change('invalid ignored item', value => value.ignoredTransient = [{}]);
    for (const item of invalid) {
      response = item.value;
      const before = { durable: durable(f), personas: JSON.stringify(f.db.personas), chat: JSON.stringify(f.liveChat), requests };
      await assert.rejects(f.runtime.runDeltaContractManual(), error => error.code === 'LIA_LIVE_DELTA_INVALID', item.name);
      assert.equal(durable(f), before.durable, item.name + ': preserve the exact owner ledger and completed range');
      assert.equal(JSON.stringify(f.db.personas), before.personas, item.name + ': preserve Persona DB');
      assert.equal(JSON.stringify(f.liveChat), before.chat, item.name + ': preserve chat');
      assert.equal(requests, before.requests + 1, item.name + ': no automatic semantic repair/retry');
      cases.push(item.name);
    }

    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.invalid/', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
    const w = dom.window;
    w.HTMLElement.prototype.scrollIntoView = function () {};
    if (!w.CSS) w.CSS = {};
    if (!w.CSS.escape) w.CSS.escape = text => String(text).replace(/[^a-zA-Z0-9_-]/g, char => '\\' + char);
    for (const name of ['document', 'window', 'navigator', 'location', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'MutationObserver', 'DOMParser', 'FileReader', 'Image', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'CSS', 'SVGElement', 'DocumentFragment', 'HTMLTemplateElement']) {
      if (w[name] !== undefined) f.context[name] = typeof w[name] === 'function' && /^[a-z]/.test(name) ? w[name].bind(w) : w[name];
    }
    await openUI();
    response = { ...clone(valid), liveState: { goals: ['Rescue Brin'] } };
    const beforeError = durable(f), personasBeforeError = JSON.stringify(f.db.personas);
    w.document.getElementById('upd-go').click();
    await waitFor(() => w.document.getElementById('dpg-status')?.dataset.tone === 'error', 'GUI rejection');
    assert.match(w.document.getElementById('dpg-status').textContent, /기존 상태와 처리 범위는 변경하지 않았습니다/);
    assert.equal(durable(f), beforeError); assert.equal(JSON.stringify(f.db.personas), personasBeforeError);
    assert.equal(JSON.parse(f.values.get(storageKey)).lastProcessedPairCount, 0);
    assert.equal(w.document.getElementById('upd-go').disabled, false, 'same range remains retryable');
    cases.push('GUI rejects malformed output while preserving state and retryable range');

    response = { ...clone(valid), coreCandidates: [clone(core)] };
    w.document.getElementById('upd-go').click();
    await waitFor(() => /분석·반영했습니다/.test(w.document.getElementById('dpg-status')?.textContent || ''), 'GUI retry succeeds');
    const accepted = JSON.parse(f.values.get(storageKey));
    assert.equal(accepted.lastProcessedPairCount, 5); assert.equal(accepted.ledgers.length, 1);
    assert.deepEqual(accepted.liveState, valid.liveState);
    assert.ok(Object.values(accepted.coreCandidateHistory).some(row => row.field === core.field && row.value === core.value), 'valid core candidates remain in advisory history');
    assert.deepEqual(accepted.coreOverlay, [], 'conservative policy does not promote a valid advisory candidate automatically');
    assert.match(w.document.getElementById('live-persona-state').textContent, /Rescue Brin before dawn/);
    assert.match(f.db.personas.find(row => row.id === accepted.livePersonaId).personaPrompt, /Rescue Brin before dawn/);
    cases.push('explicit retry of the same five pairs commits valid state and refreshes GUI');

    for (let i = 6; i <= 10; i++) f.liveChat.message.push({ role: 'user', is_user: true, chatId: 'u' + i, data: 'The rescue goal has been resolved.' }, { role: 'assistant', is_user: false, chatId: 'a' + i, data: 'Brin is safe.' });
    response = { summary: 'Rescue resolved', liveState: [], coreCandidates: [], ignoredTransient: [] };
    const cleared = await f.runtime.runDeltaContractManual();
    assert.equal(cleared.ok, true);
    const binding = JSON.parse(f.values.get(storageKey));
    assert.equal(binding.lastProcessedPairCount, 10); assert.equal(binding.ledgers.length, 2); assert.deepEqual(binding.liveState, []);
    assert.doesNotMatch(f.db.personas.find(row => row.id === binding.livePersonaId).personaPrompt, /Rescue Brin before dawn/);
    cases.push('valid empty state deliberately clears resolved state and advances one batch');
    console.log(JSON.stringify({ test: 'lia_live_delta_contract_runtime', minified: process.env.LIA_DELTA_MIN === '1', passed: cases.length, modelStubRequests: requests, externalModelCalls: 0, cases }, null, 2));
  } finally { await f.dispose(); dom?.window.close(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
