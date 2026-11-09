'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const createCompiler = require('../tools/libra_memory_graph_compiler.cjs');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
const { fixture: createLibraReaderFixture, QUOTE: LIBRA_FIXTURE_QUOTE } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const { createFixture: createFlashbackFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const { syntheticFetch, configure: configureFlashback, readyForRecall: readyFlashbackRecall } = require('./helpers/unload_recall_contract_fixture.cjs');

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
              char_mina: { id: 'char_mina', name: '민아', location: '서재', emotion: '분노', goal: '은빛 열쇠 회수', knowledge: ['지호가 열쇠 반환 약속을 지키지 않았음'] },
              char_jiho: { id: 'char_jiho', name: '지호', location: '복도', carrying: ['은빛 열쇠'] },
              // Stale/unregistered entity present in state head snapshot but absent from graph.nodes (layer === 'entity')
              old_mina: { id: 'old_mina', name: '민아', emotion: '분노' }
            },
            relationships: {
              'char_mina->char_jiho': { fromId: 'char_mina', fromName: '민아', toId: 'char_jiho', toName: '지호', state: '신뢰 하락' },
              'old_mina->char_jiho': { fromId: 'old_mina', fromName: '민아', toId: 'char_jiho', toName: '지호', state: '구버전 불신' }
            },
            world: {
              item_silver_key: { id: 'item_silver_key', name: '은빛 열쇠', ownerRef: 'char_mina', holderRef: 'char_jiho', status: '지호가 소지 중' },
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
    { id: 'u_no_owner', layer: 'unit', family: 'canonical', sourceId: 'src_can_1', bindingId: 'b_u12' },
    { id: 'u_stale_owner', layer: 'unit', family: 'state', sourceId: 'src_state_1', bindingId: 'b_u13' },
    { id: 'u_recorded_unknown_certainty', layer: 'unit', family: 'state', sourceId: 'src_state_1', bindingId: 'b_u14' }
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
    { nodeId: 'u_no_owner', family: 'canonical', kind: 'canonical_fact', semanticRole: 'canonical_assertion', turn: 3, provenanceStatus: 'verified', certainty: 'confirmed', fact: { claimKind: 'event' }, text: '밤비가 창문을 두드렸다.' },
    // [P1] entityId exists ('old_mina'), body contains '민아', but 'old_mina' is NOT in graph.nodes (layer === 'entity')
    { nodeId: 'u_stale_owner', family: 'state', kind: 'state_field', semanticRole: 'state_current', domain: 'character', entityId: 'old_mina', field: 'emotion', turn: 6, provenanceStatus: 'recorded', fieldEvidence: { memoryId: 'm1' }, certainty: 'confirmed', text: '민아 · character.emotion = 분노 (구버전 엔티티)' },
    // [P1/P2] family = state, certainty = unknown, provenanceStatus = recorded -> must stay certainty=unknown, NOT confirmed
    { nodeId: 'u_recorded_unknown_certainty', family: 'state', kind: 'state_field', semanticRole: 'state_current', domain: 'character', entityId: 'char_mina', field: 'attitude', turn: 6, provenanceStatus: 'recorded', fieldEvidence: { memoryId: 'm1' }, certainty: 'unknown', text: '민아 · character.attitude = 유보적 태도' }
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

  units.push({ nodeId: 'u_recorded_first', family: 'canonical', kind: 'canonical_fact', semanticRole: 'canonical_assertion', turn: 3, provenanceStatus: 'verified', certainty: 'confirmed', fact: { claimKind: 'event' }, text: '같은 턴에 먼저 일어난 사건.' });
  nodes.push({ id: 'u_recorded_first', layer: 'unit', family: 'canonical', sourceId: 'src_can_1', bindingId: 'b_u15' });
  candidates.push({ nodeId: 'u_recorded_first', sourceId: 'src_can_1', family: 'canonical', kind: 'canonical_fact', semanticRole: 'canonical_assertion', availability: 'set', provenanceStatus: 'verified', turn: 3, text: '같은 턴에 먼저 일어난 사건.', score: 0.1, mandatoryInclusion: false, evidenceFamilyId: 'ef_u_recorded_first', winningWitness: { sourceDependencies: ['src_can_1'], edgeChain: [], basisIds: [] } });

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

test('LIBRA: Model-Oriented Memory Document sections, State ownership, unresolved entityId degradation, certainty=unknown preservation, and consumer compatibility', async () => {
  const compiler = createCompiler({ fingerprint: sha256 });
  const { graph, queryResult } = buildRichLibraGraph();

  // 1. Default presentation preserves flat line-per-unit format for internal/other consumers
  const defaultSel = compiler.select(queryResult, graph, { consumer: 'classic', maxCharacters: 4096, maxUnits: 20 });
  const defaultPkt = compiler.render(defaultSel);
  assert.equal(defaultPkt.consumerVerification.ok, true);
  assert.equal(defaultPkt.renderedText.split('\n').length, defaultSel.bundle.items.length + 1);

  // 2. Model document presentation groups into semantic sections and is strictly deterministic
  const modelSel = compiler.select(queryResult, graph, {
    consumer: 'classic',
    presentation: 'model_document',
    maxCharacters: 4096,
    maxUnits: 20
  });
  const modelPkt = compiler.render(modelSel);
  const repeatPkt = compiler.render(compiler.select(queryResult, graph, {
    consumer: 'classic',
    presentation: 'model_document',
    maxCharacters: 4096,
    maxUnits: 20
  }));
  assert.equal(modelPkt.renderedText, repeatPkt.renderedText, 'compile+render must be 100% deterministic');
  assert.equal(modelPkt.consumerVerification.ok, true);
  assert.ok(modelPkt.characterLength <= 4096, 'rendered packet must respect maxCharacters budget');

  const text = modelPkt.renderedText;

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
  assert.match(text, /\[CHARACTER: 민아\]/);
  assert.match(text, /\[CHARACTER: 지호\]/);
  assert.match(text, /^  attrib: target=지호$/m);

  // Scenario 2: Relationship direction preservation
  assert.match(text, /\[RELATIONSHIP: 민아 → 지호\]/);
  assert.doesNotMatch(text, /visibility=(?:directional|known_by|subject_state|verified_evidence)|certainty=confirmed|provenance=T\d/, 'section meaning and defaults are stated once in the header');

  // Scenario 3: Object owner vs current holder separation
  assert.match(text, /\[WORLD \/ OBJECT STATE: 은빛 열쇠\]/);
  assert.match(text, /object_state: owner=민아 \| holder=지호 \| note=owner_and_current_holder_differ/);

  // Scenario 4 & 5: Knowledge boundary & unconfirmed awareness of other characters
  assert.match(text, /\[KNOWLEDGE HOLDER: 민아\]/);

  // [P1] Unresolved entityId ('old_mina') + character name in text ('민아') must NOT be promoted to a verified owner
  assert.doesNotMatch(text, /id=old_mina/, 'stale/unregistered entityId must never be rendered in a character header');
  const staleOwnerItem = modelSel.bundle.items.find(i => i.nodeId === 'u_stale_owner');
  assert.ok(staleOwnerItem, 'u_stale_owner must be present');
  assert.equal(staleOwnerItem.attribution.ownerId, null, 'unverified entityId must not populate ownerId');
  assert.equal(staleOwnerItem.attribution.ownerName, null, 'unverified entityId must not reconstruct ownerName from text');
  assert.equal(staleOwnerItem.attribution.ownerResolution, 'unresolved');
  assert.equal(staleOwnerItem.subHeader, '', 'unverified entityId must not emit a [CHARACTER: ...] subheader');
  assert.match(staleOwnerItem.attributionLine, /^owner=unresolved/);

  // [P1/P2] Recorded state with certainty='unknown' must preserve certainty=unknown and never promote to confirmed
  const recordedUnknownItem = modelSel.bundle.items.find(i => i.nodeId === 'u_recorded_unknown_certainty');
  assert.ok(recordedUnknownItem, 'u_recorded_unknown_certainty must be present');
  assert.equal(recordedUnknownItem.attribution.certainty, 'unknown', 'certainty=unknown must not be promoted to confirmed');
  assert.match(recordedUnknownItem.attributionLine, /certainty=unknown$/);
  assert.doesNotMatch(recordedUnknownItem.attributionLine, /certainty=confirmed/);

  // Scenario 8 & 9: Missing entityId safe degradation (no owner guessed when entityId is absent)
  const noOwnerItem = modelSel.bundle.items.find(i => i.nodeId === 'u_no_owner');
  assert.equal(noOwnerItem.attribution.ownerId, null);
  assert.equal(noOwnerItem.attribution.ownerName, null);
  assert.equal(noOwnerItem.attribution.ownerResolution, 'none');
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

  // GRADIA, GUI and Input Writer contracts remain untouched
  for (const consumer of ['input_writer', 'gui', 'gradia']) {
    const sel = compiler.select(queryResult, graph, {
      consumer,
      maxCharacters: 4096,
      ...(consumer === 'gradia' ? { gradiaSelectionReceipt: { ownerCorpusDigest: 'd1', selectionReceiptId: 'r1' } } : {})
    });
    const pkt = compiler.render(sel);
    assert.equal(pkt.consumerVerification.ok, true, `${consumer} packet verification must pass`);
  }
});

test('LIBRA: an internal id appears only when a name alone could mean two entities', () => {
  const compiler = createCompiler({ fingerprint: sha256 });
  const { graph, queryResult } = buildRichLibraGraph();
  graph.nodes.push({ id: 'ent_mina_2', layer: 'entity', family: 'entity', bindingId: 'b_ent_mina_2', identity: { entityKey: 'char_mina_2', name: '민아', kind: 'character' } });
  const { renderedText } = compiler.render(compiler.select(queryResult, graph, { consumer: 'classic', presentation: 'model_document', maxCharacters: 4096, maxUnits: 20 }));
  assert.match(renderedText, /\[CHARACTER: 민아 \| id=char_mina\]/);
  assert.match(renderedText, /\[CHARACTER: 지호\]/);
  assert.match(renderedText, /object_state: owner=민아\(char_mina\) \| holder=지호 \|/);
});

test('LIBRA: recalled evidence carries a recorded timeline without inventing story time', () => {
  const compiler = createCompiler({ fingerprint: sha256 });
  const { graph, queryResult } = buildRichLibraGraph();
  const unit = id => graph.units.find(row => row.nodeId === id);
  const candidate = id => queryResult.candidates.find(row => row.nodeId === id);
  const setTurn = (id, turn, fields = {}) => { Object.assign(unit(id), { turn, ...fields }); candidate(id).turn = turn; };
  // Relevance ranks the newer fact first; a recollection recorded late must not read as a current event.
  setTurn('u_can_hist', 90, { temporalRole: 'flashback', sessionEpoch: 0 });
  setTurn('u_no_owner', 25, { temporalRole: 'current_sequence', sessionEpoch: 0, factIndex: 1, storyClock: '2026-05-14 (목) 09:12 PM' });
  // Same turn, earlier in the source artifact, but ranked lower: fact order decides.
  setTurn('u_recorded_first', 25, { temporalRole: 'current_sequence', sessionEpoch: 0, factIndex: 0 });

  const selected = compiler.select(queryResult, graph, { consumer: 'classic', presentation: 'model_document', maxCharacters: 4096, maxUnits: 20 });
  const packet = compiler.render(selected);
  assert.equal(packet.consumerVerification.ok, true);
  const text = packet.renderedText;
  assert.ok(text.indexOf(unit('u_no_owner').text) < text.indexOf(unit('u_can_hist').text), 'history reads oldest to newest despite score order');
  const history = selected.bundle.items.filter(item => item.semanticSection === 'RELEVANT HISTORY').map(item => item.nodeId);
  assert.deepEqual(history, ['u_recorded_first', 'u_no_owner', 'u_can_hist'], 'recorded turn, then fact order inside a turn');
  const attribOf = id => selected.bundle.items.find(item => item.nodeId === id).attributionLine;
  assert.equal(attribOf('u_can_hist'), 'temporal=flashback');
  const timeOf = id => selected.bundle.items.find(item => item.nodeId === id).timeLine;
  assert.equal(timeOf('u_no_owner'), 'T25 | 2026-05-14 (목) 09:12 PM');
  assert.equal(timeOf('u_can_hist'), 'T90', 'a recollection never takes the clock of the turn that recorded it');
  assert.doesNotMatch(attribOf('u_no_owner'), /temporal=/, 'the current sequence stays unmarked');
  assert.equal(timeOf('u_lore_rule'), '', 'timeless lore gains no invented time');

  // Reordering is presentation only: the same units are admitted with the same budget.
  const baseline = buildRichLibraGraph();
  const baselineSelected = compiler.select(baseline.queryResult, baseline.graph, { consumer: 'classic', presentation: 'model_document', maxCharacters: 4096, maxUnits: 20 });
  assert.deepEqual(selected.bundle.items.map(item => item.nodeId).sort(), baselineSelected.bundle.items.map(item => item.nodeId).sort());

  // GRADIA has no attrib lines, so its evidence lines carry the same time facts inline.
  const gradiaPacket = compiler.render(compiler.select(queryResult, graph, {
    consumer: 'gradia', maxCharacters: 4096, maxUnits: 20,
    gradiaSelectionReceipt: { ownerCorpusDigest: 'd1', selectionReceiptId: 'r1' }
  }));
  assert.equal(gradiaPacket.consumerVerification.ok, true);
  assert.match(gradiaPacket.renderedText, /\[canonical:canonical_assertion@recorded_T90\/flashback\] /);
  assert.match(gradiaPacket.renderedText, /\[canonical:canonical_assertion@recorded_T25\/clock=2026-05-14 \(목\) 09:12 PM\] /);
  assert.match(gradiaPacket.renderedText, /\[lore:background_setting\] /, 'timeless lore gains no invented time');
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

test('Standalone, 2-product, and 3-product real beforeRequest hook combinations + plugin_only / server_only / mirror parity', async () => {
  // 1. Verify LIBRA across all 3 storage modes: plugin_only, server_only, and mirror
  for (const mode of ['plugin_only', 'server_only', 'mirror']) {
    const host = await createLibraReaderFixture({ mode });
    try {
      await host.f.r.api.saveLibraMemorySettings({ unifiedMemoryEngineMode: 'unified' });
      const msgs = await host.f.control.hooks.beforeRequest([{ role: 'user', content: LIBRA_FIXTURE_QUOTE }], 'model');
      const sys = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n');
      assert.match(sys, /\[LIBRA CLASSIC RECALL — CURRENT TURN ONLY\]/, `${mode}: classic header`);
      // User requested removal of [LIBRA_EVIDENCE consumer=classic ...] meta header
      assert.doesNotMatch(sys, /\[LIBRA_EVIDENCE consumer=classic/, `${mode}: evidence header stripped`);
      assert.match(sys, /\[RELATIONSHIPS\]/, `${mode}: RELATIONSHIPS section`);
      assert.match(sys, /\[KNOWLEDGE\]/, `${mode}: KNOWLEDGE section`);
      assert.match(sys, /\[OPEN THREADS\]/, `${mode}: OPEN THREADS section`);
      assert.match(sys, /\[RELEVANT HISTORY\]/, `${mode}: RELEVANT HISTORY section`);
      assert.match(sys, /\[SCENE DETAILS\]/, `${mode}: SCENE DETAILS section`);
      assert.match(sys, /\[WORLD CONTEXT\]/, `${mode}: WORLD CONTEXT section`);
      assert.match(sys, /\[RELATIONSHIP: 민아 → 지호\]/, `${mode}: relationship subheader`);
      assert.match(sys, /\[KNOWLEDGE HOLDER: 민아/, `${mode}: knowledge holder subheader`);
      // Verify recorded state with default 'unknown' certainty is preserved as certainty=unknown
      assert.match(sys, /certainty=unknown/, `${mode}: unknown certainty preserved without promotion to confirmed`);
    } finally {
      await host.cleanup();
    }
  }

  // 2. Stand up real LIBRA, HAYAKU, and Flashback runtimes and execute their actual registered beforeRequest hooks
  //    across all 7 standalone & multi-plugin combinations.
  const libraHost = await createLibraReaderFixture({ mode: 'plugin_only' });
  await libraHost.f.r.api.saveLibraMemorySettings({ unifiedMemoryEngineMode: 'unified' });

  const hayakuFact = '민아는 서재 책상 서랍에 은빛 열쇠 보관함을 넣어 두었다.';
  const hayakuPkt = createValidPacket({ turn: 1, summary: hayakuFact, subject: '민아', scene: 'library' });
  const hayakuMessages = [
    { role: 'user', chatId: 'u1', data: '은빛 열쇠 보관함은 어디에 있지?' },
    { role: 'assistant', chatId: 'a1', data: hiddenPacketMessage(hayakuFact, hayakuPkt) }
  ];
  const hayakuRuntime = await createHayakuRuntime({
    autoRepair: false,
    afterRequestAutoRepair: false,
    backgroundAutoRepair: false,
    arguments: { memory_suite_server_mode: 'plugin_only', hayaku_packet_recovery: 'false' },
    messages: hayakuMessages
  });

  // Prepare Flashback through its public capture + fresh runtime reload path so its real beforeRequest hook injects
  const fbSeedUser = '은빛 열쇠와 서재 계기판 상태를 확인한다.';
  const fbSeedReply = '서재 계기판 바늘이 붉은 눈금에 멈춰 있고 은빛 열쇠 고리가 북쪽 벽에 걸려 있다.';
  const fbSeedPhrase = '서재 계기판 바늘이 붉은 눈금에 멈춰 있고';
  let fbInit = await createFlashbackFixture({ captureBackend: 'afterRequest' });
  const fbStorage = fbInit.pluginStorage;
  const fbHost = fbInit.host;
  let fbChat = null;
  let fbCharacter = null;
  try {
    fbInit.host.nativeFetch = (url, init) => syntheticFetch(url, init);
    await configureFlashback(fbInit, 'configured');
    await fbInit.api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
    await fbInit.api._selectionTest.beforeRequest([{ role: 'user', chatId: 'u1', content: fbSeedUser }], 'model');
    await new Promise(resolve => setTimeout(resolve, 30));
    fbInit.currentChat.message = [
      { role: 'user', chatId: 'u1', data: fbSeedUser },
      { role: 'assistant', chatId: 'a1', data: fbSeedReply }
    ];
    fbInit.currentChat.messages = fbInit.currentChat.message;
    await fbInit.api._selectionTest.afterRequest(fbSeedReply, 'model');
    await readyFlashbackRecall(fbInit, 'configured', fbSeedPhrase);
    fbChat = JSON.parse(JSON.stringify(fbInit.currentChat));
    fbCharacter = JSON.parse(JSON.stringify(fbInit.character));
  } finally {
    await fbInit.dispose();
  }

  const fbRuntime = await createFlashbackFixture({
    pluginStorage: fbStorage,
    safeLocalStorage: fbHost.safeLocalStorage,
    chat: fbChat,
    character: fbCharacter,
    captureBackend: 'afterRequest'
  });

  try {
    fbRuntime.host.nativeFetch = (url, init) => syntheticFetch(url, init);
    await configureFlashback(fbRuntime, 'configured');
    const sharedQuery = `${LIBRA_FIXTURE_QUOTE} 서재 계기판 바늘과 은빛 열쇠 보관함 상태를 알려줘.`;
    // Warm up Flashback turn worldline sync once
    await fbRuntime.api._selectionTest.beforeRequest([{ role: 'user', chatId: 'u8', content: sharedQuery }], 'model');

    const runLibraHook = async msgs => await libraHost.f.control.hooks.beforeRequest(msgs, 'model');
    const runHayakuHook = async msgs => await hayakuRuntime.callBeforeRequest(msgs, 'model');
    const runFlashbackHook = async msgs => await fbRuntime.api._selectionTest.beforeRequest(msgs, 'model');

    const countOccurrences = (haystack, needle) => String(haystack || '').split(needle).length - 1;

    const combinations = [
      { name: 'LIBRA only', hooks: [runLibraHook], expect: { libra: 1, hayaku: 0, flashback: 0 } },
      { name: 'HAYAKU only', hooks: [runHayakuHook], expect: { libra: 0, hayaku: 1, flashback: 0 } },
      { name: 'Flashback only', hooks: [runFlashbackHook], expect: { libra: 0, hayaku: 0, flashback: 1 } },
      { name: 'LIBRA + HAYAKU', hooks: [runLibraHook, runHayakuHook], expect: { libra: 1, hayaku: 1, flashback: 0 } },
      { name: 'LIBRA + Flashback', hooks: [runLibraHook, runFlashbackHook], expect: { libra: 1, hayaku: 0, flashback: 1 } },
      { name: 'HAYAKU + Flashback', hooks: [runHayakuHook, runFlashbackHook], expect: { libra: 0, hayaku: 1, flashback: 1 } },
      { name: 'LIBRA + HAYAKU + Flashback', hooks: [runLibraHook, runHayakuHook, runFlashbackHook], expect: { libra: 1, hayaku: 1, flashback: 1 } }
    ];

    for (const [idx, combo] of combinations.entries()) {
      let messages = [{ role: 'user', chatId: `u_combo_${idx + 10}`, content: sharedQuery, data: sharedQuery }];
      for (const hook of combo.hooks) {
        messages = await hook(messages);
      }
      const combinedText = messages.map(m => String(m.content || m.data || '')).join('\n');
      assert.equal(
        countOccurrences(combinedText, '<LIBRA_CLASSIC_RECALL>'),
        combo.expect.libra,
        `${combo.name}: LIBRA marker count must be ${combo.expect.libra}`
      );
      assert.equal(
        countOccurrences(combinedText, '[HAYAKU RUNTIME PACKET SHAPE]'),
        combo.expect.hayaku,
        `${combo.name}: HAYAKU marker count must be ${combo.expect.hayaku}`
      );
      assert.equal(
        countOccurrences(combinedText, '[ACTIVE CONTINUITY EVIDENCE]'),
        combo.expect.flashback,
        `${combo.name}: Flashback marker count must be ${combo.expect.flashback}`
      );
    }
  } finally {
    await fbRuntime.dispose();
    await hayakuRuntime.dispose();
    await libraHost.cleanup();
  }
});
