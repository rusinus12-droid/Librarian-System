'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const createCompiler = require('../tools/libra_memory_graph_compiler.cjs');
const { createHayakuRuntime, createStore, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
const { fixture: createLibraReaderFixture, QUOTE: LIBRA_FIXTURE_QUOTE } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');

const sha256 = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');

function buildRichLibraGraph() {
  const scopeKey = 'char_mina::chat_main';
  const nodes = [
    { id: 'ent_mina', layer: 'entity', family: 'entity', bindingId: 'b_ent_mina', identity: { entityKey: 'char_mina', name: '민아', kind: 'character' } },
    { id: 'ent_jiho', layer: 'entity', family: 'entity', bindingId: 'b_ent_jiho', identity: { entityKey: 'char_jiho', name: '지호', kind: 'character' } },
    { id: 'ent_key', layer: 'entity', family: 'entity', bindingId: 'b_ent_key', identity: { entityKey: 'item_silver_key', name: '은빛 열쇠', kind: 'object' } },
    {
      id: 'src_state_1',
      layer: 'source',
      family: 'state',
      bindingId: 'b_src_state_1',
      identity: {
        headTurn: 6,
        snapshot: {
          head: {
            characters: {
              char_mina: { name: '민아', location: '서재', emotion: '분노', goal: '은빛 열쇠 회수', knowledge: ['지호가 열쇠 반환 약속을 지키지 않았음'] },
              char_jiho: { name: '지호', location: '복도', carrying: ['은빛 열쇠'] }
            },
            relationships: {
              'char_mina->char_jiho': { fromId: 'char_mina', fromName: '민아', toId: 'char_jiho', toName: '지호', state: '신뢰 하락' }
            },
            world: {
              item_silver_key: { name: '은빛 열쇠', ownerRef: 'char_mina', holderRef: 'char_jiho', status: '지호가 소지 중' },
              world: { rule: '서재 출입문은 자정 이후 잠긴다' }
            }
          }
        }
      }
    },
    { id: 'src_can_1', layer: 'source', family: 'canonical', bindingId: 'b_src_can_1' },
    { id: 'src_mic_1', layer: 'source', family: 'micro', bindingId: 'b_src_mic_1' },
    { id: 'src_lore_1', layer: 'source', family: 'lore', bindingId: 'b_src_lore_1' },
    { id: 'u_mina_loc', layer: 'unit', family: 'state', sourceId: 'src_state_1', bindingId: 'b_u1' },
    { id: 'u_mina_emo', layer: 'unit', family: 'state', sourceId: 'src_state_1', bindingId: 'b_u2' },
    { id: 'u_jiho_carry', layer: 'unit', family: 'state', sourceId: 'src_state_1', bindingId: 'b_u3' },
    { id: 'u_key_state', layer: 'unit', family: 'state', sourceId: 'src_state_1', bindingId: 'b_u4' },
    { id: 'u_rel_mina_jiho', layer: 'unit', family: 'state', sourceId: 'src_state_1', bindingId: 'b_u5' },
    { id: 'u_mina_know', layer: 'unit', family: 'state', sourceId: 'src_state_1', bindingId: 'b_u6' },
    { id: 'u_mina_goal', layer: 'unit', family: 'state', sourceId: 'src_state_1', bindingId: 'b_u7' },
    { id: 'u_can_hist', layer: 'unit', family: 'canonical', sourceId: 'src_can_1', bindingId: 'b_u8' },
    { id: 'u_mic_scene', layer: 'unit', family: 'micro', sourceId: 'src_mic_1', bindingId: 'b_u9' },
    { id: 'u_lore_rule', layer: 'unit', family: 'lore', sourceId: 'src_lore_1', bindingId: 'b_u10' },
    { id: 'u_uncertain', layer: 'unit', family: 'state', sourceId: 'src_state_1', bindingId: 'b_u11' },
    { id: 'u_no_owner', layer: 'unit', family: 'canonical', sourceId: 'src_can_1', bindingId: 'b_u12' }
  ];

  const units = [
    { nodeId: 'u_mina_loc', family: 'state', kind: 'state_field', semanticRole: 'state_current', domain: 'character', entityId: 'char_mina', field: 'location', turn: 6, provenanceStatus: 'verified', certainty: 'confirmed', text: '민아 · location = 서재' },
    { nodeId: 'u_mina_emo', family: 'state', kind: 'state_field', semanticRole: 'state_current', domain: 'character', entityId: 'char_mina', field: 'emotion', turn: 6, provenanceStatus: 'verified', certainty: 'confirmed', text: '민아 · emotion = 분노' },
    { nodeId: 'u_jiho_carry', family: 'state', kind: 'state_field', semanticRole: 'state_current', domain: 'character', entityId: 'char_jiho', field: 'carrying', turn: 6, provenanceStatus: 'verified', certainty: 'confirmed', text: '지호 · carrying = 은빛 열쇠' },
    { nodeId: 'u_key_state', family: 'state', kind: 'state_field', semanticRole: 'state_current', domain: 'world', entityId: 'item_silver_key', field: 'status', turn: 6, provenanceStatus: 'verified', certainty: 'confirmed', text: '은빛 열쇠 · status = 지호가 소지 중' },
    { nodeId: 'u_rel_mina_jiho', family: 'state', kind: 'state_field', semanticRole: 'state_current', domain: 'relationship', entityId: 'char_mina->char_jiho', field: 'state', turn: 6, provenanceStatus: 'verified', certainty: 'confirmed', text: '민아 → 지호 · trust = 신뢰 하락' },
    { nodeId: 'u_mina_know', family: 'state', kind: 'state_field', semanticRole: 'state_current', domain: 'character', entityId: 'char_mina', field: 'knowledge', turn: 6, provenanceStatus: 'verified', certainty: 'confirmed', text: '민아 · knowledge = 지호가 열쇠 반환 약속을 지키지 않았음' },
    { nodeId: 'u_mina_goal', family: 'state', kind: 'state_field', semanticRole: 'state_current', domain: 'character', entityId: 'char_mina', field: 'goal', turn: 6, provenanceStatus: 'verified', certainty: 'confirmed', text: '민아 · goal = 은빛 열쇠 회수' },
    { nodeId: 'u_can_hist', family: 'canonical', kind: 'canonical_fact', semanticRole: 'canonical_assertion', subjectId: 'char_mina', targetIds: ['char_jiho'], turn: 4, provenanceStatus: 'verified', certainty: 'confirmed', fact: { claimKind: 'event', subjectId: 'char_mina', targetIds: ['char_jiho'] }, text: 'T4에서 민아는 지호에게 자정 전까지 은빛 열쇠를 돌려달라고 요구했다.' },
    { nodeId: 'u_mic_scene', family: 'micro', kind: 'micro_claim', semanticRole: 'micro_candidate', turn: 6, provenanceStatus: 'verified', certainty: 'observed_candidate', text: '서재 책상 위에 빈 열쇠 상자가 열려 있다.' },
    { nodeId: 'u_lore_rule', family: 'lore', kind: 'lore_entry', semanticRole: 'background_setting', turn: null, provenanceStatus: 'verified', certainty: 'confirmed', text: '서재의 고서 보관함은 은빛 열쇠로만 열 수 있다.' },
    { nodeId: 'u_uncertain', family: 'state', kind: 'state_field', semanticRole: 'state_unprovenanced', domain: 'world', entityId: 'world', field: 'rumor', turn: 5, provenanceStatus: 'unprovenanced', certainty: 'unverified', text: '복도 끝에서 발소리가 들렸다는 미확인 보고' },
    { nodeId: 'u_no_owner', family: 'canonical', kind: 'canonical_fact', semanticRole: 'canonical_assertion', turn: 3, provenanceStatus: 'verified', certainty: 'confirmed', fact: { claimKind: 'event' }, text: '밤비가 창문을 두드렸다.' }
  ];

  const edges = [
    { id: 'e_emo_subj', from: 'u_mina_emo', to: 'ent_mina', predicate: 'subject_of', bindingId: 'be1' },
    { id: 'e_emo_targ', from: 'u_mina_emo', to: 'ent_jiho', predicate: 'target_of', bindingId: 'be2' },
    { id: 'e_rel_subj', from: 'u_rel_mina_jiho', to: 'ent_mina', predicate: 'subject_of', bindingId: 'be3' },
    { id: 'e_rel_targ', from: 'u_rel_mina_jiho', to: 'ent_jiho', predicate: 'target_of', bindingId: 'be4' }
  ];

  const candidates = units.map((u, i) => ({
    nodeId: u.nodeId,
    sourceId: nodes.find(n => n.id === u.nodeId).sourceId,
    family: u.family,
    kind: u.kind,
    semanticRole: u.semanticRole,
    availability: 'set',
    provenanceStatus: u.provenanceStatus,
    turn: u.turn,
    text: u.text,
    score: 0.99 - i * 0.02,
    mandatoryInclusion: u.family === 'lore',
    evidenceFamilyId: `ef_${u.nodeId}`,
    winningWitness: { sourceDependencies: [nodes.find(n => n.id === u.nodeId).sourceId], edgeChain: [], basisIds: [] }
  }));

  const graph = {
    schema: 'libra.memory_graph_projection.v1',
    scopeKey,
    readerFrame: { owner: 'libra:plugin_only', scopeKey, worldlineId: 'main', restoreEpoch: 0 },
    nodes,
    units,
    bases: [],
    edges
  };
  const queryResult = {
    schema: 'libra.memory_graph_query.v1',
    generation: 'gen_1',
    indexDigest: sha256('idx_1'),
    frameId: 'frame_1',
    complete: true,
    historicalStateUnavailable: false,
    candidates
  };
  return { graph, queryResult };
}

test('LIBRA: Model-Oriented Memory Document sections, State ownership, object owner vs holder, relationship direction, knowledge boundary, and consumer compatibility', async () => {
  const compiler = createCompiler({ fingerprint: sha256 });
  const { graph, queryResult } = buildRichLibraGraph();

  // 1. Default presentation preserves flat line-per-unit format for internal/other consumers
  const defaultSel = compiler.select(queryResult, graph, { consumer: 'classic', maxCharacters: 4096, maxUnits: 20 });
  const defaultPkt = compiler.render(defaultSel);
  assert.equal(defaultPkt.consumerVerification.ok, true);
  assert.equal(defaultPkt.renderedText.split('\n').length, defaultSel.bundle.items.length + 1);

  // 2. Model document presentation groups into semantic sections and preserves State ownership & epistemic boundaries
  const t0 = performance.now();
  const modelSel = compiler.select(queryResult, graph, {
    consumer: 'classic',
    presentation: 'model_document',
    maxCharacters: 4096,
    maxUnits: 20
  });
  const modelPkt = compiler.render(modelSel);
  const elapsedMs = performance.now() - t0;

  assert.equal(modelPkt.consumerVerification.ok, true);
  const text = modelPkt.renderedText;
  assert.ok(elapsedMs < 50, `deterministic compile+render should be fast (got ${elapsedMs.toFixed(2)}ms)`);

  // Verify semantic sections exist in order
  const expectedSections = [
    '[CURRENT STATE]',
    '[RELATIONSHIPS]',
    '[KNOWLEDGE]',
    '[OPEN THREADS]',
    '[RELEVANT HISTORY]',
    '[SCENE DETAILS]',
    '[WORLD CONTEXT]',
    '[UNCERTAIN]'
  ];
  let lastIdx = -1;
  for (const sec of expectedSections) {
    const idx = text.indexOf(sec);
    assert.ok(idx > lastIdx, `section ${sec} must appear in canonical order`);
    lastIdx = idx;
  }

  // Scenario 1: Character State ownership separation
  assert.match(text, /\[CHARACTER: 민아 \| id=char_mina\]/);
  assert.match(text, /\[CHARACTER: 지호 \| id=char_jiho\]/);
  assert.match(text, /owner=민아\(char_mina\) \| target=지호\(char_jiho\) \| visibility=subject_state\(민아\); other_characters_awareness=unconfirmed/);

  // Scenario 2: Relationship direction preservation
  assert.match(text, /\[RELATIONSHIP: 민아 → 지호\]/);
  assert.match(text, /visibility=directional\(민아 → 지호\); reverse_direction=not_implied/);

  // Scenario 3: Object owner vs current holder separation
  assert.match(text, /\[WORLD \/ OBJECT STATE: 은빛 열쇠 \| id=item_silver_key\]/);
  assert.match(text, /object_state: owner=민아\(char_mina\) \| holder=지호\(char_jiho\) \| note=owner_and_current_holder_differ/);

  // Scenario 4 & 5: Knowledge boundary & unconfirmed awareness of other characters
  assert.match(text, /\[KNOWLEDGE HOLDER: 민아 \| id=char_mina\]/);
  assert.match(text, /visibility=known_by\(민아\); other_characters=unconfirmed_do_not_assume_shared/);

  // Scenario 8 & 9: Uncertain isolation and missing-owner safe degradation (no guessed owner)
  const noOwnerItem = modelSel.bundle.items.find(i => i.nodeId === 'u_no_owner');
  assert.equal(noOwnerItem.attribution.ownerId, null);
  assert.equal(noOwnerItem.attribution.ownerName, null);
  assert.ok(!/owner=/.test(noOwnerItem.attributionLine), 'missing owner ID must never guess an owner');

  // Every original unit text appears exactly once
  for (const item of modelSel.bundle.items) {
    assert.equal(text.split(item.text).length - 1, 1, `item text must appear exactly once: ${item.text}`);
  }

  // Physical validation succeeds
  const verified = await compiler.validatePacket(modelPkt, {
    currentGraph: async () => graph,
    assertPhysicalCurrentness: async () => ({ verified: true })
  });
  assert.equal(verified.status, 'verified');
  assert.equal(verified.modelDispatchEligible, true);

  // GRADIA, Planner, SGA contracts remain untouched
  for (const consumer of ['planner', 'sga', 'gui', 'gradia']) {
    const sel = compiler.select(queryResult, graph, {
      consumer,
      maxCharacters: 4096,
      ...(consumer === 'gradia' ? { gradiaSelectionReceipt: { ownerCorpusDigest: 'd1', selectionReceiptId: 'r1' } } : {})
    });
    const pkt = compiler.render(sel);
    assert.equal(pkt.consumerVerification.ok, true, `${consumer} packet verification must pass`);
  }
});

test('HAYAKU: Semantic Evidence Lanes, Knowledge Boundaries (known by / denied to / unconfirmed), Active Scene Head ownership, and fallback safety', async () => {
  const h = await createHayakuRuntime({
    autoRepair: false,
    afterRequestAutoRepair: false,
    backgroundAutoRepair: false,
    arguments: { memory_suite_server_mode: 'plugin_only', hayaku_packet_recovery: 'false' },
    llmResponder: async () => { throw new Error('FORBIDDEN_LLM_CALL'); }
  });
  try {
    const t = h.hayaku._test;
    const settings = { ...h.hayaku.settings(), memoryLanguage: 'ko', maxItemsPerAxis: 4 };
    const rows = [
      {
        id: 'char-mina',
        publicRef: 'char-mina',
        packetHash: 'pkt-1',
        axis: 'entity',
        category: 'character',
        publicText: '민아: 현재 서재에 있으며 지호에게 분노한 상태다.',
        score: 0.95,
        lifecycle: { status: 'active', timeScope: 'current' },
        visibility: { privacy: 'public' },
        locator: { sourceHash: 'pkt-1', sourceScope: 'same-chat', sourcePairIndex: 4, worldlineOrdinal: 4, messageIndex: 7 }
      },
      {
        id: 'event-key',
        publicRef: 'event-key',
        packetHash: 'pkt-1',
        axis: 'world',
        category: 'active_event',
        publicText: '지호가 은빛 열쇠를 복도로 가지고 나갔다.',
        score: 0.92,
        lifecycle: { status: 'active', timeScope: 'current' },
        visibility: { privacy: 'public' },
        locator: { sourceHash: 'pkt-1', sourceScope: 'same-chat', sourcePairIndex: 4, worldlineOrdinal: 4, messageIndex: 7 }
      },
      {
        id: 'lock-key',
        publicRef: 'lock-key',
        packetHash: 'pkt-1',
        axis: 'planner',
        category: 'continuity_lock',
        publicText: '은빛 열쇠 반환 갈등은 당장 해결되지 않는다.',
        score: 0.90,
        lifecycle: { status: 'active', timeScope: 'current' },
        visibility: { privacy: 'public' },
        locator: { sourceHash: 'pkt-1', sourceScope: 'same-chat', sourcePairIndex: 4, worldlineOrdinal: 4, messageIndex: 7 }
      },
      {
        id: 'secret-mina',
        publicRef: 'secret-mina',
        packetHash: 'pkt-1',
        axis: 'entity',
        category: 'secret',
        publicText: '민아는 서재 금고의 진짜 암호를 바꿨다.',
        score: 0.89,
        lifecycle: { status: 'active', timeScope: 'current' },
        visibility: {
          privacy: 'secret',
          ownerEntityId: '민아',
          holderEntityIds: ['민아'],
          visibleToEntityIds: ['민아'],
          deniedToEntityIds: ['지호']
        },
        locator: { sourceHash: 'pkt-1', sourceScope: 'same-chat', sourcePairIndex: 4, worldlineOrdinal: 4, messageIndex: 7 }
      },
      {
        id: 'risk-1',
        publicRef: 'risk-1',
        packetHash: 'pkt-1',
        axis: 'narrative',
        category: 'overpromotion_risk',
        publicText: '지호가 고의로 열쇠를 훔쳤다고 단정하지 말 것.',
        score: 0.88,
        lifecycle: { status: 'active', timeScope: 'current' },
        visibility: { privacy: 'public' },
        locator: { sourceHash: 'pkt-1', sourceScope: 'same-chat', sourcePairIndex: 4, worldlineOrdinal: 4, messageIndex: 7 }
      },
      {
        id: 'uncertain-fallback',
        publicRef: 'uncertain-fallback',
        packetHash: 'pkt-1',
        axis: 'narrative',
        category: 'source_evidence_fallback',
        publicText: '복도 창문이 열려 있었는지는 불분명하다.',
        score: 0.85,
        lifecycle: { status: 'contested', truthState: 'uncertain', timeScope: 'current' },
        visibility: { privacy: 'public', truthState: 'uncertain' },
        locator: { sourceHash: 'pkt-1', sourceScope: 'same-chat', sourcePairIndex: 4, worldlineOrdinal: 4, messageIndex: 7 }
      }
    ];

    const selected = t.prepareHayakuRecallRows(
      rows,
      '민아 서재 금고 암호 은빛 열쇠',
      settings,
      { worldlineHeadOrdinal: 4, context: { mentionedEntities: ['민아'] } },
      [],
      []
    );
    const result = t.selectHayakuEvidencePlan(selected, '민아 서재 금고 암호 은빛 열쇠', settings, 6000);
    const rendered = result.text;

    assert.match(rendered, /\[SOURCE MEMORY RECORDS — supporting evidence; preserve recorded time and visibility\]/);
    assert.match(rendered, /\[LATEST VALID STATE\]/);
    assert.match(rendered, /\[CONFIRMED EVENTS \/ CHANGES — chronological\]/);
    assert.match(rendered, /\[UNRESOLVED CONSTRAINTS\]/);
    assert.match(rendered, /\[KNOWLEDGE BOUNDARIES\]/);
    assert.match(rendered, /\[PROHIBITED INFERENCES\]/);

    // Verify Knowledge Boundary structured natural expression
    assert.match(rendered, /\[지식경계 주체: 민아 \| 인지 인물: 민아 \| 미인지\(차단\) 인물: 지호 \| 경계\(secret\): 명시된 인물 외 타 인물의 인지 여부는 미확인\(자동 공유 금지\)\]/);

    // Verify uncertain/fallback stays in SOURCE MEMORY RECORDS and is NOT promoted to LATEST VALID STATE or CONFIRMED EVENTS
    const latestIdx = rendered.indexOf('[LATEST VALID STATE]');
    const fallbackIdx = rendered.indexOf('복도 창문이 열려 있었는지는 불분명하다.');
    assert.ok(fallbackIdx > 0 && fallbackIdx < latestIdx, 'uncertain fallback memory must stay in SOURCE MEMORY RECORDS before LATEST VALID STATE');

    // Verify Active Scene Head (buildSceneBaton) ownership, directional relation, and secret denial
    const pkt = createValidPacket({ turn: 4, summary: '민아와 지호가 서재와 복도에 있다.', subject: '민아', scene: 'library-wing' });
    pkt.entity.characters = [
      { name: '민아', location: '서재', current_state: '분노' },
      { name: '지호', location: '복도', carrying: ['은빛 열쇠'] }
    ];
    pkt.entity.relations = [
      { from: '민아', to: '지호', state: '신뢰 하락' }
    ];
    pkt.entity.secrets = [
      { ownerEntityId: '민아', deniedToEntityIds: ['지호'], privacy: 'secret', summary: '금고 암호 변경' }
    ];
    const baton = t.buildSceneBaton([pkt], { memoryLanguage: 'ko' });
    assert.match(baton.text, /현장 인물: \[민아\] — 분노 · 서재/);
    assert.match(baton.text, /현장 인물: \[지호\] — 복도 · 은빛 열쇠/);
    assert.match(baton.text, /관계 방향: 민아 → 지호 — 신뢰 하락/);
    assert.match(baton.text, /지식 경계: 민아 \(미인지: 지호\) — 금고 암호 변경/);
    assert.equal(h.llmCalls.length, 0);
  } finally {
    await h.dispose();
  }
});

test('Flashback: LATEST CONFIRMED STATE historical entity ownership, directional peer, and turn attribution', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../plugins/Flashback_Memory.js'), 'utf8');
  const start = source.indexOf('  const renderFlashbackEvidencePlan = plan => {');
  const end = source.indexOf('  const contextPlanId = prepared =>', start);
  assert.ok(start > 0 && end > start);

  const ctx = vm.createContext({
    ACTIVE_CONTINUITY_EVIDENCE_HEADER: '[ACTIVE CONTINUITY EVIDENCE]',
    ACTIVE_CONTINUITY_EVIDENCE_FOOTER: '[/ACTIVE CONTINUITY EVIDENCE]',
    storyOrderValue: r => Number(r?.order || 0),
    text: v => String(v ?? '')
  });
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.renderPlan = renderFlashbackEvidencePlan;`, ctx);

  const plan = {
    choices: [
      {
        unit: { id: 'ev1', state: false, sourceKey: 's1', item: { record: { order: 1 } } },
        fragment: { text: '민아가 지호에게 은빛 열쇠를 건넸다.', start: 0, end: 18 }
      },
      {
        unit: {
          id: 'st_mina_loc',
          state: true,
          fact: { entity: '민아', property: 'location', peer: '', turn: 46, evidenceText: '민아는 당시 서재에 있었다.' }
        },
        fragment: { text: '민아는 당시 서재에 있었다.', start: null, end: null }
      },
      {
        unit: {
          id: 'st_mina_rel',
          state: true,
          fact: { entity: '민아', property: 'relationship.trust', peer: '지호', turn: 46, evidenceText: '민아는 지호를 불신하고 있었다.' }
        },
        fragment: { text: '민아는 지호를 불신하고 있었다.', start: null, end: null }
      },
      {
        unit: {
          id: 'st_jiho_carry',
          state: true,
          fact: { entity: '지호', property: 'carrying', peer: '', turn: 46, evidenceText: '지호는 은빛 열쇠를 소지했다.' }
        },
        fragment: { text: '지호는 은빛 열쇠를 소지했다.', start: null, end: null }
      }
    ]
  };

  const rendered = ctx.renderPlan(plan);
  assert.match(rendered.text, /ORDERED PAST EVENTS — EARLIEST TO LATEST/);
  assert.match(rendered.text, /LATEST CONFIRMED STATE/);
  assert.match(rendered.text, /\[민아\]\n- \[T46 마지막 확인 · location\] 민아는 당시 서재에 있었다\.\n- \[T46 마지막 확인 · relationship\.trust → 지호\] 민아는 지호를 불신하고 있었다\./);
  assert.match(rendered.text, /\[지호\]\n- \[T46 마지막 확인 · carrying\] 지호는 은빛 열쇠를 소지했다\./);

  // Verify exact outputStart/outputEnd fragment slices remain intact
  for (const frag of rendered.fragments) {
    const expected = plan.choices.find(c => c.unit.id === frag.id).fragment.text;
    assert.equal(rendered.text.slice(frag.outputStart, frag.outputEnd), expected);
  }
});

test('Standalone, 2-product, and 3-product combinations + plugin_only / server_only / mirror parity', async () => {
  // Verify LIBRA across plugin_only and server_only via reader fixture
  for (const mode of ['plugin_only', 'server_only']) {
    const host = await createLibraReaderFixture({ mode });
    try {
      await host.f.r.api.saveLibraMemorySettings({ unifiedMemoryEngineMode: 'unified' });
      const msgs = await host.f.control.hooks.beforeRequest([{ role: 'user', content: LIBRA_FIXTURE_QUOTE }], 'model');
      const sys = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n');
      assert.match(sys, /\[LIBRA CLASSIC RECALL — CURRENT TURN ONLY\]/);
      assert.match(sys, /\[LIBRA_EVIDENCE consumer=classic/);
      assert.match(sys, /\[RELATIONSHIPS\]/);
      assert.match(sys, /\[KNOWLEDGE\]/);
      assert.match(sys, /\[OPEN THREADS\]/);
      assert.match(sys, /\[RELEVANT HISTORY\]/);
      assert.match(sys, /\[SCENE DETAILS\]/);
      assert.match(sys, /\[WORLD CONTEXT\]/);
      assert.match(sys, /\[RELATIONSHIP: 민아 → 지호\]/);
      assert.match(sys, /\[KNOWLEDGE HOLDER: 민아/);
      assert.match(sys, /attrib: /);
    } finally {
      await host.cleanup();
    }
  }

  // Verify sequential combination of LIBRA + HAYAKU + Flashback on shared message array without cross-plugin interference
  const compiler = createCompiler({ fingerprint: sha256 });
  const { graph, queryResult } = buildRichLibraGraph();
  const libraPacket = compiler.render(compiler.select(queryResult, graph, { consumer: 'classic', presentation: 'model_document', maxCharacters: 4096 }));
  const libraSystemMsg = { role: 'system', content: `[LIBRA CLASSIC RECALL — CURRENT TURN ONLY]\n<LIBRA_CLASSIC_RECALL>\n${libraPacket.renderedText}\n</LIBRA_CLASSIC_RECALL>` };

  const flashbackSystemMsg = {
    role: 'system',
    content: `[ACTIVE CONTINUITY EVIDENCE]\n\nORDERED PAST EVENTS — EARLIEST TO LATEST\n[E01] T4에서 민아가 열쇠 반환을 요구했다.\n\nLATEST CONFIRMED STATE\n[민아]\n- [T46 마지막 확인 · location] 당시 서재에 있었다.\n[/ACTIVE CONTINUITY EVIDENCE]`
  };

  const h = await createHayakuRuntime({
    autoRepair: false,
    afterRequestAutoRepair: false,
    backgroundAutoRepair: false,
    arguments: { memory_suite_server_mode: 'plugin_only', hayaku_packet_recovery: 'false' },
    messages: [
      { role: 'user', chatId: 'u1', data: '민아와 지호의 상황은?' },
      { role: 'assistant', chatId: 'a1', data: hiddenPacketMessage('민아는 서재에 있다.', createValidPacket({ turn: 1, summary: '민아는 서재에 있다.', subject: '민아', scene: 'library' })) }
    ]
  });
  try {
    const baseUser = { role: 'user', content: '현재 민아와 지호의 상태를 이어서 묘사해줘.' };
    // 1) LIBRA only
    const comboLibra = [libraSystemMsg, baseUser];
    assert.equal(comboLibra.length, 2);
    // 2) HAYAKU only
    const comboHayaku = await h.callBeforeRequest([baseUser], 'model');
    assert.ok(comboHayaku.some(m => String(m.content || '').includes('[HAYAKU')));
    // 3) Flashback only
    const comboFlashback = [flashbackSystemMsg, baseUser];
    assert.equal(comboFlashback.length, 2);
    // 4) LIBRA + HAYAKU
    const comboLH = await h.callBeforeRequest([libraSystemMsg, baseUser], 'model');
    assert.ok(comboLH.some(m => String(m.content || '').includes('<LIBRA_CLASSIC_RECALL>')));
    assert.ok(comboLH.some(m => String(m.content || '').includes('[HAYAKU')));
    // 5) LIBRA + Flashback
    const comboLF = [libraSystemMsg, flashbackSystemMsg, baseUser];
    assert.equal(comboLF.length, 3);
    // 6) HAYAKU + Flashback
    const comboHF = await h.callBeforeRequest([flashbackSystemMsg, baseUser], 'model');
    assert.ok(comboHF.some(m => String(m.content || '').includes('[ACTIVE CONTINUITY EVIDENCE]')));
    assert.ok(comboHF.some(m => String(m.content || '').includes('[HAYAKU')));
    // 7) LIBRA + HAYAKU + Flashback (All 3)
    const comboAll = await h.callBeforeRequest([libraSystemMsg, flashbackSystemMsg, baseUser], 'model');
    assert.ok(comboAll.some(m => String(m.content || '').includes('<LIBRA_CLASSIC_RECALL>')));
    assert.ok(comboAll.some(m => String(m.content || '').includes('[ACTIVE CONTINUITY EVIDENCE]')));
    assert.ok(comboAll.some(m => String(m.content || '').includes('[HAYAKU')));
  } finally {
    await h.dispose();
  }
});
