'use strict';
// 재측정: ID 충돌 수정 후, 위치별 규칙이 실제로 분리되는가.
//
// 앞선 "한 덩어리로 섞인다" 관측은 **ID 충돌 버그 시절**의 측정이었다
// (3갈래가 같은 ID 로 덮어써져 규칙이 한 노드에 합쳐졌다). 수정 후 다시 잰다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const i = code.lastIndexOf('\n})();');
code = code.slice(0, i) + '\n    globalThis.__p = { HierarchicalWorldManager };\n' + code.slice(i);

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
  const W = ctx.__p.HierarchicalWorldManager;
  W.loadWorldGraph([], true);
  const root = W.getProfile().rootId;

  const a = W.createNode({ name: '왕도', parent: root, layer: 'dimension' });
  const b = W.createNode({ name: '검은 탑', parent: root, layer: 'dimension' });
  const c = W.createNode({ name: '북부 변경', parent: root, layer: 'dimension' });
  out.ids = { root, 왕도: a.node.id, 검은탑: b.node.id, 북부변경: c.node.id };
  out.ids_unique = new Set([root, a.node.id, b.node.id, c.node.id]).size;

  W.updateNode(a.node.id, { rules: { setting: { places: ['왕도 광장'] } } });
  W.updateNode(b.node.id, { rules: { exists: { magic: true }, setting: { places: ['검은 탑'] } } });
  W.updateNode(c.node.id, { rules: { physics: { special_phenomena: ['혹한'] }, setting: { places: ['북부 변경'] } } });

  // 각 위치의 유효 규칙 (독립 계산)
  const eff = {};
  for (const [k, id] of Object.entries({ 왕도: a.node.id, 검은탑: b.node.id, 북부변경: c.node.id })) {
    const r = W.getEffectiveRules(id);
    eff[k] = {
      magic: r?.exists?.magic ?? null,
      places: r?.setting?.places ?? null,
      phenomena: r?.physics?.special_phenomena ?? null
    };
  }
  out.per_location_effective = eff;
  out.rules_are_separate = (() => {
    const vals = Object.values(eff);
    const magicSet = new Set(vals.map(v => JSON.stringify(v.magic)));
    const phenSet = new Set(vals.map(v => JSON.stringify(v.phenomena)));
    return magicSet.size > 1 && phenSet.size > 1;
  })();

  // 단일 activePath 로 주입하면 무엇이 나가나
  W.changeActivePath(c.node.id, { method: 'probe' });
  const promptOne = String(W.formatForPrompt() || '');
  out.prompt_activePath_북부변경 = promptOne;

  out.diagnosis = {
    question: '"규칙이 한 덩어리로 섞인다"가 지금도 사실인가',
    still_merged: /검은 탑/.test(promptOne) && /혹한/.test(promptOne),
    note: 'ID 충돌이 고쳐졌으므로 규칙은 노드별로 분리돼 있다(per_location_effective 확인). 주입은 활성 경로 1곳만 낸다.'
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}, 200);
