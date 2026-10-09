'use strict';
// Gate: World Additional / User DLC 사용자 가시성.
//
// 배경 (실측): selectForPrompt 는 후보 수·버킷 통계·거부 사유 20종을 정교하게
// 계산하지만 전부 debugWorldAdditional() 로만 흘려보내고 GUI 에는 숫자 4개만
// 도달한다. 그래서 사용자는 "왜 이 요소가 안 들어갔는지" 를 알 수 없다.
// 또 상태 기계가 injected 에 멈춘 항목(= 모델이 아직 안 쓴 요소)을 구분할 수 없다.
//
// 이 게이트가 단언하는 계약:
//   1) selectForPrompt 가 계산한 거부 사유를 상태에 남겨 GUI 가 읽을 수 있다
//   2) 상태 전이 라벨이 사용자에게 의미 있게 매핑된다 (injected = 미활용)
//   3) forceLevel / userImpact 이 실제 주입 프롬프트에 노출된다
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');

function assert(name, ok, details = {}) { return { name, ok: !!ok, details }; }

async function boot() {
  const pluginStorage = new Map();
  const chat = { id: 'vis-chat', name: 'Vis', localLore: [], msgs: [], message: [] };
  const char = { id: 'vis-char', name: 'Vis Char', chatPage: 0, chats: [chat], lorebook: [], description: 'vis.' };
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
  const snippet = '\n;globalThis.__VIS__={WorldAdditionalCore: typeof WorldAdditionalCore!=="undefined"?WorldAdditionalCore:null,MemoryEngine: typeof MemoryEngine!=="undefined"?MemoryEngine:null,MemoryState: typeof MemoryState!=="undefined"?MemoryState:null};\n';
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
  return context.__VIS__ || {};
}

(async () => {
  const assertions = [];
  const api = await boot();
  const core = api.WorldAdditionalCore;
  const cfg = api.MemoryEngine?.CONFIG || {};

  assertions.push(assert('world_additional_core_available', !!core));

  if (!core) {
    console.log(JSON.stringify({ ok: false, assertions }, null, 2));
    process.exit(1);
  }

  // ── 1. 거부 사유가 상태로 노출되는가 ─────────────────────────────────
  core.resetState();
  // 이 항목은 progressionTier 불일치로 거부되어야 한다 (national vs local 문맥)
  core.upsertDirective({
    id: 'vis_pending', type: 'world_delta', title: '미궁 문지기',
    description: '세계수 미궁에 문지기가 있다.', directive: '문지기를 언급하라',
    status: 'armed', progressionTier: 'national', activationCondition: '미궁 도달'
  });
  // 이 항목은 정상 선택되어야 한다
  core.upsertDirective({
    id: 'vis_ok', type: 'world_delta', title: '달그림자 비밀 통로',
    description: '서가 뒤 숨은 통로.', directive: '통로를 언급하라',
    status: 'armed', progressionTier: 'local'
  });

  const ctxIn = {
    turn: 5,
    promptText: '도현은 달그림자 도서관에 들어섰다.',
    rawText: '도현은 달그림자 도서관에 들어섰다.',
    narrativePrompt: '도현은 달그림자 도서관에 들어섰다.',
    focusCharacters: ['도현'],
    progressionTier: 'local'
  };

  // formatForPrompt 를 호출하면 내부에서 selectForPrompt 가 돌고 상태에 기록돼야 한다
  const prompt = String(core.formatForPrompt(ctxIn, cfg) || '');

  assertions.push(assert('prompt_contains_selected_directive', /비밀 통로/.test(prompt), {
    promptHead: prompt.slice(0, 200)
  }));

  // 거부 사유 조회 API 가 있어야 한다
  const diag = typeof core.getSelectionDiagnostics === 'function' ? core.getSelectionDiagnostics() : null;
  assertions.push(assert('selection_diagnostics_api_exists', diag !== null && typeof diag === 'object', {
    type: typeof core.getSelectionDiagnostics
  }));

  if (diag) {
    assertions.push(assert('diagnostics_reports_selected_ids',
      Array.isArray(diag.selectedIds) && diag.selectedIds.includes('vis_ok'),
      { selectedIds: diag.selectedIds }));

    assertions.push(assert('diagnostics_reports_rejected_with_reason',
      Array.isArray(diag.rejected) && diag.rejected.some(r => String(r?.directive?.id || '') === 'vis_pending' && r?.reason),
      { rejected: diag.rejected }));

    // 거부 사유는 사용자가 읽을 수 있는 한국어 라벨로 매핑돼야 한다
    const pend = (diag.rejected || []).find(r => String(r?.directive?.id || '') === 'vis_pending');
    assertions.push(assert('rejected_reason_has_human_label',
      Boolean(pend && typeof pend.label === 'string' && pend.label.length > 0),
      { label: pend && pend.label, reason: pend && pend.reason }));

    assertions.push(assert('diagnostics_reports_counts',
      Boolean(diag.bucketStats && diag.totalLimit),
      { bucketStats: diag.bucketStats, totalLimit: diag.totalLimit }));
  }

  // ── 2. 상태 전이 라벨 매핑 (injected = 미활용) ────────────────────────
  const labelFn = typeof core.getStatusLabel === 'function' ? core.getStatusLabel : null;
  assertions.push(assert('status_label_api_exists', typeof labelFn === 'function'));

  if (typeof labelFn === 'function') {
    const injectedLabel = String(labelFn('injected') || '');
    const integratedLabel = String(labelFn('integrated') || '');
    const retiredLabel = String(labelFn('retired') || '');
    assertions.push(assert('injected_label_means_unused',
      injectedLabel.length > 0 && injectedLabel !== integratedLabel,
      { injected: injectedLabel, integrated: integratedLabel, retired: retiredLabel }));
    assertions.push(assert('integrated_label_means_used',
      /등장|정착|활용|사용/.test(integratedLabel),
      { integrated: integratedLabel }));
    assertions.push(assert('unknown_status_falls_back_safely',
      typeof labelFn('nonexistent_status') === 'string',
      { fallback: labelFn('nonexistent_status') }));
  }

  // ── 3. 강도는 설계상 프롬프트에 싣지 않는다 (반증된 요구) ─────────────
  // 처음에는 "forceLevel/userImpact 이 프롬프트에 없어 모델이 강도를 구분 못 한다"를
  // 결함으로 보고 노출을 시도했으나, world_additional_targeted_test 의
  // manual_injection_bypasses_retired_global_strength_and_impact_limits 가
  // !/Force:|User impact:/ 를 단언하며 이를 뒤집었다. 이 계층은 강도를 전역 한도로
  // 제약하지 않고 응답 모델이 정본·관계·장면을 보고 스스로 정하게 하는 설계다.
  // 그래서 이 게이트는 "싣지 않는다"를 계약으로 고정한다 (회귀 방지).
  assertions.push(assert('force_and_impact_are_not_leaked_into_prompt',
    !/Force:\s*(?:soft|firm|hard)/i.test(prompt) && !/Impact[^:]*:\s*(?:none|ambient|soft|direct|major)/i.test(prompt),
    { promptHead: prompt.slice(0, 300) }));

  // 대신 두 값은 GUI 배지로 사용자에게 보여야 한다 (저장·표시 경로).
  const st = core.getState();
  const anyWithForce = [...(st.worldDeltas || []), ...(st.sceneInterventions || []), ...(st.characterAdditions || [])]
    .some(item => item && item.forceLevel);
  assertions.push(assert('directive_force_persists_for_gui_display', anyWithForce, {
    sample: [...(st.worldDeltas || [])].slice(0, 2).map(i => ({ id: i?.id, forceLevel: i?.forceLevel, userImpact: i?.userImpact }))
  }));

  // ── 4. 은퇴한 전역 영향 한도 제거 (Q2: 폐기 확정) ────────────────────
  // userImpactLimit 은 전역 상한으로 설계됐으나, 이를 강제할 isImpactAllowed 가
  // 정의만 되고 호출 0곳이라 한 번도 작동하지 않았다. 기존 스위트도
  // manual_injection_bypasses_retired_global_strength_and_impact_limits 라 이름 붙여
  // 은퇴를 단언한다. 그러므로 배선이 아니라 제거가 맞다.
  // 주의: per-directive userImpact 은 GUI 배지로 실제 작동하므로 남긴다.
  const distSrc = fs.readFileSync(DIST, 'utf8');
  // 주석은 코드가 아니다 — Retired 사유를 적은 주석이 그 심볼 이름을 담고 있으므로
  // 줄 단위로 // 주석을 걷어낸 뒤 검사한다. (이 구분을 안 하면 자기 주석에 걸려
  // 제거가 끝났는데도 실패한다.)
  const stripLineComments = (text) => text
    .split('\n')
    .map(line => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//')) return '';
      const blockAt = line.indexOf('/*');
      const lineAt = line.indexOf('//');
      if (lineAt >= 0 && (blockAt < 0 || lineAt < blockAt)) return line.slice(0, lineAt);
      return line;
    })
    .join('\n');
  const distCode = stripLineComments(distSrc);

  assertions.push(assert('dead_impact_enforcement_removed',
    !/isImpactAllowed/.test(distCode) && !/IMPACT_RANK/.test(distCode),
    {
      isImpactAllowed: (distCode.match(/isImpactAllowed/g) || []).length,
      IMPACT_RANK: (distCode.match(/IMPACT_RANK/g) || []).length,
      inCommentsOnly: (distSrc.match(/isImpactAllowed/g) || []).length
    }));

  assertions.push(assert('global_impact_limit_key_removed',
    !/userImpactLimit/.test(distCode) && !/user_impact_limit/.test(distCode),
    {
      userImpactLimit: (distCode.match(/userImpactLimit/g) || []).length,
      user_impact_limit: (distCode.match(/user_impact_limit/g) || []).length,
      inCommentsOnly: (distSrc.match(/userImpactLimit|user_impact_limit/g) || []).length
    }));

  // 상태에 남은 은퇴 설정이 로드 시 걸러지는지 (기존 저장분 호환)
  core.resetState();
  core.upsertDirective({
    id: 'vis_impact', type: 'world_delta', title: '폐쇄 색인실',
    description: '지하서고의 폐쇄 색인실.', directive: '색인실을 쓴다.',
    status: 'armed', progressionTier: 'local', userImpact: 'ambient'
  });
  const stAfter = core.getState();
  assertions.push(assert('settings_no_longer_carry_impact_limit',
    !Object.prototype.hasOwnProperty.call(stAfter?.settings || {}, 'userImpactLimit'),
    { settingsKeys: Object.keys(stAfter?.settings || {}) }));

  // per-directive userImpact 은 남아 있어야 한다 (GUI 배지 + 저장)
  const impactItem = [...(stAfter.worldDeltas || []), ...(stAfter.sceneInterventions || []), ...(stAfter.characterAdditions || [])]
    .find(item => String(item?.id || '') === 'vis_impact');
  assertions.push(assert('per_directive_impact_still_persists',
    Boolean(impactItem && impactItem.userImpact === 'ambient'),
    { userImpact: impactItem && impactItem.userImpact }));

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
