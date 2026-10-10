'use strict';
// 측정: **RisuAI 네이티브 채팅 복제(duplicate)** 를 내 리포가 어떻게 취급하는가
//
// 벤치마크 정본 (C:/Users/rusin/Desktop/plugins):
//   HAYAKU  `isVerifiedNativeChatCopyScope`  → detectionReason === 'risu_native_chat_copy'
//           `detachNativeChatCopySourceStorageArtifacts` (복사본에서 **부모 산출물 제거**)
//   Flashback `classifiedCopyModes` = { chat_copy_live, session_handoff, same_chat_persona_recovery,
//                                       shared_archive, portable_archive_layer }
//   RETRACE  HANDOFF_SCHEMA='memory-session-bridge-v2' + HandoffJournal(상태기계) + 스토리지 3모드
//
// 확인할 것:
//   ① 네이티브 복제(표식 없음)를 내 리포가 어떻게 판정하나 (inspect)
//   ② 그 복제 채팅에 hydrate 를 돌리면 기억이 넘어오나
//   ③ (비교) 네이티브 **브랜치**(표식 있음)는 넘어오나 — 대조군
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');

const noop = () => {};
const mk = () => ({
  _v: '', _t: '', style: {}, dataset: {}, tagName: 'DIV',
  classList: { toggle: noop, add: noop, remove: noop },
  set innerHTML(v) { this._v = String(v); }, get innerHTML() { return this._v || ''; },
  set textContent(v) { this._t = String(v); }, get textContent() { return this._t || ''; },
  setAttribute: noop, getAttribute: () => null, appendChild: noop, addEventListener: noop,
  querySelector: () => null, querySelectorAll: () => []
});
const document = { createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null, getElementById: () => null, head: mk(), body: mk(), readyState: 'complete', addEventListener: noop };
const store = new Map();
const Risuai = {
  apiVersion: '3.0', getRuntimeInfo: async () => ({}), getArgument: async () => undefined,
  pluginStorage: { getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => { store.set(k, String(v)); return true; }, removeItem: async (k) => store.delete(k), keys: async () => Array.from(store.keys()) },
  getLocalPluginStorage: async () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }),
  getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0,
  getCharacter: async () => ({ id: 'c1', name: 'T', chats: [] }), getChatFromIndex: async () => ({ id: 'ch1', msg: [] }),
  getDatabase: async () => ({ personas: [] }), registerSetting: async () => {}, showContainer: async () => {}, hideContainer: async () => {},
  addRisuScriptHandler: noop, onUnload: noop
};
const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise, Set, Map,
  globalThis: null, window: null, document, Risuai, risuai: Risuai, structuredClone: global.structuredClone,
  fetch: async () => { throw new Error('no'); }, AbortController, performance: { now: () => Date.now() }
};
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx, { timeout: 30000 });

// ── 픽스처: 6턴짜리 부모 채팅. 표식 없음 = 순수 네이티브 채팅. ──
const MSGS = Array.from({ length: 12 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant', data: `부모 ${i}`, chatId: `pm${i}`, isComment: false, disabled: false
}));
const PARENT = { id: 'parent-1', name: '부모', fmIndex: 0, message: MSGS.map(m => ({ ...m })) };
//   네이티브 복제 = 부모와 **완전히 같은 메시지**, 새 chat id, **표식 없음**
const COPY = { id: 'copy-1', name: '부모 (복사)', fmIndex: 0, message: MSGS.map(m => ({ ...m })) };
//   대조군: 네이티브 브랜치 = 표식이 있고 fork 지점까지만 접두가 같다
const markerFor = (forkMsgId) => ({ role: 'assistant', data: `{{specialcomment::branchedfrom::parent-1::부모::${forkMsgId}::}}`, chatId: 'cm', isComment: true, disabled: true });
const BRANCH = {
  id: 'branch-1', name: '브랜치', fmIndex: 0,
  message: [
    ...MSGS.slice(0, 6).map(m => ({ ...m })),
    markerFor('pm5'),
    { role: 'user', data: '브랜치 발화', chatId: 'bu1', isComment: false, disabled: false },
    { role: 'assistant', data: '브랜치 응답', chatId: 'ba1', isComment: false, disabled: false }
  ]
};
const CHAR = { id: 'c1', name: 'T', chats: [PARENT, COPY, BRANCH] };

// 부모 스토리지에 기억 4건을 심는다 (실제 형태 — lmai_memory, turn 메타 포함)
const parentEntry = (turn, text) => ({
  key: `mem_${turn}`, comment: 'lmai_memory',
  content: `[META:${JSON.stringify({ imp: 5, t: turn, ttl: -1, cat: 'system' })}]\n${text}`,
  mode: 'normal', insertorder: 100, alwaysActive: false
});

(async () => {
  const P = { LibraHostLineage: ctx.LibraHostLineage, LibraDataStorage: ctx.LibraDataStorage, ...ctx.LibraDataStorage };
  console.log('=== ① 네이티브 복제 vs 브랜치 판정 ===');
  const copyInfo = P.LibraHostLineage.inspect(CHAR, COPY);
  const branchInfo = P.LibraHostLineage.inspect(CHAR, BRANCH);
  const pInfo = P.LibraHostLineage.inspect(CHAR, PARENT);
  const line = (label, info) => {
    console.log(`  ${label.padEnd(10)} kind=${String(info.kind).padEnd(16)} status=${String(info.status).padEnd(12)} eligible=${String(info.inheritanceEligible).padEnd(5)} reason=${info.reason}`);
  };
  line('부모', pInfo); line('복제', copyInfo); line('브랜치', branchInfo);
  console.log('  → isInheritable(복제) =', P.LibraHostLineage.isInheritable(copyInfo));
  console.log('  → isInheritable(브랜치) =', P.LibraHostLineage.isInheritable(branchInfo));

  console.log();
  console.log('=== ② 부모 데이터 심기 ===');
  const parentScope = await P.scopeKeyFor(CHAR, PARENT, null);
  const parentEntries = [parentEntry(1, '부모 기억 1'), parentEntry(2, '부모 기억 2'), parentEntry(3, '부모 기억 3'), parentEntry(4, '부모 기억 4')];
  const savedParent = await P.save(CHAR, PARENT, parentEntries);
  console.log('  부모 scope =', parentScope);
  console.log('  부모 저장 =', JSON.stringify(savedParent));

  console.log();
  console.log('=== ③ 네이티브 복제에 hydrate (기억이 넘어오나) ===');
  const copyScope = await P.scopeKeyFor(CHAR, COPY, null);
  console.log('  복제 scope =', copyScope);
  const copyResult = await P.hydrate(CHAR, COPY);
  console.log('  hydrate =', JSON.stringify(copyResult));
  const copyShadow = P.getShadowEntries(copyScope);
  console.log('  복제 기억 수 =', copyShadow.length);
  console.log('  복제 메타 =', JSON.stringify(await P.readInheritanceMeta(copyScope)));

  console.log();
  console.log('=== ④ (대조군) 네이티브 브랜치에 hydrate ===');
  const branchScope = await P.scopeKeyFor(CHAR, BRANCH, null);
  const branchResult = await P.hydrate(CHAR, BRANCH);
  console.log('  hydrate =', JSON.stringify(branchResult));
  const branchShadow = P.getShadowEntries(branchScope);
  console.log('  브랜치 기억 수 =', branchShadow.length);
  const branchMeta = await P.readInheritanceMeta(branchScope);
  console.log('  브랜치 메타 =', JSON.stringify({ inheritedFrom: branchMeta?.inheritedFrom, hostWorldlineMeta: branchMeta?.hostWorldlineMeta ? 'saved' : null }));

  console.log();
  console.log('=== 판정 ===');
  const copyCarries = copyShadow.length;
  const branchCarries = branchShadow.length;
  console.log(`  네이티브 복제: ${copyCarries}건 이관 ${copyCarries === 0 ? '← ★ 아무것도 안 넘어온다 (결함)' : ''}`);
  console.log(`  네이티브 브랜치: ${branchCarries}건 이관 ${branchCarries > 0 ? '(정상 — 대조군이 작동한다)' : '← ★ 대조군도 실패'}`);
  if (copyCarries > 0) console.log('  → 복제가 이미 이관된다면 벤치마킹 대상이 아니다');
  process.exit(0);
})().catch(e => { console.log('MEASURE ERROR', e && e.message); console.log(e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : ''); process.exit(1); });
