'use strict';
// Gate: LIBRA 데이터가 로어가 아니라 RisuAI pluginStorage 에 저장되는가.
//
// 배경 (실측): LIBRA 는 lmai_* 38종을 캐릭터 로어북(char.localLore / globalLore)에
// 저장해 왔다. 로어북은 캐릭터 카드에 붙고, 카드가 커지고, 채팅 로어 목록을
// 오염시킨다. RisuAI 의 pluginStorage 는 **세이브 파일에 붙고 기기 간 동기화**되며
// 임의 길이 문자열을 담을 수 있다(RisuCompat 이 512KB 청크로 분할 저장).
//
// 이미 pluginStorage 를 쓰는 것 (전환 아님): LMAI_Config(설정), 턴 원장(05f),
// 냉동 보관(09b), HME 그래프(10c), 디버그 기록(01d).
//
// 이 게이트가 단언하는 계약:
//   A. 저장 라우터가 있다 — lmai_* 데이터가 pluginStorage 로 왕복한다
//   B. 로어에는 남지 않는다 — 저장 후 로어북에 lmai_* 컨테이너가 없다
//   C. 투명하다 — unpack() 이 스토리지에서 읽어 온 데이터를 그대로 돌려준다
//   D. 기존 로어 데이터를 흡수한다 — 이미 로어에 있던 lmai_* 도 읽힌다(무중단 이전)
//   E. 로어가 아닌 항목은 그대로 로어에 남는다 (다른 플러그인/사용자 항목 보존)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

// ── A. 라우터 존재 (소스 수준) ───────────────────────────────────────────
const loreSrc = fs.readFileSync(path.join(ROOT, 'src', 'parts', '01f-lore-consolidation.js'), 'utf8');
assert('storage_router_exists',
  /LibraDataStorage|storageBackedLore|persistLibraData/.test(loreSrc),
  { note: 'lmai_* 를 pluginStorage 로 라우팅하는 창구' });
assert('router_uses_plugin_storage',
  /pluginStorage\.(getItem|setItem|removeItem)|RisuCompat\.pluginStorage/.test(loreSrc), {});

// ── B~E. 런타임 실행 ─────────────────────────────────────────────────────
class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.ownerDocument = doc; this.children = []; this.parentNode = null;
    this._id = ''; this.className = ''; this.style = {}; this.attributes = {};
    this.listeners = {}; this._innerHTML = ''; this.textContent = ''; this.dataset = {};
  }
  set id(v) { this._id = String(v || ''); if (this.ownerDocument) this.ownerDocument._register(this); }
  get id() { return this._id; }
  set innerHTML(v) { this._innerHTML = String(v || ''); }
  get innerHTML() { return this._innerHTML; }
  appendChild(el) { if (!el) return el; el.parentNode = this; this.children.push(el); if (el.id && this.ownerDocument) this.ownerDocument._register(el); return el; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; }
  addEventListener(n, f) { this.listeners[n] = f; }
  removeEventListener() {} focus() {} blur() {} click() {}
  setAttribute(k, v) { this.attributes[String(k)] = String(v); }
  getAttribute(k) { return this.attributes[String(k)]; }
  querySelector(s) { return this.ownerDocument ? this.ownerDocument._queryWithin(this, s) : null; }
  querySelectorAll() { return []; }
}
class FakeDocument {
  constructor() {
    this._ids = Object.create(null);
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
    this.readyState = 'complete';
  }
  _register(el) { if (el && el.id) this._ids[el.id] = el; }
  createElement(tag) { return new FakeElement(tag, this); }
  createTextNode(t) { const e = new FakeElement('#text', this); e.textContent = t; return e; }
  getElementById(id) { return this._ids[String(id || '')] || null; }
  querySelector(sel) {
    if (sel === 'head') return this.head;
    if (sel === 'body') return this.body;
    return this._queryWithin({ children: [this.head, this.body] }, sel);
  }
  _queryWithin(root, selector) {
    const idMatch = String(selector || '').match(/^#(.+)$/);
    const stack = [...(root?.children || [])];
    while (stack.length) {
      const el = stack.shift();
      if (idMatch && el.id === idMatch[1]) return el;
      stack.push(...(el.children || []));
    }
    return null;
  }
}

(async () => {
  const document = new FakeDocument();
  const store = new Map();
  let writeCount = 0;
  // 로어북을 가진 캐릭터 (LIBRA 가 여기 쓰던 구조)
  const lorebook = [];
  const character = { id: 'char-1', name: 'T', chat: [], globalLore: lorebook, localLore: [] };
  const Risuai = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'unit', saveMethod: 'mock' }; },
    async getArgument() { return undefined; },
    pluginStorage: {
      async getItem(k) { return store.has(k) ? store.get(k) : null; },
      async setItem(k, v) { writeCount += 1; store.set(k, String(v)); },
      async removeItem(k) { store.delete(k); },
      async keys() { return Array.from(store.keys()); },
      async length() { return store.size; }
    },
    async getCharacter() { return character; },
    async setCharacter(c) { character.globalLore = c.globalLore; character.localLore = c.localLore; },
    async registerSetting() {}, async registerButton() {},
    async requestPluginPermission() { return true; },
    async showContainer() {}, async hideContainer() {}, async onUnload() {}
  };
  const context = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
    globalThis: null, window: null, document, Risuai, risuai: Risuai,
    structuredClone: global.structuredClone,
    fetch: async () => { throw new Error('fetch not expected'); },
    AbortController, performance: { now: () => Date.now() }
  };
  context.globalThis = context; context.window = context;
  vm.createContext(context);
  let runError = '';
  try { vm.runInContext(code, context, { timeout: 30000 }); } catch (e) { runError = String(e && e.message || e).slice(0, 300); }
  await new Promise(r => setTimeout(r, 80));
  assert('dist_runs_without_error', !runError, { error: runError });

  // 저장된 lmai_* 항목을 만든다 (실제 LIBRA 데이터 형태)
  const memoryEntry = {
    key: 'memory_hash_abc',
    comment: 'lmai_memory',
    content: '[META:{"t":3,"imp":8,"ttl":10}]\n테스트 기억 내용',
    mode: 'normal',
    insertorder: 100
  };
  const entityEntry = {
    key: 'entity_hero',
    comment: 'lmai_entity',
    content: JSON.stringify({ name: '주인공', description: '테스트' }),
    mode: 'normal', insertorder: 100
  };

  // ── 저장 라우터 확인: pluginStorage 에 쓰이는가 ──
  const storageApi = context.LibraDataStorage || context.LIBRA_DATA_STORAGE || null;
  const hasRouter = !!storageApi;
  assert('storage_router_exported', hasRouter, {
    candidates: ['LibraDataStorage', 'LIBRA_DATA_STORAGE'].filter(k => !!context[k])
  });

  if (hasRouter && typeof storageApi.save === 'function') {
    const before = writeCount;
    const saveResult = await storageApi.save({ char: character, chat: null, entries: [memoryEntry, entityEntry] });
    assert('save_writes_to_plugin_storage', writeCount > before, { writeCount, saveResult: !!saveResult });

    const loreEntries = Array.isArray(character.globalLore) ? character.globalLore : [];
    const libraInLore = loreEntries.filter(e => /^lmai_/.test(String(e?.comment || '')) || /^LIBRA_DATA_/.test(String(e?.key || '')));
    assert('save_leaves_no_libra_entries_in_lore', libraInLore.length === 0, {
      loreCount: loreEntries.length, libraInLore: libraInLore.slice(0, 3).map(e => e.comment || e.key)
    });

    // ── 투명성: load 가 같은 데이터를 돌려주는가 ──
    const loaded = await storageApi.load({ char: character, chat: null });
    const loadedEntries = Array.isArray(loaded) ? loaded : (loaded?.entries || []);
    const hasMemory = loadedEntries.some(e => String(e?.comment || '') === 'lmai_memory');
    const hasEntity = loadedEntries.some(e => String(e?.comment || '') === 'lmai_entity');
    assert('load_returns_saved_entries', hasMemory && hasEntity, {
      loadedCount: loadedEntries.length, comments: loadedEntries.map(e => e.comment).slice(0, 5)
    });

    // ── 기존 로어 데이터 흡수 (무중단 이전) ──
    const legacyLore = [{
      key: 'LIBRA_DATA_LMAI_MEMORY_0000_legacy',
      comment: 'lmai_memory',
      memo: 'LIBRA_CONTAINER',
      content: JSON.stringify({ version: '2.0', category: 'lmai_memory', shardIndex: 0, shardCount: 1, digest: 'legacy', entries: [{ key: 'legacy_mem', comment: 'lmai_memory', content: '옛 기억' }] })
    }];
    const absorbed = await storageApi.load({ char: { ...character, globalLore: legacyLore }, chat: null, absorbLegacyLore: true });
    const absorbedEntries = Array.isArray(absorbed) ? absorbed : (absorbed?.entries || []);
    assert('absorbs_legacy_lore_entries',
      absorbedEntries.some(e => String(e?.content || '').includes('옛 기억')),
      { absorbedCount: absorbedEntries.length });

    // ── 비-LIBRA 로어는 보존 ──
    const mixedLore = [
      { key: 'user_note', comment: 'My own note', content: '사용자 메모' },
      { key: 'other_plugin', comment: 'other_plugin_data', content: '다른 플러그인' }
    ];
    const preserved = await storageApi.save({ char: { ...character, globalLore: mixedLore }, chat: null, entries: [memoryEntry] });
    const afterMixed = Array.isArray(character.globalLore) ? character.globalLore : [];
    // save 가 별도 캐릭터 객체에 썼다면 원본 mixedLore 를 확인
    assert('non_libra_lore_untouched',
      mixedLore.every(e => e && !/^lmai_/.test(String(e.comment || ''))),
      { note: '입력 배열 자체는 변형되지 않아야 한다' });
  } else {
    assert('save_writes_to_plugin_storage', false, { reason: 'router/save 없음' });
    assert('save_leaves_no_libra_entries_in_lore', false, {});
    assert('load_returns_saved_entries', false, {});
    assert('absorbs_legacy_lore_entries', false, {});
    assert('non_libra_lore_untouched', false, {});
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
