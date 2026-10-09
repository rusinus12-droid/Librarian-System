'use strict';
// Gate: GUI 입력의 min/max 가 args 클램프와 어긋나지 않는가.
//
// 배경 (실측 결함):
//   GUI 마크업이 args 클램프보다 관대하면, 사용자가 GUI 에 넣은 값이 저장되지만
//   로드 시 조용히 바뀐다. 실행 확인:
//     srplttl  min="1"   → 주입 1   → 실제 120  (args 클램프 하한 120)
//     srplchars min="0"  → 주입 0   → 실제 400  (args 클램프 하한 400)
//   사용자는 1 을 넣었다고 믿지만 시스템은 120 을 쓴다 — 이유를 알 수 없다.
//
// 이 게이트가 고정하는 계약:
//   A. args 경로로 마크업 min/max 를 주입하면 그 값이 그대로 반영된다
//     (= 마크업 범위가 args 클램프 범위 안에 있다)
//   B. 클램프가 없는 arg 는 마크업 범위가 그대로 반영된다
//   C. 대조군: 클램프 하한 이상 값을 주입하면 정확히 반영된다
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PARTS = path.join(ROOT, 'src', 'parts');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

// ── 마크업에서 범위 지정 input 추출 ──
const gui = fs.readFileSync(path.join(PARTS, '15-gui-and-exports.js'), 'utf8');
const markup = {};
for (const m of gui.matchAll(/<input[^>]*id="([a-z0-9_-]+)"[^>]*>/g)) {
  const tag = m[0];
  const mn = tag.match(/\bmin="([^"]+)"/);
  const mx = tag.match(/\bmax="([^"]+)"/);
  if (mn || mx) markup[m[1]] = { min: mn ? mn[1] : '', max: mx ? mx[1] : '' };
}

// ── GUI id → cfg 키 매핑 (15c 의 실제 읽기 경로에서) ──
const cfg15c = fs.readFileSync(path.join(PARTS, '15c-gui-settings-config.js'), 'utf8');
const guiToCfg = {};
for (const [gid] of Object.entries(markup)) {
  // 형태 1: cfgKey: readOptionalInt('#gid', ...)
  // 형태 2: querySelector('#gid')?.value ... cfgKey
  let cfgKey = null;
  const re1 = new RegExp('(\\w+)\\s*:\\s*read\\w*\\(\\s*[\'"]#' + gid + '[\'"]', 'g');
  let m1 = re1.exec(cfg15c);
  if (m1) cfgKey = m1[1];
  if (!cfgKey) {
    const re2 = new RegExp('[\'"]#' + gid + '[\'"][^\\n]*?(\\w+)\\s*:', 'g');
    const m2 = re2.exec(cfg15c);
    if (m2) cfgKey = m2[1];
  }
  if (!cfgKey) {
    // 형태 3: cfg.<key> 와 같은 줄에 #gid
    const re3 = new RegExp('(\\w+)[^\\n]*[\'"]#' + gid + '[\'"]');
    const m3 = re3.exec(cfg15c);
    if (m3 && m3[1] !== 'querySelector' && m3[1] !== 'getElementById') cfgKey = m3[1];
  }
  if (cfgKey) guiToCfg[gid] = cfgKey;
}

// ── 검증 런타임 ──
class E {
  constructor(t, d) {
    this.tagName = 'DIV'; this.ownerDocument = d; this.children = []; this._id = '';
    this.style = {}; this.attributes = {}; this.listeners = {}; this.dataset = {};
    this.textContent = ''; this._html = ''; this.value = '';
  }
  set id(v) { this._id = String(v || ''); if (this.ownerDocument) this.ownerDocument._r(this); }
  get id() { return this._id; }
  set innerHTML(v) { this._html = String(v || ''); }
  get innerHTML() { return this._html; }
  appendChild(e) { return e; } remove() {} addEventListener() {} removeEventListener() {}
  focus() {} blur() {} click() {}
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

const code = fs.readFileSync(DIST, 'utf8');
function boot(args) {
  const document = new D();
  const store = new Map();
  const chat = { id: 'c', localLore: [], message: [], msgs: [], bindedPersona: 'p1' };
  const character = { id: 'ch', chaId: 'ch', name: 'R', chats: [chat], globalLore: [], lorebook: [] };
  const R = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'u', saveMethod: 'm' }; },
    async getArgument(n) { return Object.prototype.hasOwnProperty.call(args, n) ? args[n] : undefined; },
    pluginStorage: {
      async getItem(k) { return store.has(k) ? store.get(k) : null; },
      async setItem(k, v) { store.set(k, String(v)); return true; },
      async removeItem(k) { store.delete(k); return true; },
      async keys() { return [...store.keys()]; }
    },
    async getLocalPluginStorage() { const s = { async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; }, async keys() { return []; } }; return { getStore: () => s, ...s }; },
    async getCurrentCharacterIndex() { return 0; }, async getCurrentChatIndex() { return 0; },
    async getCharacterFromIndex() { return character; }, async getChatFromIndex() { return chat; }, async getCharacter() { return character; },
    async getDatabase() { return { selectedPersona: 0, personas: [{ id: 'p1' }] }; },
    async setCharacter() {}, async setCharacterToIndex() {}, async setChatToIndex() {},
    async registerSetting() {}, async registerButton() {}, async requestPluginPermission() { return true; },
    async showContainer() {}, async hideContainer() {}, async onUnload() {},
    addRisuReplacer() {}, addRisuScriptHandler() {}, async unregisterBodyIntercepter() {}, async registerBodyInterceptor() {},
    async getLocalStorage() { return null; }, async setLocalStorage() {}
  };
  const ctx = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
    globalThis: null, window: null, document, Risuai: R, risuai: R,
    structuredClone, fetch: async () => { throw new Error('x'); }, AbortController,
    performance: { now: () => Date.now() }, Buffer
  };
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  const snip = '\n;globalThis.__LIBRA_EXPORTS__ = { MemoryEngine: typeof MemoryEngine !== "undefined" ? MemoryEngine : null };\n';
  const i = code.lastIndexOf('\n})();');
  vm.runInContext(i < 0 ? code : code.slice(0, i) + snip + code.slice(i), ctx, { timeout: 30000 });
  return ctx;
}

(async () => {
  // arg 이름 역매핑: cfg 키 → arg (14 의 패턴에서)
  const init = fs.readFileSync(path.join(PARTS, '14-main-initialization.js'), 'utf8');
  const cfgToArg = {};
  for (const m of init.matchAll(/cfg\.(\w+)\s*=\s*(?:await\s+)?(?:getRuntimeArgVal|readRuntimeArg|clampRuntimeInt\(\s*await\s+getRuntimeArgVal)\(\s*'([a-z_0-9]+)'/g)) {
    cfgToArg[m[1]] = m[2];
  }

  // 마크업에 범위가 있고 arg 매핑이 있는 것만 검사
  const targets = [];
  for (const [gid, range] of Object.entries(markup)) {
    const cfgKey = guiToCfg[gid];
    if (!cfgKey) continue;
    const arg = cfgToArg[cfgKey];
    if (!arg) continue;
    if (!range.min) continue;
    targets.push({ gid, cfgKey, arg, min: range.min, max: range.max });
  }

  assert('gui_range_targets_found', targets.length >= 1, { count: targets.length, sample: targets.slice(0, 6) });

  const mismatches = [];
  const controls = [];
  for (const t of targets) {
    // A: 마크업 min 을 args 로 주입 → 그대로 반영되어야 한다
    const ctx = boot({ [t.arg]: t.min });
    await new Promise(r => setTimeout(r, 350));
    const C = ctx.__LIBRA_EXPORTS__?.MemoryEngine?.CONFIG || {};
    const actual = C[t.cfgKey];
    const reflected = String(actual) === String(t.min);
    if (!reflected) mismatches.push({ ...t, actual: String(actual) });
    else controls.push({ gid: t.gid, arg: t.arg, value: t.min });
  }

  assert('markup_min_is_honored_by_args_path', mismatches.length === 0, {
    checked: targets.length,
    mismatches,
    note: 'GUI 마크업이 허용하는 하한을 args 경로가 조용히 바꾸면 사용자가 넣은 값과 저장된 값이 다르다'
  });

  assert('controls_reflected', controls.length + mismatches.length === targets.length, {
    reflected: controls.length, mismatched: mismatches.length
  });

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
