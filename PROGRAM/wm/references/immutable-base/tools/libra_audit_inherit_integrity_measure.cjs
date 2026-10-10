'use strict';
// 측정: **상속·전환으로 넘어온 기록의 integrity scope 불일치**가 데이터를 버리는가
//
// 배경 — 같은 교훈이 이미 리포에 두 번 적혀 있다:
//   `04j:257`  "부모 섀도를 그대로 복사하면 부모 스코프 무결성 메타가 남아 검증 실패·중복이 생긴다
//               — 실측: memMax 98→97, 턴 1·2·97 중복"
//   `04j:112`  `_rescopeInheritedIntegrity` — 세션 전환 경로에서 **손으로** 리스코프
//
// 그런데 **스토리지 상속 경로**(`01f:149 normalizeEntries`)는 리스코프를 하지 않는다.
// 그리고 소비처는 scope 불일치를 **거부**한다:
//   `08e:376`  EntityManager.rebuildCache  → scope_mismatch 면 `continue` (엔티티 소실)
//   `08e:459`  repairLegacyFieldMappings   → scope_mismatch 면 `continue`
//   `08:117`   `if (expectedScope && actualScope && expectedScope !== actualScope) → scope_mismatch`
//
// 확인할 것:
//   ① 부모 스코프로 찍힌 기록을 **자식 스코프로 검증**하면 어떻게 되나
//   ② 리스코프하면 통과하나 (수리 방향)
//   ③ 체크섬이 스코프에 의존하나 (수리가 checksum 을 깨뜨리지 않는지)
//   ④ 대조군: 같은 스코프로 찍고 같은 스코프로 검증하면 통과하나
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');

const noop = () => {};
const mk = () => ({
  style: {}, dataset: {}, tagName: 'DIV',
  classList: { toggle: noop, add: noop, remove: noop },
  set innerHTML(v) {}, get innerHTML() { return ''; },
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

const I = ctx.LIBRA_IntegrityMetaManager;
const PARENT = 'char:c1|chat:parent-1|persona:default';
const CHILD = 'char:c1|chat:branch-1|persona:default';

// 실제 형태의 엔티티 레코드 (lmai_entity 는 name 을 recordId 로 쓴다)
const mkEntity = (name) => ({
  id: `e_${name}`, name, aliases: [],
  state: { notes: ['부모에서 얻은 단서'] },
  meta: { created: 1, updated: 2, confidence: 0.7, source: 'parent-chat', m_ids: ['m1'], aliases: [] }
});

const out = [];
const log = (...a) => out.push(a.join(' '));

log('=== ① 부모 스코프로 찍힌 기록을 자식 스코프로 검증 ===');
const stamped = I.applyIntegrityMeta(JSON.parse(JSON.stringify(mkEntity('아린'))), {
  domain: 'entity', recordSchema: 'libra.entity.entry.v1', recordId: '아린',
  scopeKey: PARENT, turn: 3, source: 'parent-chat'
});
log('  찍힌 scopeKey =', stamped.meta.integrity.scopeKey);
log('  checksum      =', String(stamped.meta.integrity.checksum).slice(0, 16));
const childView = I.validateIntegrityMeta(stamped, { domain: 'entity', recordId: '아린', scopeKey: CHILD });
log('  자식 스코프로 검증 =', JSON.stringify({ ok: childView.ok, reason: childView.reason, expectedScope: childView.expectedScope, actualScope: childView.actualScope }));
log('  → 08e:376 은 !ok 면 `continue` 로 **엔티티를 버린다**');
log('');

log('=== ② 리스코프하면 통과하나 (수리 방향) ===');
const rescoped = JSON.parse(JSON.stringify(stamped));
rescoped.meta.integrity.scopeKey = CHILD;
const rescopeView = I.validateIntegrityMeta(rescoped, { domain: 'entity', recordId: '아린', scopeKey: CHILD });
log('  scopeKey 만 바꾼 뒤 검증 =', JSON.stringify({ ok: rescopeView.ok, reason: rescopeView.reason }));
log('  → checksum 을 안 고쳐도 통과하나:', rescopeView.ok ? 'YES (checksum 은 scope 를 안 본다)' : 'NO');
log('');

log('=== ③ 체크섬이 스코프에 의존하나 ===');
const a = I.applyIntegrityMeta(JSON.parse(JSON.stringify(mkEntity('아린'))), { domain: 'entity', recordId: '아린', scopeKey: PARENT, turn: 3 });
const b = I.applyIntegrityMeta(JSON.parse(JSON.stringify(mkEntity('아린'))), { domain: 'entity', recordId: '아린', scopeKey: CHILD, turn: 3 });
log('  부모 스코프 checksum =', String(a.meta.integrity.checksum).slice(0, 16));
log('  자식 스코프 checksum =', String(b.meta.integrity.checksum).slice(0, 16));
log('  같은가 =', a.meta.integrity.checksum === b.meta.integrity.checksum);
log('  → 다르면: scope 만 바꾸면 checksum 이 깨진다 (재계산 필요)');
log('');

log('=== ④ 대조군: 같은 스코프로 찍고 같은 스코프로 검증 ===');
const sameView = I.validateIntegrityMeta(a, { domain: 'entity', recordId: '아린', scopeKey: PARENT });
log('  검증 =', JSON.stringify({ ok: sameView.ok, reason: sameView.reason }));
log('  → false 면 대조군 자체가 잘못된 것 (픽스처 오류)');
log('');

log('=== ⑤ 실제 리스코프 결과 (applyIntegrityMeta 로 재적용) ===');
const reapply = JSON.parse(JSON.stringify(stamped));
I.applyIntegrityMeta(reapply, {
  domain: 'entity', recordSchema: 'libra.entity.entry.v1', recordId: '아린',
  scopeKey: CHILD, turn: 3, source: 'parent-chat'
});
const reapplyView = I.validateIntegrityMeta(reapply, { domain: 'entity', recordId: '아린', scopeKey: CHILD });
log('  재적용 후 검증 =', JSON.stringify({ ok: reapplyView.ok, reason: reapplyView.reason }));
log('  checksum 갱신됨 =', reapply.meta.integrity.checksum !== stamped.meta.integrity.checksum);
log('');

log('=== 판정 ===');
const broken = !childView.ok && childView.reason === 'scope_mismatch';
log('  부모 스코프 기록을 자식 스코프로 검증 =', childView.reason || '(ok)');
log('  ★ 데이터가 버려지는가 =', broken ? 'YES — 상속받은 엔티티가 자식 채팅에서 사라진다' : 'NO');
log('  리스코프 수리 유효 =', reapplyView.ok && sameView.ok ? 'YES (자식 스코프 재적용 → 정상 검증)' : 'NO');

console.log(out.join('\n'));
process.exit(0);
