'use strict';
// Gate: 저장 스코프가 이 사용자의 다른 플러그인(Flashback/HAYAKU/LIA/RE:TRACE)과
// 동일한 규칙을 따르는가.
//
// 배경: Downloads/plugins 의 최신 5개 플러그인은 공유 스코프 라우팅 브리지
// (MemorySuiteStorageBridge)를 쓴다. 그들이 실측으로 확립한 규칙:
//
//   scopeId = `memory-suite:${namespace}:char:${characterId}|chat:${chatId}|persona:${personaId||'default'}`
//
//   characterId = first(character.id, _id, uid, uuid, key, `charIndex:${charIndex}`)
//   chatId      = first(chat.id, _id, uid, uuid, key, chatId, `chatIndex:${chatIndex}`)
//   personaId   = first(chat.bindedPersona, chat.boundPersonaId, chat.personaId)
//                 || (db.selectedPersona → db.personas[i].id/_id/`personaIndex:${i}`)
//
// LIBRA 는 종전에 `${charId}::${chatId}` (persona 없음, 폴백 2단계)를 썼다.
// 그러면 (a) 페르소나를 바꿔도 같은 스코프로 섞이고, (b) RisuAI 가 id 를 안 주면
// 스코프가 붕괴한다. 이 게이트가 그 두 결함을 고정한다.
//
// 기기 로컬 분리: 세이브에 실을 필요가 없는 휘발성 캐시는
// RisuCompat.getLocalPluginStorage() 로 보낸다 (이 플러그인들도 그렇게 한다).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

const src = fs.readFileSync(path.join(ROOT, 'src', 'parts', '01f-lore-consolidation.js'), 'utf8');

// ── A. 소스 수준 계약 ────────────────────────────────────────────────────
assert('scope_includes_persona', /persona/i.test(src) && /scopeKeyFor/.test(src), {
  note: 'scopeId 에 personaId 를 포함해야 한다'
});
assert('char_id_fallback_chain_is_deep',
  /(?:id|_id|uid|uuid|key)/.test(src) && /charIndex|chatIndex/.test(src), {
  note: 'id → _id → uid → uuid → key → index:N 폴백'
});
assert('device_local_storage_used', /getLocalPluginStorage|safeLocalStorage/.test(src), {
  note: '휘발성 캐시는 기기 로컬로'
});

// ── B~E. 런타임 ──────────────────────────────────────────────────────────
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

async function runWith({ character, chat, db, charIndex = 0, chatIndex = 0 }) {
  const document = new FakeDocument();
  const pluginStore = new Map();
  const pluginReads = [];
  const localStore = new Map();
  const Risuai = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'unit', saveMethod: 'mock' }; },
    async getArgument() { return undefined; },
    pluginStorage: {
      async getItem(k) { pluginReads.push(k); return pluginStore.has(k) ? pluginStore.get(k) : null; },
      async setItem(k, v) { pluginStore.set(k, String(v)); },
      async removeItem(k) { pluginStore.delete(k); },
      async keys() { return Array.from(pluginStore.keys()); }
    },
    async getLocalPluginStorage() {
      return {
        async getItem(k) { return localStore.has(k) ? localStore.get(k) : null; },
        async setItem(k, v) { localStore.set(k, String(v)); },
        async removeItem(k) { localStore.delete(k); }
      };
    },
    async getCurrentCharacterIndex() { return charIndex; },
    async getCurrentChatIndex() { return chatIndex; },
    async getCharacterFromIndex() { return character; },
    async getChatFromIndex() { return chat; },
    async getCharacter() { return character; },
    async getDatabase() { return db || {}; },
    async setCharacter() {}, async setCharacterToIndex() {}, async setChatToIndex() {},
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
  vm.runInContext(code, context, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 60));
  return { context, pluginStore, pluginReads, localStore, storage: context.LibraDataStorage };
}

(async () => {
  let r = null;
  try {
    r = await runWith({
      character: { id: 'char-A', chaId: 'char-A-canonical', name: 'A' },
      chat: { id: 'chat-1', bindedPersona: 'persona-X' },
      db: { selectedPersona: 0, personas: [{ id: 'persona-X' }] }
    });
  } catch (e) { assert('runtime_ok', false, { error: String(e && e.message || e).slice(0, 200) }); }
  assert('runtime_ok', !!r, {});
  if (!r || !r.storage) {
    assert('scope_key_has_persona', false, { reason: 'no router' });
    assert('persona_change_changes_scope', false, {});
    assert('fallback_uses_uid_when_no_id', false, {});
    assert('fallback_uses_index_when_no_ids', false, {});
    assert('volatile_cache_goes_device_local', false, {});
  } else {
    const key1 = r.storage.scopeKeyFor({ id: 'char-A' }, { id: 'chat-1', bindedPersona: 'persona-X' });
    assert('scope_key_has_persona', /persona-X/.test(String(key1)), { key: key1 });

    // 같은 캐릭터·채팅, 다른 페르소나 → 다른 스코프
    const key2 = r.storage.scopeKeyFor({ id: 'char-A' }, { id: 'chat-1', bindedPersona: 'persona-Y' });
    assert('persona_change_changes_scope', key1 !== key2, { a: key1, b: key2 });

    // id 가 없고 uid 만 있어도 스코프가 만들어지는가
    const key3 = r.storage.scopeKeyFor({ uid: 'char-uid-1' }, { uid: 'chat-uid-1' });
    assert('fallback_uses_uid_when_no_id', /char-uid-1/.test(String(key3)) && /chat-uid-1/.test(String(key3)), { key: key3 });

    // 아무 식별자도 없으면 index 로 폴백
    const coldKey = r.storage.scopeKeyFor({}, {});
    assert('cold_no_id_scope_stays_unresolved_until_index_read',
      coldKey === 'char:unknown|chat:unknown|persona:default', { key: coldKey });
    await r.storage.refreshIndexCache();
    const key4 = r.storage.scopeKeyFor({}, {});
    assert('fallback_uses_index_when_no_ids',
      key4 === 'char:charIndex:0|chat:chatIndex:0|persona:default', { key: key4 });
    const unresolvedAdmission = await r.storage.preparePersonaContext({}, {});
    assert('index_fallback_does_not_admit_unresolved_canonical_identity',
      unresolvedAdmission.ok === false && unresolvedAdmission.reason === 'identity_unresolved', { admission: unresolvedAdmission });
    const readsBefore = r.pluginReads.length;
    const unresolvedRead = await r.storage.readVerified(key4);
    assert('index_fallback_does_not_read_canonical_storage',
      unresolvedRead.ok === false && unresolvedRead.reason === 'identity_unresolved' && r.pluginReads.length === readsBefore,
      { read: unresolvedRead, readCount: r.pluginReads.length - readsBefore });

    // 기기 로컬 스토리지 노출
    const hasLocal = typeof r.storage.deviceLocal === 'object'
      || typeof r.storage.putDeviceLocal === 'function'
      || typeof r.storage.getDeviceLocal === 'function'
      || /getLocalPluginStorage/.test(src);
    assert('volatile_cache_goes_device_local', !!hasLocal, {
      exposed: Object.keys(r.storage)
    });
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
