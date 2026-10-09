'use strict';
// Gate: User DLC 생성 미리보기(승인 단계).
//
// 배경 (실측): runUserDlcWorldAnalysisFromGui 는 LLM 분석 결과를 받은 즉시
// saveLoreToChar 로 DB 에 커밋했다. 사용자가 결과를 보기 전에 저장되므로,
// 잘못 적응된 요소를 되돌리려면 삭제해야 했다. conflicted 판정 인프라는 이미
// 있으므로 "승인 단계"만 추가하면 된다.
//
// 이 게이트가 단언하는 계약:
//   1) 분석과 저장이 분리된다 (미리보기 API 가 저장 없이 결과를 돌려준다)
//   2) 미리보기 결과에 승인에 필요한 정보가 담긴다 (항목·충돌·근거)
//   3) 승인 전에는 로어가 변하지 않는다 (DB 무변경)
//   4) 승인하면 그때 저장되고, 취소하면 아무것도 남지 않는다
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');

function assert(name, ok, details = {}) { return { name, ok: !!ok, details }; }

async function boot() {
  const pluginStorage = new Map();
  const chat = { id: 'prev-chat', name: 'Preview', localLore: [], msgs: [], message: [] };
  const char = { id: 'prev-char', name: 'Preview Char', chatPage: 0, chats: [chat], lorebook: [], description: 'preview.' };
  const args = new Map(Object.entries({
    debug: 'false',
    llm_provider: 'custom_openai',
    llm_url: 'http://mock.local/v1/chat/completions',
    llm_key: 'k', llm_model: 'm',
    embedding_enabled: 'false',
    activity_dashboard: 'off'
  }));
  const risuai = {
    apiVersion: '3.0-test',
    async getRuntimeInfo() { return { apiVersion: '3.0-test', platform: 'node-test', saveMethod: 'mock' }; },
    async getArgument(n) { return args.get(n); },
    async requestPluginPermission() { return true; },
    async getCharacter() { return JSON.parse(JSON.stringify(char)); },
    async getCurrentCharacterIndex() { return 0; },
    async getCharacterFromIndex() { return JSON.parse(JSON.stringify(char)); },
    async getChatFromIndex() { return JSON.parse(JSON.stringify(chat)); },
    async setChatToIndex(_a, _b, n) { Object.assign(chat, JSON.parse(JSON.stringify(n))); return true; },
    async setCharacter(n) { Object.assign(char, JSON.parse(JSON.stringify(n))); return true; },
    async addRisuReplacer() { return true; },
    async removeRisuReplacer() { return true; },
    async addRisuScriptHandler() { return true; },
    async removeRisuScriptHandler() { return true; },
    async registerBodyIntercepter() { return true; },
    async unregisterBodyIntercepter() { return true; },
    async onUnload() { return true; },
    async registerSetting() { return true; },
    async registerButton() { return true; },
    async showContainer() { return true; },
    async hideContainer() { return true; },
    async getDatabase() { return { personas: [], selectedPersona: null, modules: [], enabledModules: [], moduleIntergration: [], characters: [] }; },
    pluginStorage: {
      async getItem(k) { return pluginStorage.has(k) ? pluginStorage.get(k) : null; },
      async setItem(k, v) { pluginStorage.set(k, String(v)); return true; },
      async removeItem(k) { pluginStorage.delete(k); return true; }
    },
    safeLocalStorage: { async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; } },
    async getLocalPluginStorage() { return { async getItem() { return null; }, async setItem() { return true; } }; },
    async nativeFetch() { throw new Error('nativeFetch should not be called'); }
  };

  let code = fs.readFileSync(DIST, 'utf8');
  const snippet = '\n;globalThis.__PREV__={UserDlcCore: typeof UserDlcCore!=="undefined"?UserDlcCore:null,MemoryEngine: typeof MemoryEngine!=="undefined"?MemoryEngine:null};\n';
  const idx = code.lastIndexOf('\n})();');
  if (idx < 0) throw new Error('Could not locate final IIFE close');
  code = code.slice(0, idx) + snippet + code.slice(idx);

  const context = {
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
    crypto: { randomUUID: crypto.randomUUID, getRandomValues: crypto.getRandomValues },
    AbortController, TextEncoder, TextDecoder, URL, Buffer,
    fetch: async () => { throw new Error('fetch should not be called'); },
    risuai, Risuai: risuai, process: { env: {} }
  };
  context.globalThis = context;
  context.window = context;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(code, context, { filename: DIST, timeout: 20000 });
  await new Promise(r => setTimeout(r, 2500));
  return { api: context.__PREV__ || {}, context, chat, char };
}

(async () => {
  const assertions = [];
  const { api } = await boot();
  const dlc = api.UserDlcCore;

  assertions.push(assert('user_dlc_core_available', !!dlc));

  if (!dlc) {
    console.log(JSON.stringify({ ok: false, assertions }, null, 2));
    process.exit(1);
  }

  // ── 1. 미리보기 API 존재 ─────────────────────────────────────────────
  assertions.push(assert('preview_api_exists',
    typeof dlc.previewWorldAnalysis === 'function',
    { type: typeof dlc.previewWorldAnalysis }));
  assertions.push(assert('commit_preview_api_exists',
    typeof dlc.commitWorldPreview === 'function',
    { type: typeof dlc.commitWorldPreview }));
  assertions.push(assert('discard_preview_api_exists',
    typeof dlc.discardWorldPreview === 'function',
    { type: typeof dlc.discardWorldPreview }));

  if (typeof dlc.previewWorldAnalysis !== 'function') {
    console.log(JSON.stringify({ ok: false, assertions }, null, 2));
    process.exit(1);
  }

  // ── 2. 미리보기는 저장하지 않는다 ────────────────────────────────────
  dlc.resetState();
  const beforeState = JSON.stringify(dlc.getState());
  const beforeCount = (dlc.getState()?.worldItems || []).length;

  const payload = {
    worldItems: [
      {
        kind: 'trap', title: '별핵 공명 함정',
        userConcept: '보물 상자를 열면 최근 기억을 잃는 함정',
        adaptedConcept: '별핵 색인 봉인이 기억 잔향에 공명하는 기록 봉인.',
        mechanism: '기억 자체를 빼앗지 않고 잔향만 감지한다.',
        trigger: '봉인 색인에 허가 없이 접촉',
        counterplay: '아리엘의 정식 열람 표식 사용',
        canonCompatibility: { status: 'compatible', conflicts: [] }
      },
      {
        kind: 'tool', title: '월막 피막',
        userConcept: '임신 예방 도구',
        adaptedConcept: '기록 마법의 얇은 보호막.',
        canonCompatibility: { status: 'conflicted', conflicts: ['기존 정본과 충돌: 마법 체계 불일치'] }
      }
    ]
  };

  const preview = dlc.previewWorldAnalysis(payload, { turn: 7, userConcept: '함정과 도구를 추가해 줘' });

  assertions.push(assert('preview_returns_summary', Boolean(preview && typeof preview === 'object'), {
    previewKeys: preview ? Object.keys(preview) : null
  }));

  if (preview) {
    assertions.push(assert('preview_lists_new_items', Array.isArray(preview.items) && preview.items.length === 2,
      { count: (preview.items || []).length }));
    assertions.push(assert('preview_flags_conflicts',
      Array.isArray(preview.conflicts) && preview.conflicts.length >= 1,
      { conflicts: preview.conflicts }));
    assertions.push(assert('preview_reports_would_add_count',
      typeof preview.wouldAdd === 'number' && preview.wouldAdd === 2,
      { wouldAdd: preview.wouldAdd }));
    assertions.push(assert('preview_reports_per_item_reason',
      (preview.items || []).every(it => it && typeof it.title === 'string' && 'blocked' in it),
      { sample: (preview.items || []).slice(0, 2) }));
  }

  // 저장되지 않았음을 확인 — 이것이 이 기능의 핵심 계약이다
  const afterState = JSON.stringify(dlc.getState());
  const afterCount = (dlc.getState()?.worldItems || []).length;
  assertions.push(assert('preview_does_not_persist_state', afterState === beforeState && afterCount === beforeCount, {
    beforeCount, afterCount, stateUnchanged: afterState === beforeState
  }));

  // ── 3. 승인하면 저장된다 ─────────────────────────────────────────────
  const committed = dlc.commitWorldPreview(preview.id || null, { turn: 7 });
  const committedItems = dlc.getState()?.worldItems || [];
  assertions.push(assert('commit_persists_items', committedItems.length === 2, {
    count: committedItems.length, committed: committed && committed.added
  }));

  // ── 4. 취소하면 아무것도 남지 않는다 ─────────────────────────────────
  dlc.resetState();
  const p2 = dlc.previewWorldAnalysis(payload, { turn: 9, userConcept: '다시' });
  const discarded = dlc.discardWorldPreview(p2?.id || null);
  assertions.push(assert('discard_leaves_no_items',
    (dlc.getState()?.worldItems || []).length === 0,
    { items: (dlc.getState()?.worldItems || []).length, discarded: discarded && discarded.discarded }));
  assertions.push(assert('discard_reports_success', Boolean(discarded && discarded.discarded === true), {
    discarded
  }));

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})().catch(e => {
  console.log(JSON.stringify({
    ok: false,
    assertions: [{ name: 'gate_harness_crashed', ok: false, details: { error: String(e && e.stack || e) } }]
  }, null, 2));
  process.exit(1);
});
