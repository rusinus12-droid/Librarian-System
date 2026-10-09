'use strict';
// Gate: 엔티티·월드그래프·서사·RP-LTM 4개 도메인의 기록 품질.
//
// 기억(memory) 감사와 같은 방식으로 검증한다 — 실제 턴을 돌려 저장된 데이터를 만들고
// 각 도메인이 (1) 오염 없이 (2) 사용자에게 실제로 도달하는지 검사한다.
//
// 배경 (실측 결함):
//   ① RP-LTM: sourceMemoryKeys 에 `-1457614357_[META:{"_"}}` 같은 깨진 키가 저장됐다.
//      getSafeMapKey 산출물(`<hash>_<앞8>_<뒤4>`)을 정규화 없이 저장해, 같은 기억이
//      정상형(`memory_hash:<hash>`)과 깨진형으로 이중 등록됐다.
//      실측: 89개 키 중 20개가 깨진형이고 그 20개가 정상형과 해시가 겹쳤다.
//   ② 서사: storyline.arcKey 가 문장 전체로 오염됐다.
//      `makeNarrativeArcKey` 가 문장을 80자까지 식별자로 변환했다.
//      실측: arcKey = '아리엘은_는_초기_조사와_관련된_..._설명했다' (59자)
//
// 정상으로 확인된 것 (게이트로 고정해 회귀 방지):
//   ③ 월드그래프: ruleMeta 가 unknown/silent 인 것은 **설계**다. LLM 이 exists.magic 을
//      채우지 않으면 마법 규칙을 지어내지 않는다. 그래프의 places/rules/phenomena 는
//      loadWorldGraph 후 formatForPrompt 로 정상 출력된다 (실측 634자).
//   ④ 엔티티: 빈 스키마 필드는 "아직 추출 안 된 정보"이며 formatEntityForPrompt 가
//      채워진 필드만 골라 출력한다 (실측 77자).
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const {installHostProjection,admit,waitForTurn}=require('./libra_broad_baseline_host_fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
const assertions = [];
const runtimeLogs=[];const diagnosticLog=(...args)=>{runtimeLogs.push(args.map(x=>typeof x==='string'?x:x?.stack||x?.message||'').filter(Boolean).join(' '));if(runtimeLogs.length>100)runtimeLogs.shift()};
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

let code = fs.readFileSync(process.env.LIBRA_BROAD_TEST_DIST || path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8')
  .replace('const PENDING_FINALIZE_MIN_MS = 3500;', 'const PENDING_FINALIZE_MIN_MS = 0;')
  .replace('const PENDING_FINALIZE_REQUIRED_MATCHES = 2;', 'const PENDING_FINALIZE_REQUIRED_MATCHES = 1;')
  .replace('const REFRESH_STABILIZE_MS = 2500;', 'const REFRESH_STABILIZE_MS = 0;')
  .replace('const REFRESH_DELETE_BLOCK_MS = 15000;', 'const REFRESH_DELETE_BLOCK_MS = 0;');

const snippet = '\n;globalThis.__LIBRA_EXPORTS__ = {' +
  "\nMemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null," +
  "\nMemoryState: typeof MemoryState !== 'undefined' ? MemoryState : null," +
  "\nLLMProvider: typeof LLMProvider !== 'undefined' ? LLMProvider : null," +
  "\nColdStartManager: typeof ColdStartManager !== 'undefined' ? ColdStartManager : null," +
  "\nEntityManager: typeof EntityManager !== 'undefined' ? EntityManager : null," +
  "\nHierarchicalWorldManager: typeof HierarchicalWorldManager !== 'undefined' ? HierarchicalWorldManager : null," +
  "\nNarrativeTracker: typeof NarrativeTracker !== 'undefined' ? NarrativeTracker : null," +
  "\nRPContinuityCore: typeof RPContinuityCore !== 'undefined' ? RPContinuityCore : null," +
  "\nLibraDataStorage,PersonaRuntimeCoordinator,RisuCompat," +
  "\nCompactMemoryCodec: typeof CompactMemoryCodec !== 'undefined' ? CompactMemoryCodec : null" +
  '\n};\n';
const closeIdx = code.lastIndexOf('\n})();');
if (closeIdx < 0) { console.log(JSON.stringify({ ok: false, reason: 'iife_close_not_found', assertions: [] })); process.exit(1); }
code = code.slice(0, closeIdx) + snippet + code.slice(closeIdx);

const Doc = class { };
class El {
  constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this._id = ''; this.style = {}; this.attributes = {}; this.dataset = {}; this.textContent = ''; this._html = ''; this.value = ''; }
  set id(v) { this._id = String(v || ''); if (this.ownerDocument) this.ownerDocument._r(this); } get id() { return this._id; }
  set innerHTML(v) { this._html = String(v || ''); } get innerHTML() { return this._html; }
  appendChild(e) { return e; } remove() {} focus() {} blur() {} click() {}
  setAttribute(k, v) { this.attributes[k] = String(v); } getAttribute(k) { return this.attributes[k]; }
  querySelector() { return null; } querySelectorAll() { return []; }
  addEventListener() {} removeEventListener() {}
}
class DocImpl {
  constructor() { this._ids = {}; this.head = new El('head', this); this.body = new El('body', this); this.readyState = 'complete'; }
  _r(e) { if (e && e.id) this._ids[e.id] = e; }
  createElement(t) { return new El(t, this); }
  createTextNode(t) { const e = new El('#t', this); e.textContent = t; return e; }
  getElementById(i) { return this._ids[String(i || '')] || null; }
  querySelector() { return null; } querySelectorAll() { return []; }
  addEventListener() {} removeEventListener() {}
}

const document = new DocImpl();
const store = new Map();
const localStore = new Map();
const msgs = [];
const chat = { id: 'chat-dom2', localLore: [], message: msgs, msgs, bindedPersona: 'p1' };
const character = { id: 'char-dom2', chaId: 'char-dom2', name: 'DOM2', chats: [chat], globalLore: [], lorebook: [] };
const replacers = { beforeRequest: [], afterRequest: [] };

const Risuai = {
  apiVersion: '3.0',
  async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'u', saveMethod: 'm' }; },
  async getArgument() { return undefined; },
  pluginStorage: {
    async getItem(k) { return store.has(k) ? store.get(k) : null; },
    async setItem(k, v) { store.set(k, String(v)); return true; },
    async removeItem(k) { store.delete(k); return true; },
    async keys() { return [...store.keys()]; }
  },
  async getLocalPluginStorage() {
    const s = {
      async getItem(k) { return localStore.has(k) ? localStore.get(k) : null; },
      async setItem(k, v) { localStore.set(k, String(v)); return true; },
      async removeItem(k) { localStore.delete(k); return true; },
      async keys() { return [...localStore.keys()]; }
    };
    return { getStore: () => s, ...s };
  },
  async getCurrentCharacterIndex() { return 0; },
  async getCurrentChatIndex() { return 0; },
  async getCharacterFromIndex() { return character; },
  async getChatFromIndex() { return chat; },
  async getCharacter() { return character; },
  async getDatabase() { return { selectedPersona: 0, personas: [{ id: 'p1' }] }; },
  async setCharacter() {},
  async setCharacterToIndex() {},
  async setChatToIndex() {},
  async registerSetting() {},
  async registerButton() {},
  async requestPluginPermission() { return true; },
  async showContainer() {},
  async hideContainer() {},
  async onUnload() {},
  addRisuReplacer(t, fn) { (replacers[t] = replacers[t] || []).push(fn); },
  addRisuScriptHandler() {},
  async unregisterBodyIntercepter() {},
  async registerBodyInterceptor() {},
  async getLocalStorage() { return null; },
  async setLocalStorage() {}
};

const ctx = {
  console: { log:diagnosticLog, warn:diagnosticLog, error:diagnosticLog, debug:diagnosticLog },
  setTimeout, clearTimeout, setInterval, clearInterval,
  URL, // Keep native VM intrinsics; foreign Object/JSON shadowing rejects VM-literal cache identity.
  globalThis: null, window: null, document, Risuai, risuai: Risuai,
  structuredClone,
  fetch: async () => { throw new Error('no network'); },
  AbortController, Buffer, TextEncoder, TextDecoder,
  crypto: { randomUUID: () => 'x' },
  performance: { now: () => Date.now() }
};
installHostProjection(Risuai,character,chat,msgs);
ctx.TextEncoder=TextEncoder;ctx.TextDecoder=TextDecoder;
ctx.globalThis = ctx;
ctx.window = ctx;
vm.createContext(ctx);

const harness = fs.readFileSync(path.join(ROOT, 'tools', 'libra_97_test_harness.cjs'), 'utf8');
const stub = harness.slice(harness.indexOf('function makePair'), harness.indexOf('async function main()'));

(async () => {
  const run = vm.runInContext(code, ctx, { timeout: 30000 });
  if (run && typeof run.then === 'function') await run;


  const E = ctx.__LIBRA_EXPORTS__;
  const engine = E.MemoryEngine;
  const initDeadline=Date.now()+5000;while(!E.MemoryState.isInitialized&&Date.now()<initDeadline)await new Promise(r=>setTimeout(r,10));
  require('node:assert/strict').equal(E.MemoryState.isInitialized,true,'actual native initialization completed');
  if (!engine) { console.log(JSON.stringify({ ok: false, reason: 'engine_missing', assertions: [] })); process.exit(1); }

  const stubFn = new Function('TURN_COUNT', 'crypto', 'return (function(){' + stub + '; return {mockLLMCall,makePair};})()');
  const { mockLLMCall, makePair } = stubFn(97, require('crypto'));
  E.ColdStartManager.check = async () => false;
  const mockCalls=[];
  E.LLMProvider.call = (...args)=>{mockCalls.push(String(args[3]?.label||args[3]?.debugLabel||'mock'));return mockLLMCall(...args)};
  E.LLMProvider.isConfigured = () => true;

  Object.assign(engine.CONFIG, {
    debug: true, activityDashboard: 'off', useLLM: true,
    afterRequestMaintenanceMode: 'foreground', afterRequestForegroundTimeoutMs: 45000, backgroundMaintenanceDelayMs: 0,
    storyAuthorEnabled: true, storyAuthorMode: 'proactive',
    directorEnabled: true, directorMode: 'standard',
    worldAdditionalEnabled: true, worldAdditionalMode: 'firm', worldAdditionalAutoIntegrate: true,
    embed: { ...(engine.CONFIG.embed || {}), enabled: false },
    llm: { ...(engine.CONFIG.llm || {}), provider: 'custom_openai', url: 'http://mock/v1', key: 'k', model: 'm', timeout: 5000, stream: false, maxCompletionTokens: 20000 },
    auxLlm: { ...(engine.CONFIG.auxLlm || {}), enabled: false }
  });

  engine.CONFIG.llmPresets={fixture:{...engine.CONFIG.llm}};engine.CONFIG.llmDefaultPreset='fixture';
  await admit(E,character,chat,store);
  const beforeRequest = replacers.beforeRequest[replacers.beforeRequest.length - 1];
  const afterRequest = replacers.afterRequest[replacers.afterRequest.length - 1];

  const TURNS = 12;
  for (let t = 1; t <= TURNS; t++) {
    const pair = makePair(t);
    // The native user message exists before Risu builds its request; the native
    // assistant is published after the response hook returns its unchanged text.
    msgs.push({ role: 'user', content: pair.user, m_id: 'live-u-' + t, id: 'live-u-' + t, time: Date.now() });
    chat.message = msgs;
    character.chats[0] = chat;
    await beforeRequest({messages:[{ role: 'system', content: 'sys' }, { role: 'user', content: pair.user }],maxContextTokens:128000,maxResponseTokens:4096}, 'model');
    await afterRequest(pair.assistant, 'model');
    msgs.push({ role: 'assistant', content: pair.assistant, m_id: 'live-a-' + t, id: 'live-a-' + t, time: Date.now() + 1 });
    try{await waitForTurn(store,pair.user,pair.assistant)}catch(error){console.error(JSON.stringify({frontierFailure:{turn:t,mockCalls,runtimeLogs,compat:E.RisuCompat.getDiagnostics(),requestStates:Array.from(E.MemoryState.runtimeDebugRequestsByKey.values()),receipts:require('./libra_generation_capture_receipt_fixture.cjs').readLedgerReceipts(store).map(r=>({recordKey:r.recordKey,status:r.status,analysisStatus:r.analysisStatus,deferredReason:r.deferredReason,lastError:r.lastError,analysisError:r.analysisError,resetGeneration:r.resetGeneration}))}}));throw error;}
  }
  await new Promise(r => setTimeout(r, 2000));

  const lore = engine.getLorebook(character, chat) || [];
  const find = (comment) => lore.find(e => String(e.comment || '').trim() === comment);

  // ── ① RP-LTM: sourceMemoryKeys 가 깨지지 않고 중복도 없어야 한다 ──
  const rpEntry = find('lmai_rp_longterm');
  if (rpEntry) {
    let rp = null;
    try { rp = JSON.parse(String(rpEntry.content).replace(/^\[META:\{[^\r\n]*\}\]\s*/, '')); } catch (_) {}
    const keys = Array.isArray(rp?.sourceMemoryKeys) ? rp.sourceMemoryKeys.map(String) : [];
    const broken = keys.filter(k => k.includes('[') || k.includes(']') || k.includes('{'));
    const hashes = keys.map(k => (k.match(/(-?\d+)/) || [])[1]).filter(Boolean);
    const dupHashes = hashes.length - new Set(hashes).size;
    assert('rplongterm_keys_well_formed', broken.length === 0, {
      total: keys.length, broken: broken.length, samples: broken.slice(0, 3)
    });
    assert('rplongterm_keys_not_duplicated', dupHashes === 0, {
      total: keys.length, uniqueHashes: new Set(hashes).size, duplicated: dupHashes
    });
  } else {
    assert('rplongterm_present', false, { reason: 'lmai_rp_longterm 엔트리 없음' });
  }

  // ── ② 서사: arcKey 가 식별자여야 한다 (문장 금지) ──
  const narEntry = find('lmai_narrative');
  if (narEntry) {
    let nar = null;
    const raw = String(narEntry.content);
    const brace = raw.indexOf('{');
    try { nar = JSON.parse(raw.slice(brace)); } catch (_) {}
    const storylines = Array.isArray(nar?.storylines) ? nar.storylines : [];
    const badArc = storylines
      .map(s => String(s?.arcKey || '').trim())
      .filter(k => k && (k.length > 60 || /[.!?。！？]/.test(k) || /(?:은|는|했다|한다)(?:\s|$)/.test(k)));
    assert('narrative_arc_key_is_identifier', badArc.length === 0, {
      storylines: storylines.length, bad: badArc.slice(0, 3),
      arcKeys: storylines.map(s => String(s?.arcKey || '').slice(0, 40))
    });
    const turnLog = Array.isArray(nar?.turnLog) ? nar.turnLog : [];
    assert('narrative_turn_log_recorded', turnLog.length > 0, { count: turnLog.length });
  } else {
    assert('narrative_present', false, { reason: 'lmai_narrative 엔트리 없음' });
  }

  // ── ③ 월드그래프: loadWorldGraph 후 프롬프트에 세계 규칙이 나가야 한다 (회귀 방지) ──
  const wgEntry = find('lmai_world_graph');
  const HM = E.HierarchicalWorldManager;
  if (wgEntry && HM) {
    let prompt = '';
    try {
      HM.loadWorldGraph([{ comment: 'lmai_world_graph', content: String(wgEntry.content) }], true);
      prompt = String(HM.formatForPrompt() || '');
    } catch (_) {}
    const hasStructure = prompt.includes('세계관') || prompt.includes('World');
    const hasRules = prompt.includes('규칙') || prompt.includes('Rules');
    assert('world_graph_emits_to_prompt', prompt.length > 100 && hasStructure && hasRules, {
      promptLength: prompt.length, hasStructure, hasRules, head: prompt.slice(0, 200)
    });
    // ruleMeta 는 LLM 이 채우지 않으면 unknown/silent 가 정상 (지어내지 않음)
    let g = null;
    try { g = JSON.parse(String(wgEntry.content)); } catch (_) {}
    const main = Object.fromEntries(g?.nodes || []).world_main || {};
    const meta = (main?.rules?.ruleMeta?.metaphysics) || {};
    const states = Object.values(meta).map(v => String(v?.state || ''));
    assert('world_graph_rule_meta_explicit', states.every(s => s === 'present' || s === 'absent' || s === 'unknown'), {
      states, note: 'unknown 은 LLM 미판정 시 정상 (규칙을 지어내지 않음)'
    });
  } else {
    assert('world_graph_present', false, { reason: 'lmai_world_graph 없거나 HM 미노출' });
  }

  // ── ④ 엔티티: 프롬프트에 인물이 나가고, 빈 필드는 걸러져야 한다 ──
  const entEntry = find('lmai_entity');
  const EM = E.EntityManager;
  if (entEntry && EM) {
    let ents = [];
    try {
      const raw = String(entEntry.content);
      const json = raw.slice(raw.indexOf('{') >= 0 ? raw.indexOf('{') : 0);
      const first = JSON.parse(json.split(/\n\s*\n/)[0]);
      ents = first ? [first] : [];
    } catch (_) { ents = []; }
    let formatted = '';
    if (ents[0]) {
      try { formatted = String(EM.formatEntityForPrompt(ents[0]) || ''); } catch (_) {}
    }
    assert('entity_emits_to_prompt', formatted.length > 0 && formatted.includes('【'), {
      length: formatted.length, head: formatted.slice(0, 200)
    });
    // 채워진 필드만 나가고 빈 라벨이 나열되지 않아야 한다
    const emptyLabels = ['성격/Personality: ,', '배경/Background: ,', '말투/Speech:'];
    assert('entity_skips_empty_fields', !emptyLabels.some(l => formatted.includes(l)), {
      formatted: formatted.slice(0, 300)
    });
  } else {
    assert('entity_present', false, { reason: 'lmai_entity 없거나 EM 미노출' });
  }

  const failed = assertions.filter(a => !a.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    summary: failed.length === 0
      ? `도메인 기록 품질(엔티티·월드그래프·서사·RP-LTM) ${assertions.length}/${assertions.length}`
      : `실패 ${failed.length}/${assertions.length}`,
    assertions
  }, null, 1));
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(err => {
  console.log(JSON.stringify({ ok: false, reason: String(err?.message || err), stack: String(err?.stack || ''), assertions }, null, 1));
  process.exit(1);
});
