'use strict';
// 실측: HME 조화안 B — HME 그래프가 세계 정본에서 규칙을 읽는가.
//
// 전: 10c 가 기억 경유(payload.world.ruleHighlights)로만 읽었다 → 5단계 후 그게 비어 HME 가 세계 규칙을 잃었다.
// 후: 정본(08a)에서 직접 읽는다. 정본이 비면 레거시(기억)로 되돌아간다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const i = code.lastIndexOf('\n})();');
code = code.slice(0, i) + `
    globalThis.__p = { HierarchicalWorldManager, buildHmeGraphRowSignals: (typeof buildHmeGraphRowSignals === 'function' ? buildHmeGraphRowSignals : null) };
` + code.slice(i);

const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
  globalThis: null, window: null, structuredClone: global.structuredClone, crypto,
  document: {
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, children: [] }),
    head: { appendChild() {} }, body: { appendChild() {} },
    querySelector: () => null, getElementById: () => null, readyState: 'complete'
  },
  Risuai: {
    apiVersion: '3.0', getRuntimeInfo: async () => ({}), getArgument: async () => undefined,
    pluginStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, keys: async () => [] },
    getLocalPluginStorage: async () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }),
    getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0,
    getCharacter: async () => ({}), getChatFromIndex: async () => ({ msg: [] }), getDatabase: async () => ({ personas: [] }),
    registerSetting: async () => {}, showContainer: async () => {}, hideContainer: async () => {}
  },
  fetch: async () => { throw new Error('no'); }, AbortController, performance: { now: () => Date.now() }
};
ctx.risuai = ctx.Risuai; ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
let runErr = '';
try { vm.runInContext(code, ctx, { timeout: 30000 }); } catch (e) { runErr = String(e.message); }

setTimeout(() => {
  const out = { run_error: runErr || null };
  const P = ctx.__p;
  if (!P) { console.log(JSON.stringify({ ok: false, reason: 'no probe' }, null, 2)); process.exit(1); }
  const W = P.HierarchicalWorldManager;
  // 10c 는 IIFE 지역이라 함수를 직접 꺼낼 수 없다 — 정본 리더만 노출돼 있다.
  // (buildHmeGraphRowSignals 는 10d:46 이 부르는 내부 함수다.)
  const readCanon = ctx.__libraReadWorldCanonSignals || null;

  W.loadWorldGraph([], true);
  const root = W.getProfile().rootId;
  const b = W.createNode({ name: '검은 탑', parent: root, layer: 'dimension' });
  const c = W.createNode({ name: '북부 변경', parent: root, layer: 'dimension' });
  W.updateNode(b.node.id, { rules: { exists: { magic: true }, setting: { places: ['검은 탑'] } } });
  W.updateNode(c.node.id, { rules: { physics: { special_phenomena: ['혹한'] } } });
  W.changeActivePath(b.node.id, { method: 'probe' });
  W.setActiveNodes([b.node.id, c.node.id]);

  out.canon_rules = W.getCurrentRules();
  out.active_nodes = W.getActiveNodes();

  if (typeof readCanon !== 'function') {
    out.note = '정본 리더 미노출 — 소스 계약으로 판정한다';
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  // ── 정본이 있으면 거기서 읽는다 ──
  const canon = readCanon();
  out.from_canon = {
    raw: canon,
    ruleHighlights: canon?.ruleHighlights,
    signature: canon?.signature,
    has_rules: Array.isArray(canon?.ruleHighlights) && canon.ruleHighlights.length > 0,
    has_signature: Array.isArray(canon?.signature) && canon.signature.length > 0,
    has_magic: (canon?.ruleHighlights || []).some(x => /마법|Magic/i.test(String(x))),
    has_hyeonsang: (canon?.ruleHighlights || []).some(x => /혹한/.test(String(x)))
  };

  // ── 정본이 바뀌면 다시 읽는가 (캐시 키) ──
  const canonBefore = JSON.stringify(readCanon()?.ruleHighlights);
  W.updateNode(b.node.id, { rules: { exists: { magic: true }, setting: { places: ['검은 탑', '왕도'] } } });
  const canonAfter = JSON.stringify(readCanon()?.ruleHighlights);
  out.cache_invalidation = { before: canonBefore, after: canonAfter, changed: canonBefore !== canonAfter };

  // ── 정본이 비면 null (레거시로 되돌아가는 조건) ──
  W.loadWorldGraph([], true);
  const emptyCanon = readCanon();
  out.canon_empty = {
    raw: emptyCanon,
    is_empty: !emptyCanon || (emptyCanon.ruleHighlights || []).length === 0,
    note: '정본이 비면 소비처가 레거시(payload.world)로 되돌아간다'
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}, 200);
