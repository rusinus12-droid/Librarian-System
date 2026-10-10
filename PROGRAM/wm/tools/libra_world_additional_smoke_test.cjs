'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const GUI_PARTS = fs.readdirSync(path.join(ROOT, 'src', 'parts'))
  .filter(name => /^15(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => path.join(ROOT, 'src', 'parts', name));

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function assert(ok, name, details = {}) {
  if (!ok) {
    const e = new Error(`${name} failed: ${JSON.stringify(details)}`);
    e.details = details;
    throw e;
  }
  return { name, ok: true, details };
}

async function loadLibra() {
  const replacers = { beforeRequest: [], afterRequest: [] };
  const scriptHandlers = { output: [], editoutput: [] };
  const bodyInterceptors = [];
  const pluginStorage = new Map();
  const chat = { id: 'wa-smoke-chat', name: 'WA Smoke Chat', localLore: [], msgs: [], message: [], isStreaming: false };
  const char = { id: 'wa-smoke-char', name: 'WA Smoke Character', chatPage: 0, chats: [chat], lorebook: [], description: '루멘 아카데미 테스트 캐릭터.' };
  const database = { personas: [], selectedPersona: null, modules: [], enabledModules: [], moduleIntergration: [], characters: [char] };
  const args = new Map(Object.entries({
    debug: 'false',
    llm_provider: 'custom_openai',
    llm_url: 'http://mock.local/v1/chat/completions',
    llm_key: 'dummy-key',
    llm_model: 'mock-libra-model',
    aux_llm_enabled: 'false',
    embedding_enabled: 'false',
    cold_start_history_limit: '0',
    manual_ooc_pause: 'false',
    world_additional_mode: 'off',
    world_canon_custom_text: '',
    world_canon_custom_force: 'true',
    world_additional_custom_text: '',
    world_additional_custom_force: 'true'
  }));
  const risuai = {
    async getArgument(name) { return args.get(name); },
    async getCharacter() { return clone(char); },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacterFromIndex(index) { return Number(index) === 0 ? clone(char) : null; },
    async getChatFromIndex(charIndex, chatIndex) { return Number(charIndex) === 0 && Number(chatIndex) === 0 ? clone(chat) : null; },
    async setChatToIndex(charIndex, chatIndex, nextChat) { Object.assign(chat, clone(nextChat)); chat.message = chat.msgs || chat.message || []; char.chats[0] = chat; return true; },
    async setCharacter(nextChar) { Object.assign(char, clone(nextChar)); return true; },
    async addRisuReplacer(type, handler) { (replacers[type] || (replacers[type] = [])).push(handler); return true; },
    async removeRisuReplacer(type, handler) { replacers[type] = (replacers[type] || []).filter(h => h !== handler); return true; },
    async addRisuScriptHandler(mode, handler) { (scriptHandlers[mode] || (scriptHandlers[mode] = [])).push(handler); return true; },
    async removeRisuScriptHandler(mode, handler) { scriptHandlers[mode] = (scriptHandlers[mode] || []).filter(h => h !== handler); return true; },
    async registerBodyIntercepter(handler) { const id = `body-${bodyInterceptors.length + 1}`; bodyInterceptors.push({ id, handler }); return id; },
    async unregisterBodyIntercepter() { return true; },
    async onUnload() { return true; },
    async registerSetting() { return true; },
    async registerButton() { return true; },
    async showContainer() { return true; },
    async hideContainer() { return true; },
    async getDatabase(keys) { const out = {}; for (const k of Array.isArray(keys) ? keys : Object.keys(database)) out[k] = clone(database[k]); return out; },
    pluginStorage: {
      async getItem(key) { return pluginStorage.has(key) ? pluginStorage.get(key) : null; },
      async setItem(key, value) { pluginStorage.set(key, value); return true; }
    },
    async nativeFetch() { throw new Error('nativeFetch should not be called in WA smoke test'); },
    async requestPluginPermission() { return true; }
  };

  let code = fs.readFileSync(DIST, 'utf8');
  const exportSnippet = `\n;globalThis.__LIBRA_EXPORTS__ = {\n` +
    `MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null,\n` +
    `MemoryState: typeof MemoryState !== 'undefined' ? MemoryState : null,\n` +
    `WorldAdditionalCore: typeof WorldAdditionalCore !== 'undefined' ? WorldAdditionalCore : null,\n` +
    `TurnMaintenanceOptimizer: typeof TurnMaintenanceOptimizer !== 'undefined' ? TurnMaintenanceOptimizer : null,\n` +
    `LLMProvider: typeof LLMProvider !== 'undefined' ? LLMProvider : null\n` +
    `};\n`;
  const idx = code.lastIndexOf('\n})();');
  if (idx < 0) throw new Error('Could not locate final IIFE close');
  code = code.slice(0, idx) + exportSnippet + code.slice(idx);

  const logs = [];
  const context = {
    console: {
      log: (...a) => logs.push({ level: 'log', msg: a.map(String).join(' ') }),
      warn: (...a) => logs.push({ level: 'warn', msg: a.map(String).join(' ') }),
      error: (...a) => logs.push({ level: 'error', msg: a.map(String).join(' ') }),
      debug: (...a) => logs.push({ level: 'debug', msg: a.map(String).join(' ') })
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance,
    crypto: { randomUUID: crypto.randomUUID },
    AbortController,
    TextEncoder,
    TextDecoder,
    URL,
    fetch: async () => { throw new Error('fetch should not be called in WA smoke test'); },
    risuai,
    Risuai: risuai,
    process: { env: process.env },
    Buffer,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64')
  };
  context.globalThis = context;
  vm.createContext(context);
  const run = vm.runInContext(code, context, { filename: DIST, timeout: 10000 });
  if (run && typeof run.then === 'function') await run;
  await sleep(50);
  return { exports: context.__LIBRA_EXPORTS__, logs, chat, char };
}

async function main() {
  const { exports } = await loadLibra();
  const core = exports.WorldAdditionalCore;
  const engine = exports.MemoryEngine;
  assert(core && typeof core.formatForPrompt === 'function', 'world_additional_core_exported');
  assert(typeof exports.TurnMaintenanceOptimizer?.runWorldAdditionalManual === 'function', 'world_additional_manual_analyzer_exported');
  const guiSource = GUI_PARTS.map(part => fs.readFileSync(part, 'utf8')).join('');
  assert(guiSource.includes('btn-analyze-world-additional') && guiSource.includes('runWorldAdditionalManualAnalysisFromGui'), 'world_additional_manual_gui_bound');
  assert(['entities', 'world', 'active', 'log'].every(tab => guiSource.includes(`data-wa-tab="${tab}"`)), 'world_additional_internal_db_tabs_present');
  assert(guiSource.includes('world-additional-entities') && guiSource.includes('world-additional-world') && !guiSource.includes('world-additional-flow'), 'world_additional_db_views_replace_flow_panel');

  const configOn = {
    ...(engine.CONFIG || {}),
    worldAdditionalEnabled: true,
    worldAdditionalMode: 'firm',
    worldAdditionalMaxPerRequest: 3,
    worldAdditionalAutoIntegrate: true,
    worldCanonCustomText: '',
    worldCanonCustomForce: true,
    worldAdditionalCustomText: '',
    worldAdditionalCustomForce: true
  };
  const earlyCtx = {
    turn: 1,
    userMessage: '초반 조사 임무로 도현은 달그림자 도서관 지하서고에 갔다. 금지 기록 열람 절차를 확인해야 한다.',
    worldPrompt: '루멘 아카데미 / 달그림자 도서관 / 금지 기록 / 학생회 감시망',
    worldStatePrompt: '현재 국면: 초기 조사. 아직 최종 결전은 멀다.',
    narrativePrompt: '초기 조사 단계. 현지 단서와 작은 압력 중심.',
    directorPrompt: '현재 장면 규모는 local/section이다.',
    storyAuthorPrompt: '자연스러운 전개와 현지 조력자/관찰자 우선.',
    focusCharacters: ['도현', '아리엘'],
    loreHints: ['아리엘: 달그림자 도서관 관리자이자 기존 정본 조력자.'],
    memoryHints: ['도현은 아리엘과 금지 기록을 조사하고 있다.']
  };

  const results = [];

  core.resetState();
  const customOnly = core.formatForPrompt(earlyCtx, { ...configOn, worldAdditionalEnabled: false, worldAdditionalMode: 'off', worldCanonCustomText: '리브라 캐논 DB 반영: 지하서고에는 폐쇄 색인실이 존재한다.', worldCanonCustomForce: true, worldAdditionalCustomText: '이 구역에 임무를 도와줄 현지 연락책을 추가한다.', worldAdditionalCustomForce: true });
  results.push(assert(customOnly === '', 'retired_direct_instruction_fields_are_ignored'));

  core.resetState();
  core.upsertDirective({
    type: 'character_addition',
    name: '종말의 군주',
    title: '종말의 군주',
    role: 'final boss',
    description: '초반 조사 중 직접 나타나 도현과 대면한다.',
    directive: '이번 장면에 최종 보스가 직접 등장한다.',
    purpose: '최종 보스 직접 투입',
    sourceBasis: ['달그림자 도서관 초기 조사'],
    activationCondition: '달그림자 도서관 조사 장면',
    noveltyReason: '새로운 강대 적대자',
    noveltyScope: 'unintroduced_new',
    progressionTier: 'final',
    forceLevel: 'hard',
    userImpact: 'soft',
    status: 'armed'
  });
  const finalBossPrompt = core.formatForPrompt(earlyCtx, configOn);
  results.push(assert(!/종말의 군주/.test(finalBossPrompt), 'early_final_boss_direct_injection_blocked'));

  core.resetState();
  core.upsertDirective({
    type: 'character_addition',
    name: '윤서',
    title: '서고 보조 사서 윤서',
    role: 'local helper/contact',
    description: '달그림자 도서관 지하서고의 교대 기록을 아는 아직 등장하지 않은 현지 보조 사서.',
    directive: '도현이 금지 기록 열람 절차를 확인하려 할 때, 윤서가 현지 절차와 단서로 장면을 도와준다.',
    purpose: '임무 장소에 자연스럽게 있는 미등장 현지 조력자 투입',
    sourceBasis: ['달그림자 도서관', '지하서고', '금지 기록 열람 절차'],
    activationCondition: '달그림자 도서관 지하서고 조사 장면',
    noveltyReason: '현재 정본 조력자인 아리엘과 다른 현장 실무 단서가 필요하다.',
    noveltyScope: 'unintroduced_new',
    progressionTier: 'local',
    forceLevel: 'firm',
    userImpact: 'ambient',
    status: 'armed'
  });
  const localPrompt = core.formatForPrompt(earlyCtx, configOn);
  results.push(assert(/서고 보조 사서 윤서/.test(localPrompt) && /current section/.test(localPrompt), 'grounded_unintroduced_local_character_injected'));
  core.ingestMaintenance({ manifestations: [] }, '윤서는 지하서고의 교대 기록을 꺼내며 도현에게 금지 기록 열람 절차의 허점을 알려주었다.', { turn: 2 }, configOn);
  const yun = core.getState().characterAdditions.find(item => item.name === '윤서');
  results.push(assert(yun && yun.status === 'integrated', 'manifested_character_integrated', { status: yun && yun.status }));

  core.resetState();
  core.upsertDirective({
    type: 'character_addition',
    name: '아리엘',
    title: '아리엘',
    role: 'helper',
    description: '이미 정본에 있는 도서관 관리자지만 새 인물처럼 투입하려 한다.',
    directive: '아리엘을 새 인물로 등장시킨다.',
    purpose: '조력자 투입',
    sourceBasis: ['달그림자 도서관'],
    activationCondition: '도서관 조사 장면',
    noveltyReason: '새 인물처럼 사용',
    noveltyScope: 'unintroduced_new',
    progressionTier: 'local',
    forceLevel: 'firm',
    userImpact: 'ambient',
    status: 'armed'
  });
  const knownPrompt = core.formatForPrompt(earlyCtx, configOn);
  results.push(assert(!/Character Addition[\s\S]*아리엘/.test(knownPrompt), 'known_canon_actor_not_reintroduced_as_new'));

  core.resetState();
  core.upsertDirective({
    type: 'world_delta',
    title: '지하서고 교대 기록부',
    description: '달그림자 도서관 지하서고에는 출입 교대 기록부가 있고, 금지 기록 접근자의 흔적을 남긴다.',
    directive: '도서관 조사 장면에서 교대 기록부를 실제 단서로 사용할 수 있게 한다.',
    purpose: '현재 임무 장소에서 자연스럽게 세계관 단서 추가',
    sourceBasis: ['달그림자 도서관', '지하서고', '금지 기록'],
    activationCondition: '달그림자 도서관 지하서고 조사 장면',
    progressionTier: 'local',
    forceLevel: 'firm',
    userImpact: 'none',
    status: 'armed'
  });
  const worldDeltaPrompt = core.formatForPrompt(earlyCtx, configOn);
  results.push(assert(/지하서고 교대 기록부/.test(worldDeltaPrompt), 'grounded_world_delta_injected'));

  console.log(JSON.stringify({ ok: true, assertions: results }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error.message, details: error.details || null, stack: error.stack }, null, 2));
  process.exit(1);
});
