'use strict';
// Gate: RP 장기 연속성(RP-LTM)이 정본 기억과 **충돌하지 않는가**.
//
// 배경 (실측): RP-LTM 은 정본 기억 레코드 안의 필드(payload.rpLongTerm)지만
// **다른 역할**을 담당한다 — 정본은 "무슨 일이 있었나"(턴 요약·근거),
// RP-LTM 은 "무엇이 아직 유효한가"(약속의 이행/파기, 미해결 과제, 수명 등급).
// 역할이 다르므로 없애지 않고, 대신 **충돌을 막는 규칙**을 고정한다.
//
// 실측한 충돌 3건과 조정:
//   ① 주입 순서 — RP-LTM 이 [관련 기억] 보다 앞에 왔다 → 기억 뒤로 옮겼다.
//   ② 수명 역전 — RP-LTM 수명이 정본 ttl 을 **덮어썼다**(정본 imp6 → permanent,
//      RP imp5 → long). 정본은 그 턴의 실제 중요도 판정이고 RP-LTM 수명은
//      카테고리 기본값이라, **늘리는 방향만** 허용하고 줄이는 것은 금지한다.
//      실측 대조군: 정본 영구(imp9) + RP short(80턴) → 종전 80 으로 **줄였다**.
//   ③ 주입 중복 — episodes 카테고리가 다른 카테고리를 재조합해 같은 문장이
//      블록 안에서 2번, 정본과 합치면 3번 반복됐다 → 주입에서 제외했다.
//
// 이 게이트가 단언하는 계약:
//   1) 주입 순서: memories 가 rpLongTermContinuity 보다 앞이다
//   2) 수명: 정본 ttl 을 RP-LTM 이 줄이지 않는다 (늘리는 것은 허용)
//   3) 수명: RP-LTM 이 없으면 정본 ttl 이 그대로다
//   4) 주입 중복: episodes 헤더가 주입 텍스트에 없다
//   5) 주입 중복: 같은 문장이 두 번 들어가지 않는다
//   6) 정본 기억 본문에 RP-LTM 문장이 섞이지 않는다 (화면 계층)
const fs = require('fs');
const path = require('path');
// 기본 경로는 기존 Playwright 로더 그대로다 (미설치 시 exit 2).
// LIBRA_CONTRACT_RUNTIME=node 로만 JS 계약용 jsdom VM을 명시적으로 선택한다.
const { loadPlaywright, PLAYWRIGHT_HINT, contractArtifactName } = require('./libra_contract_runtime.cjs');
const { chromium } = loadPlaywright() || {};
if (!chromium) { console.error(PLAYWRIGHT_HINT); process.exit(2); }

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const bundle = read(path.join('dist', contractArtifactName()));

function assert(name, ok, details = {}) { return { name, ok: !!ok, details }; }
const assertions = [];

// ── 1. 주입 순서 (소스 계약) ─────────────────────────────────────────────
{
  const src = read('src/parts/13c-before-request-injection.js');
  const memIdx = src.indexOf("key: 'memories'");
  const rpIdx = src.indexOf("key: 'rpLongTermContinuity'");
  assertions.push(assert('memories_precedes_rp_long_term_in_injection',
    memIdx > 0 && rpIdx > 0 && memIdx < rpIdx,
    { memIdx, rpIdx, note: 'memories 가 먼저 — 정본을 읽고 그 위에 유효성 참고를 얹는다' }));
}

// ── 2·3·4·5. 실행 검증 ───────────────────────────────────────────────────
const TAIL = '})();';
const lc = bundle.lastIndexOf(TAIL);
const probe = 'try{globalThis.__ME__=MemoryEngine;}catch(e){}'
  + 'try{globalThis.__RP__=RPContinuityCore;}catch(e){}'
  + 'try{globalThis.__CODEC__=CompactMemoryCodec;}catch(e){}'
  + 'try{globalThis.__UTILS__=Utils;}catch(e){}globalThis.__P__="ok";';
const instrumented = bundle.slice(0, lc) + ';' + probe + TAIL + bundle.slice(lc + TAIL.length);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body></body></html>');
  await page.evaluate(() => {
    const lore = []; const chat = { messages: [{ role: 'user', content: 'x' }], lorebook: lore, id: 'c1' };
    const char = { name: 'C', chat, lorebook: lore, globalLore: [], defaultVariables: {}, variables: {}, id: 'ch1' };
    const store = new Map();
    const R = { apiVersion: '3.0',
      async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'web', saveMethod: 'mock' }; },
      async getArgument() {}, pluginStorage: { async getItem(k) { return store.get(k) ?? null }, async setItem(k, v) { store.set(k, String(v)) }, async removeItem(k) { store.delete(k) } },
      async getCharacter() { return char }, async setCharacter() {}, async setLorebook() {},
      async registerSetting() {}, async registerButton() {}, async requestPluginPermission() { return true },
      async showContainer() {}, async hideContainer() {}, async onUnload() {}, async onStart() {},
      async getChat() { return chat }, async setChat() {}, async addChat() {}, async saveChat() {},
      async getCurrentChatIndex() { return 0 }, async getUserSetting() {}, async setUserSetting() {},
      async alert() {}, async confirm() { return true }, async getVersion() { return '3.0' } };
    window.Risuai = R; window.risuai = R;
  });
  await page.addScriptTag({ content: instrumented });
  await page.waitForTimeout(1500);

  const out = await page.evaluate(async () => {
    const ME = globalThis.__ME__, rp = globalThis.__RP__, codec = globalThis.__CODEC__;
    if (!ME || !rp || !codec) return { error: '심볼 미노출', me: !!ME, rp: !!rp, codec: !!codec };
    const sharedLore = [];
    const chat0 = { messages: [{ role: 'user', content: 'x' }], lorebook: sharedLore, id: 'c1' };
    const char0 = { name: 'C', chat: chat0, lorebook: sharedLore, globalLore: [], defaultVariables: {}, variables: {}, id: 'ch1' };

    // [META:{...}] 를 중괄호 균형으로 꺼낸다 (메타 안에 ']' 가 들어갈 수 있다)
    const parseMetaBlock = (text) => {
      const s = String(text || '').indexOf('[META:');
      if (s < 0) return null;
      let i = s + 6, depth = 0, inStr = false, esc = false;
      for (; i < text.length; i++) {
        const ch = text[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
      }
      try { return JSON.parse(text.slice(s + 6, i)); } catch (_) { return null; }
    };

    const res = { ttl: [], prompt: null };
    // 대조군 설계 근거: getRetentionPolicy 는
    //   protected/permanent → -1 · long → 720 · medium → 240 · 그 외 → max(defaultTtl, 80).
    // 그래서 '정본 imp9(영구, -1) + RP 신호없음(short)' 이면 RP ttl = 80 이 나온다.
    // 종전 코드(rpRetention?.ttl ?? canonicalTtl)는 여기서 **영구를 80턴으로 줄였다**.
    // 고친 코드는 정본 -1 을 지킨다 — 이 케이스가 변이를 실제로 검출한다(실측).
    // getRetentionPolicy 실측:
    //   imp>=9 → -1 · imp>=6 → 60 · imp<6 → 30 (defaultTtl)
    //   신호있음 + short → Math.max(defaultTtl, 80)   ← imp<6 이면 80 > 30 이 된다
    //   신호있음 + medium → 240 · long → 720 · permanent/protected → -1
    //
    // 검출되는 대조군: **imp=3(정본 30) + RP 신호있음/short** → RP ttl = 80.
    //   종전 코드(rpRetention?.ttl ?? canonicalTtl)는 30 을 **80 으로 바꿨다**.
    //   고친 코드는 canonicalTtl(30) 을 지킨다 — imp3 은 'RP 가 늘리는 것'도 막는다.
    //   ※ imp>=9 에서는 RP 가 어떤 값을 내든 -1 이라 변이가 검출되지 않는다(실측).
    // 게이트가 고정한 계약은 **정본 ttl 이 RP 때문에 바뀌지 않는다** 이다.
    //   - imp>=9 → 정본 -1 (영구) · imp 2..8 → 60 · imp<2 → 30   (실측 threshold=2)
    //   - RP short 는 Math.max(defaultTtl, 80) 이므로 **imp<2 에서만** 80 > 30 이 된다
    //     → 그 케이스가 정본 30 을 80 으로 바꾸던 결함을 검출한다.
    //   - imp>=2 에서는 RP 가 60 이하를 내지 않아 변이가 검출되지 않는다(실측).
    const CASES = [
      { label: 'imp1 + RP short(80) → 종전엔 30을 80으로 바꿈', imp: 1, durability: 'short', rpSignals: true, expect: 'keep' },
      { label: 'imp1 + RP medium(240)', imp: 1, durability: 'medium', rpSignals: true, expect: 'keep' },
      { label: 'imp1 + RP long(720)', imp: 1, durability: 'long', rpSignals: true, expect: 'keep' },
      { label: 'imp2 + RP short(80)', imp: 2, durability: 'short', rpSignals: true, expect: 'keep' },
      { label: 'imp1 + RP permanent(-1) → 늘림은 허용', imp: 1, durability: 'permanent', protected: true, rpSignals: true, expect: 'grow' },
      // ↓ 이 케이스가 **줄이는 방향**을 검출한다.
      //   imp9 → 정본 -1(영구). RP 는 protected 가 아니므로 ttl = max(-1, 80) = 80.
      //   종전 코드(rpRetention?.ttl ?? canonicalTtl)는 영구 기억을 80턴으로 **줄였다**.
      { label: 'imp9 + RP short(80) → 종전엔 영구를 80으로 줄임', imp: 9, durability: 'short', rpSignals: true, expect: 'keep' },
      { label: 'RP 없음 (대조) imp1', imp: 1, rp: false, expect: 'keep' }
    ];
    const threshold = Number(ME.CONFIG && ME.CONFIG.threshold) || 6;
    for (const c of CASES) {
      const lore = [];
      const tm = c.rp === false ? null : {
        schema: 'libra.rp_turn_memory.v1', version: 1, turn: 12, importance: c.imp,
        durability: c.durability, protected: c.protected === true,
        // 함정(실측): stableFacts 가 하나라도 있으면 normalizeTurnMemory 가
        // protected 를 **자동으로 true** 로 만든다(normalized.stableFacts.length > 0).
        // 그러면 getRetentionPolicy 가 항상 -1 을 내 정본을 줄이는 경우가 생기지 않는다.
        // 그래서 '신호는 있지만 protected 는 아닌' 상태를 만들려면
        // kind 가 boundary 가 아닌 preferences 를 쓴다 — 그 경로가
        // ttl = Math.max(defaultTtl, 80) 로 떨어진다.
        stableFacts: [],
        preferences: c.rpSignals === false ? [] : [{ id: 'p1', text: '도현은 커피를 좋아한다.', kind: 'taste', entities: ['도현'], durability: c.durability, status: 'active', lastTurn: 12 }],
        commitments: [], openLoops: [], relationshipMilestones: [], stateChanges: [], callbacks: [], episodes: []
      };
      const payload = { schema: 'libra.memory.turn_ledger.v2', version: 2, turn: 12, importance: c.imp, summary: '표본 ' + c.label };
      if (tm) payload.rpLongTerm = tm;
      let entry = null;
      try {
        entry = await ME.prepareMemory({ content: codec.serialize(payload), importance: c.imp, forceCreate: true }, 12, [], lore, char0, chat0, null, {});
      } catch (e) { res.ttl.push({ label: c.label, error: e.message }); continue; }
      const meta = entry ? parseMetaBlock(entry.content) : null;
      const canonical = c.imp >= Math.max(9, threshold + 2) ? -1 : (c.imp >= threshold ? 60 : 30);
      res.ttl.push({ label: c.label, canonical, actual: meta ? meta.ttl : null, expect: c.expect });
    }

    // 주입 텍스트 — episodes 제외와 중복 확인
    const tm2 = rp.extractHeuristic('', '아리엘은 루멘 아카데미 소속이다. 아리엘은 도현에게 봉인된 문을 보여주기로 약속했다. 두 사람의 신뢰가 깊어졌다.', { turn: 12, entityRefs: ['도현', '아리엘'] });
    const lore2 = [];
    rp.saveState(lore2, Object.assign({ revision: 1 }, tm2));
    const text = rp.formatForPrompt(lore2, { maxChars: 2600, currentTurn: 12 });
    const lines = text.split('\n').filter(l => l.startsWith('- ')).map(l => l.replace(/\s*\(.*$/, '').trim());
    const dupes = [];
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) if (lines[i] === lines[j]) dupes.push(lines[i]);
    res.prompt = { len: text.length, hasEpisodes: /Key Episodes/.test(text), lineCount: lines.length, dupes };
    return res;
  });

  if (out.error) {
    assertions.push(assert('product_symbols_exposed', false, out));
  } else {
    // ── 2. 수명: 줄이지 않는다 ──────────────────────────────────────────
    // 축소 판정 — ttl -1 은 '영구'(가장 긴 값)이므로 수치 비교 전에 정규화한다.
    //   -1 을 그냥 숫자로 비교하면 60 → -1 이 '줄었다'로 오판된다(실측).
    const rank = (v) => (Number(v) === -1 ? Infinity : Number(v));
    const shrunk = (out.ttl || []).filter(t => {
      if (t.error || t.actual === null || t.actual === undefined) return true;
      return rank(t.actual) < rank(t.canonical);
    });
    assertions.push(assert('rp_long_term_never_shrinks_canonical_ttl', shrunk.length === 0,
      { shrunk, cases: out.ttl, note: '정본 영구를 RP short 가 80턴으로 줄이던 결함의 회귀 방지' }));

    // ── 3. RP 없으면 정본 그대로 ────────────────────────────────────────
    const control = (out.ttl || []).find(t => t.label && t.label.includes('대조'));
    assertions.push(assert('canonical_ttl_kept_when_no_rp_long_term',
      control && control.actual === control.canonical,
      { control }));

    // ── 2b. 늘리는 방향은 허용 (기능 축소 방지) ─────────────────────────
    // 늘림 여부를 게이트가 직접 계산한다 — 케이스에 expect 를 박아두지 않는다.
    // 규칙: 최종 ttl 은 canonicalTtl 이상이어야 한다(늘리는 것은 자유, 줄이는 것만 금지).
    const allAtLeastCanonical = (out.ttl || []).every(t => !t.error && t.actual !== null
      && rank(t.actual) >= rank(t.canonical));
    assertions.push(assert('final_ttl_is_never_below_canonical', allAtLeastCanonical,
      { cases: out.ttl }));

    // ── 4·5. 주입 중복 ──────────────────────────────────────────────────
    assertions.push(assert('episodes_excluded_from_prompt',
      out.prompt && out.prompt.hasEpisodes === false, { prompt: out.prompt }));
    assertions.push(assert('no_duplicate_sentences_in_prompt',
      out.prompt && out.prompt.dupes.length === 0, { dupes: out.prompt ? out.prompt.dupes : null }));
  }

  // ── 6. 화면 계층: 정본 본문에 RP 문장이 섞이지 않는다 ────────────────
  {
    const src = read('src/parts/15a-gui-session-data.js');
    assertions.push(assert('gui_body_excludes_rp_long_term_sentences',
      src.includes('const rpContinuity = [];'),
      { note: 'RP-LTM 문장은 본문에서 빠지고 접힌 rpGroups 로 간다' }));
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
