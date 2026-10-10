'use strict';
// T09 of LIBRA_WorldMaker_Integration_Plan_20260925/docs/02_IMPLEMENTATION_PLAN.md
// (`01` sections 4, `03` A36/A37/A38)
//
// T09 connects canonical events to relation and motif history. The plan names four
// cases by hand:
//
//   * a confession that got no answer -- the relationship must not be promoted to
//     a mutual romance just because a confession happened;
//   * a reconciliation that did not restore the old trust -- the milestone is the
//     reconciliation, not a return to the previous state;
//   * two different rings with the same name -- a label is not an identity;
//   * a prop that merely repeats -- repetition alone is NOT a symbol.
//
// MEASURED DEFECT (before this change): `bookNarrativeModel` built `arcs` entries
// (story flow, turning points, motifs) but `BOOK_NARRATIVE_GROUPS` had no `arcs`
// tab, so they were never drawn -- the same display-layer drop as T08. There was
// also no relation-milestone group, so a directional relationship was readable only
// in the management screens.
//
// The model is EXECUTED from the shipped source against a fixed view, so a page
// that merely names the groups cannot pass.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync(process.env.LIBRA_TEST_PLUGIN || path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const between = (a, b) => {
  const i = source.indexOf(a); const j = source.indexOf(b, i);
  assert.ok(i >= 0 && j > i, `source anchors not found: ${a} .. ${b}`);
  return source.slice(i, j);
};

const results = [];
const record = (name, fn) => { fn(); results.push(name); };

// ── the almanac model, executed from the shipped source ──────────────────────
const modelFor = view => {
  const ctx = vm.createContext({
    guiAsObject: v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
    guiAsArray: v => (Array.isArray(v) ? v : []),
    text: v => String(v ?? '').trim(),
    compact: (v, n) => String(v ?? '').slice(0, n),
    bookNarrativeStatus: s => String(s || ''),
    bookNarrativeKind: k => String(k || '기타'),
    bookNarrativeTurn: r => Number(r?.turn || 0),
    bookNarrativeEvidence: row => {
      const records = [row, ...Object.values((row && typeof row === 'object' && row.fieldEvidence) || {}), row?.evidence].filter(Boolean);
      return records.flatMap(r => (Array.isArray(r?.evidenceSpans) ? r.evidenceSpans : [])
        .map(span => ({ memoryId: r?.memoryId || '', ref: span?.ref || '', quote: span?.quote || '', turn: 0 })));
    },
    worldManagerRelationshipDefinition: row => String(row?.state?.value || row?.definition || ''),
    Object, Array, String, Number, Set, Map, Math, JSON
  });
  vm.runInContext(
    `${between('const bookNarrativeStatus =', 'const bookNarrativeHistoryKey =')}
     Object.assign(globalThis, { bookNarrativeModel });`, ctx);
  return ctx.bookNarrativeModel(view, []);
};

// (1) a confession with no answer -- not a mutual romance.
record('A36 a confession without an answer stays a one-way milestone', () => {
  const view = {
    narrative: {},
    relationships: [{
      id: 'rel_confession', dimension: 'romance', status: 'active',
      subjectId: 'ce_mina', targetId: 'ce_jiho',
      summary: '민아가 지호에게 고백했다. 지호는 아직 답하지 않았다.',
      state: { value: '민아가 지호에게 고백했다. 지호의 답은 아직 없다.' },
      evidenceSpans: [{ ref: 't7-a', quote: '민아가 고백했고 지호는 답하지 않았다.' }]
    }]
  };
  const groups = modelFor(view);
  assert.ok(Array.isArray(groups.relations), 'the model publishes a relations group');
  assert.equal(groups.relations.length, 1, 'the confession is one milestone');
  const text = JSON.stringify(groups.relations[0]);
  // The row is shown as stated: one-way, with no answer. Nothing adds mutuality.
  assert.ok(/답하지 않았다|답은 아직 없다/.test(text), 'the unanswered state is carried through');
  assert.ok(!/서로|상호|둘 다 사랑|mutual/i.test(text),
    'no mutual romance is inferred from a one-way confession');
});

// (2) a reconciliation that did not restore the old trust.
record('A36 a reconciliation is not read as restored trust', () => {
  const view = {
    narrative: {},
    relationships: [{
      id: 'rel_mended', dimension: 'trust', status: 'active',
      subjectId: 'ce_mina', targetId: 'ce_junho',
      summary: '두 사람은 화해했다. 다만 예전처럼 서로를 믿지는 않는다.',
      state: { value: '화해했지만 예전 수준의 신뢰로 돌아가지 않았다.' },
      evidenceSpans: [{ ref: 't9-a', quote: '화해했지만 예전처럼 믿지는 않는다고 말했다.' }]
    }]
  };
  const text = JSON.stringify(modelFor(view).relations[0]);
  assert.ok(/화해/.test(text), 'the reconciliation is recorded');
  assert.ok(/예전|돌아가지 않/.test(text), 'the limited nature of the reconciliation is preserved');
  assert.ok(!/신뢰 회복|완전히 회복/.test(text), 'restored trust is not invented');
});

// (3) two different rings with the same name are not one thing.
record('A37 a repeated LABEL is not an identity', () => {
  // Two motifs that share a label but carry different, explicitly stated meanings.
  const view = {
    narrative: {
      motifs: [
        { id: 'm1', title: '은빛 반지', summary: '어머니가 남긴 은빛 반지', meaning: '가족의 기억' },
        { id: 'm2', title: '은빛 반지', summary: '기록회의 서약 은빛 반지', meaning: '맹세의 표식' }
      ]
    },
    relationships: []
  };
  const groups = modelFor(view);
  const motifs = groups.arcs.filter(row => /반지/.test(String(row.title || '')));
  assert.equal(motifs.length, 2, 'both rings are listed separately');
  const ids = new Set(motifs.map(row => row.id));
  assert.equal(ids.size, 2, 'the same label does not collapse them into one entry');
  const bodies = motifs.map(row => JSON.stringify(row)).join(' ');
  assert.ok(/가족의 기억|어머니/.test(bodies) && /맹세|서약/.test(bodies),
    'each ring keeps its own stated meaning instead of a shared label');
});

// (4) repetition alone is not a symbol.
record('A37 a merely repeated prop is not promoted to a symbol by the reading layer', () => {
  // A prop with no stated meaning: the almanac must not manufacture one. The model
  // reads motifs from the stored narrative; nothing here invents a meaning from the
  // fact that a word repeated.
  const view = {
    narrative: { motifs: [{ id: 'm3', title: '찻잔', summary: '찻잔', meaning: '' }] },
    relationships: []
  };
  const groups = modelFor(view);
  const cup = groups.arcs.find(row => /찻잔/.test(String(row.title || '')));
  assert.ok(cup, 'the repeated prop is listed as what it is');
  const body = String(cup.body || '');
  assert.ok(!/상징|symbol/i.test(body),
    'the reading layer does not label a repeated prop a symbol by itself');
  assert.equal(cup.kind, '반복 소재',
    'it is classified as a repeated prop, not upgraded to a meaning-bearing category');
});

record('A38 an episode reads from stored bundles and invents no summary', () => {
  // The almanac's episode view is the event/closed list built from stored facts and
  // canonical chapters. The model must expose those groups and must not synthesise
  // prose of its own.
  const groups = modelFor({ narrative: {}, relationships: [] });
  for (const key of ['threads', 'events', 'arcs', 'closed', 'relations']) {
    assert.ok(Array.isArray(groups[key]), `the model exposes the ${key} group`);
  }
  const model = between('const bookNarrativeModel =', 'const bookNarrativeHistoryKey =');
  assert.ok(!/summary\s*=\s*[^,;]*await|generate|callModel|runLLMModel/.test(model),
    'the almanac model never generates a summary');
  assert.ok(!/storage\.(getJson|setJson)/.test(model),
    'the almanac model reads the provided view, never storage directly');
});

record('the almanac publishes a tab for every group it builds', () => {
  const groupsLine = between('const BOOK_NARRATIVE_GROUPS =', 'const bookNarrativeStatus =');
  for (const key of ['threads', 'events', 'arcs', 'closed', 'relations']) {
    assert.ok(new RegExp(`\\['${key}'`).test(groupsLine),
      `the tab list carries ${key}, so the group is reachable (a group with no tab is never drawn)`);
  }
  // Every tab must have a matching group in the model, because the almanac reads
  // `groups[active].filter(...)` -- a tab without a group would throw at render.
  const model = between('const bookNarrativeModel =', 'const bookNarrativeHistoryKey =');
  for (const key of ['threads', 'events', 'arcs', 'closed', 'relations']) {
    assert.ok(new RegExp(`${key}\\s*:\\s*\\[\\]`).test(model),
      `the model declares the ${key} array for its tab`);
  }
});

console.log(JSON.stringify({
  test: 'libra_main_memory_episode_motif',
  passed: results.length,
  results,
  boundary: 'shipped almanac model executed against fixed views; no live RisuAI, no model calls'
}));
