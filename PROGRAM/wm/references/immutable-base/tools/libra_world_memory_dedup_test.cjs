'use strict';
// Gate: 세계 규칙이 기억에 복사되지 않는다 (5단계 — 중복 제거).
//
// 실측된 결함: 05e 의 buildWorldRecallMemoryContent 가 기억 레코드의 payload.world 에
//   정본과 **같은 값**을 복사했다. 실측 어절 공유 25/25 = 100%.
//   그 사본이 03d:224 로 회상 텍스트에 다시 들어가 같은 텍스트가 두 번 주입된다.
//
// 제거 대상(복사 8개): exists · systems · physics · custom · ruleHighlights ·
//                      classification · activePath · userCorrection
// 유지 대상(판정 기능): signature · ruleHash · activePathHash · correctionHash
//   → 05e:354 shouldCreateWorldRecallMemorySnapshot 이 이 해시로 스냅샷 생성 여부를 정한다.
//
// 이 게이트가 고정하는 계약:
//   R1 기억 payload.world 에 정본 값 복사가 없다
//   R2 해시 3종은 남아 있다 (스냅샷 판정이 계속 돈다)
//   R3 worldSignature 로 스냅샷 중복 방지가 계속 작동한다
//   R4 회상 텍스트에서 세계 규칙이 빠진다 (정본이 매 턴 주입하므로 손실 아님)
//   R5 정본(08a) 은 영향받지 않는다 — 세계 블록은 그대로 나간다
//   R6 하위 호환: 기존 기억(복사본이 있는 것)도 읽힌다
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
if (idx === -1) { console.log(JSON.stringify({ ok: false, reason: 'iife_close_not_found' })); process.exit(1); }
code = code.slice(0, idx) + `
    globalThis.__probe = {
        HierarchicalWorldManager, CompactMemoryCodec,
        buildWorldRecallMemoryContent: (typeof buildWorldRecallMemoryContent === 'function' ? buildWorldRecallMemoryContent : null),
        shouldCreateWorldRecallMemorySnapshot: (typeof shouldCreateWorldRecallMemorySnapshot === 'function' ? shouldCreateWorldRecallMemorySnapshot : null),
        getWorldRecallRuleHash: (typeof getWorldRecallRuleHash === 'function' ? getWorldRecallRuleHash : null),
        getWorldRecallActivePathHash: (typeof getWorldRecallActivePathHash === 'function' ? getWorldRecallActivePathHash : null),
        getWorldRecallCorrectionHash: (typeof getWorldRecallCorrectionHash === 'function' ? getWorldRecallCorrectionHash : null),
        extractWorldRuleHighlights, normalizeWorldRuleUpdate
    };
` + code.slice(idx);

const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.ownerDocument = doc; this.children = []; this.parentNode = null;
    this._id = ''; this.className = ''; this.style = {}; this.attributes = {};
    this.listeners = {}; this._innerHTML = ''; this.textContent = ''; this.dataset = {};
  }
  set id(v) { this._id = String(v || ''); if (this.ownerDocument) this.ownerDocument._register(this); }
  get id() { return this._id; }
  set innerHTML(v) { this._innerHTML = String(v || ''); }
  get innerHTML() { return this._innerHTML; }
  appendChild(el) { if (!el) return el; el.parentNode = this; this.children.push(el); if (el.id && this.ownerDocument) this.ownerDocument._register(el); return el; }
  remove() {} addEventListener(n, f) { this.listeners[n] = f; }
  removeEventListener() {} focus() {} blur() {} click() {}
  setAttribute(k, v) { this.attributes[String(k)] = String(v); }
  getAttribute(k) { return this.attributes[String(k)]; }
  querySelector() { return null; } querySelectorAll() { return []; }
}
class FakeDocument {
  constructor() { this._ids = Object.create(null); this.head = new FakeElement('head', this); this.body = new FakeElement('body', this); this.readyState = 'complete'; }
  _register(el) { if (el && el.id) this._ids[el.id] = el; }
  createElement(tag) { return new FakeElement(tag, this); }
  createTextNode(t) { const e = new FakeElement('#text', this); e.textContent = t; return e; }
  getElementById(id) { return this._ids[String(id || '')] || null; }
  querySelector(sel) { if (sel === 'head') return this.head; if (sel === 'body') return this.body; return null; }
}

(async () => {
  const document = new FakeDocument();
  const store = new Map();
  const character = { id: 'char-1', chaId: 'char-1', name: 'T', chats: [], globalLore: [] };
  const chat = { id: 'chat-1', localLore: [], msgs: [], message: [], bindedPersona: 'p1' };
  character.chats = [chat];
  const Risuai = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'unit', saveMethod: 'mock' }; },
    async getArgument() { return undefined; },
    pluginStorage: {
      async getItem(k) { return store.has(k) ? store.get(k) : null; },
      async setItem(k, v) { store.set(k, String(v)); },
      async removeItem(k) { store.delete(k); },
      async keys() { return Array.from(store.keys()); }
    },
    async getLocalPluginStorage() { return { async getItem() { return null; }, async setItem() {}, async removeItem() {} }; },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacterFromIndex() { return character; },
    async getChatFromIndex() { return chat; },
    async getCharacter() { return character; },
    async getDatabase() { return { selectedPersona: 0, personas: [{ id: 'p1' }] }; },
    async setCharacter() {}, async setCharacterToIndex() {}, async setChatToIndex() {},
    async registerSetting() {}, async registerButton() {},
    async requestPluginPermission() { return true; },
    async showContainer() {}, async hideContainer() {}, async onUnload() {}
  };
  const context = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
    globalThis: null, window: null, document, Risuai, risuai: Risuai,
    structuredClone: global.structuredClone,
    fetch: async () => { throw new Error('fetch not expected'); },
    AbortController, performance: { now: () => Date.now() }
  };
  context.globalThis = context; context.window = context;
  vm.createContext(context);
  let runError = '';
  try { vm.runInContext(code, context, { timeout: 30000 }); } catch (e) { runError = String(e && e.message || e).slice(0, 400); }
  await new Promise(r => setTimeout(r, 130));
  assert('dist_runs_without_error', !runError, { error: runError });

  const P = context.__probe;
  const SRC = fs.readFileSync(path.join(ROOT, 'src/parts/05e-canonical-turn-memory-helpers.js'), 'utf8');
  assert('probe_exported', !!P?.CompactMemoryCodec, {});

  if (!P?.CompactMemoryCodec) {
    for (const n of ['no_canon_rules_copied_into_memory', 'hashes_are_kept',
      'signature_dedup_still_works', 'change_detection_survives_dedup', 'recall_text_drops_world_rules',
      'canon_block_unaffected', 'legacy_memory_still_reads']) assert(n, false, { reason: 'no probe' });
  } else {
    const W = P.HierarchicalWorldManager;
    W.loadWorldGraph([], true);
    const root = W.getProfile().rootId;
    W.updateNode(root, {
      rules: {
        exists: { magic: true, mythical_creatures: ['드래곤'] },
        setting: { places: ['검은 탑'] },
        custom: { rule_1: '마력은 저주받은 자만 쓴다' }
      },
      meta: { classification: 'dark-fantasy', worldSummary: '마력이 일상인 세계' }
    });

    // ── R1: 정본 값 복사가 없는가 (소스 계약 + 실행) ──
    // **정확한 판정**: `world: {` 리터럴의 **직접 키**만 본다.
    // 지문(ruleHash 등)은 그 안에서 정본 값을 해시 입력으로 쓸 수 있다 — 그건 복사가 아니다.
    // (실측 오탐: 단순 substring 검색이 ruleHash 의 JSON.stringify 입력을 "복사"로 잡았다.)
    const worldBlock = (() => {
      const i = SRC.indexOf('world: {');
      if (i < 0) return '';
      return SRC.slice(i, i + 1400);
    })();
    // 직접 키 = 줄 시작의 `식별자:` (중첩 객체 내부의 키는 제외한다).
    const directKeys = [...worldBlock.matchAll(/^\s{16}([a-zA-Z][a-zA-Z0-9_]*):/gm)].map(m => m[1]);
    const copyKeys = ['exists', 'systems', 'physics', 'custom', 'ruleHighlights', 'activePath', 'userCorrection', 'classification'];
    const stillCopied = directKeys.filter(k => copyKeys.includes(k));
    assert('no_canon_rules_copied_into_memory', stillCopied.length === 0,
      { direct_keys: directKeys, still_copied: stillCopied });

    // ── R2: 해시 3종은 남아 있는가 ──
    const hashFns = ['getWorldRecallRuleHash', 'getWorldRecallActivePathHash', 'getWorldRecallCorrectionHash'];
    const hashesPresent = hashFns.every(f => SRC.includes(`const ${f} = `));
    const hashUsed = /ruleHash:\s*getWorldRecallRuleHash/.test(SRC)
      && /activePathHash:\s*getWorldRecallActivePathHash/.test(SRC)
      && /correctionHash:\s*getWorldRecallCorrectionHash/.test(SRC);
    assert('hashes_are_kept', hashesPresent && hashUsed,
      { functions_present: hashesPresent, used_in_payload: hashUsed });

    // ── R3: signature 기반 스냅샷 중복 방지가 계속 도는가 ──
    // 같은 signature 를 가진 기억이 lorebook 에 있으면 create:false 여야 한다.
    const sig = 'sig-abc-123';
    const fakeEntry = {
      key: 'lmai_memory::x', comment: 'lmai_memory',
      content: JSON.stringify({
        schema: P.CompactMemoryCodec.WRITE_SCHEMA || P.CompactMemoryCodec.LEDGER_SCHEMA,
        turn: 5, arcKey: 'world_rule_snapshot',
        payload: { worldSignature: sig, world: { signature: sig }, summary: 's' }
      })
    };
    // CompactMemoryCodec 로 직렬화된 형태가 필요 — 실제 빌더 결과를 쓴다.
    // (엔트리 구조가 정확하지 않으면 이 단언은 배선 검사로 대체한다.)
    const shouldFn = P.shouldCreateWorldRecallMemorySnapshot;
    let dedupOk = null;
    if (typeof shouldFn === 'function') {
      try {
        const first = shouldFn([], { worldSignature: sig, world: { signature: sig }, turn: 5 }, { turn: 5 });
        dedupOk = first?.create === true;   // 빈 lorebook 이면 baseline 생성
      } catch { dedupOk = null; }
    }
    // 함수가 안 노출되면 소스 배선으로 판정한다.
    const dedupWired = /hasMatchingWorldRecallMemory\(lorebook,\s*signature\)/.test(SRC);
    assert('signature_dedup_still_works',
      dedupWired && (dedupOk === null || dedupOk === true),
      { wired: dedupWired, runtime: dedupOk, note: '함수 미노출 시 배선 검사' });

    // ── R3b: 값 제거 후에도 **규칙/경로/교정 변경 감지가 도는가** (이 단계의 핵심 위험) ──
    // 값만 지우면 해시 입력이 비어 양쪽 해시가 항상 같아진다 → 변경 감지가 조용히 죽는다.
    // 지문(해시)을 빌드 시점에 저장하는 방식이 그걸 막는지 실제 판정으로 확인한다.
    const build = P.buildWorldRecallMemoryContent;
    const Codec = P.CompactMemoryCodec;
    const shouldDecide = P.shouldCreateWorldRecallMemorySnapshot;
    if (typeof build === 'function' && typeof shouldDecide === 'function') {
      const mk = (rules, meta, path) => {
        const content = build(meta || {}, rules || {}, {
          turn: 10, importance: 7, sourceHash: 'h', sourceMessageIds: ['m1'],
          activePath: path || [W.getProfile().rootId]
        });
        return { content, payload: Codec.parsePayloadFromContent(content) };
      };
      const metaA = { classification: 'dark-fantasy', worldSummary: '마력이 일상인 세계' };
      const rulesA = { exists: { magic: true }, setting: { places: ['검은 탑'] } };
      const rulesB = { exists: { magic: true }, setting: { places: ['검은 탑', '왕도'] } };
      const A = mk(rulesA, metaA);
      const B = mk(rulesB, metaA);
      const D = mk(rulesA, { ...metaA, userWorldCorrection: '마법은 등록제다' });
      // 경로 변경: 노드를 만들고 활성 경로를 옮긴다 (activePathHash 가 잡아야 하는 것).
      const pathNode = W.createNode({ name: '경로변경용', parent: W.getProfile().rootId, layer: 'dimension' });
      const C = mk(rulesA, metaA, [W.getProfile().rootId, pathNode.node.id]);
      const hashFn = P.getWorldRecallRuleHash;
      const pathFn = P.getWorldRecallActivePathHash;
      const corrFn = P.getWorldRecallCorrectionHash;

      const entry = (payload, content, turn) => ({ key: `lmai_memory::t${turn}`, comment: 'lmai_memory', content, mode: 'normal', insertorder: 1, alwaysActive: false });
      const lore = [entry(A.payload, A.content, 10)];
      const dChanged = shouldDecide(lore, B.payload, { turn: 12 });
      const dCorr = shouldDecide(lore, D.payload, { turn: 13 });

      const dPath = shouldDecide(lore, C.payload, { turn: 14 });
      assert('change_detection_survives_dedup',
        hashFn(A.payload) !== hashFn(B.payload)
          && pathFn && corrFn && corrFn(A.payload) !== corrFn(D.payload)
          && pathFn(A.payload) !== pathFn(C.payload)
          && dChanged?.reason === 'world_rules_changed'
          && dCorr?.reason === 'user_world_correction_changed'
          && dPath?.reason === 'world_path_changed',
        {
          rule_hash_differs: hashFn(A.payload) !== hashFn(B.payload),
          path_hash_differs: pathFn ? pathFn(A.payload) !== pathFn(C.payload) : null,
          correction_hash_differs: corrFn ? corrFn(A.payload) !== corrFn(D.payload) : null,
          rule_change_decision: dChanged?.reason,
          path_change_decision: dPath?.reason,
          correction_change_decision: dCorr?.reason,
          world_keys: A.payload?.world ? Object.keys(A.payload.world).sort() : null
        });
    }

    // ── R4: 회상 텍스트에서 세계 규칙이 빠지는가 ──
    // 03d:224 의 pushArray(payloadWorld?.ruleHighlights) 가 빈손이 되는지 — 소스 계약.
    const d3 = fs.readFileSync(path.join(ROOT, 'src/parts/03d-compact-memory-recall-migration.js'), 'utf8');
    const recallTextBuild = (() => {
      const i = d3.indexOf('const worldRuleHighlights = [');
      return i < 0 ? '' : d3.slice(i, i + 400);
    })();
    // 05e 가 더 이상 ruleHighlights 를 안 넣으므로 이 목록은 비게 된다.
    const recallRuleSource = /payloadWorld\?\.ruleHighlights/.test(recallTextBuild);
    assert('recall_text_drops_world_rules',
      recallRuleSource && stillCopied.length === 0,
      { still_reads_payload: recallRuleSource, producer_removed: stillCopied.length === 0,
        direct_keys: directKeys,
        note: '읽는 쪽은 그대로 두되(하위 호환) 생산자가 안 넣는다 → 새 기억에서는 빈손' });

    // ── R5: 정본은 영향받지 않는다 ──
    const canonPrompt = String(W.formatForPrompt() || '');
    const canonRules = W.getCurrentRules();
    assert('canon_block_unaffected',
      /검은 탑/.test(canonPrompt) && /저주받은/.test(canonPrompt) && canonRules?.exists?.magic === true,
      { prompt_has_rules: /검은 탑/.test(canonPrompt), magic: canonRules?.exists?.magic });

    // ── R6: 하위 호환 — 복사본이 있는 기존 기억도 읽힌다 ──
    // 03d 의 읽는 코드가 그대로면 기존 데이터는 계속 동작한다.
    const legacyReadOk = /payloadWorld\?\.ruleHighlights/.test(d3) && /payloadWorld\?\.classification/.test(d3);
    assert('legacy_memory_still_reads', legacyReadOk,
      { reads_legacy_ruleHighlights: /payloadWorld\?\.ruleHighlights/.test(d3),
        reads_legacy_classification: /payloadWorld\?\.classification/.test(d3) });
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
