'use strict';
// Gate: @arg 설명의 "(default N)" 주장이 실제 기본 CONFIG 와 일치하는가.
//
// 배경 (실측 결함):
//   `threshold` 가 "(default 4)" 라고 주장했지만 실제 기본값은 2 였다.
//   `sim_threshold` 는 "(default 0.2)" 주장 vs 실제 0.10.
//   `gc_batch_size` 는 "(default 200)" 주장 vs 실제 16.
//   원인은 그 숫자들이 **프리셋(memory_preset=sim_medium 등)의 값**이었기 때문이다.
//   기본 프리셋은 'custom' 이라 프리셋이 적용되지 않으므로, args 화면의 안내가
//   실제 동작과 다르다.
//
// 이 게이트가 고정하는 계약:
//   A. @arg 의 "(default N)" 은 아무 arg 도 주지 않은 런타임의 실제 CONFIG 값과 같다
//   B. 단, "memory_preset overrides" 같은 조건부 표기는 별도로 취급한다
//   C. 불일치가 있으면 어느 arg 가 주장/실제 다른지 보고한다
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PARTS = path.join(ROOT, 'src', 'parts');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

// ── @arg 의 default 주장 수집 ──
const shell = fs.readFileSync(path.join(PARTS, '00-plugin-shell-and-args.js'), 'utf8');
const claims = {};
for (const m of shell.matchAll(/^\/\/@arg\s+(\S+)\s+(\S+)\s+(.*)$/gm)) {
  const name = m[1], types = m[2], desc = m[3];
  const dm = desc.match(/\(default\s+([^;)）]+)/);
  if (!dm) continue;
  let value = dm[1].trim();
  // 조건부 표기는 제외 (프리셋이 덮어쓰거나 provider 기본)
  const conditional = /overrides|provider default|leaves/i.test(desc);
  claims[name] = { value, conditional, desc: desc.slice(0, 80) };
}

// ── arg → cfg 키 매핑 (14 의 실제 읽기 경로에서) ──
const init = fs.readFileSync(path.join(PARTS, '14-main-initialization.js'), 'utf8');
const argToCfg = {};
// 형태 1: cfg.X = ...getRuntimeArgVal('arg'...  /  readRuntimeArg('arg')  /  clampRuntimeInt(await getRuntimeArgVal('arg'...
for (const m of init.matchAll(/cfg\.(\w+)\s*=\s*(?:await\s+)?(?:getRuntimeArgVal|readRuntimeArg|clampRuntimeInt\(\s*await\s+getRuntimeArgVal)\(\s*'([a-z_0-9]+)'/g)) {
  argToCfg[m[2]] = m[1];
}
// 형태 2: cfg.X = clampRuntimeInt(await getVal('cfgKey', 'arg', 'number', ...), ...)
for (const m of init.matchAll(/cfg\.(\w+)\s*=\s*(?:await\s+)?(?:getRuntimeArgVal|clampRuntimeInt\(\s*await\s+getVal|getVal)\(\s*'\w+'\s*,\s*'([a-z_0-9]+)'/g)) {
  argToCfg[m[2]] = m[1];
}
// 형태 3: cfg.X = await getVal('X', 'arg', ...)  — 이미 위에서 처리
// 형태 4: 리소스 계열은 clampRuntimeInt(await getVal('cfgKey', 'arg', ...)) 안쪽
for (const m of init.matchAll(/cfg\.(\w+)\s*=\s*clampRuntimeInt\(\s*await\s+getVal\(\s*'(\w+)'\s*,\s*'([a-z_0-9]+)'/g)) {
  argToCfg[m[3]] = m[2];
}

// ── 실제 기본 CONFIG 획득 ──
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

(async () => {
  const code = fs.readFileSync(DIST, 'utf8');
  const document = new D();
  const store = new Map();
  const chat = { id: 'c', localLore: [], message: [], msgs: [], bindedPersona: 'p1' };
  const character = { id: 'ch', chaId: 'ch', name: 'D', chats: [chat], globalLore: [], lorebook: [] };
  const R = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'u', saveMethod: 'm' }; },
    async getArgument() { return undefined; },   // 아무 arg 도 주지 않는다
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
  await new Promise(r => setTimeout(r, 400));
  const CONFIG = ctx.__LIBRA_EXPORTS__?.MemoryEngine?.CONFIG || {};

  assert('default_config_loaded', Object.keys(CONFIG).length > 50, { keys: Object.keys(CONFIG).length });

  // 매핑 커버리지: 건너뜀의 대부분이 "no cfg mapping" 이면 게이트가 무력하다
  const mappedClaims = Object.entries(claims).filter(([arg]) => argToCfg[arg]).length;
  assert('mapping_coverage_sufficient', mappedClaims >= 10, {
    totalClaims: Object.keys(claims).length,
    mapped: mappedClaims,
    argToCfgSample: Object.entries(argToCfg).slice(0, 8)
  });

  // ── 대조 ──
  const checked = [];
  const mismatches = [];
  const skipped = [];
  for (const [arg, claim] of Object.entries(claims)) {
    if (claim.conditional) { skipped.push({ arg, reason: 'conditional wording', claim: claim.value }); continue; }
    const cfgKey = argToCfg[arg];
    if (!cfgKey) { skipped.push({ arg, reason: 'no cfg mapping' }); continue; }
    if (!Object.prototype.hasOwnProperty.call(CONFIG, cfgKey)) {
      skipped.push({ arg, reason: 'cfg key absent in CONFIG', cfgKey });
      continue;
    }
    const actual = CONFIG[cfgKey];
    // 단위 표기 (예: '96MB') 처리
    let expected = claim.value;
    let ok;
    if (/^\d+MB$/i.test(expected)) {
      ok = Number(actual) === parseInt(expected, 10) * 1024 * 1024;
    } else if (/^[\d.]+$/.test(expected)) {
      ok = String(actual) === String(expected);
    } else {
      skipped.push({ arg, reason: 'non-numeric default wording', claim: expected });
      continue;
    }
    const row = { arg, cfgKey, claimed: claim.value, actual: String(actual) };
    checked.push(row);
    if (!ok) mismatches.push(row);
  }

  assert('documented_defaults_match_runtime', mismatches.length === 0, {
    checked: checked.length,
    mismatches,
    skippedCount: skipped.length,
    note: 'args 화면의 (default N) 이 실제 기본 CONFIG 와 다르면 사용자가 잘못된 기대를 한다'
  });

  assert('coverage_reported', true, {
    totalClaims: Object.keys(claims).length,
    checked: checked.length,
    skipped: skipped.slice(0, 10)
  });

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
