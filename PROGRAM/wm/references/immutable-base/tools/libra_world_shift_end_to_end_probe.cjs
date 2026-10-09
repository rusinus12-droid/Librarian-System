'use strict';
// 실측: 실모델이 실제로 낸 world 출력이 세계 노드를 만드는가 (계약 → 소비 전체 연결).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const i = code.lastIndexOf('\n})();');
code = code.slice(0, i) + `
    globalThis.__p = { HierarchicalWorldManager, resolveStructuredWorldMutationPolicy, classifyNarrativeTurnChannel };
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
  if (!P) { console.log(JSON.stringify({ ok: false }, null, 2)); process.exit(1); }
  const W = P.HierarchicalWorldManager;
  W.loadWorldGraph([], true);

  // 실모델(qwen3.5:9b)이 실제로 낸 world 출력 그대로
  const modelWorld = {
    classification: { primary: 'fantasy' },
    state: { location: '아르카디아', time: '정신을 차린 직후' },
    setting: { places: ['아르카디아'] },
    dimensionalShifts: [{ from: '사용자 이전 세계', to: '아르카디아', type: '고대 유적의 제단 의식' }]
  };
  const policy = P.resolveStructuredWorldMutationPolicy(modelWorld);
  const ch = P.classifyNarrativeTurnChannel('나는 고대 유적의 제단에 손을 얹었다. 빛이 터지더니 눈앞이 바뀌었다.', '정신을 차렸을 때 나는 다른 세계에 서 있었다. 하늘에는 두 개의 달이 떠 있고.');
  out.before = { nodes: W.getProfile().nodes.size, activePath: W.getProfile().activePath };
  out.channel = ch.channel;
  out.policy = policy;

  if (ch.channel === 'scene' && policy.allowDimensionalShift) {
    for (const s of modelWorld.dimensionalShifts) {
      const name = String(s.to || s.target || s.world || '').trim();
      let n = null;
      for (const [, node] of W.getProfile().nodes) {
        const nm = String(node?.name || '').trim();
        if (nm && (nm === name || nm.includes(name) || name.includes(nm))) { n = node; break; }
      }
      if (!n) {
        const r = W.createNode({ name, layer: 'dimension', parent: W.getProfile().rootId, source: 'llm_structured_world_payload' });
        if (r.success) n = r.node;
      }
      if (n) W.changeActivePath(n.id, { method: String(s.type || 'llm_structured') });
    }
  }
  out.after = { nodes: W.getProfile().nodes.size, activePath: W.getProfile().activePath };
  out.node_created = W.getProfile().nodes.size > out.before.nodes;
  const tree = [];
  const walk = (id, d) => { const n = W.getProfile().nodes.get(id); if (!n) return; tree.push('  '.repeat(d) + n.name); (n.children || []).forEach(c => walk(c, d + 1)); };
  walk(W.getProfile().rootId, 0);
  out.tree = tree;
  out.injected_prompt = String(W.formatForPrompt() || '');

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}, 200);
