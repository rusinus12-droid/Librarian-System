'use strict';
// LIBRA quick connect flow with mocked providers: renders, connects, saves only
// after every requested test passes, and leaves settings untouched on failure.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const L = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const slice = (a, b) => { const i = L.indexOf(a), j = L.indexOf(b, i + a.length); assert(i >= 0 && j > i, `${a}/${b}`); return L.slice(i, j); };
const source = slice('  const LIBRA_QUICK_KEY_PATTERNS =', '  const buildApprovedMockupSettingsPanel =');

const makeContext = ({ llmOk = true, embedOk = true, models = ['gpt-5.4-mini', 'gpt-5.4'] } = {}) => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>');
  const document = dom.window.document;
  const log = { saved: 0, embedSaved: null, status: [], llmTests: [], embedTests: [] };
  const guiEl = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === 'class') node.className = value; else if (key === 'text') node.textContent = value;
      else if (key === 'value') node.value = value == null ? '' : String(value); else if (key === 'checked') node.checked = !!value;
      else if (key === 'disabled') node.disabled = !!value; else if (key === 'dataset') Object.assign(node.dataset, value || {});
      else if (key === 'onClick') node.addEventListener('click', value); else if (key === 'onInput') node.addEventListener('input', value);
      else if (value !== false && value != null && typeof value !== 'function') node.setAttribute(key, String(value));
    }
    for (const child of [].concat(children)) if (child != null) node.append(child.nodeType ? child : String(child));
    return node;
  };
  const embedConfig = { enabled: true, provider: 'voyageai', model: 'voyage-4-lite', url: 'https://api.voyageai.com/v1/embeddings', key: '' };
  const capabilities = { openai: { label: 'OpenAI', defaultUrl: 'https://api.openai.com/v1/embeddings', models: ['text-embedding-3-small'], batchSize: 8 },
    voyageai: { label: 'Voyage AI', defaultUrl: 'https://api.voyageai.com/v1/embeddings', models: ['voyage-4-lite'], batchSize: 8 },
  };
  const Gui = { state: { providers: { 'RisuAI 보조 모델': { provider: 'risuai_aux' } }, runtime: { defaultPresetName: '' } }, app: document.getElementById('app'), visible: true };
  const storage = new Map();
  const c = vm.createContext({
    document, Gui, guiEl, log,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    LibraAttention: { opening: false }, bindApprovedOverlayKeyboard: () => {},
    fieldNode: (label, control, note = '') => guiEl('div', { class: 'field' }, [guiEl('label', { text: label }), control, note ? guiEl('small', { text: note }) : null]),
    guiAsArray: value => Array.isArray(value) ? value : [],
    canonicalProvider: value => String(value || '').toLowerCase(),
    providerDisplayLabel: value => ({ openai: 'OpenAI', risuai_aux: 'RisuAI 보조 모델' })[value] || String(value || ''),
    providerChoices: () => [['openai', 'OpenAI'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['custom', 'Custom'], ['risuai_aux', 'RisuAI']],
    RISUAI_AUX_PRESET_NAME: 'RisuAI 보조 모델', RISUAI_AUX_PROVIDER: 'risuai_aux',
    normalizeProviderPresetBindingName: value => String(value || ''),
    presetDisplayName: name => name, presetModelDisplay: preset => preset?.model || '',
    defaultUrlForProvider: provider => `https://${provider}.example/v1`,
    sanitizePreset: raw => ({ ...raw }), stableDraftHash: value => String(value).length.toString(16).padStart(24, '0'),
    uniquePresetName: base => base,
    listProviderModels: async () => models.map(id => ({ id })),
    testProviderPreset: async preset => { log.llmTests.push(preset); return llmOk ? { ok: true } : { ok: false, reason: 'HTTP 401' }; },
    markGuiDirty: () => {}, saveGuiState: async () => { log.saved += 1; return true; },
    guiSetStatus: message => log.status.push(message), queueGuiRender: () => {},
    selectNode: (value, items) => guiEl('select', {}, items.map(([v, label]) => guiEl('option', { value: v, text: label }))),
    LibraProviderBridge: { peekConfig: () => ({ embed: embedConfig }) },
    EmbeddingProviderRegistry: {
      normalizeConfig: cfg => ({ ...cfg }), getCapabilities: provider => capabilities[provider] || { label: provider, models: [] },
      validateConfig: cfg => ({ ok: !!cfg.key, missing: cfg.key ? [] : ['API Key'] })
    },
    LibraMemoryCore: {
      state: {},
      testEmbeddingConnection: async patch => { log.embedTests.push(patch); return embedOk ? { ok: true } : { ok: false, error: 'HTTP 401' }; },
      saveEmbeddingSettings: async patch => { log.embedSaved = patch; Object.assign(embedConfig, patch); return patch; }
    }
  });
  vm.runInContext(source + '\nObject.assign(globalThis,{runLibraQuickConnect,buildLibraQuickConnectBody,buildLibraQuickConnectCard,libraQuickConnectState,libraEmbeddingStatusSummary,openLibraQuickConnectDialog,maybeOpenLibraFirstSetup});', c);
  return c;
};
const card = c => (title, desc, children) => c.guiEl('div', { class: 'card' }, [c.guiEl('h2', { text: title }), ...children]);

(async () => {
  // Renders with an unusable default embedding shown honestly.
  {
    const c = makeContext();
    const node = c.buildLibraQuickConnectBody();
    const textContent = node.textContent;
    assert.match(c.buildLibraQuickConnectCard({ card: card(c) }).textContent, /빠른 연결 열기…/, 'settings pages show a compact card');
    assert.match(textContent, /RisuAI 보조 모델 · 따로 설정하지 않아도 동작합니다/);
    assert.match(textContent, /설정 안 됨 · 키워드 검색만 사용 \(API Key\)/);
    assert.match(textContent, /키를 붙여넣으면 제공자를 자동으로 알아냅니다/);
  }
  // One OpenAI key: generation preset + embedding, both tested before saving.
  {
    const c = makeContext();
    Object.assign(c.libraQuickConnectState(), { key: 'sk-proj-abc' });
    const summary = await c.runLibraQuickConnect();
    assert.match(summary, /기억 분석 AI: OpenAI · gpt-5.4-mini/);
    assert.match(summary, /임베딩: OpenAI · text-embedding-3-small/);
    const preset = c.Gui.state.providers['OpenAI 빠른 연결'];
    assert.equal(preset.model, 'gpt-5.4-mini'); assert.equal(preset.key, 'sk-proj-abc');
    assert.equal(c.Gui.state.runtime.defaultPresetName, 'OpenAI 빠른 연결');
    assert.equal(c.log.saved, 1);
    assert.equal(c.log.embedSaved.provider, 'openai'); assert.equal(c.log.embedSaved.key, 'sk-proj-abc');
    assert.equal(c.libraQuickConnectState().key, '', 'the key is not kept in the form after saving');
    assert.equal(c.libraEmbeddingStatusSummary().state, 'ready');
  }
  // Embedding test fails → nothing is saved, not even the passing generation preset.
  {
    const c = makeContext({ embedOk: false });
    Object.assign(c.libraQuickConnectState(), { key: 'sk-proj-abc' });
    await assert.rejects(c.runLibraQuickConnect(), /임베딩 연결 실패 · HTTP 401/);
    assert.equal(c.log.saved, 0); assert.equal(c.log.embedSaved, null);
    assert.equal(c.Gui.state.providers['OpenAI 빠른 연결'], undefined);
  }
  // Voyage key: embedding only; generation stays on RisuAI's auxiliary model.
  {
    const c = makeContext();
    Object.assign(c.libraQuickConnectState(), { key: 'pa-abc' });
    const summary = await c.runLibraQuickConnect();
    assert.doesNotMatch(summary, /기억 분석 AI/);
    assert.equal(c.log.llmTests.length, 0); assert.equal(c.log.saved, 0);
    assert.equal(c.log.embedSaved.provider, 'voyageai');
    assert.equal(c.Gui.state.runtime.defaultPresetName, '');
  }
  // No recognizable model → asks for one instead of guessing.
  {
    const c = makeContext({ models: ['some-model'] });
    Object.assign(c.libraQuickConnectState(), { key: 'sk-proj-abc', useEmbed: false });
    await assert.rejects(c.runLibraQuickConnect(), /모델 이름을 입력해 주세요/);
  }
  // Unknown key without a provider choice.
  {
    const c = makeContext();
    Object.assign(c.libraQuickConnectState(), { key: 'xyz' });
    await assert.rejects(c.runLibraQuickConnect(), /제공자를 직접 골라 주세요/);
  }
  // First setup popup: opens once while embedding is unusable, never again after closing.
  {
    const c = makeContext();
    assert.equal(c.maybeOpenLibraFirstSetup(), true);
    const dialog = c.Gui.app.querySelector('[data-libra-quick-dialog]');
    assert.ok(dialog, 'popup opened');
    assert.match(dialog.textContent, /LIBRA 시작하기/);
    assert.match(dialog.textContent, /나중에 하기/);
    [...dialog.querySelectorAll('button')].find(button => button.textContent === '나중에 하기').click();
    assert.equal(c.Gui.app.querySelector('[data-libra-quick-dialog]'), null, 'closed');
    assert.equal(c.maybeOpenLibraFirstSetup(), false, 'shown only once');
  }
  // Already configured embedding: no popup.
  {
    const c = makeContext();
    Object.assign(c.libraQuickConnectState(), { key: 'pa-abc' });
    await c.runLibraQuickConnect();
    assert.equal(c.maybeOpenLibraFirstSetup(), false);
    assert.equal(c.Gui.app.querySelector('[data-libra-quick-dialog]'), null);
  }
  // Not while the attention button is opening another screen.
  {
    const c = makeContext();
    c.LibraAttention.opening = true;
    assert.equal(c.maybeOpenLibraFirstSetup(), false);
  }
  console.log('PASS libra_quick_connect_flow_test');
})().catch(error => { console.error(error); process.exit(1); });
