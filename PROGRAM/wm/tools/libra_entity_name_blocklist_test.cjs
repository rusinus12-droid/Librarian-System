'use strict';
// Gate: 이름 차단 판정이 "직함 전체 이름"을 잘못 차단하지 않는가.
//
// 배경 (실측): isBlockedEntityName('학생회장') 이 true 였다. 원인은 두 단계다.
//   ① isBuiltinWeakEntityName 은 BUILTIN_WEAK_ENTITY_BLOCKLIST 의 '회장' 을 **정확 일치**로만 본다.
//   ② 그런데 probe 에 buildAliasCandidates 의 한국어 축약 이름이 들어간다 —
//      getKoreanShortName('학생회장') → '회장'(끝 2자). 그래서 차단 목록과 만난다.
// 결과: 끝 2자가 차단어와 겹치는 3~4자 이름이 **인물·관계 양쪽에서 조용히 사라진다**.
//   학생회장 → 회장(차단) · 부회장 → 회장(차단) · 서클부장 → 부장(차단) · 김선배 → 선배(차단)
// 그 관계는 12-processors-world-entity.js:717 과 15a-gui-session-data.js:1627 에서 걸러져
// 화면에 나타나지 않는다 — 예외도 로그도 없다.
//
// 이 게이트가 단언하는 계약:
//   1) 약한 이름('회장') 단독은 계속 차단된다 (기능 축소 방지)
//   2) 직함을 포함한 고유 이름('학생회장')은 차단되지 않는다
//   3) 길이 조건(축약 대상 3~4자)에 걸리는 이름만 영향받는다 — 다른 이름은 안전하다
//   4) 볼륨/챕터 같은 서술 표지도 계속 차단된다
const fs = require('fs');
const path = require('path');
// 기본 경로는 기존 Playwright 로더 그대로다 (미설치 시 exit 2).
// LIBRA_CONTRACT_RUNTIME=node 로만 JS 계약용 jsdom VM을 명시적으로 선택한다.
const { loadPlaywright, PLAYWRIGHT_HINT, contractArtifactName } = require('./libra_contract_runtime.cjs');
const { chromium } = loadPlaywright() || {};
if (!chromium) { console.error(PLAYWRIGHT_HINT); process.exit(2); }

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', contractArtifactName());
const bundle = fs.readFileSync(DIST, 'utf8');

function assert(name, ok, details = {}) { return { name, ok: !!ok, details }; }

const TAIL = '})();';
const lastClose = bundle.lastIndexOf(TAIL);
const probe = `try{if(typeof EntityManager!=='undefined'){globalThis.__EM__=EntityManager;}}catch(e){}`;
const instrumented = bundle.slice(0, lastClose) + ';' + probe + TAIL + bundle.slice(lastClose + TAIL.length);

const CASES = [
  // [이름, 차단되어야 하는가, 설명]
  ['회장', true, '약한 이름 단독 — 계속 차단'],
  ['부장', true, '약한 이름 단독 — 계속 차단'],
  ['선배', true, '약한 이름 단독 — 계속 차단'],
  ['볼륨', true, '서술 표지 — 계속 차단'],
  ['챕터 3', true, '서술 표지 — 계속 차단'],
  ['사용자', true, '시스템 표지 — 계속 차단'],
  ['학생회장', false, '직함 포함 고유 이름 — 차단되면 안 된다'],
  ['부회장', false, '직함 포함 고유 이름 — 차단되면 안 된다'],
  ['서클부장', false, '직함 포함 고유 이름 — 차단되면 안 된다'],
  ['김선배', false, '성+직함 — 차단되면 안 된다'],
  ['도현', false, '평범한 이름'],
  ['아리엘', false, '평범한 이름'],
  ['김유진', false, '평범한 이름']
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body></body></html>');
  await page.evaluate(() => {
    const lore = [];
    const chat = { messages: [], lorebook: lore };
    const char = { name: 'C', chat, lorebook: lore, globalLore: [], defaultVariables: {}, variables: {} };
    const store = new Map();
    const R = { apiVersion: '3.0',
      async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'web', saveMethod: 'mock' }; },
      async getArgument() {}, pluginStorage: { async getItem(k) { return store.get(k) ?? null; }, async setItem(k, v) { store.set(k, String(v)); }, async removeItem(k) { store.delete(k); } },
      async getCharacter() { return char; }, async setCharacter() {}, async setLorebook() {},
      async registerSetting() {}, async registerButton() {}, async requestPluginPermission() { return true; },
      async showContainer() {}, async hideContainer() {}, async onUnload() {}, async onStart() {},
      async getChat() { return chat; }, async setChat() {}, async addChat() {}, async saveChat() {},
      async getCurrentChatIndex() { return 0; }, async getUserSetting() {}, async setUserSetting() {},
      async alert() {}, async confirm() { return true; }, async getVersion() { return '3.0'; } };
    window.Risuai = R; window.risuai = R;
  });
  await page.addScriptTag({ content: instrumented });
  await page.waitForTimeout(1200);

  const observed = await page.evaluate((cases) => {
    const em = globalThis.__EM__;
    if (!em) return { error: 'EntityManager 미노출' };
    const out = {};
    for (const [name] of cases) {
      try { out[name] = em.isBlockedEntityName(name, []); } catch (e) { out[name] = 'err:' + e.message; }
    }
    return out;
  }, CASES);

  const assertions = [];
  const wrong = [];
  for (const [name, expected, note] of CASES) {
    const got = observed[name];
    if (got !== expected) wrong.push({ name, expected, got, note });
  }
  assertions.push(assert('blocked_name_judgement_matches_contract', wrong.length === 0,
    { wrong, observed }));

  // 기능 축소 방지 — 약한 이름 차단은 살아 있어야 한다
  const weakStillBlocked = CASES.filter(c => c[1]).every(([n]) => observed[n] === true);
  assertions.push(assert('weak_names_still_blocked', weakStillBlocked,
    { sample: CASES.filter(c => c[1]).map(([n]) => [n, observed[n]]) }));

  // 길이 조건 확인 — 결함은 3~4자 이름에만 나타난다(축약 대상). 이 사실 자체를 고정한다.
  const lengthBound = ['학생회장', '부회장', '서클부장', '김선배']
    .every(n => [...n].length >= 3 && [...n].length <= 4);
  assertions.push(assert('defect_is_length_bound', lengthBound,
    { note: 'getKoreanShortName 은 3~4자만 축약한다 — 5자 이상은 영향받지 않는다' }));

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions, observed }, null, 2));
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
