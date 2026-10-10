'use strict';
// 실측: 중복 제거 후에도 "규칙이 바뀌었나" 판정이 계속 도는가.
//
// 이 단계의 핵심 위험: 값만 지우면 해시 입력이 비어 양쪽 해시가 항상 같아지고
//   world_rules_changed / world_path_changed / user_world_correction_changed 가
//   **영구히 안 뜬다**(변경 감지가 조용히 죽는다).
//
// 지문(해시)을 빌드 시점에 저장하는 방식이 그걸 막는지 실제 스냅샷 판정을 돌려 확인한다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const i = code.lastIndexOf('\n})();');
code = code.slice(0, i) + `
    globalThis.__p = {
        HierarchicalWorldManager, CompactMemoryCodec,
        buildWorldRecallMemoryContent: (typeof buildWorldRecallMemoryContent === 'function' ? buildWorldRecallMemoryContent : null),
        shouldCreateWorldRecallMemorySnapshot: (typeof shouldCreateWorldRecallMemorySnapshot === 'function' ? shouldCreateWorldRecallMemorySnapshot : null),
        getWorldRecallRuleHash: (typeof getWorldRecallRuleHash === 'function' ? getWorldRecallRuleHash : null),
        getWorldRecallActivePathHash: (typeof getWorldRecallActivePathHash === 'function' ? getWorldRecallActivePathHash : null),
        getWorldRecallCorrectionHash: (typeof getWorldRecallCorrectionHash === 'function' ? getWorldRecallCorrectionHash : null)
    };
` + code.slice(i);

const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
  globalThis: null, window: null, structuredClone: global.structuredClone,
  document: {
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, children: [] }),
    head: { appendChild() {} }, body: { appendChild() {} },
    querySelector: () => null, getElementById: () => null, readyState: 'complete'
  },
  Risuai: {
    apiVersion: '3.0', getRuntimeInfo: async () => ({}), getArgument: async () => undefined,
    pluginStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, keys: async () => [] },
    getLocalPluginStorage: async () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }),
    getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0,
    getCharacter: async () => ({}), getChatFromIndex: async () => ({ msg: [] }), getDatabase: async () => ({ personas: [] }),
    registerSetting: async () => {}, showContainer: async () => {}, hideContainer: async () => {}
  },
  fetch: async () => { throw new Error('no'); }, AbortController, performance: { now: () => Date.now() }
};
ctx.risuai = ctx.Risuai; ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
let runErr = '';
try { vm.runInContext(code, ctx, { timeout: 30000 }); } catch (e) { runErr = String(e.message); }

setTimeout(() => {
  const out = { run_error: runErr || null };
  const P = ctx.__p;
  if (!P) { console.log(JSON.stringify({ ok: false, reason: 'no probe' }, null, 2)); process.exit(1); }
  const W = P.HierarchicalWorldManager;
  const Codec = P.CompactMemoryCodec;
  const build = P.buildWorldRecallMemoryContent;

  W.loadWorldGraph([], true);
  const root = W.getProfile().rootId;

  const mkContent = (rules, meta) => build(meta || {}, rules || {}, {
    turn: 10, importance: 7, sourceHash: 'h', sourceMessageIds: ['m1'], activePath: [root]
  });

  const rulesA = { exists: { magic: true }, setting: { places: ['검은 탑'] }, custom: { rule_1: '마력은 저주받은 자만 쓴다' } };
  const rulesB = { exists: { magic: true }, setting: { places: ['검은 탑', '왕도'] }, custom: { rule_1: '마력은 저주받은 자만 쓴다' } };  // 장소 추가
  const metaA = { classification: 'dark-fantasy', worldSummary: '마력이 일상인 세계' };

  const contentA = mkContent(rulesA, metaA);
  const payloadA = Codec.parsePayloadFromContent(contentA);
  const contentB = mkContent(rulesB, metaA);
  const payloadB = Codec.parsePayloadFromContent(contentB);

  out.payload_world_keys = payloadA?.world ? Object.keys(payloadA.world).sort() : null;
  out.no_copied_values = !payloadA?.world?.exists && !payloadA?.world?.setting && !payloadA?.world?.custom
    && !payloadA?.world?.ruleHighlights && !payloadA?.world?.activePath && !payloadA?.world?.userCorrection;

  // ── 핵심: 규칙이 바뀌면 ruleHash 가 달라지는가 ──
  const hashA = P.getWorldRecallRuleHash(payloadA);
  const hashB = P.getWorldRecallRuleHash(payloadB);
  out.rule_hash = {
    a: hashA, b: hashB,
    differs_when_rules_change: hashA !== hashB,
    same_payload_hash: hashA === P.getWorldRecallRuleHash(Codec.parsePayloadFromContent(mkContent(rulesA, metaA)))
  };

  // ── 스냅샷 판정: 규칙이 바뀌면 'world_rules_changed' 가 나오는가 ──
  // 실제 경로: 새 페이로드로 만들어 기존 lore 에 스냅샷이 있으면 비교한다.
  // memoryEntry 를 만들어 lore 에 넣고 판정한다.
  const makeEntry = (content, turn) => ({
    key: `lmai_memory::t${turn}`, comment: 'lmai_memory', content,
    mode: 'normal', insertorder: 1, alwaysActive: false
  });

  const lore = [makeEntry(contentA, 10)];
  const decisionB = P.shouldCreateWorldRecallMemorySnapshot(lore, payloadB, { turn: 12 });
  const decisionA = P.shouldCreateWorldRecallMemorySnapshot(lore, payloadA, { turn: 12 });

  out.snapshot_decision = {
    unchanged_rules_same_turn: decisionA,   // recent_equivalent (또는 interval)
    changed_rules: decisionB,
    detects_rule_change: decisionB?.reason === 'world_rules_changed',
    detects_no_change: decisionA?.create === false || decisionA?.reason === 'interval_refresh'
  };

  // ── 경로 변경 감지 ──
  const c = W.createNode({ name: '북부 변경', parent: root, layer: 'dimension' });
  W.changeActivePath(c.node.id, { method: 'probe' });
  const contentC = build(metaA, rulesA, { turn: 13, importance: 7, sourceHash: 'h', sourceMessageIds: ['m2'], activePath: [root, c.node.id] });
  const payloadC = Codec.parsePayloadFromContent(contentC);
  const decisionC = P.shouldCreateWorldRecallMemorySnapshot(lore, payloadC, { turn: 13 });
  out.path_hash = {
    a: P.getWorldRecallActivePathHash(payloadA),
    c: P.getWorldRecallActivePathHash(payloadC),
    differs: P.getWorldRecallActivePathHash(payloadA) !== P.getWorldRecallActivePathHash(payloadC),
    decision: decisionC?.reason
  };

  // ── 사용자 교정 감지 ──
  const contentD = build({ classification: 'dark-fantasy', worldSummary: '마력이 일상인 세계', userWorldCorrection: '마법은 등록제다' }, rulesA, { turn: 14, importance: 7, sourceHash: 'h', sourceMessageIds: ['m3'], activePath: [root] });
  const payloadD = Codec.parsePayloadFromContent(contentD);
  out.correction_hash = {
    differs: P.getWorldRecallCorrectionHash(payloadA) !== P.getWorldRecallCorrectionHash(payloadD)
  };

  // ── 회상 텍스트에서 세계 규칙이 빠졌는가 ──
  const recallText = String(Codec.buildDisplayTextFromEntry?.({ content: contentA }) || '');
  const recallSearch = String(Codec.extractSearchTextFromEntry?.({ content: contentA }) || (() => {
    try { return JSON.stringify(Codec) .length ? '' : ''; } catch { return ''; }
  })());
  out.recall_text = {
    display_has_rules: /저주받은|검은 탑/.test(recallText),
    display_sample: recallText.slice(0, 200),
    note: '03d:224 가 payloadWorld.ruleHighlights 를 읽지만 생산자가 안 넣으므로 새 기억에서는 빈손'
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}, 200);
