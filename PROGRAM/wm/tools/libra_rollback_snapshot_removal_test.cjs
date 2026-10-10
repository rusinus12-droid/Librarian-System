'use strict';
// Gate: 엔티티·관계 스냅샷 롤백 기계가 완전히 제거되었는가.
//
// 배경 (실측):
//   captureRollbackSnapshot 은 매 업데이트마다 살아서 스냅샷을 캡처했지만
//   (엔티티 1건 48,402 bytes 중 13,592 bytes = 28.1%), restoreRollbackSnapshot
//   의 유일한 호출자가 **테스트 파일 1개**뿐이었다. 즉 쓰기만 하고 읽지 않는
//   죽은 페이로드가 상주했다. 사용자가 새로 만들기로 했으므로 완전 제거한다.
//
// 제거 대상 (전부):
//   - MAX_ROLLBACK_SNAPSHOTS (08b)
//   - trimRollbackSnapshots / captureRollbackSnapshot / discardRollbackSnapshot
//     / restoreRollbackSnapshot (08b)
//   - 엔티티·관계 캡처 호출 2곳 (08d)
//   - API 노출 (08e) — restoreRollbackSnapshot, discardRollbackSnapshot
//   - target.meta.rollbackSnapshots 필드 자체
//
// 이 게이트가 고정하는 계약:
//   A. dist 에 스냅샷 기계의 심볼이 하나도 없다
//   B. 엔티티·관계 레코드에 meta.rollbackSnapshots 가 생기지 않는다
//   C. 제거 후에도 엔티티·관계 업데이트가 정상 동작한다 (기능 보존)
//   D. 무결성 메타·프로비넌스는 그대로 (다른 기계는 안 건드림)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {installHostProjection,admit}=require('./libra_broad_baseline_host_fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
const DIST = process.env.LIBRA_BROAD_TEST_DIST || path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const code = fs.readFileSync(DIST, 'utf8');
const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

// A. 심볼 부재 (주석 제거 후 스캔 — retired 설명 주석은 허용하지 않음)
const stripped = code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map(line => line.replace(/\/\/.*$/, ''))
  .join('\n');
const SYMBOLS = [
  'MAX_ROLLBACK_SNAPSHOTS',
  'trimRollbackSnapshots',
  'captureRollbackSnapshot',
  'discardRollbackSnapshot',
  'restoreRollbackSnapshot'
];
const found = SYMBOLS.filter(sym => stripped.includes(sym));
assert('no_rollback_snapshot_symbols_in_dist', found.length === 0, { found });

// 문자열 리터럴로 남은 것도 없다 (meta.rollbackSnapshots 같은 필드 접근)
const literalHits = (stripped.match(/rollbackSnapshots/g) || []).length;
assert('no_rollback_snapshots_field_access', literalHits === 0, { literalHits });

class E {
  constructor(t, d) {
    this.tagName = 'DIV'; this.ownerDocument = d; this.children = []; this._id = '';
    this.style = {}; this.attributes = {}; this.listeners = {}; this.dataset = {};
    this.textContent = ''; this._html = '';
  }
  set id(v) { this._id = String(v || ''); if (this.ownerDocument) this.ownerDocument._r(this); }
  get id() { return this._id; }
  set innerHTML(v) { this._html = String(v || ''); }
  get innerHTML() { return this._html; }
  appendChild(e) { if (!e) return e; e.parentNode = this; this.children.push(e); return e; }
  remove() {} addEventListener() {} removeEventListener() {} focus() {} blur() {} click() {}
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  querySelector() { return null; } querySelectorAll() { return []; }
}
class D {
  constructor() { this._ids = {}; this.head = new E('head', this); this.body = new E('body', this); this.readyState = 'complete'; }
  _r(e) { if (e && e.id) this._ids[e.id] = e; }
  createElement(t) { return new E(t, this); }
  createTextNode(t) { const e = new E('#t', this); e.textContent = t; return e; }
  getElementById(i) { return this._ids[String(i || '')] || null; }
  querySelector() { return null; } querySelectorAll() { return []; }
}

(async () => {
  const document = new D();
  const store = new Map();
  const chat = { id: 'chat-1', localLore: [], message: [], msgs: [], bindedPersona: 'p1' };
  const character = { id: 'char-1', chaId: 'char-1', name: 'T', chats: [chat], globalLore: [], lorebook: [] };
  const messages=chat.message;chat.msgs=messages;
  messages.push({role:'user',data:'Create both entity and relation records.',chatId:'u1'},{role:'assistant',data:'Both entities cooperate in this current turn.',chatId:'m1'});
  const R = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'u', saveMethod: 'm' }; },
    async getArgument() { return undefined; },
    pluginStorage: {
      async getItem(k) { return store.has(k) ? store.get(k) : null; },
      async setItem(k, v) { store.set(k, String(v)); return true; },
      async removeItem(k) { store.delete(k); return true; },
      async keys() { return Array.from(store.keys()); }
    },
    async getLocalPluginStorage() {
      const s = { async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; }, async keys() { return []; } };
      return { getStore: () => s, ...s };
    },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacterFromIndex() { return character; },
    async getChatFromIndex() { return chat; },
    async getCharacter() { return character; },
    async getDatabase() { return { selectedPersona: 0, personas: [{ id: 'p1' }] }; },
    async setCharacter() {}, async setCharacterToIndex() {}, async setChatToIndex() {},
    async registerSetting() {}, async registerButton() {},
    async requestPluginPermission() { return true; },
    async showContainer() {}, async hideContainer() {}, async onUnload() {}
  };
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise, Set, Map,
    globalThis: null, window: null, document, Risuai: R, risuai: R,
    structuredClone, fetch: async () => { throw new Error('no fetch'); },
    AbortController, performance: { now: () => Date.now() }
  };
  installHostProjection(R,character,chat,messages);
  ctx.TextEncoder=TextEncoder;ctx.TextDecoder=TextDecoder;
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  // 하네스와 동일하게 exports 스니펫 주입 (플러그인은 자체 export 가 없다).
  const exportSnippet = '\n;globalThis.__LIBRA_EXPORTS__ = {\n'
    + "MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null,\n"
    + "EntityManager: typeof EntityManager !== 'undefined' ? EntityManager : null,\n"
    + 'LibraDataStorage,PersonaRuntimeCoordinator,\n'
    + '};\n';
  const idx = code.lastIndexOf('\n})();');
  const patched = idx < 0 ? code : code.slice(0, idx) + exportSnippet + code.slice(idx);
  let runError = '';
  try { vm.runInContext(patched, ctx, { timeout: 30000 }); } catch (e) { runError = String(e && e.message || e).slice(0, 300); }
  await new Promise(r => setTimeout(r, 80));
  assert('dist_runs_without_error', !runError, { error: runError });

  const EM = ctx.EntityManager || ctx.__LIBRA_EXPORTS__?.EntityManager || null;
  assert('entity_manager_available', !!EM, { hasEntityManager: !!EM });

  if (EM) {
    const beforeAdmission=JSON.stringify([...store]);let unverifiedRejected=false;
    try{await EM.saveToLorebook({id:'char-1'},{id:'chat-1'},[])}catch(error){unverifiedRejected=error.message==='entity_persistence_target_unverified'}
    assert('unadmitted_entity_target_rejected',unverifiedRejected&&JSON.stringify([...store])===beforeAdmission);
    await admit(ctx.__LIBRA_EXPORTS__,character,chat,store);
    // B/D: 엔티티·관계를 업데이트하고 **실제 저장 경로**(saveToLorebook)로 레코드를 만든다.
    const lore = [];
    EM.clearCache?.();
    ctx.__LIBRA_EXPORTS__.MemoryEngine.setTurn(1);
    EM.updateEntity('도현', {
      source: 'structured_packet', s_id: 'sess1', m_id: 'm1',
      identity: { occupation: '관측자' },
      status: { notes: '기록', lastUpdated: 1 }
    }, lore);
    // 관계는 양쪽 엔티티가 캐시에 있어야 한다.
    EM.updateEntity('아리엘', { source: 'structured_packet', s_id: 'sess1', m_id: 'm1', identity: { occupation: '기록관' } }, lore);
    EM.updateRelation('도현', '아리엘', {
      relationType: '조력', source: 'structured_packet', s_id: 'sess1', m_id: 'm1'
    }, lore);
    if (typeof EM.saveToLorebook === 'function') {
      await EM.saveToLorebook(character,chat,lore);
    }
    let ent = lore.find(e => String(e?.comment) === 'lmai_entity');
    const rel = lore.find(e => String(e?.comment) === 'lmai_relation');
    assert('entity_record_created', !!ent, { loreCount: lore.length, comments: lore.map(e => e.comment) });
    if (ent) {
      const obj = JSON.parse(String(ent.content).replace(/^\[META:\{[^\r\n]*\}\]/, '').trim());
      const hasSnapshots = Object.prototype.hasOwnProperty.call(obj?.meta || {}, 'rollbackSnapshots');
      assert('entity_has_no_rollback_snapshots', !hasSnapshots, { metaKeys: Object.keys(obj?.meta || {}).slice(0, 14) });
      assert('entity_record_keeps_shape', !!obj.name, { name: obj.name });
      assert('entity_integrity_preserved', obj?.meta?.integrity?.schema === 'libra.integrity_meta.v1',
        { integrity: obj?.meta?.integrity?.schema });
    }
    // C: 관계 레코드도 정상
    assert('relation_update_still_works', !!rel, { comments: lore.map(e => e.comment) });
    if (rel) {
      const robj = JSON.parse(String(rel.content).replace(/^\[META:\{[^\r\n]*\}\]/, '').trim());
      assert('relation_has_no_rollback_snapshots',
        !Object.prototype.hasOwnProperty.call(robj?.meta || {}, 'rollbackSnapshots'),
        { metaKeys: Object.keys(robj?.meta || {}).slice(0, 14) });
    }
    // API 에서 사라졌는가
    assert('dead_api_removed', typeof EM.restoreRollbackSnapshot !== 'function' && typeof EM.discardRollbackSnapshot !== 'function',
      { restore: typeof EM.restoreRollbackSnapshot, discard: typeof EM.discardRollbackSnapshot });
    assert('live_api_kept', typeof EM.retractRelationTimelineEvents === 'function' && typeof EM.recomputeRelationProjection === 'function',
      { retract: typeof EM.retractRelationTimelineEvents, recompute: typeof EM.recomputeRelationProjection });
  }

  // 크기: 엔티티 레코드가 스냅샷 없이 얼마인가
  if (EM) {
    const lore = [];
    EM.clearCache?.();
    messages.length=0;
    for (let t = 1; t <= 5; t += 1) {
      messages.push({role:'user',data:'Update entity at turn '+t,chatId:'mu'+t},{role:'assistant',data:'Entity update '+t,chatId:'mm'+t});
      ctx.__LIBRA_EXPORTS__.MemoryEngine.setTurn(t);
      EM.updateEntity('미라', {
        source: 'structured_packet', s_id: 'sess1', m_id: 'mm' + t,
        identity: { occupation: '기록관' }, status: { notes: '턴' + t, lastUpdated: t }
      }, lore);
    }
    if (typeof EM.saveToLorebook === 'function') {
      await EM.saveToLorebook(character,chat,lore);
    }
    const e = lore.find(x => String(x?.comment) === 'lmai_entity');
    const bytes = e ? Buffer.byteLength(String(e.content), 'utf8') : 0;
    assert('entity_record_has_no_growth_from_snapshots', bytes > 0 && bytes < 20000, { bytes });
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
