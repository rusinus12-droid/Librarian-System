'use strict';
// Gate: DLC 요소 카드의 인라인 편집.
//
// 배경 (실측): renderUserDlcWorldCard / renderUserDlcTargetCard /
// renderWorldAdditionalDirectiveCard 는 카드에 투입 토글과 삭제만 제공한다.
// 내용을 고치려면 재분석하거나 삭제 후 재생성해야 했고, 그러면 revision 이력과
// 사용자가 켜 둔 투입 상태가 끊긴다.
//
// 이 게이트가 단언하는 계약:
//   1) 카드에 편집 버튼이 있고, 편집 가능한 필드가 지정되어 있다
//   2) 편집은 새 항목이 아니라 같은 id 를 갱신한다 (revision 증가, 투입 상태 보존)
//   3) 빈 제목 같은 잘못된 편집은 거부된다
//   4) 편집 후에도 프롬프트 투입이 계속 작동한다
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const GUI_SRC = path.join(ROOT, 'src', 'parts', '15b-gui-content-world-dlc.js');

function assert(name, ok, details = {}) { return { name, ok: !!ok, details }; }

async function boot() {
  const pluginStorage = new Map();
  const chat = { id: 'edit-chat', name: 'Edit', localLore: [], msgs: [], message: [] };
  const char = { id: 'edit-char', name: 'Edit Char', chatPage: 0, chats: [chat], lorebook: [], description: 'edit.' };
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
  const snippet = '\n;globalThis.__EDIT__={UserDlcCore: typeof UserDlcCore!=="undefined"?UserDlcCore:null,WorldAdditionalCore: typeof WorldAdditionalCore!=="undefined"?WorldAdditionalCore:null,MemoryEngine: typeof MemoryEngine!=="undefined"?MemoryEngine:null};\n';
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
  return context.__EDIT__ || {};
}

(async () => {
  const assertions = [];
  const api = await boot();
  const dlc = api.UserDlcCore;

  assertions.push(assert('user_dlc_core_available', !!dlc));

  // ── 1. 카드에 편집 버튼 + 편집 필드 지정 ─────────────────────────────
  const guiSrc = fs.readFileSync(GUI_SRC, 'utf8');
  assertions.push(assert('card_renders_edit_button',
    /data-wa-edit-kind/.test(guiSrc) && /data-wa-edit-id/.test(guiSrc),
    {
      editKind: (guiSrc.match(/data-wa-edit-kind/g) || []).length,
      editId: (guiSrc.match(/data-wa-edit-id/g) || []).length
    }));
  assertions.push(assert('edit_button_delegated_in_events',
    /data-wa-edit-kind/.test(fs.readFileSync(path.join(ROOT, 'src', 'parts', '15d-gui-events-finalize.js'), 'utf8')),
    {}));

  if (!dlc) {
    console.log(JSON.stringify({ ok: false, assertions }, null, 2));
    process.exit(1);
  }

  // ── 2. 편집 API: 같은 id 갱신, revision 증가, 투입 상태 보존 ─────────
  assertions.push(assert('edit_item_api_exists',
    typeof dlc.updateWorldItemFields === 'function',
    { type: typeof dlc.updateWorldItemFields }));

  if (typeof dlc.updateWorldItemFields !== 'function') {
    console.log(JSON.stringify({ ok: false, assertions }, null, 2));
    process.exit(1);
  }

  dlc.resetState();
  const created = dlc.upsertWorldItem({
    kind: 'trap', title: '별핵 공명 함정',
    userConcept: '기억을 잃는 함정', adaptedConcept: '별핵 색인 봉인.',
    mechanism: '잔향만 감지한다.', status: 'armed'
  }, { turn: 5 });
  const originalId = created?.item?.id;
  const originalRevision = Number(created?.item?.revision || 1);
  // 투입을 켜둔 상태를 만든다 (편집이 이걸 끊으면 안 된다)
  dlc.setInjectionState('world', originalId, true);
  const beforeEdit = (dlc.getState().worldItems || []).find(i => i.id === originalId);

  const edited = dlc.updateWorldItemFields(originalId, {
    title: '별핵 공명 함정 (수정)',
    mechanism: '기억 잔향과 색인 흔적을 함께 감지한다.'
  }, { turn: 8 });

  const afterEdit = (dlc.getState().worldItems || []).find(i => i.id === originalId);
  assertions.push(assert('edit_updates_same_item_id', Boolean(afterEdit && afterEdit.id === originalId), {
    originalId, afterId: afterEdit && afterEdit.id,
    totalItems: (dlc.getState().worldItems || []).length
  }));
  assertions.push(assert('edit_applies_new_values',
    afterEdit?.title === '별핵 공명 함정 (수정)' && /색인 흔적/.test(String(afterEdit?.mechanism || '')),
    { title: afterEdit?.title, mechanism: afterEdit?.mechanism }));
  assertions.push(assert('edit_bumps_revision',
    Number(afterEdit?.revision || 0) > originalRevision,
    { before: originalRevision, after: afterEdit?.revision }));

  // 투입 상태 보존: edit 후에도 토글이 켜져 있어야 한다
  const injectionOn = afterEdit?.useEnabled !== false && afterEdit?.injectionDisabled !== true;
  assertions.push(assert('edit_preserves_injection_state', injectionOn, {
    before: { useEnabled: beforeEdit?.useEnabled, injectionDisabled: beforeEdit?.injectionDisabled },
    after: { useEnabled: afterEdit?.useEnabled, injectionDisabled: afterEdit?.injectionDisabled }
  }));

  // ── 3. 잘못된 편집 거부 ──────────────────────────────────────────────
  const badEmptyTitle = dlc.updateWorldItemFields(originalId, { title: '   ' }, { turn: 9 });
  const afterBad = (dlc.getState().worldItems || []).find(i => i.id === originalId);
  assertions.push(assert('edit_rejects_empty_title',
    badEmptyTitle?.changed === false && afterBad?.title === '별핵 공명 함정 (수정)',
    { result: badEmptyTitle, title: afterBad?.title }));

  const badUnknownId = dlc.updateWorldItemFields('dlc_does_not_exist', { title: '무엇' }, { turn: 9 });
  assertions.push(assert('edit_rejects_unknown_id',
    badUnknownId?.changed === false && String(badUnknownId?.reason || '').length > 0,
    { result: badUnknownId }));

  // ── 4. 편집 후에도 프롬프트 투입이 작동 ──────────────────────────────
  const prompt = String(dlc.formatWorldForPrompt({ turn: 10 }, 4000) || '');
  assertions.push(assert('edited_item_still_injects',
    /수정/.test(prompt) && /색인 흔적/.test(prompt),
    { promptHead: prompt.slice(0, 300) }));

  // ── 5. World Additional 디렉티브도 같은 편집을 지원 ──────────────────
  assertions.push(assert('directive_edit_api_exists',
    typeof api.WorldAdditionalCore?.updateDirectiveFields === 'function',
    { type: typeof api.WorldAdditionalCore?.updateDirectiveFields }));

  if (typeof api.WorldAdditionalCore?.updateDirectiveFields === 'function') {
    api.WorldAdditionalCore.resetState();
    const d = api.WorldAdditionalCore.upsertDirective({
      id: 'wa_edit', type: 'world_delta', title: '폐쇄 색인실',
      description: '지하서고의 폐쇄 색인실.', directive: '색인실을 쓴다.', status: 'armed'
    });
    const before = api.WorldAdditionalCore.getState().worldDeltas.find(i => i.id === 'wa_edit');
    const r = api.WorldAdditionalCore.updateDirectiveFields('wa_edit', { title: '폐쇄 색인실 (수정)', directive: '조사 경로로 쓴다.' }, { turn: 11 });
    const after = api.WorldAdditionalCore.getState().worldDeltas.find(i => i.id === 'wa_edit');
    assertions.push(assert('directive_edit_updates_same_item',
      Boolean(after && after.id === 'wa_edit') && after.title === '폐쇄 색인실 (수정)',
      { title: after && after.title, before: before && before.title }));
    assertions.push(assert('directive_edit_rejects_unknown_id',
      api.WorldAdditionalCore.updateDirectiveFields('nope', { title: 'x' }, {}).changed === false,
      {}));
  }

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
