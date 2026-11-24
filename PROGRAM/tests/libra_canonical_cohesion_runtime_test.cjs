'use strict';
// Canonical anti-fragmentation runtime & reader test:
// - unifiedPromptContract causal/multi-span synthesis instructions & existing invariants
// - v4/v5 extractCanonicalSearchMetadata support (facts + entities + legacy chronology)
// - engine.select linkedSearchText scoring, causal suffix bundling, sibling deduplication & budget limits
// - End-to-end State commit + replay seal + recall causal bundling (explicit dependsOn & legacy fallback)
// - Isolation of uncertain/historical/pending facts
// - Book Canonical Reader "연계 흐름" / "도메인 분류" / markdown fallback rendering
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const input = require('./fixtures/unified_vertical_source.json');
const engine = require('../tools/libra_state_memory_engine.cjs')({
  fingerprint: value => {
    let h = 2166136261;
    const s = String(value ?? '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  },
  tokenizer: text => String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
});

const source = fs.readFileSync(process.env.LIBRA_TEST_PLUGIN || path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const quote = ref => input.sourceRows.find(r => r.ref === ref).text;

const between = (a, b) => {
  const i = source.indexOf(a);
  const j = source.indexOf(b, i);
  assert.ok(i >= 0 && j > i, `source anchors not found: ${a} .. ${b}`);
  return source.slice(i, j);
};

const flatDom = node => {
  if (!node || typeof node !== 'object') return [];
  const children = Array.isArray(node.children) ? node.children : [];
  return [node, ...children.flatMap(flatDom)];
};

const domText = node => flatDom(node).map(n => (n.text == null ? '' : String(n.text))).join('\n');

test('unifiedPromptContract includes multi-span & causal synthesis rules while keeping strict invariants', () => {
  const match = /const unifiedPromptContract = \(\) => \[([\s\S]*?)\]\.join\('\\n'\);/.exec(source);
  assert.ok(match, 'unifiedPromptContract must exist');
  const contract = vm.runInNewContext(`[${match[1]}].join('\\n')`, {
    UNIFIED_ARTIFACT_SCHEMA_V5: 'libra.canonical_artifact.v5',
    CONTINUITY_STATE_RELATION_DIMENSIONS: ['trust', 'affection', 'tension', 'hierarchy', 'debt']
  });
  assert.match(contract, /cite 1–4 evidenceSpans/);
  assert.match(contract, /COHESIVE SCENE SYNTHESIS & CAUSAL LINKING:/);
  assert.match(contract, /dependsOn:\["f<id>"\]/);
  assert.match(contract, /never put historical, flashback, reported, hypothetical, or uncertain facts into a confirmed current_sequence fact’s dependsOn/);
  assert.match(contract, /shortest exact supporting quotation \(2–320 normalized characters\)/);
  assert.match(contract, /ACTOR KNOWLEDGE:/);
  assert.match(contract, /WORLD IDENTITY:/);
});

test('extractCanonicalSearchMetadata indexes v4/v5 facts and entities cleanly alongside legacy chronology', () => {
  const meta = engine.extractCanonicalSearchMetadata({
    title: '서재의 은빛 열쇠 사건',
    canonicalArtifact: {
      schema: 'libra.canonical_artifact.v5',
      entities: [
        { tempId: 'mina', name: '민아', type: 'person', kind: 'person' },
        { tempId: 'jiho', name: '지호', type: 'person', kind: 'person', aliases: ['관리자대행'] }
      ],
      facts: [
        { domain: 'character', claimKind: 'character_state', text: '민아는 피곤한 기색을 보였다.' },
        { domain: 'event', claimKind: 'event', text: '지호가 서재에서 은빛 열쇠 비밀 약속을 건넸다.' },
        { domain: 'narrative', claimKind: 'turning_point', text: '공연 허가 담당자 미스터리 전환점' }
      ]
    }
  });
  assert.equal(meta.title, '서재의 은빛 열쇠 사건');
  assert.ok(meta.searchTerms.includes('민아'));
  assert.ok(meta.searchTerms.includes('지호'));
  assert.ok(meta.searchTerms.includes('은빛'));
  assert.ok(meta.searchTerms.includes('열쇠'));
  assert.ok(meta.searchTerms.includes('미스터리'));
  assert.ok(meta.searchText.includes('지호가 서재에서 은빛 열쇠 비밀 약속을 건넸다'));
});

test('select boosts causal neighbors via linkedSearchText, bundles missing context, deduplicates siblings, and stays within budget', () => {
  const fCauseKey = 'canonical:m1:1:f_cause';
  const fRelKey = 'canonical:m1:1:f_rel';
  const fPosKey = 'canonical:m1:1:f_pos';
  const rows = [
    {
      id: 'row-cause',
      family: 'canonical',
      axis: engine.axisFor('event'),
      domain: 'event',
      turn: 3,
      text: '지호가 서재에서 민아에게 비밀 암호 금고를 열어 보였다.',
      evidenceKeys: [fCauseKey],
      linkedNeighbors: [
        { key: fRelKey, relation: 'effect', text: '민아가 지호를 깊이 신뢰하게 되었다.' },
        { key: fPosKey, relation: 'effect', text: '민아가 은빛 열쇠를 보관하게 되었다.' }
      ],
      linkedSearchText: '민아가 지호를 깊이 신뢰하게 되었다. · 민아가 은빛 열쇠를 보관하게 되었다.'
    },
    {
      id: 'row-rel',
      family: 'canonical',
      axis: 'relationships',
      domain: 'relationship',
      turn: 3,
      text: '민아가 지호를 깊이 신뢰하게 되었다.',
      evidenceKeys: [fRelKey],
      linkedNeighbors: [{ key: fCauseKey, relation: 'cause', text: '지호가 서재에서 민아에게 비밀 암호 금고를 열어 보였다.' }],
      linkedSearchText: '지호가 서재에서 민아에게 비밀 암호 금고를 열어 보였다.'
    },
    {
      id: 'row-pos',
      family: 'canonical',
      axis: 'world',
      domain: 'possession',
      turn: 3,
      text: '민아가 은빛 열쇠를 보관하게 되었다.',
      evidenceKeys: [fPosKey],
      linkedNeighbors: [{ key: fCauseKey, relation: 'cause', text: '지호가 서재에서 민아에게 비밀 암호 금고를 열어 보였다.' }],
      linkedSearchText: '지호가 서재에서 민아에게 비밀 암호 금고를 열어 보였다.'
    }
  ];

  // When only consequences are selected without row-cause, sibling causes are attached once
  const selectedOnlyEffects = engine.select({
    rows: [rows[1], rows[2]],
    query: '암호 금고 이후 신뢰와 열쇠',
    maxItems: 2,
    minimumPerAxis: 0,
    maxCharacters: 600
  });
  assert.equal(selectedOnlyEffects.items.length, 2);
  const firstEffectPrompt = selectedOnlyEffects.items[0].promptText || '';
  const secondEffectPrompt = selectedOnlyEffects.items[1].promptText || '';
  assert.ok(firstEffectPrompt.includes('원인·맥락: 지호가 서재에서 민아에게 비밀 암호 금고를 열어 보였다'), 'first selected effect pulls missing cause');
  assert.ok(!secondEffectPrompt.includes('원인·맥락:'), 'sibling sharing same cause does not repeat cause suffix');
  assert.ok([rows[1].text, rows[2].text].includes(selectedOnlyEffects.items[0].text), 'base row.text remains unmodified');
  assert.notEqual(selectedOnlyEffects.items[0].text, firstEffectPrompt, 'causal context lives on promptText only');
  assert.ok(selectedOnlyEffects.budget.usedCharacters <= 600);

  // When cause + 1 of 2 effects are selected, the selected effect does not repeat cause, while cause pulls only the unselected effect
  const partialPair = engine.select({
    rows: [rows[0], rows[1]],
    query: '암호 금고 신뢰',
    maxItems: 4,
    minimumPerAxis: 0,
    maxCharacters: 800
  });
  assert.equal(partialPair.items.length, 2);
  const partialCause = partialPair.items.find(i => i.id === 'row-cause');
  const partialRel = partialPair.items.find(i => i.id === 'row-rel');
  assert.ok(!partialRel.promptText, 'selected effect does not repeat already-selected cause');
  assert.ok(partialCause.promptText.includes('연계 변화: 민아가 은빛 열쇠를 보관하게 되었다'), 'cause bundles only unselected effect');
  assert.ok(!partialCause.promptText.includes('깊이 신뢰하게 되었다'), 'cause does not repeat already-selected effect');

  // When cause AND all effects are selected together, zero redundant suffixes are appended
  const allSelected = engine.select({
    rows,
    query: '암호 금고 신뢰 열쇠 보관',
    maxItems: 4,
    minimumPerAxis: 0,
    maxCharacters: 1000
  });
  assert.equal(allSelected.items.length, 3);
  assert.ok(allSelected.items.every(item => !item.promptText), 'no suffix when all linked neighbors are already selected');

  // Tight budget gracefully skips appending suffix rather than exceeding maxCharacters
  const tight = engine.select({
    rows: [rows[1]],
    query: '신뢰',
    maxItems: 1,
    minimumPerAxis: 0,
    maxCharacters: 80
  });
  assert.equal(tight.items.length, 1);
  assert.ok(!tight.items[0].promptText, 'tight budget skips suffix cleanly');
  assert.ok(tight.budget.usedCharacters <= 80);
});

test('end-to-end unified canonical commit + recall links explicit dependsOn & legacy dependsOn:[], while isolating uncertain/pending facts', async () => {
  const f = await fixture();
  try {
    const q = n => [{ ref: `t${n}-a`, quote: quote(`t${n}-a`) }];
    const artifact = {
      schema: 'libra.canonical_artifact.v5',
      entities: [
        { tempId: 'mina', name: '민아', type: 'person', kind: 'person', evidenceSpans: q(2) },
        { tempId: 'jiho', name: '지호', type: 'person', kind: 'person', evidenceSpans: q(2) },
        { tempId: 'key', name: '은빛 열쇠', type: 'world', kind: 'object', evidenceSpans: q(2) },
        { tempId: 'pending_q', name: '미확인 단서', type: 'world', kind: 'thread', evidenceSpans: q(5) }
      ],
      facts: [
        {
          tempFactId: 'f_evt_loan',
          domain: 'event',
          subjectTempRef: 'jiho',
          claimKind: 'event',
          values: { detail: '지호가 서재에서 민아의 은빛 열쇠를 빌리고 당일 반환을 서약했다' },
          text: '지호가 서재에서 민아의 은빛 열쇠를 빌려 들고 당일 돌려주기로 서약했다.',
          temporalRole: 'current_sequence',
          certainty: 'confirmed',
          evidenceSpans: [
            { ref: 't2-a', quote: '지호가 민아 소유의 은빛 열쇠를 빌려 받았고, 오늘 돌려주겠다고 약속했다.' },
            { ref: 't3-a', quote: '준호가 지호에게서 열쇠를 받아 들었다.' },
            { ref: 't5-a', quote: '오늘 열쇠를 반환하겠다는 약속은 이행되었다.' }
          ],
          dependsOn: []
        },
        {
          tempFactId: 'f_rel_trust',
          domain: 'relationship',
          subjectTempRef: 'mina',
          targetTempRef: 'jiho',
          dimension: 'trust',
          claimKind: 'relationship',
          values: { value: '신뢰한다고 명시적으로 밝혔다' },
          text: '민아는 지호를 신뢰한다고 밝혔다.',
          temporalRole: 'current_sequence',
          certainty: 'confirmed',
          evidenceSpans: [{ ref: 't4-a', quote: '민아는 지호를 신뢰한다고 말했다.' }],
          dependsOn: ['f_evt_loan']
        },
        {
          // Legacy-style fact with dependsOn: [] on the same span t2-a + shared entity (`jiho` / `은빛 열쇠`)
          tempFactId: 'f_legacy_pos',
          domain: 'world',
          subjectTempRef: 'key',
          claimKind: 'possession',
          values: { holderRef: 'jiho' },
          text: '은빛 열쇠가 임시로 지호 수중에 놓였다.',
          temporalRole: 'current_sequence',
          certainty: 'confirmed',
          evidenceSpans: [{ ref: 't2-a', quote: '지호가 민아 소유의 은빛 열쇠를 빌려 받았고' }],
          dependsOn: []
        },
        {
          // Uncertain rumor sharing span t2-a & jiho — MUST NOT be linked into confirmed causal context
          tempFactId: 'f_uncertain',
          domain: 'character',
          subjectTempRef: 'jiho',
          claimKind: 'character_note',
          values: { detail: '창고 여분 열쇠가 있다는 미확인 소문 의심표식XYZ' },
          text: '창고 여분 열쇠가 있다는 미확인 소문 의심표식XYZ',
          temporalRole: 'uncertain',
          certainty: 'uncertain',
          evidenceSpans: [{ ref: 't2-a', quote: '지호가 민아 소유의 은빛 열쇠를 빌려 받았고' }],
          dependsOn: []
        },
        {
          // Pending unlinked thread — MUST NOT be linked into confirmed causal context
          tempFactId: 'f_pending_thr',
          domain: 'narrative',
          subjectTempRef: 'pending_q',
          claimKind: 'thread',
          values: {
            thread: {
              summary: '미연결 보류 단서표식ABC',
              status: 'open',
              link: 'update',
              linkCandidateAlias: '존재하지않는이전스레드'
            }
          },
          text: '미연결 보류 단서표식ABC',
          temporalRole: 'current_sequence',
          certainty: 'confirmed',
          evidenceSpans: [{ ref: 't5-a', quote: '공연 허가를 누가 내주는지는 아직 밝혀지지 않았다.' }],
          dependsOn: []
        }
      ],
      stateBindings: [
        { factTempId: 'f_rel_trust', typedValueField: 'value', stateDomain: 'relationship', stateField: 'value' },
        { factTempId: 'f_legacy_pos', typedValueField: 'holderRef', stateDomain: 'world', stateField: 'holderRef' }
      ]
    };

    f.control.artifact = artifact;
    await f.run();

    const storedMemory = f.getMemory(1);
    assert.ok(storedMemory, 'canonical memory must commit');
    assert.ok(storedMemory.canonicalArtifact.facts.some(x => x.tempFactId === 'f_evt_loan'));
    assert.ok(storedMemory.canonicalArtifact.facts.some(x => x.tempFactId === 'f_rel_trust'));
    assert.ok(storedMemory.canonicalArtifact.facts.some(x => x.tempFactId === 'f_legacy_pos'));
    assert.equal(f.r.core.renderUnifiedArtifact(storedMemory.canonicalArtifact), storedMemory.text, 'replay seal must hold exactly');

    // Inspect captured canonical rows directly via internal capture to confirm explicit + legacy causal links & isolation
    const res = await f.r.api.previewUnifiedMemoryRecall({
      queryText: '왜 민아는 지호를 신뢰한다고 밝혔나'
    });
    const rendered = String(res?.packet?.renderedText || '');
    const memTexts = (res?.memories || []).map(m => String(m?.memory?.text || m?.excerpt || '')).join('\n');
    assert.ok(rendered.includes('민아는 지호를 신뢰한다고 밝혔다') || memTexts.includes('민아는 지호를 신뢰한다고 밝혔다'), 'direct canonical hit delivered');
    assert.doesNotMatch(rendered + '\n' + memTexts, /\((?:원인·맥락|연계 변화):[^)]*(?:의심표식XYZ|단서표식ABC)/, 'uncertain/pending fact never leaks into confirmed causal context');
    assert.ok(!rendered.split('\n').some(line => (line.includes('민아는 지호를 신뢰') || line.includes('은빛 열쇠가 임시로')) && /의심표식XYZ|단서표식ABC/.test(line)), 'confirmed lines carry no uncertain/pending causal suffix');

    // Constrain recall budget so only one consequence fits and verify (원인·맥락: ...) pulls its linked event anchor
    const saved = await f.r.api.getLibraMemorySettings();
    await f.r.api.saveLibraMemorySettings({ ...saved, recallTotalMaxChars: 520 });
    const constrainedTrust = await f.r.api.previewUnifiedMemoryRecall({
      queryText: '민아는 지호를 신뢰한다고 밝혔다'
    });
    const constrainedText = String(constrainedTrust?.packet?.renderedText || '');
    assert.ok(
      constrainedText.includes('민아는 지호를 신뢰한다고 밝혔다') || constrainedText.includes('신뢰한다고 명시적으로 밝혔다'),
      'constrained trust hit present'
    );
    assert.doesNotMatch(constrainedText, /\((?:원인·맥락|연계 변화):[^)]*(?:의심표식XYZ|단서표식ABC)/, 'constrained recall also isolates uncertain/pending facts from causal suffixes');
    assert.ok(!constrainedText.split('\n').some(line => (line.includes('민아는 지호를 신뢰') || line.includes('은빛 열쇠가 임시로')) && /의심표식XYZ|단서표식ABC/.test(line)));

    // Restore settings and check legacy dependsOn:[] fallback query
    await f.r.api.saveLibraMemorySettings(saved);
    const recallLegacy = await f.r.api.previewUnifiedMemoryRecall({
      queryText: '왜 은빛 열쇠가 임시로 지호 수중에 놓였나'
    });
    const legacyText = String(recallLegacy?.packet?.renderedText || '');
    const legacyMemTexts = (recallLegacy?.memories || []).map(m => String(m?.memory?.text || m?.excerpt || '')).join('\n');
    assert.ok(legacyText.includes('은빛 열쇠가 임시로 지호 수중에 놓였다') || legacyMemTexts.includes('은빛 열쇠가 임시로 지호 수중에 놓였다'), 'legacy dependsOn:[] canonical fact recalled');
    assert.ok(legacyText.includes('지호가 서재에서 민아의 은빛 열쇠를 빌려'), 'legacy fallback brings linked anchor');

    // Story structure supplement fires even when multi-turn synthesis merges into < 3 events (citedTurns.size >= 3)
    assert.ok(
      f.control.supplementCalls.some(c => JSON.stringify(c).includes('[LIBRA STORY STRUCTURE]')),
      'multi-span consolidated events still trigger [LIBRA STORY STRUCTURE] when >= 3 turns are cited'
    );

    // Cold-start commit populates v4/v5 searchTerms, recallTerms, and searchText directly onto manifest ref
    const coldRef = f.getManifest()?.memories?.['1'];
    assert.ok(coldRef, 'manifest ref populated on commit');
    assert.ok(Array.isArray(coldRef.searchTerms) && coldRef.searchTerms.length > 0, 'manifest searchTerms persisted');
    assert.ok(Array.isArray(coldRef.recallTerms) && coldRef.recallTerms.length > 0, 'manifest recallTerms persisted');
    assert.ok(coldRef.searchTerms.includes('지호') && coldRef.searchTerms.includes('민아'), 'entities indexed on commit');
    assert.ok(coldRef.searchText.includes('은빛 열쇠'), 'event text indexed in searchText');

    // Reanalysis picks up new canonical terms cleanly and bumps revision to 2
    const inv = await f.r.api.listReanalysisRanges({ kind: 'canonical' });
    assert.ok(inv?.ranges?.length > 0);
    f.control.artifact = {
      ...artifact,
      facts: artifact.facts.map(fact => fact.tempFactId === 'f_evt_loan'
        ? { ...fact, text: '지호가 서재에서 금고서약재분석토큰 사건을 매듭지었다.' }
        : fact)
    };
    const reanalyzed = await f.r.api.reanalyzeSelectedRanges({
      kind: 'canonical',
      scopeKey: inv.scopeKey,
      topology: inv.topology,
      ranges: [inv.ranges[0]]
    });
    assert.equal(reanalyzed.ok, true, 'canonical reanalysis succeeds');
    const updatedRef = f.getManifest()?.memories?.['1'];
    assert.equal(updatedRef.revision, 2, 'reanalysis advances revision to 2');
    assert.ok(updatedRef.searchTerms.includes('금고서약재분석토큰'), 'reanalyzed event term immediately updated in manifest');
    assert.equal(f.r.core.renderUnifiedArtifact(f.getMemory(1).canonicalArtifact), f.getMemory(1).text, 'replay seal holds after reanalysis');
  } finally {
    await f.r.cleanup?.();
  }
});

test('pending linkStatus thread is isolated from confirmed causal bundling in SDK capture and reader', () => {
  // Execute buildCanonicalRecallRows logic directly from LibraStateMemoryOwner.source.js against a stored v5 artifact
  const ownerSource = fs.readFileSync(path.join(__dirname, '../sdk/LibraStateMemoryOwner.source.js'), 'utf8');
  const start = ownerSource.indexOf('const buildCanonicalRecallRows =');
  const end = ownerSource.indexOf('const capture = createLibraStateMemoryCapture', start);
  assert.ok(start > 0 && end > start);
  const fnSource = ownerSource.slice(start, end);
  const ownerCtx = vm.createContext({
    asArray: v => (Array.isArray(v) ? v : []),
    string: v => (v == null ? '' : String(v)),
    canonicalEvidenceArtifactRows: art => (art?.facts || []).map(f => ({ ...f, assertionId: f.tempFactId })),
    unifiedArtifactSchemaReadable: s => /^libra\.canonical_artifact\.v[45]$/.test(String(s || '')),
    memoryReviewDecision: () => 'accepted'
  });
  vm.runInContext(`${fnSource}\nthis.__buildCanonicalRecallRows = buildCanonicalRecallRows;`, ownerCtx);
  const rows = ownerCtx.__buildCanonicalRecallRows({
    memoryId: 'mem-p1',
    revision: 1,
    canonicalArtifact: {
      schema: 'libra.canonical_artifact.v5',
      entities: [
        { tempId: 'jiho', name: '지호', type: 'person', kind: 'person' },
        { tempId: 'q1', name: '미확인 단서', type: 'world', kind: 'thread' }
      ],
      facts: [
        {
          tempFactId: 'f_evt', domain: 'event', claimKind: 'event', subjectTempRef: 'jiho',
          text: '지호가 서재에서 봉인된 서류를 꺼냈다.', temporalRole: 'current_sequence', certainty: 'confirmed',
          evidenceSpans: [{ ref: 't2-a', quote: '서류' }], dependsOn: []
        },
        {
          tempFactId: 'f_pend', domain: 'narrative', claimKind: 'thread', subjectTempRef: 'q1',
          values: { thread: { summary: '보류 단서표식ABC', status: 'open', linkStatus: 'pending', lifecycleId: 'lc1', linkPendingReason: 'unmatched' } },
          text: '미연결 보류 단서표식ABC', temporalRole: 'current_sequence', certainty: 'confirmed',
          evidenceSpans: [{ ref: 't2-a', quote: '서류' }], dependsOn: ['f_evt']
        },
        {
          tempFactId: 'f_unc', domain: 'character', claimKind: 'character_note', subjectTempRef: 'jiho',
          text: '불확실 루머표식XYZ', temporalRole: 'uncertain', certainty: 'uncertain',
          evidenceSpans: [{ ref: 't2-a', quote: '서류' }], dependsOn: []
        },
        {
          tempFactId: 'f_pos', domain: 'world', claimKind: 'possession', subjectTempRef: 'jiho',
          text: '지호가 서류를 품에 넣었다.', temporalRole: 'current_sequence', certainty: 'confirmed',
          evidenceSpans: [{ ref: 't2-a', quote: '서류' }], dependsOn: []
        }
      ]
    }
  }, null);
  const evtRow = rows.find(r => r.text.includes('봉인된 서류를 꺼냈다'));
  const posRow = rows.find(r => r.text.includes('서류를 품에 넣었다'));
  const pendRow = rows.find(r => r.text.includes('단서표식ABC'));
  const uncRow = rows.find(r => r.text.includes('루머표식XYZ'));
  assert.ok(evtRow.linkedSearchText.includes('서류를 품에 넣었다'), 'legacy fallback links confirmed same-turn/entity fact');
  assert.ok(posRow.linkedSearchText.includes('봉인된 서류를 꺼냈다'), 'effect links back to confirmed event anchor');
  assert.ok(!evtRow.linkedSearchText.includes('단서표식ABC'), 'pending thread isolated from confirmed anchor');
  assert.ok(!evtRow.linkedSearchText.includes('루머표식XYZ'), 'uncertain fact isolated from confirmed anchor');
  assert.equal(pendRow.linkedNeighbors, undefined);
  assert.equal(uncRow.linkedNeighbors, undefined);
});

test('Book Canonical Reader defaults to connected flow view, groups linked & legacy facts, and toggles to domain view or markdown fallback', () => {
  const slice = between('const buildBookTurnEvidenceSection =', 'const buildBookMemoryReaderProjection =');
  const guiState = { canonicalReadingView: 'flow' };
  let renderCalls = 0;
  const ctx = vm.createContext({
    Gui: guiState,
    guiEl: (tag, attrs = {}, children = []) => ({ tag, ...attrs, children: (children || []).filter(Boolean) }),
    guiAsArray: v => (Array.isArray(v) ? v : []),
    guiAsObject: v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
    text: v => (v == null ? '' : String(v)),
    queueGuiNavigationRender: () => { renderCalls++; }
  });
  vm.runInContext(`${slice}\nthis.__exports = { buildBookMemoryReadingBody, buildBookCanonicalConnectedFlow };`, ctx);
  const { buildBookMemoryReadingBody } = ctx.__exports;

  const detail = {
    memoryId: 'mem-coh-1',
    summary: '도서관 서재에서 열쇠 대출 서약이 맺어졌다.',
    text: '# 종합 기억\n요약입니다.\n\n## 시간순 사건\n- 사건\n\n## 인물과 관계\n- 관계',
    canonicalArtifact: {
      schema: 'libra.canonical_artifact.v5',
      summary: '도서관 서재에서 열쇠 대출 서약이 맺어졌다.',
      entities: [
        { tempId: 'mina', name: '민아', type: 'person', kind: 'person' },
        { tempId: 'jiho', name: '지호', type: 'person', kind: 'person' }
      ],
      facts: [
        {
          tempFactId: 'f_evt',
          domain: 'event',
          claimKind: 'event',
          subjectTempRef: 'jiho',
          text: '지호가 서재에서 민아의 은빛 열쇠를 빌렸다.',
          temporalRole: 'current_sequence',
          certainty: 'confirmed',
          evidenceSpans: [{ ref: 'turn:2', quote: '빌려 받았고' }, { ref: 'turn:3', quote: '받아 들었다' }],
          dependsOn: []
        },
        {
          tempFactId: 'f_rel',
          domain: 'relationship',
          claimKind: 'relationship',
          subjectTempRef: 'mina',
          targetTempRef: 'jiho',
          dimension: 'trust',
          text: '민아가 지호를 신뢰하기로 했다.',
          temporalRole: 'current_sequence',
          certainty: 'confirmed',
          evidenceSpans: [{ ref: 'turn:4', quote: '신뢰한다' }],
          dependsOn: ['f_evt']
        },
        {
          // Legacy fallback without dependsOn, sharing turn:2 + jiho
          tempFactId: 'f_pos_legacy',
          domain: 'world',
          claimKind: 'possession',
          subjectTempRef: 'jiho',
          text: '지호가 은빛 열쇠를 임시로 보관하게 되었다.',
          temporalRole: 'current_sequence',
          certainty: 'confirmed',
          evidenceSpans: [{ ref: 'turn:2', quote: '열쇠를 빌려' }],
          dependsOn: []
        },
        {
          tempFactId: 'f_uncertain_clue',
          domain: 'character',
          claimKind: 'character_note',
          subjectTempRef: 'jiho',
          text: '아직 확인되지 않은 소문 단서',
          temporalRole: 'uncertain',
          certainty: 'uncertain',
          evidenceSpans: [{ ref: 'turn:2', quote: '소문' }],
          dependsOn: []
        }
      ]
    }
  };

  // Default flow mode groups explicit dependsOn & fallback same-turn/entity outcomes into one episode card
  const flowTree = buildBookMemoryReadingBody(detail);
  assert.equal(flowTree.dataset.canonicalReadingMode, 'flow');
  const flatFlow = flatDom(flowTree);
  const episodeCard = flatFlow.find(n => n.dataset?.canonicalEpisode === 'f_evt');
  assert.ok(episodeCard, 'episode card rendered for event anchor');
  const episodeText = domText(episodeCard);
  assert.ok(episodeText.includes('T2 · T3'), 'formatted multi-turn span chip shown');
  assert.ok(episodeText.includes('지호') && episodeText.includes('민아'), 'involved entity chips shown');
  assert.ok(episodeText.includes('민아가 지호를 신뢰하기로 했다'), 'explicit dependsOn outcome grouped');
  assert.ok(episodeText.includes('지호가 은빛 열쇠를 임시로 보관하게 되었다'), 'fallback same-turn/entity outcome grouped');
  assert.ok(episodeText.includes('소지'), 'claimKind badge uses Korean label');
  assert.ok(!episodeText.includes('아직 확인되지 않은 소문 단서'), 'uncertain clue stays isolated outside confirmed episode');
  const backgroundNode = flatFlow.find(n => n.dataset?.canonicalBackground === 'true');
  assert.ok(backgroundNode && domText(backgroundNode).includes('아직 확인되지 않은 소문 단서'));

  // Toggle switches to domain breakdown view
  const domainTab = flatFlow.find(n => n.dataset?.canonicalReadingTab === 'domains');
  assert.ok(domainTab);
  domainTab.onClick();
  assert.equal(guiState.canonicalReadingView, 'domains');
  assert.equal(renderCalls, 1);

  const domainsTree = buildBookMemoryReadingBody(detail);
  assert.equal(domainsTree.dataset.canonicalReadingMode, 'domains');
  assert.ok(flatDom(domainsTree).some(n => n.dataset?.canonicalDomainSections === 'true'));

  // Backward-compatible markdown-only detail without canonicalArtifact.facts keeps exact plain prose layout
  const plainTree = buildBookMemoryReadingBody({ text: '# 종합 기억\n단순 본문\n\n## 시간순 사건\n- 1턴 사건' });
  assert.equal(plainTree.dataset.canonicalReadingMode, undefined);
  assert.ok(!flatDom(plainTree).some(n => n.dataset?.canonicalReadingTab));
  assert.ok(domText(plainTree).includes('단순 본문'));

  // Untruncated connected-flow summary when artifact.summary is absent and detail.summary carries a 900-char …[truncated] slice
  guiState.canonicalReadingView = 'flow';
  const longDetail = {
    memoryId: 'mem-coh-long',
    summary: '# 종합 기억\n## 시간순 사건\n- 푸딩이 콘돔을 벗겨 버리고...\n…[truncated]',
    text: [
      '# 종합 기억',
      '## 시간순 사건',
      '- 푸딩이 콘돔을 벗겨 버리고 소연을 눕혀 새 콘돔을 꺼내 관계를 시작했다. (근거: t55-u, t55-a)',
      '- 소연이 새 콘돔을 직접 씌웠고 푸딩이 천천히 들어가자 소연이 손등으로 입을 막았다. (근거: t55-a)',
      '- 소연이 끝난 뒤의 여운 속에서 조용히 숨을 고르며 푸딩을 바라보았다. (근거: t55-a)',
      '## 회상 키워드',
      '- 푸딩, 소연, 콘돔'
    ].join('\n'),
    canonicalArtifact: {
      schema: 'libra.canonical_artifact.v5',
      entities: [{ tempId: 'soyeon', name: '소연', type: 'person', kind: 'person' }],
      facts: [{
        tempFactId: 'f_long_evt',
        domain: 'event',
        claimKind: 'event',
        subjectTempRef: 'soyeon',
        text: '소연과의 밤이 이어졌다.',
        temporalRole: 'current_sequence',
        certainty: 'confirmed',
        evidenceSpans: [{ ref: 'turn:55', quote: '숨을 고르며' }],
        dependsOn: []
      }]
    }
  };
  const longFlowTree = buildBookMemoryReadingBody(longDetail);
  const longSummaryNode = flatDom(longFlowTree).find(n => n.dataset?.canonicalFlowSummary === 'true');
  assert.ok(longSummaryNode, 'canonical flow summary card renders');
  const longSummaryText = domText(longSummaryNode);
  assert.ok(!longSummaryText.includes('[truncated]'), 'summary card must never render [truncated]');
  assert.ok(longSummaryText.includes('여운 속에서 조용히 숨을 고르며 푸딩을 바라보았다'), 'last bullet of full canonical text is completely preserved');
  assert.ok(longSummaryText.includes('푸딩, 소연, 콘돔'), 'trailing recall keyword section is completely preserved');
});
