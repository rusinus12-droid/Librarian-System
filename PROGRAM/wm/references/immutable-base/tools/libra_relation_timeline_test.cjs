'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const clone = (v) => v == null ? v : JSON.parse(JSON.stringify(v));
const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) <= eps;
const assertions = [];
const check = (name, ok, details = {}) => { assertions.push({ name, ok: !!ok, details }); if (!ok) throw new Error(`${name}: ${JSON.stringify(details)}`); };

async function load() {
  const chat = { id: 'relation-timeline-chat', localLore: [], msgs: [], message: [], isStreaming: false };
  const char = { id: 'relation-timeline-char', name: 'Relation Timeline', chatPage: 0, chats: [chat], globalLore: [] };
  const storage = new Map();
  const args = new Map(Object.entries({ debug: 'false', llm_provider: 'custom_openai', llm_url: 'http://mock', llm_key: 'x', llm_model: 'mock', embedding_enabled: 'false', activity_dashboard: 'off' }));
  const risuai = {
    apiVersion: '3.0-test',
    async getRuntimeInfo(){ return { apiVersion: '3.0-test', platform: 'node-test' }; },
    async getArgument(n){ return args.get(n); }, async requestPluginPermission(){ return true; },
    async getCharacter(){ return clone(char); }, async getCurrentCharacterIndex(){ return 0; }, async getCurrentChatIndex(){ return 0; },
    async getCharacterFromIndex(){ return clone(char); }, async getChatFromIndex(){ return clone(chat); },
    async setChatToIndex(_a,_b,next){ Object.assign(chat, clone(next)); char.chats[0] = chat; return true; },
    async setCharacter(next){ Object.assign(char, clone(next)); return true; },
    async addRisuReplacer(){ return true; }, async removeRisuReplacer(){ return true; },
    async addRisuScriptHandler(){ return true; }, async removeRisuScriptHandler(){ return true; },
    async registerBodyIntercepter(){ return 'relation-test'; }, async unregisterBodyIntercepter(){ return true; }, async onUnload(){ return true; },
    async registerSetting(){ return true; }, async registerButton(){ return true; }, async showContainer(){ return true; }, async hideContainer(){ return true; },
    async getDatabase(){ return { personas: [], selectedPersona: null }; },
    pluginStorage: { async getItem(k){ return storage.get(k) ?? null; }, async setItem(k,v){ storage.set(k, String(v)); return true; }, async removeItem(k){ storage.delete(k); return true; } },
    safeLocalStorage: { async getItem(){ return null; }, async setItem(){ return true; }, async removeItem(){ return true; } },
    async getLocalPluginStorage(){ return { async getItem(){ return null; }, async setItem(){ return true; }, async removeItem(){ return true; } }; },
    async nativeFetch(){ throw new Error('unexpected fetch'); }
  };
  let code = fs.readFileSync(DIST, 'utf8');
  const exportCode = `\n;globalThis.__LIBRA_RELATION_TEST__={EntityManager,EntityAwareProcessor,MemoryEngine,MemoryState,LibraLoreConsolidator,LibraDataStorage};\n`;
  const idx = code.lastIndexOf('\n})();');
  if (idx < 0) throw new Error('IIFE close not found');
  code = code.slice(0, idx) + exportCode + code.slice(idx);
  const context = { console: { log(){}, warn(){}, error(){}, debug(){} }, setTimeout, clearTimeout, setInterval, clearInterval, performance,
    crypto: { randomUUID: crypto.randomUUID }, AbortController, TextEncoder, TextDecoder, URL, Buffer,
    fetch: async()=>{ throw new Error('unexpected fetch'); }, risuai, Risuai: risuai, globalThis: null, process: { env: {} },
    atob: s=>Buffer.from(String(s),'base64').toString('binary'), btoa:s=>Buffer.from(String(s),'binary').toString('base64') };
  context.globalThis = context;
  vm.createContext(context);
  const result = vm.runInContext(code, context, { filename: DIST, timeout: 15000 });
  if (result && typeof result.then === 'function') await result;
  await new Promise(r=>setTimeout(r,60));
  return { api: context.__LIBRA_RELATION_TEST__, chat, char };
}

(async()=>{
  const { api, char, chat } = await load();
  const { EntityManager, EntityAwareProcessor, MemoryEngine } = api;
  const admission = await api.LibraDataStorage.preparePersonaContext(char, chat);
  check('persistence_target_is_admitted', admission.ok);
  check('entity_manager_exported', !!EntityManager);
  check('entity_processor_exported', !!EntityAwareProcessor);
  const fullNameCases = [
    '텐마 사키',
    '키리타니 하루카',
    '존 스미스',
    '天馬 咲希',
    'Jean-Luc Picard'
  ];
  for (const fullName of fullNameCases) {
    const sanitized = EntityAwareProcessor.sanitizeEntities([{
      name: fullName,
      entityKind: 'character',
      status: { currentLocation: '교실' }
    }], [], {
      conversationText: `${fullName}가 교실에 들어왔다.`,
      requireConversationEvidenceForNew: true
    });
    check(`multipart_name_preserved:${fullName}`, sanitized.length === 1 && sanitized[0].name === fullName, { sanitized });
  }
  const fullNameLore = [];
  EntityManager.clearCache();
  EntityManager.updateEntity('텐마', {
    source: 'structured_packet',
    identity: { aliases: ['사키', 'Saki Tenma'] }
  }, fullNameLore);
  EntityManager.updateEntity('푸딩', { source: 'structured_packet' }, fullNameLore);
  EntityManager.updateRelation('푸딩', '텐마', { relationType: 'classmate', source: 'structured_packet' }, fullNameLore);
  EntityManager.updateEntity('텐마 사키', {
    source: 'structured_packet',
    identity: { aliases: ['사키', 'Saki Tenma'] }
  }, fullNameLore);
  EntityManager.collapseDuplicates();
  check('partial_japanese_name_upgraded_to_full_name',
    EntityManager.getEntityCache().has('텐마 사키') && !EntityManager.getEntityCache().has('텐마'),
    { entityNames: Array.from(EntityManager.getEntityCache().keys()) });
  const migratedRelation = Array.from(EntityManager.getRelationCache().values())[0];
  check('partial_name_relation_rewritten_to_full_name',
    migratedRelation && [migratedRelation.entityA, migratedRelation.entityB].includes('텐마 사키'),
    { migratedRelation });
  EntityManager.clearCache();
  const lore = [];
  MemoryEngine.setTurn(1);
  EntityManager.updateEntity('Ari', { source: 'manual', status: { currentLocation: 'hall' } }, lore);
  EntityManager.updateEntity('Noah', { source: 'manual', status: { currentLocation: 'hall' } }, lore);
  let rel = EntityManager.updateRelation('Ari', 'Noah', {
    relationType: '연인', details: { closeness: 0.8, trust: 0.9 }, metrics: { tension: 0.1, risk: 0.1 },
    source: 'conversation', s_id: 'session-1', m_id: 'm1', event: '서로의 신뢰를 확인했다.'
  }, lore);
  check('initial_absolute_projection', near(rel.details.closeness,0.8) && near(rel.details.trust,0.9) && near(rel.metrics.tension,0.1), { details: rel.details, metrics: rel.metrics });
  check('timeline_created', rel.relationTimeline?.schema === 'libra.relation.timeline.v1' && rel.relationTimeline.events.length === 1, { timeline: rel.relationTimeline });

  MemoryEngine.setTurn(2);
  rel = EntityManager.updateRelation('Ari', 'Noah', {
    relationType: '배신 이후 적대', relationDelta: { closeness: -0.6, trust: -1 }, sentiments: { currentTension: 0.85 }, metrics: { risk: 0.9, ambiguity: 0.1 },
    source: 'conversation', s_id: 'session-1', m_id: 'm2', event: 'Noah가 Ari를 배신했다.',
    eventLedger: [{ summary: '배신 사건 원장', messageId: 'm2', status: 'active' }],
    evidence: [{ snippet: '배신의 직접 증거', messageId: 'm2', sourceKind: 'conversation', status: 'active' }]
  }, lore);
  check('negative_delta_lowers_scores', near(rel.details.closeness,0.5) && near(rel.details.trust,0.4), { closeness: rel.details.closeness, trust: rel.details.trust });
  check('absolute_tension_and_risk_can_update', near(rel.metrics.tension,0.85) && near(rel.metrics.risk,0.9), { metrics: rel.metrics });
  check('relation_label_is_not_floor', rel.details.trust < 0.75 && rel.relationType === '배신 이후 적대', { trust: rel.details.trust, relationType: rel.relationType });
  const afterBetrayal = clone(rel.relationTimeline);

  rel = EntityManager.updateRelation('Ari', 'Noah', {
    relationType: '배신 이후 적대', relationDelta: { closeness: -0.6, trust: -1 }, sentiments: { currentTension: 0.85 }, metrics: { risk: 0.9, ambiguity: 0.1 },
    source: 'conversation', s_id: 'session-1', m_id: 'm2', event: 'Noah가 Ari를 배신했다.',
    eventLedger: [{ summary: '배신 사건 원장', messageId: 'm2', status: 'active' }],
    evidence: [{ snippet: '배신의 직접 증거', messageId: 'm2', sourceKind: 'conversation', status: 'active' }]
  }, lore);
  check('same_source_reanalysis_is_idempotent', near(rel.details.closeness,0.5) && near(rel.details.trust,0.4) && rel.relationTimeline.events.length === afterBetrayal.events.length, { timeline: rel.relationTimeline });

  MemoryEngine.setTurn(3);
  rel = EntityManager.updateRelation('Ari', 'Noah', {
    relationDelta: { closeness: 0.2, trust: 0.4, tension: -0.35 }, metrics: { risk: 0.45 },
    source: 'conversation', s_id: 'session-1', m_id: 'm3', event: 'Noah가 사과하고 일부 신뢰를 회복했다.'
  }, lore);
  check('recovery_can_raise_and_lower_independent_axes', near(rel.details.closeness,0.6) && near(rel.details.trust,0.6) && near(rel.metrics.tension,0.5) && near(rel.metrics.risk,0.45), { details: rel.details, metrics: rel.metrics });

  const retracted = EntityManager.retractRelationTimelineEvents(rel, ['m2'], { status: 'retracted', reason: 'reroll_deleted' });
  check('targeted_event_retracted', retracted === 1, { retracted, timeline: rel.relationTimeline });
  check('projection_recomputed_without_deleted_betrayal', near(rel.details.closeness,0.9) && near(rel.details.trust,1.0) && near(rel.metrics.tension,0) && near(rel.metrics.risk,0.45), { details: rel.details, metrics: rel.metrics });
  check('inactive_event_retained_for_audit', rel.relationTimeline.events.some(e=>e.sourceMessageId==='m2' && e.status==='retracted'));
  check('auxiliary_provenance_retracted', rel.eventLedger.some(e=>e.messageId==='m2' && e.status==='retracted') && rel.evidence.some(e=>e.messageId==='m2' && e.status==='retracted'), { eventLedger: rel.eventLedger, evidence: rel.evidence });
  const relationPromptAfterRetraction = EntityManager.formatRelationForPrompt(rel);
  check('retracted_event_not_injected', !relationPromptAfterRetraction.includes('배신했다') && !relationPromptAfterRetraction.includes('배신 사건 원장'), { relationPromptAfterRetraction });

  MemoryEngine.setTurn(4);
  rel = EntityManager.updateRelation('Ari','Noah',{ relationDelta:{trust:-1}, source:'conversation', s_id:'session-1', m_id:'m4', event:'다시 거짓말했다.' }, lore);
  check('latest_event_applied_before_rollback', near(rel.details.trust,0.5), { trust: rel.details.trust });
  // 스냅샷 롤백 기계는 제거되었다 (사용자가 새로 만들 예정). 대신 남아있는
  // 리트랙션 경로가 그 역할을 대신하는지 확인한다.
  const retractResult = EntityManager.retractRelationTimelineEvents(rel, ['m4'], { status: 'retracted', reason: 'reroll_deleted' });
  check('rollback_removed_but_retraction_works', retractResult >= 0 && !Object.prototype.hasOwnProperty.call(rel.meta || {}, 'rollbackSnapshots'), { retracted: retractResult, metaKeys: Object.keys(rel.meta || {}).slice(0, 10) });

  await EntityManager.saveToLorebook(char, chat, lore);
  const savedRelation = lore.find(e=>e.comment==='lmai_relation');
  check('timeline_persisted', !!savedRelation && JSON.parse(savedRelation.content).relationTimeline?.events?.length === 4, { count: savedRelation ? JSON.parse(savedRelation.content).relationTimeline?.events?.length : 0 });
  EntityManager.clearCache();
  EntityManager.rebuildCache(lore);
  const rebuilt = [...EntityManager.getRelationCache().values()][0];
  check('rebuild_preserves_projection', !!rebuilt && near(rebuilt.details.trust,1.0) && near(rebuilt.details.closeness,0.9), { rebuilt });
  check('timeline_bounded', rebuilt.relationTimeline.events.length <= 96, { count: rebuilt.relationTimeline.events.length });
  check('defined_assessment_updates_from_first_contact', rebuilt.relationshipAssessment?.stage === 'defined' && rebuilt.relationshipAssessment?.definitionConfidence > 0.5, { assessment: rebuilt.relationshipAssessment });

  const beforeManualEventCount = rebuilt.relationTimeline.events.length;
  const manual = EntityManager.applyManualRelationProjection(rebuilt, {
    relationType: '연인', closeness: 0.2, trust: 0.1,
    currentStatus: { summary: '수동으로 관계 악화를 반영함' }, currentTurn: 5, sourceRevision: 1
  });
  check('gui_manual_projection_has_no_relation_type_floor', near(manual.details.closeness, 0.2) && near(manual.details.trust, 0.1), { details: manual.details, relationType: manual.relationType });
  const manualEventCount = manual.relationTimeline.events.length;
  EntityManager.applyManualRelationProjection(manual, {
    relationType: '연인', closeness: null, trust: null,
    currentStatus: { summary: '수치를 미정으로 되돌림' }, currentTurn: 6, sourceRevision: 2
  });
  check('gui_manual_projection_can_clear_scores_and_upserts', manual.details.closeness == null && manual.details.trust == null && manual.relationTimeline.events.length === manualEventCount && manualEventCount === beforeManualEventCount + 1, { details: manual.details, eventCount: manual.relationTimeline.events.length });

  MemoryEngine.setTurn(10);
  EntityManager.updateEntity('Mina', { source: 'manual' }, lore);
  EntityManager.updateEntity('Jin', { source: 'manual' }, lore);
  let compacted = EntityManager.updateRelation('Mina', 'Jin', {
    details: { closeness: 0.5, trust: 0.5 }, axes: { respect: 0.6 }, currentStatus: { summary: 'steady', lastChangedTurn: 10 },
    source: 'conversation', s_id: 'session-2', m_id: 'c0', event: '관계를 정립했다.'
  }, lore);
  for (let i = 1; i <= 120; i++) {
    MemoryEngine.setTurn(10 + i);
    compacted = EntityManager.updateRelation('Mina', 'Jin', {
      relationDelta: { trust: i % 2 ? 0.02 : -0.02 },
      axisDeltas: { respect: i % 2 ? 0.02 : -0.02 },
      currentStatus: { summary: `state-${i}`, lastChangedTurn: 10 + i },
      source: 'conversation', s_id: 'session-2', m_id: `c${i}`, event: `change-${i}`
    }, lore);
  }
  check('timeline_compacts_without_losing_projection', compacted.relationTimeline.events.length === 96 && compacted.relationTimeline.history.length === 25 && compacted.relationTimeline.compaction?.compactedEvents === 25 && compacted.relationTimeline.compaction?.provenanceRetained === true && near(compacted.details.trust, 0.5) && near(compacted.axes.respect, 0.6), {
    count: compacted.relationTimeline.events.length, history: compacted.relationTimeline.history.length, compaction: compacted.relationTimeline.compaction, trust: compacted.details.trust, respect: compacted.axes.respect
  });
  const compactedRetraction = EntityManager.retractRelationTimelineEvents(compacted, ['c1'], { status: 'retracted', reason: 'old_source_deleted' });
  check('compacted_history_remains_source_reversible', compactedRetraction === 1 && near(compacted.details.trust, 0.49) && near(compacted.axes.respect, 0.58) && compacted.relationTimeline.history.some(event => event.sourceMessageId === 'c1' && event.status === 'retracted'), {
    retracted: compactedRetraction, trust: compacted.details.trust, respect: compacted.axes.respect, history: compacted.relationTimeline.history.slice(0, 3)
  });
  check('latest_volatile_relation_status_wins', compacted.currentStatus.summary === 'state-120', { currentStatus: compacted.currentStatus });

  // Delayed analysis must retain historical evidence without rolling the live
  // projection back to an older source turn.
  MemoryEngine.setTurn(20);
  let monotonicEntity = EntityManager.updateEntity('Chrona', {
    source: 'conversation', sourceTurn: 13, m_id: 'entity-t13',
    status: { currentLocation: 'roof', currentMood: 'calm', healthStatus: 'healed' },
    currentState: { summary: 'recovered', location: 'roof', physicalState: ['healed'], emotionalState: ['calm'], activeProblems: [] },
    continuity: { openThreads: [], unresolvedNeeds: [], commitments: [], nextActionHints: ['leave safely'] }
  }, lore);
  monotonicEntity = EntityManager.updateEntity('Chrona', {
    source: 'correction', forceReplace: true, sourceTurn: 12, m_id: 'entity-t12-late',
    status: { currentLocation: 'hall', currentMood: 'afraid', healthStatus: 'bleeding' },
    currentState: { summary: 'wounded', location: 'hall', physicalState: ['bleeding'], emotionalState: ['afraid'], activeProblems: ['wound'] },
    continuity: { openThreads: ['escape'], unresolvedNeeds: ['treatment'], commitments: [], nextActionHints: ['hide'] },
    evidence: [{ snippet: 'historical wound', messageId: 'entity-t12-late', sourceKind: 'conversation' }]
  }, lore);
  check('late_entity_turn_cannot_rollback_current_state', monotonicEntity.currentState.location === 'roof'
    && monotonicEntity.currentState.physicalState.includes('healed')
    && !monotonicEntity.currentState.physicalState.includes('bleeding')
    && monotonicEntity.currentState.activeProblems.length === 0
    && monotonicEntity.meta.sourceTurn === 13,
    { currentState: monotonicEntity.currentState, status: monotonicEntity.status, meta: monotonicEntity.meta });
  check('late_entity_evidence_is_retained', monotonicEntity.evidence.some(item => item.messageId === 'entity-t12-late'), { evidence: monotonicEntity.evidence });
  monotonicEntity = EntityManager.updateEntity('Chrona', {
    source: 'conversation', sourceTurn: 14, m_id: 'entity-t14',
    currentState: { location: 'street', physicalState: [], emotionalState: ['relieved'], activeProblems: [] }
  }, lore);
  check('newer_entity_snapshot_replaces_empty_arrays', monotonicEntity.currentState.location === 'street'
    && monotonicEntity.currentState.physicalState.length === 0
    && monotonicEntity.currentState.emotionalState.includes('relieved')
    && monotonicEntity.meta.sourceTurn === 14,
    { currentState: monotonicEntity.currentState, meta: monotonicEntity.meta });

  EntityManager.updateEntity('Rin', { source: 'conversation', sourceTurn: 13 }, lore);
  EntityManager.updateEntity('Sol', { source: 'conversation', sourceTurn: 13 }, lore);
  let monotonicRelation = EntityManager.updateRelation('Rin', 'Sol', {
    source: 'conversation', sourceTurn: 13, m_id: 'rel-t13', relationType: '동맹',
    currentStatus: { summary: 'trusted allies', lastChangedTurn: 13 },
    sentiments: { fromAtoB: 'trust', fromBtoA: 'trust' }, event: '동맹을 맺었다.'
  }, lore);
  monotonicRelation = EntityManager.updateRelation('Rin', 'Sol', {
    source: 'correction', forceReplace: true, sourceTurn: 12, m_id: 'rel-t12-late', relationType: '적대',
    currentStatus: { summary: 'hostile', lastChangedTurn: 12 },
    sentiments: { fromAtoB: 'hate', fromBtoA: 'hate' }, event: '과거에 다퉜다.'
  }, lore);
  check('late_relation_turn_cannot_rollback_projection', monotonicRelation.relationType === '동맹'
    && monotonicRelation.currentStatus.summary === 'trusted allies'
    && monotonicRelation.sentiments.fromAtoB === 'trust'
    && monotonicRelation.meta.sourceTurn === 13,
    { relationType: monotonicRelation.relationType, currentStatus: monotonicRelation.currentStatus, sentiments: monotonicRelation.sentiments, meta: monotonicRelation.meta });
  check('late_relation_event_remains_historical', monotonicRelation.relationTimeline.events.some(event => event.sourceMessageId === 'rel-t12-late' && event.turn === 12), { timeline: monotonicRelation.relationTimeline });

  const result = { ok: assertions.every(a=>a.ok), assertions, projection: { details: rebuilt.details, metrics: rebuilt.metrics, relationType: rebuilt.relationType }, timeline: rebuilt.relationTimeline, compaction: compacted.relationTimeline.compaction };
  fs.mkdirSync(path.join(ROOT,'test-output'),{recursive:true});
  fs.writeFileSync(path.join(ROOT,'test-output','relation-timeline-test.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  process.exit(result.ok?0:1);
})().catch(err=>{ console.error(err && err.stack || err); process.exit(1); });
