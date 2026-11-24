'use strict';
// Search engine & final injected prompt composition suite:
// 1. Korean particle stemming in exactSignal, scorePrecomputed, and extractCanonicalSearchMetadata
// 2. Korean State field label indexing & entity-aware slot weighting in select()
// 3. allocationPlan hybrid intent & current canonical floor without breaking standard policy caps
// 4. Secondary `scene` signal continuity in select() and runtime.query()
// 5. Final 4-tier prompt order (CURRENT STATE grouped -> ACTIVE CONSTRAINTS & MOMENTUM -> RECENT CHANGES -> RECORDED HISTORY -> SCENE DETAILS -> PERSPECTIVE NOTES) & streamlined UNIFIED_RECALL_RULES
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const createEngine = require('../tools/libra_state_memory_engine.cjs');
const createRuntime = require('../tools/libra_state_memory_runtime.cjs');

const fingerprint = value => {
  let h = 2166136261;
  const s = String(value ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
};

const engine = createEngine({ fingerprint });

test('Korean particle stemming matches across differing particles and strips particles from canonical searchTerms', () => {
  assert.equal(engine.exactSignal('은빛 열쇠가 서재에 있다', '열쇠를 서재에서'), 1);
  assert.ok(engine.score('민아는 서재에 도착했다', '민아가 서재로') > 1.5);

  const meta = engine.extractCanonicalSearchMetadata({
    title: '서재의 은빛 열쇠',
    canonicalArtifact: {
      schema: 'libra.canonical_artifact.v5',
      entities: [{ tempId: 'mina', name: '민아', type: 'person', kind: 'person' }],
      facts: [{ domain: 'event', claimKind: 'event', text: '민아가 서재에서 은빛 열쇠를 지호에게 넘겼다.' }]
    }
  });
  assert.ok(meta.searchTerms.includes('민아'));
  assert.ok(meta.searchTerms.includes('서재'));
  assert.ok(meta.searchTerms.includes('열쇠'));
  assert.ok(meta.searchTerms.includes('지호'));
  assert.ok(!meta.searchTerms.includes('민아가'));
  assert.ok(!meta.searchTerms.includes('열쇠를'));
});

test('stateRows indexes Korean field labels and weights extra fields of the same entity at 0.35 slots', () => {
  const rows = engine.stateRows({
    throughTurn: 5,
    characters: [{
      id: 'char_mina',
      name: '민아',
      state: { locationRef: 'loc_study', condition: '긴장', mood: '경계', goal: '열쇠 회수', emotions: '불안' }
    }],
    world: [{ id: 'loc_study', name: '서재', state: { condition: '조용함' } }]
  });
  const locRow = rows.find(r => r.stateField === 'locationRef');
  assert.ok(locRow && locRow.entityGroupKey === 'characters:민아');
  assert.ok(locRow.text.includes('위치 (locationRef)'), 'text indexes Korean label alongside field name');
  assert.ok(engine.score(locRow.text, '위치') > 0, 'Korean label query matches State row lexically');

  // With 5 fields for 민아 + 1 canonical + 1 micro under maxItems: 5, entity slot weighting keeps both canonical and micro
  const pool = [
    ...rows.filter(r => r.entityGroupKey === 'characters:민아'),
    { id: 'can1', family: 'canonical', axis: 'narrative', turn: 3, text: '민아가 서재에서 서약을 맺었다.', evidenceKeys: ['c1'] },
    { id: 'mic1', family: 'micro', axis: 'narrative', turn: 4, text: '민아가 열쇠를 확인하며 한숨을 쉬었다.', evidenceKeys: ['m1'] }
  ];
  const selected = engine.select({
    rows: pool,
    query: '민아',
    maxItems: 5,
    minimumPerAxis: 0,
    maxCharacters: 4000
  });
  assert.ok(selected.items.some(i => i.id === 'can1'), 'canonical slot survives alongside multi-field entity State');
  assert.ok(selected.items.some(i => i.id === 'mic1'), 'micro slot survives alongside multi-field entity State');
});

test('allocationPlan supports hybrid current+history queries and current canonical floor while preserving standard caps', () => {
  const hybrid = engine.allocationPlan('지금 두 사람이 왜 어색해?', 40, { maxItems: 24, canonicalCap: 16, microCap: 12 });
  assert.equal(hybrid.intent, 'mixed');
  assert.equal(hybrid.canonicalCandidates, 11);

  const cur = engine.allocationPlan('지금 은빛 열쇠 보유자는 누구야?', 40, { maxItems: 24, canonicalCap: 16, microCap: 12 });
  assert.equal(cur.intent, 'current');
  assert.equal(cur.canonicalCandidates, 6);

  const hist = engine.allocationPlan('열쇠의 과거 경위', 40, { maxItems: 24, canonicalCap: 16, microCap: 12 });
  assert.equal(hist.intent, 'history');
  assert.deepEqual([hist.canonicalCandidates, hist.microCandidates], [16, 6]);
});

test('scene secondary signal keeps scene-relevant rows in select() and runtime.query() on short user input', async () => {
  const frame = {
    head: {
      throughTurn: 4,
      characters: [{ id: 'c1', name: '민아', state: { locationRef: '도서관 서재', condition: '건강함', goal: '고문서 해독' } }],
      narrative: {
        locks: [{ title: '금고 비밀', summary: '비밀 금고 번호를 외부에 발설하지 않기로 맹세함', status: 'active' }],
        momentum: '도서관 서재 비밀 금고 밖에서 기록회 감시자가 대기 중이다.'
      }
    },
    refs: [{ key: 'ref-1', memoryId: 'm1', revision: 1, turnRange: { start: 1, end: 4 }, searchText: '도서관 서재 비밀 금고', searchTerms: ['도서관', '서재', '비밀', '금고'] }],
    turns: [1],
    settings: {},
    identity: 'snap-1',
    owner: 'libra',
    scope: { scopeKey: 'scope-1' },
    worldlineId: 'main',
    stateKey: 'state-1',
    stateAuthority: { current: true, pending: false },
    check() {},
    async canonical() {
      return {
        key: 'ref-1',
        proofs: [],
        rows: [{ id: 'c1', family: 'canonical', axis: 'narrative', domain: 'event', turn: 2, sourceKey: 'ref-1', text: '서재 북쪽 벽 뒤에 비밀 금고가 숨겨져 있다.', evidenceKeys: ['canon:m1:1:f1'] }]
      };
    },
    async micro() {
      return {
        key: 'micro-1',
        proofs: [],
        rows: [{ id: 'm1', family: 'micro', axis: 'narrative', domain: 'event', turn: 1, sourceKey: 'micro-1', text: '민아가 서재 비밀 금고의 놋쇠 손잡이를 매만졌다.', evidenceKeys: ['micro:1'] }]
      };
    },
    async lens() {
      return {
        key: 'lens-1',
        proofs: [],
        rows: [{ id: 'l1', family: 'lens', axis: 'narrative', turn: 3, sourceKey: 'lens-1', text: '[PERSPECTIVE NOTES · NON-CANONICAL] [시선 추적] 민아는 비밀 금고를 열지 망설이고 있다.', lensItem: { lensId: 'l1', floorPassed: true } }]
      };
    },
    register() { return 'tok'; },
    async assertCurrent() {},
    release() {}
  };

  const runtime = createRuntime({ engine, capture: async () => frame, fingerprint: String, authorityStore: new Map() });
  const result = await runtime.query({
    queryText: '응, 조심스럽게 열어 본다.',
    sceneText: '민아가 도서관 서재의 비밀 금고 앞에 서 있다.',
    sceneWeight: 0.65
  });

  const text = result.packet.renderedText;
  assert.match(text, /비밀 금고가 숨겨져 있다/, 'scene signal pulls canonical fact on short user reply');
  assert.match(text, /놋쇠 손잡이를 매만졌다/, 'scene signal pulls micro detail on short user reply');
  assert.match(text, /\[ACTIVE CONSTRAINTS & MOMENTUM — scene conditions that must hold\]/);
  assert.match(text, /- \[LOCK\] .*:.*비밀 금고 번호를 외부에 발설하지 않기로 맹세함/);
  assert.match(text, /- \[MOMENTUM\] .*:.*기록회 감시자가 대기 중이다/);

  // Verify 4-tier section order: CURRENT STATE < ACTIVE CONSTRAINTS < RECORDED HISTORY < SCENE DETAILS < PERSPECTIVE NOTES
  const iState = text.indexOf('[CURRENT STATE');
  const iConst = text.indexOf('[ACTIVE CONSTRAINTS & MOMENTUM');
  const iHist = text.indexOf('[RECORDED HISTORY');
  const iDetail = text.indexOf('[SCENE DETAILS');
  const iPersp = text.indexOf('[PERSPECTIVE NOTES');
  assert.ok(iState >= 0 && iConst > iState && iHist > iConst && iDetail > iHist && iPersp > iDetail,
    `unexpected section order in:\n${text}`);

  // Contiguous grouping keeps same entity's fields adjacent
  const blockLines = text.split('\n');
  const minaLines = blockLines.map((line, idx) => (line.startsWith('- 민아 — ') ? idx : -1)).filter(idx => idx >= 0);
  if (minaLines.length >= 2) {
    assert.equal(minaLines.at(-1) - minaLines[0], minaLines.length - 1, 'same-entity State lines stay contiguous');
  }
  runtime.release(result);
});

test('LIBRA UNIFIED_RECALL_RULES is streamlined while retaining required authority & precedence clauses', () => {
  const src = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
  const match = /const UNIFIED_RECALL_RULES = \[([\s\S]*?)\]\.join\('\\n'\);/.exec(src);
  assert.ok(match);
  const rules = new Function(`return [${match[1]}].join('\\n');`)();
  assert.ok(rules.includes('Sections, in order of authority: CURRENT STATE is how things stand now'));
  assert.ok(rules.includes('ACTIVE CONSTRAINTS & MOMENTUM'));
  assert.ok(rules.includes('they never override CURRENT STATE or recorded facts'));
  assert.ok(!rules.includes('T<n>') && !rules.includes('dated after the CURRENT STATE turn'));
  assert.ok(rules.length < 1050, `expected streamlined UNIFIED_RECALL_RULES under 1050 chars, got ${rules.length}`);
});
