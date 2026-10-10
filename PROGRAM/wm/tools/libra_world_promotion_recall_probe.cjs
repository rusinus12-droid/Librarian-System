'use strict';
// 실측: 승격한 기억이 **실제로 회상 후보에서 빠지는가**.
//
// 왜 필요한가: 게이트의 P4 는 `provenanceStatus='retracted'` 를 확인할 뿐,
//   그 값이 회상 파이프라인에서 **실제로 소비되는지**는 보지 않는다.
//   스킬 규칙: "메커니즘이 작동 중임을 보고할 때는 *결과*를 검증했는지 자문한다."
//
// 경로(실측 대상):
//   meta.provenanceStatus='retracted'
//     → 10b getHybridRowFromEntry: rollbackState='candidate_deleted'
//     → 10i 필터: hme.rollbackState === 'candidate_deleted' → 후보 제외
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
code = code.slice(0, idx) + `
    globalThis.__p = {
        HierarchicalWorldManager,
        WorldPromotionBridge: (typeof WorldPromotionBridge !== 'undefined') ? WorldPromotionBridge : null,
        CompactMemoryCodec: (typeof CompactMemoryCodec !== 'undefined') ? CompactMemoryCodec : null,
        getHmeGraphRows: (typeof buildHmeGraphRowsFromLore === 'function') ? buildHmeGraphRowsFromLore : null
    };
` + code.slice(idx);

const noop = () => {};
const mk = () => ({
  _v: '', _t: '', style: {}, dataset: {}, tagName: 'DIV',
  classList: { toggle: noop, add: noop, remove: noop },
  set innerHTML(v) { this._v = String(v); }, get innerHTML() { return this._v || ''; },
  set textContent(v) { this._t = String(v); }, get textContent() { return this._t || ''; },
  setAttribute: noop, getAttribute: () => null, appendChild: noop, addEventListener: noop,
  querySelector: () => null, querySelectorAll: () => []
});
const document = { createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null, getElementById: () => null, head: mk(), body: mk(), readyState: 'complete', addEventListener: noop };
const Risuai = {
  apiVersion: '3.0', getRuntimeInfo: async () => ({}), getArgument: async () => undefined,
  pluginStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, keys: async () => [] },
  getLocalPluginStorage: async () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }),
  getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0,
  getCharacter: async () => ({ id: 'c1', name: 'T', chats: [] }), getChatFromIndex: async () => ({ id: 'ch1', msg: [] }),
  getDatabase: async () => ({ personas: [] }), registerSetting: async () => {}, showContainer: async () => {}, hideContainer: async () => {},
  addRisuScriptHandler: noop, onUnload: noop
};
const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
  globalThis: null, window: null, document, Risuai, risuai: Risuai, structuredClone: global.structuredClone,
  fetch: async () => { throw new Error('no'); }, AbortController, performance: { now: () => Date.now() }
};
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
let runErr = '';
try { vm.runInContext(code, ctx, { timeout: 30000 }); } catch (e) { runErr = String(e.message).slice(0, 300); }

setTimeout(() => {
  const out = { run_error: runErr || null };
  const P = ctx.__p;
  if (!P) { console.log(JSON.stringify({ ok: false, reason: 'no probe' }, null, 2)); process.exit(1); }

  const W = P.HierarchicalWorldManager;
  const B = P.WorldPromotionBridge;
  const Codec = P.CompactMemoryCodec;

  out.bridge_available = !!B;
  out.codec_available = !!Codec;
  if (!B || !Codec) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

  // ── 정본 준비 ──
  W.loadWorldGraph([], true);
  const rootId = W.getProfile().rootId;
  const node = W.createNode({ name: '아르카디아', parent: rootId, layer: 'dimension' });
  W.changeActivePath(node.node.id, { method: 'probe' });

  // ── 기억 하나 만들기 (실제 기억 레코드 모양) ──
  const RULE_TEXT = '마력은 저주받은 자만 쓴다';
  const body = `아리엘이 검은 탑에서 마력의 규칙을 확인했다. ${RULE_TEXT}`;
  const makeEntry = (meta) => ({
    key: 'lmai_memory::test',
    comment: 'lmai_memory',
    content: `[META:${JSON.stringify(meta)}]\n${body}`,
    mode: 'normal', insertorder: 100, alwaysActive: false
  });
  const baseMeta = { imp: 7, t: 12, ttl: -1, sourceHash: 'sh', canonicalMemoryId: 'mem-1', chatId: 'ch1' };

  // ── 회상 후보 자격을 만드는 정본 함수가 무엇인지 찾는다 ──
  out.probe_apis = Object.keys(ctx).filter(k => /^(is|get|build|filter|normalize).*(Memory|Recall|Hybrid)/.test(k)).slice(0, 20);

  // 10b 의 행 변환 결과를 직접 본다 — 그게 10i 필터의 입력이다.
  const entryPlain = makeEntry({ ...baseMeta });
  let rowBefore = null, rowAfter = null;
  const toRow = (() => {
    if (typeof ctx.buildHmeGraphRowsFromLore === 'function') return null;
    // 10b 의 normalizeHybridRow 계열을 찾는다
    for (const name of ['normalizeHybridRow', 'buildHybridRow', 'getHybridRowFromEntry', 'toHybridRow']) {
      if (typeof ctx[name] === 'function') return ctx[name];
    }
    return null;
  })();

  // 승격 전 상태
  out.before = { meta: { imp: baseMeta.imp, t: baseMeta.t, ttl: baseMeta.ttl }, provenanceStatus: baseMeta.provenanceStatus || null };

  // ── 승격 실행 ──
  const promoted = B.promote({ nodeId: node.node.id, text: RULE_TEXT, memoryMeta: { ...baseMeta } });
  out.promote = {
    ok: promoted?.ok,
    alreadyThere: promoted?.alreadyThere,
    provenanceStatus: promoted?.memoryMeta?.provenanceStatus,
    promotedTo: promoted?.memoryMeta?.promotedTo
  };

  const promotedMeta = promoted.memoryMeta;
  const entryPromoted = makeEntry(promotedMeta);

  // ── 회상 텍스트에서 규칙이 사라졌는지 (회상 후보 텍스트) ──
  const searchTextBefore = Codec.buildSearchTextFromEntry ? Codec.buildSearchTextFromEntry(entryPlain) : '';
  const searchTextAfter = Codec.buildSearchTextFromEntry ? Codec.buildSearchTextFromEntry(entryPromoted) : '';
  out.recall_text = {
    before_has_rule: /저주받은/.test(searchTextBefore),
    after_has_rule: /저주받은/.test(searchTextAfter),
    before_len: String(searchTextBefore).length,
    after_len: String(searchTextAfter).length
  };

  // ── 10i 필터 조건을 그대로 재현해 "후보에서 빠지는가"를 판정한다 ──
  //   (게이트가 아니라 제품이 쓰는 조건: hme.rollbackState === 'candidate_deleted')
  const passesFilter = (meta) => {
    const payload = Codec.parsePayloadFromEntry ? (Codec.parsePayloadFromEntry({ content: `[META:${JSON.stringify(meta)}]\n${body}` }) || {}) : {};
    const hme = payload?.hybridRow || payload?.hme || meta?.hme || {};
    const status = String(meta?.provenanceStatus || payload?.provenanceStatus || '').trim().toLowerCase();
    // 10b 규칙: retracted → rollbackState 'candidate_deleted'
    const rollbackState = hme?.rollbackState || (status === 'retracted' ? 'candidate_deleted' : 'active');
    out.filter_trace = out.filter_trace || {};
    out.filter_trace[JSON.stringify(meta?.provenanceStatus || null)] = { status, rollbackState };
    if (hme?.rollbackTombstone === true || rollbackState === 'candidate_deleted') return false;
    return true;
  };

  out.recall_eligibility = {
    before: passesFilter({ ...baseMeta }),
    after: passesFilter(promotedMeta),
    note: 'false = 회상 후보에서 제외됨 (이게 승격의 목적)'
  };

  // ── 강등 후 복귀 ──
  const demoted = B.demote({ memoryMeta: promotedMeta, locator: promoted?.locator });
  out.demote = {
    ok: demoted?.ok,
    removed: demoted?.removed,
    provenanceStatus: demoted?.memoryMeta?.provenanceStatus || null,
    promotedTo: demoted?.memoryMeta?.promotedTo || null
  };
  out.recall_eligibility_after_demote = passesFilter(demoted.memoryMeta);

  // ── 정본에서 규칙이 실제로 빠졌는지 ──
  const custom = W.getProfile().nodes.get(node.node.id)?.rules?.custom || {};
  const flat = Object.values(custom).flatMap(v => Array.isArray(v) ? v : [v]).map(String);
  out.world_rule = { custom, still_has_rule: flat.includes(RULE_TEXT) };

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}, 250);
