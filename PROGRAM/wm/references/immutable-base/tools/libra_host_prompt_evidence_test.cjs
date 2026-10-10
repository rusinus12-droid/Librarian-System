'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const turnCommitSource = fs.readdirSync(path.join(ROOT, 'src', 'parts'))
  .filter(name => /^05(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => fs.readFileSync(path.join(ROOT, 'src', 'parts', name), 'utf8'))
  .join('');
const maintenanceSource = fs.readdirSync(path.join(ROOT, 'src', 'parts'))
  .filter(name => /^09(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => fs.readFileSync(path.join(ROOT, 'src', 'parts', name), 'utf8'))
  .join('\n');
const guiSource = fs.readdirSync(path.join(ROOT, 'src', 'parts'))
  .filter(name => /^15(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => fs.readFileSync(path.join(ROOT, 'src', 'parts', name), 'utf8'))
  .join('');

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this._id = '';
    this.style = {};
    this.listeners = {};
    this.textContent = '';
  }
  set id(value) { this._id = String(value || ''); if (this.ownerDocument) this.ownerDocument._ids[this._id] = this; }
  get id() { return this._id; }
  set innerHTML(value) { this._innerHTML = String(value || ''); }
  get innerHTML() { return this._innerHTML || ''; }
  appendChild(el) { el.parentNode = this; this.children.push(el); return el; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  querySelector(selector) { return this.ownerDocument?.querySelector(selector) || null; }
}

class FakeDocument {
  constructor() {
    this._ids = Object.create(null);
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
  }
  createElement(tag) { return new FakeElement(tag, this); }
  getElementById(id) { return this._ids[String(id || '')] || null; }
  querySelector(selector) {
    if (selector === 'head') return this.head;
    if (selector === 'body') return this.body;
    const match = String(selector || '').match(/^#(.+)$/);
    return match ? this.getElementById(match[1]) : null;
  }
}

const assertions = [];
const assert = (name, ok, detail = null) => assertions.push({ name, ok: !!ok, detail });

(async () => {
  const document = new FakeDocument();
  const storage = new Map();
  const Risuai = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'unit', saveMethod: 'mock' }; },
    async getArgument(key) { return key === 'activity_dashboard' ? 'off' : undefined; },
    pluginStorage: {
      async getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      async setItem(key, value) { storage.set(key, String(value)); },
      async removeItem(key) { storage.delete(key); }
    },
    async getCharacter() { return null; },
    async registerSetting() {},
    async registerButton() {},
    async requestPluginPermission() { return false; },
    async onUnload() {}
  };
  const context = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
    document, Risuai, risuai: Risuai, structuredClone: global.structuredClone,
    fetch: async () => { throw new Error('fetch not expected'); },
    AbortController, performance: { now: () => Date.now() }, globalThis: null, window: null
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(code, context, { timeout: 30000 });
  await new Promise(resolve => setTimeout(resolve, 50));

  const api = context.LIBRA_HostPromptEvidenceBuffer;
  assert('host_prompt_evidence_api_exported', !!api && typeof api.capture === 'function' && typeof api.formatForAnalysis === 'function');

  const snapshot = api.capture([
    { role: 'system', content: '지유는 검은 머리와 금빛 눈을 지닌 학생이다.' },
    { role: 'system', memo: 'hypaMemory', content: '<Previous Conversation> 지유는 푸딩과 카페에서 만났다. </Previous Conversation>' },
    { role: 'system', content: '화성 우주항의 세관 규정은 매주 변경된다.' },
    { role: 'system', content: '[LIBRA WORLD] lmai_memory self-generated context' },
    { role: 'user', content: '현재 사용자 입력은 캡처 대상이 아니다.' }
  ], { requestSequence: 7, scopeKey: 'chat:test' });

  assert('snapshot_schema_and_bounds', snapshot.schema === 'libra.host_prompt_evidence.v1' && snapshot.records.length === 3 && snapshot.totalChars <= 20000, snapshot);
  assert('libra_self_context_excluded', !snapshot.records.some(record => /LIBRA WORLD|lmai_memory/.test(record.content)), snapshot.records);
  assert('ordinary_user_message_excluded', !snapshot.records.some(record => /현재 사용자 입력/.test(record.content)), snapshot.records);

  const selected = api.formatForAnalysis(snapshot, '지유가 검은 머리를 쓸어 넘기며 푸딩을 바라보았다.', { maxChars: 5000 });
  assert('response_relevant_context_selected', selected.includes('지유는 검은 머리') && selected.includes('카페에서 만났다'), selected);
  assert('unrelated_context_not_selected', !selected.includes('화성 우주항'), selected);

  const unrelated = api.formatForAnalysis(snapshot, '완전히 새로운 바람 소리가 창문을 흔들었다.', { maxChars: 5000 });
  assert('zero_overlap_returns_no_context', unrelated === '', unrelated);
  assert('normal_turn_no_direct_character_source_read', !turnCommitSource.includes('CharacterEntitySourceHintBridge.build(char, chat, entityConversationText'));
  assert('maintenance_no_direct_external_lore_slice', !maintenanceSource.includes('const loreSnippets = MemoryEngine.CONFIG.useLorebookRAG'));
  assert('prompt_declares_validation_only_policy', maintenanceSource.includes('Host Prompt Validation Context is read-only corroboration.'));
  assert('obsolete_auto_reflection_gui_removed', !guiSource.includes('id="ssrchypa"') && !guiSource.includes('id="ssrcmodule"'));

  const output = { ok: assertions.every(item => item.ok), assertions };
  fs.mkdirSync(path.join(ROOT, 'test-output'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'test-output', 'host_prompt_evidence_result.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ok ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
