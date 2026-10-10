'use strict';
// Probe: GUI 세계관 화면이 읽는 노드 필드 vs 08a(정본)가 실제로 만드는 필드를 맞댄다.
//
// 배경: 15b 의 renderWorldDetail / syncWorldKpi 는 node.summary, node.depth,
//       node.revision, node.parentId, node.classification, node.fields 를 읽는다.
//       08a 의 createNode 는 name/layer/parent/children/rules/meta/... 를 만든다.
//       "GUI 가 0 또는 — 를 표시한다" 를 결함으로 단정하기 전에 실행으로 확인한다.
//       (스킬: 판정은 같은 실행 안에서 실제 저장 경로로 한다)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
code = code.slice(0, idx) + '\n    globalThis.__probeHWM = HierarchicalWorldManager;\n' + code.slice(idx);

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
  remove() {}
  addEventListener(n, f) { this.listeners[n] = f; }
  removeEventListener() {} focus() {} blur() {} click() {}
  setAttribute(k, v) { this.attributes[String(k)] = String(v); }
  getAttribute(k) { return this.attributes[String(k)]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
class FakeDocument {
  constructor() { this._ids = Object.create(null); this.head = new FakeElement('head', this); this.body = new FakeElement('body', this); this.readyState = 'complete'; }
  _register(el) { if (el && el.id) this._ids[el.id] = el; }
  createElement(tag) { return new FakeElement(tag, this); }
  createTextNode(t) { const e = new FakeElement('#text', this); e.textContent = t; return e; }
  getElementById(id) { return this._ids[String(id || '')] || null; }
  querySelector(sel) { if (sel === 'head') return this.head; if (sel === 'body') return this.body; return null; }
}

(async () => {
  const document = new FakeDocument();
  const store = new Map();
  const character = { id: 'char-1', chaId: 'char-1', name: 'T', chats: [], globalLore: [] };
  const chat = { id: 'chat-1', localLore: [], message: [], bindedPersona: 'p1' };
  const Risuai = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'unit', saveMethod: 'mock' }; },
    async getArgument() { return undefined; },
    pluginStorage: {
      async getItem(k) { return store.has(k) ? store.get(k) : null; },
      async setItem(k, v) { store.set(k, String(v)); },
      async removeItem(k) { store.delete(k); },
      async keys() { return Array.from(store.keys()); }
    },
    async getLocalPluginStorage() { return { async getItem() { return null; }, async setItem() {}, async removeItem() {} }; },
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
  // 최상위 IIFE 가 async 라, 끝줄의 export 는 부팅(await) 이 끝난 뒤에 실행된다 — 기다리지 않으면 undefined 다.
  await new Promise(r => setTimeout(r, 80));

  const W = context.__probeHWM;
  const out = { run_error: runError || null, gui_field_reads: {} };
  if (!W) { console.log(JSON.stringify({ ok: false, reason: 'no module' })); process.exit(1); }

  const lore = [];
  W.loadWorldGraph(lore, true);            // 기본 root(world_main) 생성
  const root = W.getProfile().rootId;
  const child = W.createNode({ name: '그림자 왕국', layer: 'dimension', parent: root, source: 'probe' });
  W.updateNode(child.node.id, {
    rules: { setting: { places: ['심연의 문', '검은 탑'], organizations: ['야경단'] }, physics: { special_phenomena: ['빛이 사라진다'] } },
    meta: { worldSummary: '빛이 사라진 왕국', classification: 'dark-fantasy' }
  });
  W.changeActivePath(child.node.id, { method: 'probe' });

  // GUI 가 _WLD 를 만드는 방식 그대로 (15a:1613)
  const profile = W.getProfile();
  const _WLD = { nodes: Array.from(profile.nodes.entries()), activePath: [...profile.activePath], rootId: profile.rootId };

  // ── GUI renderWorldDetail 이 읽는 필드 (15b:466~480) ──
  const entry = _WLD.nodes.find(([id]) => String(id) === String(child.node.id));
  const node = entry[1];
  out.gui_field_reads.detail = {
    'node.summary (→요약)': node.summary ?? null,
    'node.depth (→깊이)': node.depth ?? null,
    'node.revision (→T#)': node.revision ?? null,
    'node.parentId (→상위 노드)': node.parentId ?? null,
    'node.classification (→세계 분류)': node.classification ?? null,
    'node.fields 존재?': (node.fields && typeof node.fields === 'object') ? Object.keys(node.fields) : null,
    '"실제 정본에 있는 대응 필드"': {
      'node.meta.worldSummary': node.meta?.worldSummary ?? null,
      'node.meta.classification': node.meta?.classification ?? null,
      'node.parent (parentId 아님)': node.parent ?? null,
      'node.rules.setting.places': node.rules?.setting?.places ?? null,
      'depth 는 어디에도 없음': ('depth' in node) ? '있음' : '없음'
    }
  };

  // ── GUI syncWorldKpi 의 규칙 계수 (15b:520) ──
  let ruleCountGuiStyle = 0;
  _WLD.nodes.forEach(([, n]) => {
    const fields = n?.fields && typeof n.fields === 'object' ? n.fields : {};
    ruleCountGuiStyle += Object.values(fields).reduce((s, v) => s + (Array.isArray(v) ? v.filter(Boolean).length : (v ? 1 : 0)), 0);
  });
  // 정본 rules 로 세면?
  let ruleCountCanon = 0;
  _WLD.nodes.forEach(([, n]) => {
    const r = n?.rules || {};
    const walk = (o) => { let c = 0; for (const v of Object.values(o || {})) { if (Array.isArray(v)) c += v.filter(Boolean).length; else if (v && typeof v === 'object') c += walk(v); else if (v) c += 1; } return c; };
    const settingCount = walk(r.setting) + walk(r.physics) + walk(r.exists) + walk(r.systems);
    ruleCountCanon += settingCount;
  });
  out.gui_field_reads.kpi = {
    'GUI 방식(fields) 규칙 수': ruleCountGuiStyle,
    '정본(rules) 규칙 수': ruleCountCanon,
    '노드 수': _WLD.nodes.length
  };

  // ── 정본이 실제로 담고 있는 것 ──
  out.canon_node_fields = Object.keys(node).sort();
  out.canon_rules_actual = node.rules;
  out.canon_meta_actual = node.meta;

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
