'use strict';
// LIBRA quick connect: one pasted key → provider, recommended model, embedding.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const L = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const slice = (a, b) => { const i = L.indexOf(a), j = L.indexOf(b, i + a.length); assert(i >= 0 && j > i, `${a}/${b}`); return L.slice(i, j); };
const c = vm.createContext({
  guiAsArray: value => Array.isArray(value) ? value : [],
  canonicalProvider: value => String(value || '').toLowerCase(),
  providerDisplayLabel: value => String(value || ''),
  providerChoices: () => [['openai', 'OpenAI'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['openrouter', 'OpenRouter'], ['deepseek', 'DeepSeek'], ['custom', 'Custom']]
});
vm.runInContext(slice('  const LIBRA_QUICK_KEY_PATTERNS =', '  const libraQuickConnectState =')
  + '\nObject.assign(globalThis,{detectLibraKeyProvider,libraQuickProviderTargets,pickLibraRecommendedModel});', c);
const plain = value => JSON.parse(JSON.stringify(value));

// Key prefixes → generation and/or embedding provider.
assert.deepEqual(plain(c.detectLibraKeyProvider('sk-ant-api03-abc')), { llm: 'claude', embed: '', label: 'Claude / Anthropic', detected: true });
assert.equal(c.detectLibraKeyProvider('sk-proj-abc').embed, 'openai');
assert.equal(c.detectLibraKeyProvider('sk-or-v1-abc').llm, 'openrouter');
assert.equal(c.detectLibraKeyProvider('AIzaSyD1234567890abcdefghijklmn').embed, 'gemini');
assert.deepEqual(plain(c.detectLibraKeyProvider('pa-abc')), { llm: '', embed: 'voyageai', label: 'Voyage AI', detected: true });
assert.equal(c.detectLibraKeyProvider('sk-0123456789abcdef0123456789abcdef').llm, 'deepseek');
assert.equal(c.detectLibraKeyProvider('Bearer sk-ant-x').llm, 'claude', 'a pasted Bearer prefix is ignored');
assert.equal(c.detectLibraKeyProvider('random-key').detected, false);
// Manual provider choice overrides detection.
assert.deepEqual(plain(c.libraQuickProviderTargets('voyageai', 'whatever')), { llm: '', embed: 'voyageai', label: 'Voyage AI', detected: true });
assert.equal(c.libraQuickProviderTargets('claude', '').llm, 'claude');
assert.equal(c.libraQuickProviderTargets('custom', '').llm, '', 'custom needs the full editor');

// Recommended models: fast/inexpensive families, newest version, no preview/audio variants.
assert.equal(c.pickLibraRecommendedModel('openai', ['gpt-4o', 'gpt-4.1-mini', 'gpt-5.4-mini', 'gpt-5.4-mini-audio-preview', 'gpt-5.4', 'text-embedding-3-small']), 'gpt-5.4-mini');
assert.equal(c.pickLibraRecommendedModel('claude', ['claude-opus-4-1', 'claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'claude-3-5-haiku-20241022']), 'claude-haiku-4-5');
assert.equal(c.pickLibraRecommendedModel('gemini', ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.0-flash', 'gemini-3.0-flash-lite', 'gemini-3.0-flash-preview', 'gemini-embedding-001']), 'gemini-3.0-flash');
assert.equal(c.pickLibraRecommendedModel('deepseek', ['deepseek-reasoner', 'deepseek-chat']), 'deepseek-chat');
assert.equal(c.pickLibraRecommendedModel('kimi', ['kimi-k3']), '', 'unknown families ask the user');

// Wiring: a compact card on both connection pages opens the quick connect popup,
// the popup opens itself once on first LIBRA open, and the memory summary is honest.
assert.ok(L.includes("buildLibraQuickConnectCard({card}),\n        card('생성 AI 프리셋',"), 'AI page shows quick connect first');
assert.ok(L.includes("buildLibraQuickConnectCard({card}),\n          card('임베딩',"), 'embedding page shows quick connect first');
assert.ok(L.includes("if (typeof maybeOpenLibraFirstSetup === 'function') await maybeOpenLibraFirstSetup();"), 'first setup popup is offered when the window opens');
assert.ok(!/Ollama로 무료 임베딩|runLibraQuickOllama/.test(L), 'local Ollama shortcut removed');
assert.ok(L.includes("'임베딩 미설정'") && L.includes('키워드 검색만 사용 중'), 'memory summary no longer shows an unusable default as configured');
// Nothing is saved before every requested test passes.
const flow = slice('  const runLibraQuickConnect = async () => {', '  const libraQuickConnectStatusRows =');
assert.ok(flow.indexOf('testProviderPreset(preset)') < flow.indexOf('Gui.state.providers[name] = llm.preset'));
assert.ok(flow.indexOf('testEmbeddingConnection(patch)') < flow.indexOf('await persistStructuredSettingsState(payload,'));
console.log('PASS libra_quick_connect_test');
