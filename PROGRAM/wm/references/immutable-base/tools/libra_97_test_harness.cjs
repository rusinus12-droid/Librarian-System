'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const OUT_DIR = path.join(ROOT, 'test-output');
fs.mkdirSync(OUT_DIR, { recursive: true });

const TEST_FAST_PATCH = true;
// summarizeLore 는 main() 밖의 모듈 스코프 함수라 main() 지역 변수에 접근할 수 없다.
// HME 파생 캐시(기기 로컬)를 집계하려면 참조를 모듈 스코프로 끌어올려야 한다.
let __localPluginStorageRef = null;
let finalExitCode = 0;
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_PATH = path.join(OUT_DIR, `libra-97-harness-${RUN_ID}.json`);
const TURN_COUNT = Math.max(1, Number(process.env.LIBRA_TURNS || 97) || 97);
const FOREGROUND_TIMEOUT_MS = Math.max(100, Number(process.env.LIBRA_FOREGROUND_TIMEOUT_MS || 5000) || 5000);
const TURN_CALL_TIMEOUT_MS = Math.max(1000, Number(process.env.LIBRA_TURN_CALL_TIMEOUT_MS || 15000) || 15000);
// V8 may temporarily retain the bundled VM source plus several canonical JSON
// packets until the next major GC.  The settled-growth assertion below is the
// leak guard; this ceiling only catches runaway transient allocation.
const TRANSIENT_HEAP_LIMIT_MB = Math.max(128, Number(process.env.LIBRA_TRANSIENT_HEAP_LIMIT_MB || 640) || 640);

  // GC 없이 측정한 힙 증가는 신뢰할 수 없다 — 죽은 객체가 남아 실제 사용량보다
  // 크게 나온다 (실측: GC 사용 가능 78.9MB vs 불가 148.0MB, 편차 2배).
  // 조용히 통과시키지도, 거짓 실패시키지도 않고 "측정 불가"로 명시한다.
  const heapGrowthAssertable = () => typeof global.gc === 'function';
  const heapGrowthSkipNote = 'heap_growth_unmeasurable_without_gc';
  const SETTLED_HEAP_GROWTH_LIMIT_MB = Math.max(32, Number(process.env.LIBRA_SETTLED_HEAP_GROWTH_LIMIT_MB || 128) || 128);

function stableHash(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 12);
}
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowIso() { return new Date().toISOString(); }
function bytesToMB(n) { return Math.round((Number(n || 0) / 1024 / 1024) * 100) / 100; }
function memSample(label) {
  const beforeGc = process.memoryUsage();
  if (global.gc) { try { global.gc(); } catch (_) {} }
  const m = process.memoryUsage();
  return {
    label,
    at: nowIso(),
    rssMB: bytesToMB(m.rss),
    heapUsedMB: bytesToMB(m.heapUsed),
    preGcHeapUsedMB: bytesToMB(beforeGc.heapUsed),
    gcAvailable: typeof global.gc === 'function',
    heapTotalMB: bytesToMB(m.heapTotal),
    externalMB: bytesToMB(m.external),
    arrayBuffersMB: bytesToMB(m.arrayBuffers)
  };
}
function p95(values) {
  const arr = values.filter(v => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!arr.length) return 0;
  return arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))];
}
function avg(values) {
  const arr = values.filter(v => Number.isFinite(v));
  return arr.length ? arr.reduce((a,b)=>a+b,0) / arr.length : 0;
}

function makePair(turn) {
  const arc = turn <= 20 ? '초기 조사' : turn <= 45 ? '별핵 봉인 해제' : turn <= 70 ? '노아의 배신과 화해' : '월식 의식 결전';
  const place = turn % 5 === 0 ? '시계탑 관측실' : turn % 3 === 0 ? '달그림자 도서관 지하서고' : '루멘 아카데미 중앙정원';
  const active = turn % 4 === 0 ? '미라' : turn % 7 === 0 ? '노아' : '아리엘';
  const user = `T${turn}. 도현은 ${place}에서 ${active}에게 ${arc}의 다음 단서를 묻고, 별핵 파편 ${turn}의 반응을 확인한다.`;
  const assistant = [
    `T${turn}. ${place}에서 도현은 별핵 파편 ${turn}이 은색 빛을 내는 장면을 목격했다.`,
    `${active}은(는) ${arc}와 관련된 직접 증거를 확인하고, 루멘 아카데미의 금지 규칙이 아직 유효하다고 설명했다.`,
    turn % 6 === 0 ? `노아는 기록 일부를 숨겼지만 도현을 보호하려는 동기였음이 드러났다.` : `아리엘은 도현에게 관측 기록을 맡기며 신뢰를 조금 더 보였다.`,
    turn % 9 === 0 ? `세계 규칙: 월식이 가까워질수록 시간 잠금 주문은 불안정해지고 거짓 기억을 만들 수 있다.` : `현재 갈등은 별핵의 진짜 사용 목적과 학생회 감시망을 피하는 문제로 이어졌다.`
  ].join(' ');
  return { user, assistant, arc, place, active };
}

function buildHistoricalMessages(count = 97) {
  const msgs = [];
  msgs.push({ role: 'assistant', content: '루멘 아카데미의 밤, 달그림자 도서관에서 금지된 별핵 기록이 깨어났다.', m_id: 'greeting-0', time: Date.now() - 1000000 });
  for (let i = 1; i <= count; i++) {
    const pair = makePair(i);
    msgs.push({ role: 'user', content: pair.user, m_id: `u-${i}`, time: Date.now() - (1000000 - i * 2000) });
    msgs.push({ role: 'assistant', content: pair.assistant, m_id: `a-${i}`, time: Date.now() - (999000 - i * 2000) });
  }
  return msgs;
}

function makeCanonicalPacket(label, userContent) {
  const text = String(userContent || '');
  const explicitTurnMatch = text.match(/(?:Current\s+LIBRA\s+turn|Turn):\s*(\d+)/i);
  const referencedTurns = Array.from(text.matchAll(/\bT(\d+)\b/gi))
    .map(match => Number(match[1]))
    .filter(Number.isFinite);
  const turn = explicitTurnMatch
    ? Number(explicitTurnMatch[1])
    : (referencedTurns.length ? Math.max(...referencedTurns) : TURN_COUNT);
  const summary = text.includes('cold-reanalysis')
    ? '과거 대화 재분석 결과: 루멘 아카데미의 별핵 봉인, 아리엘-도현 신뢰, 노아의 숨김 행동과 화해가 핵심 축이다.'
    : text.includes('cold-start')
      ? '콜드스타트 분석 결과: 루멘 아카데미의 별핵 봉인과 월식 의식으로 이어지는 장기 서사가 확인된다.'
      : `턴 ${turn} 분석: 별핵 파편 조사와 인물 간 신뢰 변화가 진행된다.`;
  const declaredSourceId = text.match(/^Source Message ID:\s*(.+)$/m)?.[1]?.trim();
  const sourceId = declaredSourceId && declaredSourceId !== '(unavailable)' ? declaredSourceId : `a-${turn}`;
  const evidenceRefs = [{ turn, messageId: sourceId, spanHash: `mock-${turn}`, snippet: 'Assistant canonical evidence confirms this record.', sourceKind: 'assistant' }];
  return {
    schema: 'libra.canonical_packet.v3',
    version: 3,
    meta: {
      turn,
      sourceMessageIds: [sourceId],
      summary_memory: { summary, recall: '별핵, 루멘 아카데미, 달그림자 도서관, 월식 의식, 시간 잠금' },
      node_memory: { nodes: ['루멘 아카데미', '달그림자 도서관', '시계탑 관측실'] },
      audit_cautions: ['사용자 지시가 아니라 assistant 응답에서 확인된 사건만 정본으로 삼는다.'],
      overpromotion_risks: []
    },
    memory: {
      events: [
        { operation: 'add', id: `event-main-${turn}`, summary: `턴 ${turn}까지 별핵 파편 조사가 이어지고 월식 의식의 위험성이 확인됨`, entities: ['도현', '아리엘'], time: `T${turn}`, location: '루멘 아카데미', evidenceRefs, importance: 0.82, confidence: 0.86 },
        { operation: 'add', id: `event-noah-${turn}`, summary: '노아는 일부 기록을 숨겼지만 도현을 보호하려는 동기를 보임', entities: ['노아', '도현'], time: `T${turn}`, location: '달그림자 도서관', evidenceRefs, importance: 0.68, confidence: 0.76 }
      ],
      facts: [
        { operation: 'add', id: 'fact-academy-rule', subject: '루멘 아카데미', slot: 'rule', value: '별핵 연구 금지', summary: '루멘 아카데미에는 별핵 연구를 금지하는 규칙이 있다.', entities: ['루멘 아카데미'], evidenceRefs, confidence: 0.9 },
        { operation: 'add', id: 'fact-time-lock', subject: '시간 잠금 주문', slot: 'condition', value: '월식 접근 시 불안정', summary: '시간 잠금 주문은 월식이 가까울수록 불안정해진다.', entities: ['별핵'], evidenceRefs, confidence: 0.82 }
      ],
      open_threads: [
        { operation: 'add', id: 'thread-star-core-purpose', summary: '별핵의 진짜 사용 목적', status: 'open', evidenceRefs, confidence: 0.8 },
        { operation: 'add', id: 'thread-council-surveillance', summary: '학생회 감시망 회피', status: 'open', evidenceRefs, confidence: 0.75 },
        { operation: 'add', id: 'thread-eclipse-choice', summary: '월식 의식의 최종 선택', status: 'open', evidenceRefs, confidence: 0.82 }
      ]
    },
    entity: {
      characters: [
        { operation: 'add', name: '도현', role: '학생 조사자', background: '루멘 아카데미의 학생으로 별핵 사건을 추적한다.', personality: ['신중함', '책임감'], current_state: `T${turn} 기준 별핵 파편 조사 중`, open_threads: ['별핵 사용 목적 확인'], evidenceRefs, confidence: 0.88, importance: 0.8 },
        { operation: 'add', name: '아리엘', role: '도서관 관리자/조력자', background: '달그림자 도서관의 기록을 관리한다.', personality: ['침착함', '보호적'], speech: ['차분하고 정중한 말투'], current_state: '도현에게 관측 기록을 맡기며 신뢰를 보인다.', evidenceRefs, confidence: 0.86, importance: 0.78 },
        { operation: 'add', name: '미라', role: '장치 기술자', background: '시계탑 관측 장치를 수리하고 별핵 반응을 측정한다.', personality: ['현실적', '분석적'], current_state: '관측 장치와 별핵 파편을 점검한다.', evidenceRefs, confidence: 0.78, importance: 0.62 },
        { operation: 'add', name: '노아', role: '경쟁자에서 임시 동맹', background: '일부 기록을 숨겼지만 보호 동기를 가진 인물이다.', personality: ['방어적', '갈등적'], current_state: '숨긴 기록 때문에 신뢰 문제가 남아 있다.', evidenceRefs, confidence: 0.74, importance: 0.65 }
      ],
      relations: [
        { operation: 'add', entityA: '도현', entityB: '아리엘', type: '조력과 신뢰', summary: '도현과 아리엘은 별핵 조사를 함께하며 신뢰를 쌓는다.', closeness: 0.55, trust: 0.68, unresolved_issues: ['별핵 사용 목적에 대한 비밀'], evidenceRefs, confidence: 0.84 },
        { operation: 'add', entityA: '도현', entityB: '노아', type: '긴장 섞인 동맹', summary: '노아의 은폐 때문에 갈등이 있으나 보호 동기가 드러난다.', closeness: 0.34, trust: 0.42, tension: 0.58, unresolved_issues: ['숨긴 기록의 전모'], evidenceRefs, confidence: 0.74 }
      ],
      current_state: [
        { name: '도현', current_state: `T${turn} 기준 ${summary}`, focus: '별핵 파편 조사' }
      ],
      secrets: [
        { holder: '노아', secret: '기록 일부를 숨긴 이유는 도현 보호와 관련된다.', visible_to: ['노아'], confidence: 0.65 }
      ],
      pov_memories: []
    },
    world: {
      summary: '루멘 아카데미는 별핵과 시간 잠금 주문을 둘러싼 금지 연구가 존재하는 마법 학원 세계다.',
      description: '달그림자 도서관, 시계탑 관측실, 학생회 감시망이 주요 무대다.',
      tech: '마법 관측 장치와 별핵 공명 측정기',
      rules: ['별핵 연구는 학생회 승인 없이 금지된다.', '월식이 가까워질수록 시간 잠금 주문은 불안정해진다.'],
      places: ['루멘 아카데미', '달그림자 도서관', '시계탑 관측실'],
      organizations: ['학생회 감시망', '도서관 기록관리부'],
      social_rules: ['금지 기록은 공식 허가 없이는 열람할 수 없다.'],
      phenomena: ['별핵 공명', '시간 잠금 불안정화', '거짓 기억 발생'],
      systems: { magic: '별핵 공명과 시간 잠금 주문' },
      physics: { special_phenomena: ['월식 공명'] },
      exists: { academy: true, magic: true },
      state: { time: `T${turn}`, location: '루멘 아카데미', scene: '별핵 파편 조사 진행', active_events: ['월식 의식 접근'], offscreen_threads: ['학생회 감시 강화'] },
      active_events: ['별핵 파편 공명', '학생회 감시 강화'],
      offscreen_threads: ['월식 의식 준비']
    },
    narrative: {
      summary,
      current_arc: '별핵 봉인의 진실을 추적하며 월식 의식의 결정을 향해 간다.',
      storylines: [
        { name: '별핵 봉인과 월식 의식', context: summary, keyPoints: ['별핵 파편 조사', '시간 잠금 불안정화', '월식 의식 접근'], ongoingTensions: ['학생회 감시', '노아의 은폐', '별핵 사용 목적'], entities: ['도현', '아리엘', '노아', '미라'] }
      ],
      scene_phase: 'investigation_to_confrontation',
      conflict_traces: ['금지 연구와 안전 문제', '신뢰와 은폐'],
      scene_deltas: [`T${turn} 별핵 조사가 진전됨`],
      theme_motifs: ['기억', '신뢰', '금지된 지식'],
      unresolved_threads: ['월식 의식의 선택', '노아가 숨긴 기록의 전모']
    },
    guards: {
      continuity_locks: ['별핵 연구 금지는 계속 유효하다.', '노아의 은폐는 보호 동기와 연결된다.'],
      audit_cautions: ['사용자 요청 자체를 사건으로 저장하지 않는다.'],
      overpromotion_risks: []
    },
    importance: { overall: 0.84, reason: ['장기 세계관', '핵심 관계', '미해결 갈등'] }
  };
}

function makeWorldAdditionalPayload(turn, options = {}) {
  const bucket = Math.max(1, Math.ceil(Number(turn || 1) / 10));
  const manual = options.manual === true;
  const suffix = manual ? 'manual' : String(bucket);
  return {
    sceneInterventions: [{
      id: `wa_scene_${suffix}`,
      type: 'scene_intervention',
      title: manual ? '수동 분석: 시계탑 경보의 재점화' : `시계탑 관측 경보 ${bucket}`,
      description: manual
        ? '현재 채팅의 별핵 공명 단서를 근거로 시계탑 경보가 다음 장면에서 다시 작동할 수 있다.'
        : '별핵 파편 공명이 강해질 때 시계탑 관측 경보가 장면 압력으로 작동한다.',
      directive: '사용자 행동을 강제하지 말고 관측 장치의 경보와 주변 인물의 반응으로 단서를 제시한다.',
      sourceBasis: ['별핵 공명', '시계탑 관측실'],
      relatedEntities: ['도현', '아리엘'],
      activationCondition: '별핵 파편이나 월식 의식이 다시 언급될 때',
      progressionTier: 'section',
      status: 'armed',
      forceLevel: 'firm',
      userImpact: 'soft'
    }],
    worldDeltas: [{
      id: `wa_world_${suffix}`,
      type: 'world_delta',
      title: manual ? '수동 분석: 월식 관측망의 국지적 불안정' : `월식 관측망 변화 ${bucket}`,
      description: '월식 접근으로 루멘 아카데미의 관측망 일부가 간헐적으로 불안정해진다.',
      directive: '확정된 세계 규칙과 충돌하지 않는 국지적 현상으로만 반영한다.',
      sourceBasis: ['월식 접근', '시간 잠금 주문 불안정'],
      relatedEntities: ['루멘 아카데미'],
      activationCondition: '관측 장치나 시간 잠금 주문을 사용하는 장면',
      progressionTier: 'section',
      status: 'armed',
      forceLevel: 'firm',
      userImpact: 'soft'
    }],
    characterAdditions: [{
      id: `wa_character_${suffix}`,
      type: 'character_addition',
      title: manual ? '수동 분석: 야간 관측 보조원 세라' : `야간 관측 보조원 ${bucket}`,
      name: manual ? '세라' : `관측 보조원 ${bucket}`,
      role: '루멘 아카데미 시계탑의 현장 보조원',
      description: '현재 조사에 필요한 국지적 관측 기록을 전달할 수 있는 미등장 조연이다.',
      directive: '기존 핵심 인물을 대체하거나 비밀을 자동으로 해답하지 않는 보조 역할로만 사용한다.',
      sourceBasis: ['시계탑 관측실', '관측 기록'],
      noveltyReason: '현장 관측 기록의 출처가 되는 국지적 조연이 아직 없다.',
      activationCondition: '시계탑 현장 기록을 직접 확인하는 장면',
      progressionTier: 'local',
      status: 'prepared',
      forceLevel: 'soft',
      userImpact: 'soft'
    }],
    manifestations: []
  };
}

function structuredSnapshotFromPacket(packet) {
  return {
    narrative: packet.narrative.summary || packet.meta.summary_memory.summary,
    narrativeDetails: {
      storylines: packet.narrative.storylines.map(s => ({
        name: s.name,
        context: s.context,
        keyPoints: s.keyPoints,
        ongoingTensions: s.ongoingTensions,
        entities: s.entities
      }))
    },
    entities: packet.entity.characters.map(c => ({
      name: c.name,
      role: c.role,
      appearance: c.appearance || '',
      personality: Array.isArray(c.personality) ? c.personality.join(', ') : String(c.personality || ''),
      background: c.background || '',
      occupation: c.role || '',
      currentState: { summary: c.current_state || '', cognitiveFocus: c.focus ? [c.focus] : [] },
      continuity: { openThreads: (c.open_threads || []).map(label => ({ label, status: 'active', pressure: 0 })) },
      quality: { confidence: c.confidence || 0.7, importance: c.importance || 0.5, salience: c.importance || 0.5 }
    })),
    relations: packet.entity.relations.map(r => ({
      entityA: r.entityA,
      entityB: r.entityB,
      type: r.type,
      sentiment: r.summary,
      currentStatus: { summary: r.summary },
      metrics: { closeness: r.closeness ?? null, trust: r.trust ?? null, tension: r.tension || 0, ambiguity: 0.2 },
      dynamics: { unresolvedIssues: r.unresolved_issues || [], recentChanges: [r.summary] },
      quality: { confidence: r.confidence || 0.7, importance: 0.6, salience: 0.6 }
    })),
    world: {
      tech: packet.world.tech,
      summary: packet.world.summary,
      description: packet.world.description,
      classification: { primary: 'academy fantasy', complexity: 'multi_arc' },
      exists: packet.world.exists,
      systems: packet.world.systems,
      setting: { places: packet.world.places, organizations: packet.world.organizations, socialRules: packet.world.social_rules },
      physics: packet.world.physics,
      phenomena: packet.world.phenomena,
      rules: packet.world.rules,
      state: packet.world.state,
      custom: {}
    }
  };
}


async function withTimeout(promise, ms, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mockLLMCall(config, systemPrompt, userContent, options = {}) {
  const label = String(options.label || options.debugLabel || 'mock');
  const packet = makeCanonicalPacket(label, `${label}\n${String(userContent || '')}`);
  let payload;
  if (/transition-summary/i.test(label)) {
    const content = '루멘 아카데미 시계탑 관측실에서 도현과 아리엘은 별핵 파편의 공명 기록을 대조하고 있다. 월식 의식이 가까워지며 시간 잠금 주문과 학생회 감시망의 압력이 높아진 상태다.';
    return Promise.resolve({
      content,
      usage: {
        prompt_tokens: Math.ceil(String(userContent || '').length / 4),
        completion_tokens: Math.ceil(content.length / 4)
      },
      serviceTier: ''
    });
  }
  if (/world-additional-(?:turn|manual|historical)/i.test(label)) {
    payload = { worldAdditional: makeWorldAdditionalPayload(packet.meta.turn, { manual: /world-additional-manual/i.test(label) }) };
  } else if (/afterrequest-analysis-bundle/i.test(label)) {
    payload = {
      canonicalPacket: packet,
      entityExtraction: {
        spans: [
          { text: '도현', type: 'person', confidence: 0.9 },
          { text: '아리엘', type: 'person', confidence: 0.88 },
          { text: '루멘 아카데미', type: 'place', confidence: 0.86 }
        ],
        entities: packet.entity.characters.map(c => ({ name: c.name, role: c.role, summary: c.current_state || c.background, confidence: c.confidence || 0.75 })),
        relations: packet.entity.relations,
        world: packet.world,
        conflicts: [],
        uncertain: [],
        rejected: [],
        sourceMode: 'mock_afterrequest_unified_analysis'
      },
      maintenance: {
        narrativeBrief: packet.narrative.summary,
        correction: null,
        longTermMemory: {
          schema: 'libra.rp_longterm.turn.v1',
          durableFacts: packet.memory.facts.map(f => f.summary || String(f)),
          preferences: [],
          commitments: [],
          unresolvedThreads: packet.narrative.unresolved_threads,
          relationshipMilestones: packet.entity.relations.map(r => r.summary),
          stateChanges: packet.memory.events.map(e => e.summary),
          callbackAnchors: [],
          visibility: 'public'
        },
        storyAuthor: {
          currentArc: packet.narrative.current_arc,
          narrativeGoal: '월식 의식 전까지 별핵의 목적을 확인한다.',
          activeTensions: packet.narrative.unresolved_threads,
          nextBeats: ['별핵 파편 반응 검증', '학생회 감시망 회피'],
          guardrails: packet.guards.continuity_locks,
          focusCharacters: ['도현', '아리엘', '노아'],
          recentDecisions: packet.narrative.scene_deltas
        },
        director: {
          sceneMandate: '조사와 관계 갈등의 균형을 유지한다.',
          requiredOutcomes: packet.narrative.scene_deltas,
          forbiddenMoves: packet.guards.overpromotion_risks,
          emphasis: packet.narrative.theme_motifs,
          targetPacing: 'steady',
          pressureLevel: 'medium',
          focusCharacters: ['도현', '아리엘']
        },
        worldAdditional: makeWorldAdditionalPayload(packet.meta.turn)
      }
    };
  } else if (/turn-maintenance-bundle/i.test(label)) {
    payload = {
      narrativeBrief: packet.narrative.summary,
      correction: null,
      longTermMemory: {
        durableFacts: packet.memory.facts.map(f => f.summary || String(f)),
        preferences: [], commitments: [], unresolvedThreads: packet.narrative.unresolved_threads,
        relationshipMilestones: packet.entity.relations.map(r => r.summary), stateChanges: packet.memory.events.map(e => e.summary), callbackAnchors: []
      },
      storyAuthor: { currentArc: packet.narrative.current_arc, activeTensions: packet.narrative.unresolved_threads, nextBeats: ['다음 단서 확인'], guardrails: packet.guards.continuity_locks, focusCharacters: ['도현', '아리엘'] },
      director: { sceneMandate: '정본 사건만 유지한다.', requiredOutcomes: packet.narrative.scene_deltas, forbiddenMoves: [], emphasis: packet.narrative.theme_motifs, focusCharacters: ['도현', '아리엘'] },
      worldAdditional: makeWorldAdditionalPayload(packet.meta.turn),
      canonicalPacket: packet
    };
  } else if (/verify|merge/i.test(label)) {
    payload = structuredSnapshotFromPacket(packet);
  } else if (/synthesis|canonical/i.test(label)) {
    payload = { canonicalPacket: packet, compatibilitySnapshot: structuredSnapshotFromPacket(packet) };
  } else {
    payload = { canonicalPacket: packet };
  }
  return Promise.resolve({ content: JSON.stringify(payload), usage: { prompt_tokens: Math.ceil(String(userContent || '').length / 4), completion_tokens: Math.ceil(JSON.stringify(payload).length / 4) }, serviceTier: '' });
}

function unpackLoreEntries(exports, char, chat) {
  const lore = exports.MemoryEngine.getLorebook(char, chat) || [];
  return lore;
}
function parseJsonObject(text) {
  try {
    const value = JSON.parse(String(text || '{}'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) {
    return {};
  }
}

function summarizeTurnLedger(pluginStorage) {
  const records = [];
  const indexes = [];
  const rawRecords = new Map(require('./libra_generation_capture_receipt_fixture.cjs').readLedgerReceipts(pluginStorage).map(record => [record.recordKey, record]));
  for (const [key, raw] of pluginStorage.entries()) {
    if (!String(key || '').startsWith('libra.v5.ltm.turn-ledger::')) continue;
    const value = rawRecords.get(String(key)) || parseJsonObject(raw);
    if (String(key).endsWith('::index')) {
      indexes.push({
        key: String(key),
        scopeKey: String(value.scopeKey || ''),
        updatedAt: Number(value.updatedAt || 0),
        refs: Array.isArray(value.records) ? value.records.length : 0,
        tail: Array.isArray(value.records) ? value.records.slice(-5) : []
      });
      continue;
    }
    if (value.kind === 'libra_raw_turn') {
      const userTurn = Number(String(value.userText || '').match(/\bT(\d+)\b/)?.[1] || 0);
      const assistantTurn = Number(String(value.assistantText || '').match(/\bT(\d+)\b/)?.[1] || 0);
      records.push({
        recordId: String(value.recordId || ''),
        scopeKey: String(value.scopeKey || ''),
        chatId: String(value.chatId || ''),
        requestSequence: Number(value.requestSequence || 0),
        status: String(value.status || ''),
        analysisStatus: String(value.analysisStatus || ''),
        deferredReason: String(value.deferredReason || ''),
        turn: Number(value.turn || 0),
        observedAt: Number(value.observedAt || 0),
        updatedAt: Number(value.updatedAt || 0),
        error: String(value.error || value.analysisError || ''),
        userTurn,
        assistantTurn,
        pairAligned: userTurn > 0 && userTurn === assistantTurn
      });
    }
  }
  records.sort((a, b) => a.observedAt - b.observedAt || a.requestSequence - b.requestSequence);
  return {
    storageEntries: pluginStorage.size,
    recordCount: records.length,
    indexCount: indexes.length,
    byStatus: records.reduce((out, row) => {
      const key = row.status || '(empty)';
      out[key] = (out[key] || 0) + 1;
      return out;
    }, {}),
    byAnalysisStatus: records.reduce((out, row) => {
      const key = row.analysisStatus || '(empty)';
      out[key] = (out[key] || 0) + 1;
      return out;
    }, {}),
    turnMin: records.length ? Math.min(...records.map(row => row.turn || 0)) : 0,
    turnMax: records.length ? Math.max(...records.map(row => row.turn || 0)) : 0,
    uniqueTurns: new Set(records.map(row => row.turn).filter(Boolean)).size,
    alignedPairs: records.filter(row => row.pairAligned).length,
    records: records.slice(-12),
    indexes
  };
}

async function waitForLiveDrain(pluginStorage, exports, char, chat, turnCount, timeoutMs) {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1000, Number(timeoutMs || 0) || 240000);
  let ledger = summarizeTurnLedger(pluginStorage);
  while (Date.now() < deadline) {
    ledger = summarizeTurnLedger(pluginStorage);
    const committed = Number(ledger.byStatus?.committed || 0);
    const analyzed = Number(ledger.byAnalysisStatus?.done || 0);
    const transactionIdle = !exports.MemoryState.scopedRuntimeTransaction;
    const commitLocksIdle = Number(exports.MemoryState.pendingTurnCommitLocksByScope?.size || 0) === 0;
    const maintenanceLocksIdle = Number(exports.MemoryState.turnMaintenanceLocksByChatId?.size || 0) === 0;
    const loreTurn = Number(exports.MemoryEngine.getCurrentTurn?.() || 0);
    if (
      ledger.recordCount >= turnCount
      && committed >= turnCount
      && analyzed >= turnCount
      && ledger.alignedPairs >= turnCount
      && loreTurn >= turnCount
      && transactionIdle
      && commitLocksIdle
      && maintenanceLocksIdle
    ) {
      return { settled: true, elapsedMs: Date.now() - startedAt, ledger, loreTurn };
    }
    await sleep(100);
  }
  //   ★ 타임아웃으로 끝났을 때 **어느 조건이 안 맞았는지**를 남긴다.
  //     종전에는 settled/elapsedMs/loreTurn 만 남아 실패 원인이 사라졌다(실측: 6건 전부 판정불가).
  const unmet = [];
  if (!(ledger.recordCount >= turnCount)) unmet.push(`recordCount ${ledger.recordCount}<${turnCount}`);
  if (!(Number(ledger.byStatus?.committed || 0) >= turnCount)) unmet.push(`committed ${Number(ledger.byStatus?.committed || 0)}<${turnCount}`);
  if (!(Number(ledger.byAnalysisStatus?.done || 0) >= turnCount)) unmet.push(`analyzed ${Number(ledger.byAnalysisStatus?.done || 0)}<${turnCount}`);
  if (!(ledger.alignedPairs >= turnCount)) unmet.push(`alignedPairs ${ledger.alignedPairs}<${turnCount}`);
  const finalLoreTurn = Number(exports.MemoryEngine.getCurrentTurn?.() || 0);
  if (!(finalLoreTurn >= turnCount)) unmet.push(`loreTurn ${finalLoreTurn}<${turnCount}`);
  if (exports.MemoryState.scopedRuntimeTransaction) unmet.push('scopedRuntimeTransaction');
  if (Number(exports.MemoryState.pendingTurnCommitLocksByScope?.size || 0) !== 0) unmet.push('pendingCommitLocks');
  if (Number(exports.MemoryState.turnMaintenanceLocksByChatId?.size || 0) !== 0) unmet.push('maintenanceLocks');
  return {
    settled: false,
    elapsedMs: Date.now() - startedAt,
    ledger,
    unmet,
    loreTurn: finalLoreTurn,
    scopedRuntimeTransaction: clone(exports.MemoryState.scopedRuntimeTransaction || null),
    pendingCommitLocks: Number(exports.MemoryState.pendingTurnCommitLocksByScope?.size || 0),
    maintenanceLocks: Number(exports.MemoryState.turnMaintenanceLocksByChatId?.size || 0)
  };
}
function relationEndpoints(record = {}) {
  const pair = Array.isArray(record.pair) ? record.pair : (Array.isArray(record.entities) ? record.entities : []);
  return [
    record.entityA || record.entity_a || record.source || record.from || pair[0] || '',
    record.entityB || record.entity_b || record.target || record.to || pair[1] || ''
  ].map(value => String(value || '').trim());
}
function countMeaningfulLeaves(value, seen = new Set()) {
  if (value == null || value === '' || value === false) return 0;
  if (typeof value !== 'object') return 1;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countMeaningfulLeaves(item, seen), 0);
  return Object.values(value).reduce((sum, item) => sum + countMeaningfulLeaves(item, seen), 0);
}
function fingerprintLore(lore = [], excludedComments = []) {
  const excluded = new Set(Array.isArray(excludedComments) ? excludedComments : [excludedComments]);
  return stableHash((Array.isArray(lore) ? lore : [])
    .filter(entry => !excluded.has(String(entry?.comment || '')))
    .map(entry => `${String(entry?.comment || '')}\u0000${String(entry?.key || '')}\u0000${String(entry?.content || '')}`)
    .sort()
    .join('\u0001'));
}
function summarizeLore(exports, char, chat) {
  const lore = unpackLoreEntries(exports, char, chat);
  const byComment = {};
  const bytesByComment = {};
  for (const e of lore) {
    const comment = e.comment || '(none)';
    byComment[comment] = (byComment[comment] || 0) + 1;
    bytesByComment[comment] = (bytesByComment[comment] || 0) + Buffer.byteLength(String(e?.content || ''), 'utf8');
  }
  const memories = lore.filter(e => e.comment === 'lmai_memory');
  const entities = lore.filter(e => e.comment === 'lmai_entity');
  const relations = lore.filter(e => e.comment === 'lmai_relation');
  const narrative = lore.find(e => e.comment === 'lmai_narrative');
  const worldStatesEntry = lore.find(e => e.comment === 'lmai_world_states');
  const worldGraphEntry = lore.find(e => e.comment === 'lmai_world_graph');
  const storyAuthorEntry = lore.find(e => e.comment === 'lmai_story_author');
  const directorEntry = lore.find(e => e.comment === 'lmai_director');
  const worldAdditionalEntry = lore.find(e => e.comment === 'lmai_world_additional');
  const hmeIndex = lore.find(e => e.comment === 'lmai_hme_index');
  const hmeGraphIndex = lore.find(e => e.comment === 'lmai_hme_graph_index');
  let narrativeStorylines = 0;
  let narrativeTurnLog = 0;
  try {
    const parsed = JSON.parse(narrative?.content || '{}');
    narrativeStorylines = Array.isArray(parsed.storylines) ? parsed.storylines.length : 0;
    narrativeTurnLog = Array.isArray(parsed.turnLog) ? parsed.turnLog.length : 0;
  } catch (_) {}
  let hmeRows = 0;
  let hmeGraphNodes = 0;
  let hmeGraphEdges = 0;
  // HME 는 로어가 아니라 기기 로컬 저장소(localPluginStorage)의 파생 캐시에 산다.
  // 로어만 보면 항상 0 이 된다.
  try {
    for (const [key, raw] of (__localPluginStorageRef || new Map()).entries()) {
      const k = String(key || '');
      if (!k.includes('hme-derived')) continue;
      const parsed = JSON.parse(String(raw || '{}'));
      if (k.endsWith(':scope')) {
        hmeRows = Array.isArray(parsed.rows) ? parsed.rows.length : (Array.isArray(parsed.items) ? parsed.items.length : 0);
      } else if (k.endsWith(':graph')) {
        hmeGraphNodes = Array.isArray(parsed.nodes) ? parsed.nodes.length : 0;
        hmeGraphEdges = Array.isArray(parsed.edges) ? parsed.edges.length : 0;
      }
    }
  } catch (_) {}
  // 로어에 레거시 HME 항목이 있으면 그쪽 값을 우선한다 (없으면 위 파생 캐시 값 유지).
  try {
    if (hmeIndex) {
      const parsed = JSON.parse(hmeIndex.content || '{}');
      hmeRows = Array.isArray(parsed.rows) ? parsed.rows.length : (Array.isArray(parsed.items) ? parsed.items.length : 0);
    }
  } catch (_) {}
  try {
    if (hmeGraphIndex) {
      const parsed = JSON.parse(hmeGraphIndex.content || '{}');
      hmeGraphNodes = Array.isArray(parsed.nodes) ? parsed.nodes.length : (parsed.nodes ? Object.keys(parsed.nodes).length : 0);
      hmeGraphEdges = Array.isArray(parsed.edges) ? parsed.edges.length : (parsed.edges ? Object.keys(parsed.edges).length : 0);
    }
  } catch (_) {}
  const memoryTurns = [];
  const memoryMetaTail = [];
  for (const e of memories) {
    const content = String(e.content || '');
    const match = content.match(/\[META:({[\s\S]*?})\]/);
    if (match) {
      try {
        const meta = JSON.parse(match[1]);
        if (Number.isFinite(Number(meta.t || meta.turn))) memoryTurns.push(Number(meta.t || meta.turn));
        memoryMetaTail.push({ turn: Number(meta.t || meta.turn || 0), category: String(meta.cat || meta.category || ''), source: String(meta.source || ''), sessionId: String(meta.s_id || ''), canonicalFactSlot: String(meta.canonicalFactSlot || ''), canonicalMemoryId: String(meta.canonicalMemoryId || ''), sourceHash: String(meta.sourceHash || ''), messageId: String(meta.messageId || meta.m_id || ''), entities: Array.isArray(meta.ent) ? meta.ent.slice(0, 12) : [], summary: String(meta.summary || '').slice(0, 180) });
      } catch (_) {}
    }
  }
  const entityRecords = entities.slice(0, 12).map(entry => {
    const record = parseJsonObject(entry.content);
    const currentState = String(record.currentState?.summary || record.current_state?.summary || record.status?.notes || '').slice(0, 220);
    const embeddedTurn = Number(currentState.match(/\bT(\d+)\b/i)?.[1] || 0);
    return {
      name: String(record.name || record.canonicalName || '').trim(),
      currentState,
      embeddedTurn,
      lastTurn: Number(record.currentState?.lastObservedTurn || record.status?.lastUpdated || record.meta?.updated || 0),
      episodeCount: Array.isArray(record.episodeLedger) ? record.episodeLedger.length : 0,
      integrity: record.meta?.integrity?.schema || ''
    };
  });
  const relationRecords = relations.slice(0, 12).map(entry => {
    const record = parseJsonObject(entry.content);
    const endpoints = relationEndpoints(record);
    return {
      entityA: endpoints[0],
      entityB: endpoints[1],
      type: String(record.relationType || record.type || '').slice(0, 100),
      lastTurn: Number(record.meta?.updated || record.quality?.lastUpdatedTurn || 0),
      integrity: record.meta?.integrity?.schema || ''
    };
  });
  const narrativeRecord = parseJsonObject(narrative?.content);
  const narrativeTurnRows = Array.isArray(narrativeRecord.turnLog) ? narrativeRecord.turnLog : [];
  const worldStatesRecord = parseJsonObject(worldStatesEntry?.content);
  const worldTurnRows = Array.isArray(worldStatesRecord.turnLog) ? worldStatesRecord.turnLog : [];
  const storyAuthorRecord = parseJsonObject(storyAuthorEntry?.content);
  const directorRecord = parseJsonObject(directorEntry?.content);
  const worldAdditionalRecord = parseJsonObject(worldAdditionalEntry?.content);
  const worldGraphRecord = parseJsonObject(worldGraphEntry?.content);
  const worldGraphNodes = Array.isArray(worldGraphRecord.nodes)
    ? worldGraphRecord.nodes.map(item => Array.isArray(item) ? item[1] : item).filter(item => item && typeof item === 'object')
    : Object.values(worldGraphRecord.nodes && typeof worldGraphRecord.nodes === 'object' ? worldGraphRecord.nodes : {}).filter(item => item && typeof item === 'object');
  const worldAdditionalBuckets = ['sceneInterventions', 'worldDeltas', 'characterAdditions'];
  const worldAdditionalCounts = Object.fromEntries(worldAdditionalBuckets.map(key => [key, Array.isArray(worldAdditionalRecord[key]) ? worldAdditionalRecord[key].length : 0]));
  worldAdditionalCounts.worldCodex = Array.isArray(worldAdditionalRecord.worldCodex) ? worldAdditionalRecord.worldCodex.length : 0;
  worldAdditionalCounts.activeDirectives = Array.isArray(worldAdditionalRecord.activeDirectives) ? worldAdditionalRecord.activeDirectives.length : 0;
  worldAdditionalCounts.manifestationLog = Array.isArray(worldAdditionalRecord.manifestationLog) ? worldAdditionalRecord.manifestationLog.length : 0;
  const commentHashes = Object.fromEntries(Object.keys(byComment).sort().map(comment => [
    comment,
    stableHash(lore.filter(entry => String(entry?.comment || '(none)') === comment)
      .map(entry => `${String(entry?.key || '')}\u0000${String(entry?.content || '')}`)
      .sort()
      .join('\u0001'))
  ]));
  const topEntrySizes = lore.map(entry => ({
    key: String(entry?.key || '').slice(0, 120),
    comment: String(entry?.comment || '').trim(),
    bytes: Buffer.byteLength(String(entry?.content || ''), 'utf8'),
    contentHead: String(entry?.content || '').slice(0, 260),
    contentTail: String(entry?.content || '').slice(-260)
  })).sort((a, b) => b.bytes - a.bytes).slice(0, 12);
  const largestMemory = memories
    .map(entry => ({ entry, bytes: Buffer.byteLength(String(entry?.content || ''), 'utf8') }))
    .sort((a, b) => b.bytes - a.bytes)[0] || null;
  const largestEntity = entities
    .map(entry => ({ entry, bytes: Buffer.byteLength(String(entry?.content || ''), 'utf8') }))
    .sort((a, b) => b.bytes - a.bytes)[0] || null;
  const largestEntry = lore
    .map(entry => ({ entry, bytes: Buffer.byteLength(String(entry?.content || ''), 'utf8') }))
    .sort((a, b) => b.bytes - a.bytes)[0] || null;
  return {
    totalLore: lore.length,
    byComment,
    bytesByComment,
    memories: memories.length,
    entities: entities.length,
    relations: relations.length,
    narrativeStorylines,
    narrativeTurnLog,
    worldStateTurnLog: worldTurnRows.length,
    worldStateLastTurn: worldTurnRows.reduce((maxTurn, item) => Math.max(maxTurn, Number(item?.turn || item?.t || 0)), 0),
    hmeRows,
    hmeGraphNodes,
    hmeGraphEdges,
    storyAuthor: {
      present: Boolean(storyAuthorEntry),
      schema: String(storyAuthorRecord.schema || ''),
      lastTurn: Number(storyAuthorRecord.lastPlanTurn || storyAuthorRecord.plannerMeta?.lastObservedTurn || storyAuthorRecord.plannerMeta?.generatedAtTurn || 0),
      currentArc: String(storyAuthorRecord.currentArc || '').slice(0, 220),
      narrativeGoal: String(storyAuthorRecord.narrativeGoal || '').slice(0, 320),
      nextBeats: Array.isArray(storyAuthorRecord.nextBeats) ? storyAuthorRecord.nextBeats.slice(0, 8).map(String) : [],
      activeTensions: Array.isArray(storyAuthorRecord.activeTensions) ? storyAuthorRecord.activeTensions.slice(0, 8).map(String) : [],
      focusCharacters: Array.isArray(storyAuthorRecord.focusCharacters) ? storyAuthorRecord.focusCharacters.slice(0, 8).map(String) : [],
      plannerStatus: String(storyAuthorRecord.plannerMeta?.status || '')
    },
    director: {
      present: Boolean(directorEntry),
      schema: String(directorRecord.schema || ''),
      lastTurn: Number(directorRecord.lastTurn || directorRecord.plannerMeta?.lastObservedTurn || directorRecord.plannerMeta?.generatedAtTurn || 0),
      sceneMandate: String(directorRecord.sceneMandate || '').slice(0, 320),
      requiredOutcomes: Array.isArray(directorRecord.requiredOutcomes) ? directorRecord.requiredOutcomes.slice(0, 8).map(String) : [],
      forbiddenMoves: Array.isArray(directorRecord.forbiddenMoves) ? directorRecord.forbiddenMoves.slice(0, 8).map(String) : [],
      focusCharacters: Array.isArray(directorRecord.focusCharacters) ? directorRecord.focusCharacters.slice(0, 8).map(String) : [],
      plannerStatus: String(directorRecord.plannerMeta?.status || '')
    },
    worldAdditional: {
      present: Boolean(worldAdditionalEntry),
      schema: String(worldAdditionalRecord.schema || ''),
      scopeKey: String(worldAdditionalRecord.scopeKey || ''),
      chatId: String(worldAdditionalRecord.chatId || ''),
      lastTurn: Number(worldAdditionalRecord.lastTurn || 0),
      counts: worldAdditionalCounts,
      totalDirectives: worldAdditionalBuckets.reduce((sum, key) => sum + Number(worldAdditionalCounts[key] || 0), 0),
      sampleIds: worldAdditionalBuckets.flatMap(key => (Array.isArray(worldAdditionalRecord[key]) ? worldAdditionalRecord[key] : []).slice(-3).map(item => String(item?.id || item?.title || item?.name || ''))).filter(Boolean).slice(-9)
    },
    worldGraph: {
      present: Boolean(worldGraphEntry),
      schema: String(worldGraphRecord.schema || ''),
      rootId: String(worldGraphRecord.rootId || ''),
      nodeCount: worldGraphNodes.length,
      activePath: Array.isArray(worldGraphRecord.activePath) ? worldGraphRecord.activePath.slice(0, 16).map(String) : [],
      ruleFactCount: worldGraphNodes.reduce((sum, node) => sum + countMeaningfulLeaves(node?.rules || {}), 0),
      worldSummaryChars: worldGraphNodes.reduce((sum, node) => sum + String(node?.meta?.worldSummary || node?.meta?.worldMetadata?.summary || '').length, 0)
    },
    commentHashes,
    nonWorldAdditionalFingerprint: fingerprintLore(lore, ['lmai_world_additional']),
    currentTurn: exports.MemoryEngine.getCurrentTurn?.() || 0,
    memoryTurnMin: memoryTurns.length ? Math.min(...memoryTurns) : 0,
    memoryTurnMax: memoryTurns.length ? Math.max(...memoryTurns) : 0,
    memoryUniqueTurns: new Set(memoryTurns).size,
    memoryInventory: memoryMetaTail.map(item => ({
      turn: item.turn,
      category: item.category,
      source: item.source,
      canonicalMemoryId: item.canonicalMemoryId,
      sourceHash: item.sourceHash,
      messageId: item.messageId,
      summaryHash: stableHash(item.summary)
    })),
    sampleMemoryKeys: memories.slice(0, 5).map(e => e.key || ''),
    sampleEntityNames: entities.slice(0, 8).map(e => { try { return JSON.parse(e.content || '{}').name || e.key || ''; } catch { return e.key || ''; } }),
    axisSamples: {
      memoryMetaTail: memoryMetaTail.slice(-5),
      entities: entityRecords,
      relations: relationRecords,
      narrative: {
        storylineNames: (Array.isArray(narrativeRecord.storylines) ? narrativeRecord.storylines : []).slice(0, 8).map(item => String(item?.name || item?.title || item?.id || '')).filter(Boolean),
        turnLogTail: narrativeTurnRows.slice(-5).map(item => ({ turn: Number(item?.turn || item?.t || 0), summary: String(item?.summary || item?.sceneSummary || item?.event || '').slice(0, 180) })),
        integrity: narrativeRecord.integrity?.schema || narrativeRecord.meta?.integrity?.schema || ''
      },
      world: {
        keys: Object.keys(worldStatesRecord).slice(0, 24),
        current: worldStatesRecord.current || worldStatesRecord.currentState || worldStatesRecord.state || null,
        turnLogTail: worldTurnRows.slice(-5).map(item => ({
          turn: Number(item?.turn || item?.t || 0),
          keys: Object.keys(item || {}).slice(0, 20),
          snapshot: item?.state || item?.snapshot || item?.worldSnapshot || item?.world || null,
          activePath: Array.isArray(item?.activePath) ? item.activePath.slice(0, 8) : [],
          rules: item?.rules || null,
          activeWorld: String(item?.activeWorld || ''),
          currentLocation: String(item?.currentLocation || ''),
          currentScene: String(item?.currentScene || ''),
          ruleCount: item?.rulesSnapshot && typeof item.rulesSnapshot === 'object' ? Object.keys(item.rulesSnapshot).length : 0,
          summary: String(item?.summary || item?.notes || '').slice(0, 180)
        })),
        historyCount: Array.isArray(worldStatesRecord.history) ? worldStatesRecord.history.length : (Array.isArray(worldStatesRecord.timeline) ? worldStatesRecord.timeline.length : 0),
        integrity: worldStatesRecord.integrity?.schema || worldStatesRecord.meta?.integrity?.schema || ''
      }
    },
    packedStoredEntries: Array.isArray(chat.localLore) ? chat.localLore.length : 0,
    storedBytes: Buffer.byteLength(JSON.stringify(chat.localLore || []), 'utf8'),
    largestMemory: largestMemory ? {
      bytes: largestMemory.bytes,
      key: String(largestMemory.entry?.key || ''),
      content: String(process.env.LIBRA_DUMP_LARGEST_MEMORY || '') === '1' ? String(largestMemory.entry?.content || '') : ''
    } : null,
    largestEntity: largestEntity ? {
      bytes: largestEntity.bytes,
      key: String(largestEntity.entry?.key || ''),
      content: String(process.env.LIBRA_DUMP_LARGEST_ENTITY || '') === '1' ? String(largestEntity.entry?.content || '') : ''
    } : null,
    largestEntry: largestEntry ? {
      bytes: largestEntry.bytes,
      key: String(largestEntry.entry?.key || ''),
      comment: String(largestEntry.entry?.comment || ''),
      content: String(process.env.LIBRA_DUMP_LARGEST_ENTRY || '') === '1' ? String(largestEntry.entry?.content || '') : ''
    } : null,
    topEntrySizes
  };
}

function appendAxisIntegrityAssertions(assertCheck, summary, expectedTurn) {
  const axis = summary?.axisSamples || {};
  const entityNames = new Set((axis.entities || []).map(item => String(item?.name || '').trim()).filter(Boolean));
  const unknownRelationEndpoints = (axis.relations || [])
    .flatMap(item => [item?.entityA, item?.entityB])
    .map(value => String(value || '').trim())
    .filter(value => value && !entityNames.has(value));
  const unknownMemoryRefs = (axis.memoryMetaTail || [])
    .flatMap(item => Array.isArray(item?.entities) ? item.entities : [])
    .map(value => String(value || '').trim())
    .filter(value => value && !entityNames.has(value));
  const linkedMemoryRefs = (axis.memoryMetaTail || []).some(item => Array.isArray(item?.entities) && item.entities.length > 0);
  const latestNarrativeTurn = Math.max(0, ...(axis.narrative?.turnLogTail || []).map(item => Number(item?.turn || 0)));
  const latestWorldTurn = Math.max(0, ...(axis.world?.turnLogTail || []).map(item => Number(item?.turn || 0)));
  const latestWorld = (axis.world?.turnLogTail || []).slice().sort((a, b) => Number(b?.turn || 0) - Number(a?.turn || 0))[0] || {};
  const entityLastTurn = Math.max(0, ...(axis.entities || []).map(item => Number(item?.lastTurn || 0)));
  const embeddedEntityTurns = (axis.entities || []).map(item => Number(item?.embeddedTurn || 0)).filter(Boolean);
  const entityTurnMismatches = (axis.entities || []).filter(item => Number(item?.embeddedTurn || 0) > 0 && Number(item?.lastTurn || 0) > 0 && Number(item.embeddedTurn) !== Number(item.lastTurn));

  assertCheck('axis_entity_integrity_metadata_present', (axis.entities || []).length > 0 && (axis.entities || []).every(item => item.integrity === 'libra.integrity_meta.v1'), { entities: axis.entities });
  assertCheck('axis_entity_state_reaches_expected_turn', entityLastTurn >= expectedTurn, { entityLastTurn, expectedTurn, entities: axis.entities });
  assertCheck('axis_entity_embedded_turn_matches_metadata', entityTurnMismatches.length === 0 && embeddedEntityTurns.every(turn => turn <= Number(summary?.currentTurn || expectedTurn)), { entityTurnMismatches, embeddedEntityTurns, currentTurn: summary?.currentTurn, expectedTurn });
  assertCheck('axis_relation_endpoints_resolve_to_entities', (axis.relations || []).length > 0 && unknownRelationEndpoints.length === 0, { unknownRelationEndpoints, relations: axis.relations });
  assertCheck('axis_relation_integrity_metadata_present', (axis.relations || []).every(item => item.integrity === 'libra.integrity_meta.v1'), { relations: axis.relations });
  assertCheck('axis_memory_entity_refs_are_canonical', unknownMemoryRefs.length === 0 && (expectedTurn < 2 || linkedMemoryRefs), { unknownMemoryRefs, memoryMetaTail: axis.memoryMetaTail });
  assertCheck('axis_narrative_reaches_expected_turn', latestNarrativeTurn >= expectedTurn && axis.narrative?.integrity === 'libra.integrity_meta.v1', { latestNarrativeTurn, expectedTurn, narrative: axis.narrative });
  assertCheck('axis_world_state_reaches_expected_turn', latestWorldTurn >= expectedTurn && axis.world?.integrity === 'libra.integrity_meta.v1' && (latestWorld.ruleCount > 0 || latestWorld.activeWorld || latestWorld.currentLocation || latestWorld.currentScene), { latestWorldTurn, expectedTurn, latestWorld, world: axis.world });
}

function appendOrchestrationAssertions(assertCheck, summary, expectedTurn, prefix = '') {
  const name = suffix => prefix ? `${prefix}_${suffix}` : suffix;
  assertCheck(name('story_author_accumulated'), summary.storyAuthor?.present === true
    && Number(summary.storyAuthor?.lastTurn || 0) >= expectedTurn
    && Boolean(summary.storyAuthor?.currentArc)
    && Boolean(summary.storyAuthor?.narrativeGoal || summary.storyAuthor?.nextBeats?.length), {
    expectedTurn,
    storyAuthor: summary.storyAuthor
  });
  assertCheck(name('director_accumulated'), summary.director?.present === true
    && Number(summary.director?.lastTurn || 0) >= expectedTurn
    && Boolean(summary.director?.sceneMandate)
    && Array.isArray(summary.director?.requiredOutcomes)
    && summary.director.requiredOutcomes.length > 0, {
    expectedTurn,
    director: summary.director
  });
  assertCheck(name('world_additional_accumulated'), summary.worldAdditional?.present === true
    && Number(summary.worldAdditional?.lastTurn || 0) >= expectedTurn
    && Number(summary.worldAdditional?.counts?.sceneInterventions || 0) > 0
    && Number(summary.worldAdditional?.counts?.worldDeltas || 0) > 0
    && Number(summary.worldAdditional?.counts?.characterAdditions || 0) > 0, {
    expectedTurn,
    worldAdditional: summary.worldAdditional
  });
  assertCheck(name('world_graph_has_meaningful_content'), summary.worldGraph?.present === true
    && Number(summary.worldGraph?.nodeCount || 0) > 0
    && Number(summary.worldGraph?.ruleFactCount || 0) > 0
    && (Number(summary.worldGraph?.worldSummaryChars || 0) > 0 || (summary.worldGraph?.activePath || []).length > 0), {
    worldGraph: summary.worldGraph
  });
}

function summarizeCheckpoint(summary, requestedTurn, drain = null) {
  const axis = summary?.axisSamples || {};
  return {
    requestedTurn,
    drain: drain ? { settled: drain.settled === true, elapsedMs: drain.elapsedMs, loreTurn: drain.loreTurn,
      unmet: Array.isArray(drain.unmet) ? drain.unmet : [] } : null,
    currentTurn: Number(summary?.currentTurn || 0),
    memories: Number(summary?.memories || 0),
    memoryTurnMax: Number(summary?.memoryTurnMax || 0),
    entityLastTurn: Math.max(0, ...(axis.entities || []).map(item => Number(item?.lastTurn || 0))),
    relationLastTurn: Math.max(0, ...(axis.relations || []).map(item => Number(item?.lastTurn || 0))),
    narrativeTurn: Math.max(0, ...(axis.narrative?.turnLogTail || []).map(item => Number(item?.turn || 0))),
    narrativeTurnLog: Number(summary?.narrativeTurnLog || 0),
    worldTurn: Math.max(0, ...(axis.world?.turnLogTail || []).map(item => Number(item?.turn || 0))),
    storyAuthorTurn: Number(summary?.storyAuthor?.lastTurn || 0),
    directorTurn: Number(summary?.director?.lastTurn || 0),
    worldAdditionalTurn: Number(summary?.worldAdditional?.lastTurn || 0),
    worldAdditionalDirectives: Number(summary?.worldAdditional?.totalDirectives || 0),
    worldGraphNodes: Number(summary?.worldGraph?.nodeCount || 0),
    worldGraphRuleFacts: Number(summary?.worldGraph?.ruleFactCount || 0)
  };
}

function appendCheckpointAssertions(assertCheck, checkpoints = []) {
  const regressions = [];
  for (let i = 0; i < checkpoints.length; i += 1) {
    const current = checkpoints[i];
    const previous = checkpoints[i - 1];
    const requiredWatermarks = ['currentTurn', 'memoryTurnMax', 'entityLastTurn', 'narrativeTurn', 'worldTurn', 'storyAuthorTurn', 'directorTurn', 'worldAdditionalTurn'];
    for (const key of requiredWatermarks) {
      if (Number(current?.[key] || 0) < Number(current?.requestedTurn || 0)) {
        regressions.push({ type: 'below_requested_turn', key, checkpoint: current });
      }
    }
    if (current?.drain && current.drain.settled !== true) regressions.push({ type: 'drain_not_settled', checkpoint: current });
    if (!previous) continue;
    for (const key of ['currentTurn', 'memories', 'memoryTurnMax', 'entityLastTurn', 'narrativeTurn', 'narrativeTurnLog', 'worldTurn', 'storyAuthorTurn', 'directorTurn', 'worldAdditionalTurn', 'worldAdditionalDirectives', 'worldGraphNodes', 'worldGraphRuleFacts']) {
      if (Number(current?.[key] || 0) < Number(previous?.[key] || 0)) regressions.push({ type: 'regression', key, previous, current });
    }
  }
  assertCheck('live_domain_checkpoints_monotonic_and_current', checkpoints.length >= 2 && regressions.length === 0, { checkpoints, regressions });
}

function inspectNarrativeGui(exports, char, chat) {
  const gui = exports?.LMAI_GUI;
  const lore = unpackLoreEntries(exports, char, chat);
  if (typeof gui?.buildNarrativeInspectorSnapshot !== 'function' || typeof gui?.renderNarrativeInspectorHtml !== 'function') {
    return { available: false, reason: 'narrative_inspector_helpers_not_exported' };
  }
  try {
    const snapshot = gui.buildNarrativeInspectorSnapshot(lore, {
      storyAuthorState: exports?.StoryAuthor?.getState?.() || {},
      directorState: exports?.Director?.getState?.() || {},
      config: exports?.MemoryEngine?.CONFIG || {}
    });
    const authorHtml = String(gui.renderNarrativeInspectorHtml(snapshot, 'author') || '');
    const directorHtml = String(gui.renderNarrativeInspectorHtml(snapshot, 'director') || '');
    return {
      available: true,
      snapshot: clone(snapshot),
      authorHtmlChars: authorHtml.length,
      directorHtmlChars: directorHtml.length,
      authorHtmlHash: stableHash(authorHtml),
      directorHtmlHash: stableHash(directorHtml),
      authorHtmlHead: authorHtml.slice(0, 600),
      directorHtmlHead: directorHtml.slice(0, 600),
      authorContainsState: Boolean(snapshot?.storyAuthor?.state?.currentArc)
        && authorHtml.includes(String(snapshot.storyAuthor.state.currentArc)),
      directorContainsState: Boolean(snapshot?.director?.state?.sceneMandate)
        && directorHtml.includes(String(snapshot.director.state.sceneMandate)),
      authorContainsTurn: authorHtml.includes(`T${Number(snapshot?.storyAuthor?.state?.lastPlanTurn || 0)}`),
      directorContainsTurn: directorHtml.includes(`T${Number(snapshot?.director?.state?.lastTurn || 0)}`)
    };
  } catch (error) {
    return { available: true, error: error?.message || String(error), stack: error?.stack || '' };
  }
}

async function main() {
  const logs = [];
  const samples = [];
  const errors = [];
  const replacers = { beforeRequest: [], afterRequest: [] };
  const scriptHandlers = { output: [], editoutput: [] };
  const bodyInterceptors = [];
  const unloadHandlers = [];
  const pluginStorage = new Map();
  // 실제 RisuAI 는 기기 로컬 저장소(getLocalPluginStorage)를 제공한다. LIBRA 는
  // HME 파생 캐시를 여기에 둔다 (세이브에 안 붙고 기기 간 동기화도 안 됨).
  // mock 이 없으면 HME 가 저장되지 않아 hmeRows 가 항상 0 으로 보인다.
  const localPluginStorage = new Map();
  __localPluginStorageRef = localPluginStorage;

  const chat = {
    id: `chat-libra-97-${RUN_ID}`,
    name: 'LIBRA 97턴 하네스 채팅',
    localLore: [],
    msgs: [],
    message: null,
    isStreaming: false,
    __libraTest: true
  };
  chat.message = chat.msgs;
  const char = {
    id: 'char-libra-test',
    name: 'LIBRA Test Character',
    chatPage: 0,
    chats: [chat],
    lorebook: [],
    description: '루멘 아카데미의 별핵 사건을 다루는 장기 RP 캐릭터.'
  };
  const database = { personas: [], selectedPersona: null, modules: [], enabledModules: [], moduleIntergration: [], characters: [char] };
  const args = new Map(Object.entries({
    debug: 'true',
    llm_provider: 'custom_openai',
    llm_url: 'http://mock.local/v1/chat/completions',
    llm_key: 'dummy-key',
    llm_model: 'mock-libra-model',
    llm_timeout_ms: '5000',
    llm_max_completion_tokens: '20000',
    llm_stream: 'false',
    aux_llm_enabled: 'false',
    embedding_enabled: 'false',
    cold_start_scope_preset: 'all',
    cold_start_history_limit: '0',
    manual_ooc_pause: 'false'
  }));
  const risuai = {
    async getArgument(name) { return args.get(name); },
    async getCharacter() { return clone(char); },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacterFromIndex(index) { return Number(index) === 0 ? clone(char) : null; },
    async getChatFromIndex(charIndex, chatIndex) { return Number(charIndex) === 0 && Number(chatIndex) === 0 ? clone(char.chats[0]) : null; },
    async setChatToIndex(charIndex, chatIndex, nextChat) {
      if (Number(charIndex) !== 0 || Number(chatIndex) !== 0) throw new Error('bad chat index');
      const preservedMsgs = char.chats[0].msgs;
      const merged = clone(nextChat);
      // Risu 저장 API가 lore만 업데이트하는 상황을 보수적으로 모사: 메시지 배열 참조는 유지하되 저장된 필드는 반영.
      merged.msgs = Array.isArray(nextChat.msgs) ? clone(nextChat.msgs) : preservedMsgs;
      merged.message = merged.msgs;
      char.chats[0] = merged;
      Object.assign(chat, merged);
      chat.msgs = merged.msgs;
      chat.message = chat.msgs;
      // Keep the active-chat object identity aligned with Risu's selected chat.
      // Several product paths mutate the resolved chat before the next host
      // save; retaining a detached clone here hid those writes from transition.
      char.chats[0] = chat;
      return true;
    },
    async setCharacter(nextChar) {
      const merged = clone(nextChar);
      Object.keys(char).forEach(k => delete char[k]);
      Object.assign(char, merged);
      if (!Array.isArray(char.chats)) char.chats = [chat];
      // The host replaces the selected chat snapshot. Clear fields absent from
      // the new session so legacy msgs cannot override its empty message array.
      Object.keys(chat).forEach(k => delete chat[k]);
      Object.assign(chat, char.chats[0]);
      chat.msgs = chat.msgs || chat.messages || chat.message || [];
      chat.message = chat.msgs;
      char.chats[0] = chat;
      database.characters = [char];
      return true;
    },
    async addRisuReplacer(type, handler) { (replacers[type] || (replacers[type] = [])).push(handler); return true; },
    async removeRisuReplacer(type, handler) { replacers[type] = (replacers[type] || []).filter(h => h !== handler); return true; },
    async addRisuScriptHandler(mode, handler) { (scriptHandlers[mode] || (scriptHandlers[mode] = [])).push(handler); return true; },
    async removeRisuScriptHandler(mode, handler) { scriptHandlers[mode] = (scriptHandlers[mode] || []).filter(h => h !== handler); return true; },
    async registerBodyIntercepter(handler) { const id = `interceptor-${bodyInterceptors.length + 1}`; bodyInterceptors.push({ id, handler }); return id; },
    async unregisterBodyIntercepter(id) { const idx = bodyInterceptors.findIndex(x => x.id === id); if (idx >= 0) bodyInterceptors.splice(idx, 1); return true; },
    async onUnload(handler) { unloadHandlers.push(handler); return true; },
    async registerSetting() { return true; },
    async registerButton() { return true; },
    async showContainer() { return true; },
    async hideContainer() { return true; },
    async getDatabase(keys) {
      const out = {};
      for (const k of Array.isArray(keys) ? keys : Object.keys(database)) out[k] = clone(database[k]);
      return out;
    },
    pluginStorage: {
      async getItem(key) { return pluginStorage.has(key) ? pluginStorage.get(key) : null; },
      async setItem(key, value) { pluginStorage.set(key, value); return true; },
      // 실제 RisuAI 는 removeItem 을 제공한다. mock 에 없으면 플러그인의 청크
      // 정리(이전 청크 삭제)가 no-op 이 되어, 턴마다 새 청크가 누적된다.
      // (3MB 데이터 × 97턴 × 6청크 ≈ 1.2GB 힙 → 힙 단언 실패)
      async removeItem(key) { pluginStorage.delete(key); return true; },
      async keys() { return Array.from(pluginStorage.keys()); }
    },
    async getLocalPluginStorage() {
      const store = {
        async getItem(key) { return localPluginStorage.has(key) ? localPluginStorage.get(key) : null; },
        async setItem(key, value) { localPluginStorage.set(key, value); return true; },
        async removeItem(key) { localPluginStorage.delete(key); return true; },
        async keys() { return Array.from(localPluginStorage.keys()); }
      };
      return { getStore: () => store, ...store };
    },
    async nativeFetch() { throw new Error('nativeFetch should not be called in mock LLM mode'); },
    async requestPluginPermission() { return true; }
  };

  let code = fs.readFileSync(DIST, 'utf8');
  if (TEST_FAST_PATCH) {
    code = code
      .replace('const PENDING_FINALIZE_MIN_MS = 3500;', 'const PENDING_FINALIZE_MIN_MS = 0;')
      .replace('const PENDING_FINALIZE_REQUIRED_MATCHES = 2;', 'const PENDING_FINALIZE_REQUIRED_MATCHES = 1;')
      .replace('const REFRESH_STABILIZE_MS = 2500;', 'const REFRESH_STABILIZE_MS = 0;')
      .replace('const REFRESH_DELETE_BLOCK_MS = 15000;', 'const REFRESH_DELETE_BLOCK_MS = 0;');
  }
  const exportSnippet = `\n;globalThis.__LIBRA_EXPORTS__ = {\n` +
    `MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null,\n` +
    `MemoryState: typeof MemoryState !== 'undefined' ? MemoryState : null,\n` +
    `ColdStartManager: typeof ColdStartManager !== 'undefined' ? ColdStartManager : null,\n` +
    `TransitionManager: typeof TransitionManager !== 'undefined' ? TransitionManager : null,\n` +
    `LLMProvider: typeof LLMProvider !== 'undefined' ? LLMProvider : null,\n` +
    `EntityManager: typeof EntityManager !== 'undefined' ? EntityManager : null,\n` +
    `NarrativeTracker: typeof NarrativeTracker !== 'undefined' ? NarrativeTracker : null,\n` +
    `StoryAuthor: typeof StoryAuthor !== 'undefined' ? StoryAuthor : null,\n` +
    `Director: typeof Director !== 'undefined' ? Director : null,\n` +
    `WorldAdditionalCore: typeof WorldAdditionalCore !== 'undefined' ? WorldAdditionalCore : null,\n` +
    `HierarchicalWorldManager: typeof HierarchicalWorldManager !== 'undefined' ? HierarchicalWorldManager : null,\n` +
    `WorldStateTracker: typeof WorldStateTracker !== 'undefined' ? WorldStateTracker : null,\n` +
    `CharacterStateTracker: typeof CharacterStateTracker !== 'undefined' ? CharacterStateTracker : null,\n` +
    `DebugExportManager: typeof DebugExportManager !== 'undefined' ? DebugExportManager : null,\n` +
    `LibraDataStorage: typeof LibraDataStorage !== 'undefined' ? LibraDataStorage : null,\n` +
    `PendingTurnManager: typeof PendingTurnManager !== 'undefined' ? PendingTurnManager : null,\n` +
    `TurnMaintenanceOptimizer: typeof TurnMaintenanceOptimizer !== 'undefined' ? TurnMaintenanceOptimizer : null,\n` +
    `TurnRecordLedger: typeof TurnRecordLedger !== 'undefined' ? TurnRecordLedger : null,\n` +
    `LibraLoreConsolidator: typeof LibraLoreConsolidator !== 'undefined' ? LibraLoreConsolidator : null,\n` +
    `CompactMemoryCodec: typeof CompactMemoryCodec !== 'undefined' ? CompactMemoryCodec : null,\n` +
    `LMAI_GUI: typeof LMAI_GUI !== 'undefined' ? LMAI_GUI : null\n` +
    `};\n`;
  const idx = code.lastIndexOf('\n})();');
  if (idx < 0) throw new Error('Could not locate final IIFE close');
  code = code.slice(0, idx) + exportSnippet + code.slice(idx);

  const context = {
    console: {
      log: (...a) => logs.push({ level: 'log', at: nowIso(), msg: a.map(String).join(' ') }),
      warn: (...a) => logs.push({ level: 'warn', at: nowIso(), msg: a.map(String).join(' ') }),
      error: (...a) => logs.push({ level: 'error', at: nowIso(), msg: a.map(String).join(' ') }),
      debug: (...a) => logs.push({ level: 'debug', at: nowIso(), msg: a.map(String).join(' ') })
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance,
    crypto: { randomUUID: crypto.randomUUID },
    AbortController,
    TextEncoder,
    TextDecoder,
    URL,
    fetch: async () => { throw new Error('fetch should not be called in mock LLM mode'); },
    risuai,
    Risuai: risuai,
    process: { env: process.env },
    Buffer,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64')
  };
  context.globalThis = context;
  vm.createContext(context);

  samples.push(memSample('before_eval'));
  const evalStart = performance.now();
  const runPromise = vm.runInContext(code, context, { filename: DIST, timeout: 10000 });
  if (runPromise && typeof runPromise.then === 'function') await runPromise;
  const exports = context.__LIBRA_EXPORTS__;
  if (!exports || !exports.MemoryEngine || !exports.ColdStartManager) {
    throw new Error(`LIBRA exports unavailable: keys=${Object.keys(context.__LIBRA_EXPORTS__ || {}).join(',')}`);
  }
  // 등록과 초기 내부 async IIFE가 끝날 시간을 조금 둔다.
  await sleep(100);
  samples.push(memSample('after_eval'));

  // 자동 cold-start 타이머가 테스트에 끼어들지 않게 check만 비활성화한다. 수동 start/reanalysis는 그대로 호출한다.
  exports.ColdStartManager.check = async () => false;
  // ── 캡처 / 재생 모드 (실모델 실측용) ──
  // 목적: 실제 제품 실행이 **실제로 만든** 프롬프트를 파일로 받아 로컬 모델에 보내고, 그 원본 답변을
  //       같은 경로에 다시 먹인다. 프롬프트를 손으로 재구성하지 않는다.
  // 캡처 모드도 mock 으로 턴을 돌린다 — mock 이 만드는 답변 자체는 버리고, 그 턴에서 나간 요청만 저장한다.
  const CAPTURE_DIR = String(process.env.LIBRA_CAPTURE_DIR || '').trim();
  const REPLAY_FILE = String(process.env.LIBRA_REPLAY_FILE || '').trim();
  const REPLAY_STRICT = String(process.env.LIBRA_REPLAY_STRICT || '') === '1';
  const captureIndex = new Map();
  const captureRecords = [];
  const makeCaptureKey = (label, systemPrompt, userContent) => crypto.createHash('sha256')
    .update(`${label}\u0001${String(systemPrompt || '')}\u0001${String(userContent || '')}`)
    .digest('hex');
  if (REPLAY_FILE) {
    const table = new Map();
    const raw = fs.readFileSync(REPLAY_FILE, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record = null;
      try { record = JSON.parse(line); } catch (_) { continue; }
      if (!record || typeof record.key !== 'string' || typeof record.answer !== 'string') continue;
      table.set(record.key, record);
    }
    const served = new Set();
    let missCount = 0;
    exports.LLMProvider.call = async (config, systemPrompt, userContent, options = {}) => {
      const label = String(options.label || options.debugLabel || 'mock');
      const key = makeCaptureKey(label, systemPrompt, userContent);
      const record = table.get(key);
      if (!record) {
        missCount += 1;
        const miss = `replay miss #${missCount} label=${label} key=${key.slice(0, 12)} chars=${String(userContent || '').length}`;
        if (REPLAY_STRICT) throw new Error(miss);
        logs.push({ level: 'warn', at: nowIso(), msg: `[LIBRA_REPLAY] ${miss}` });
        return mockLLMCall(config, systemPrompt, userContent, options);
      }
      served.add(key);
      // 원본 답변을 그대로 돌려준다 — 자르지 않고 sha256 도 함께 싣는다.
      return {
        content: record.answer,
        usage: record.usage || {},
        finishReason: record.finishReason || '',
        streamMeta: { finishReason: record.finishReason || '' },
        truncated: record.truncated === true,
        serviceTier: '',
        replay: { sha256: record.sha256 || '', model: record.model || '', servedFrom: 'replay_file' }
      };
    };
    globalThis.__LIBRA_REPLAY_STATS__ = {
      get: () => ({
        tableSize: table.size,
        servedCount: served.size,
        missCount,
        unserved: Array.from(table.keys()).filter(k => !served.has(k)).length,
        strict: REPLAY_STRICT
      })
    };
  } else if (!CAPTURE_DIR) {
    exports.LLMProvider.call = mockLLMCall;
  }
  if (CAPTURE_DIR) {
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    exports.LLMProvider.call = async (config, systemPrompt, userContent, options = {}) => {
      const label = String(options.label || options.debugLabel || 'mock');
      const key = makeCaptureKey(label, systemPrompt, userContent);
      const seen = (captureIndex.get(key) || 0) + 1;
      captureIndex.set(key, seen);
      captureRecords.push({
        key,
        label,
        reason: String(options.reason || ''),
        labelOccurrence: seen,
        systemPrompt: String(systemPrompt || ''),
        userContent: String(userContent || ''),
        systemChars: String(systemPrompt || '').length,
        userChars: String(userContent || '').length,
        options: {
          maxTokens: options.maxTokens ?? null,
          profile: options.profile ?? null,
          jsonMode: options.jsonMode ?? null,
          forceJsonMode: options.forceJsonMode ?? null,
          forceNonStreaming: options.forceNonStreaming ?? null,
          disableReasoning: options.disableReasoning ?? null
        }
      });
      // 실제 모델을 부르지 않는다 — 프롬프트만 모은다. 답변은 mock 값이며 저장에 쓰이지 않는다.
      return mockLLMCall(config, systemPrompt, userContent, options);
    };
  }
  exports.LLMProvider.isConfigured = () => true;
  Object.assign(exports.MemoryEngine.CONFIG, {
    debug: String(process.env.LIBRA_DEBUG || '0') === '1',
    activityDashboard: String(process.env.LIBRA_ACTIVITY_DASHBOARD || 'off'),
    useLLM: true,
    afterRequestMaintenanceMode: String(process.env.LIBRA_AFTER_REQUEST_MODE || 'foreground'),
    afterRequestForegroundTimeoutMs: FOREGROUND_TIMEOUT_MS,
    backgroundMaintenanceDelayMs: 0,
    storyAuthorEnabled: true,
    storyAuthorMode: 'proactive',
    directorEnabled: true,
    directorMode: 'standard',
    worldAdditionalEnabled: true,
    worldAdditionalMode: 'firm',
    worldAdditionalAutoIntegrate: true,
    embed: { ...(exports.MemoryEngine.CONFIG.embed || {}), enabled: false, key: '', url: '', provider: 'custom_openai', model: 'mock-embedding' },
    llm: { ...(exports.MemoryEngine.CONFIG.llm || {}), provider: 'custom_openai', url: 'http://mock.local/v1/chat/completions', key: 'dummy-key', model: 'mock-libra-model', timeout: 5000, stream: false, maxCompletionTokens: 20000 },
    auxLlm: { ...(exports.MemoryEngine.CONFIG.auxLlm || {}), enabled: false }
  });

  const beforeHandler = replacers.beforeRequest[replacers.beforeRequest.length - 1];
  const afterHandler = replacers.afterRequest[replacers.afterRequest.length - 1];
  if (typeof beforeHandler !== 'function' || typeof afterHandler !== 'function') {
    throw new Error(`handlers missing: before=${replacers.beforeRequest.length}, after=${replacers.afterRequest.length}`);
  }

  const results = {
    runId: RUN_ID,
    paths: { root: ROOT, dist: DIST, logPath: LOG_PATH },
    fastPatch: TEST_FAST_PATCH,
    turnCount: TURN_COUNT,
    foregroundTimeoutMs: FOREGROUND_TIMEOUT_MS,
    turnCallTimeoutMs: TURN_CALL_TIMEOUT_MS,
    node: process.version,
    build: { distBytes: fs.statSync(DIST).size, evalMs: Math.round(evalStart ? performance.now() - evalStart : 0) },
    handlerCounts: { beforeRequest: replacers.beforeRequest.length, afterRequest: replacers.afterRequest.length, output: scriptHandlers.output.length, editoutput: scriptHandlers.editoutput.length, bodyInterceptors: bodyInterceptors.length, unloadHandlers: unloadHandlers.length },
    stages: {},
    samples,
    errors,
    warnings: []
  };


  if (String(process.env.LIBRA_COLD_ONLY || '') === '1') {
    const historicalMessages = buildHistoricalMessages(TURN_COUNT);
    chat.msgs = historicalMessages;
    chat.message = chat.msgs;
    char.chats[0] = chat;
    samples.push(memSample(`cold_only_loaded_${TURN_COUNT}_turns`));
    results.stages.preloadedHistory = summarizeLore(exports, char, chat);

    const beforeCold = summarizeLore(exports, char, chat);
    const coldStartTime = performance.now();
    let coldResult = null;
    try {
      coldResult = await exports.ColdStartManager.startAutoSummarization({ confirmationGranted: true, trigger: 'test' });
    } catch (e) {
      errors.push({ stage: 'cold_start', message: e?.message || String(e), stack: e?.stack || '' });
    }
    await sleep(50);
    const afterCold = summarizeLore(exports, char, chat);
    results.stages.coldStart = {
      elapsedMs: Math.round(performance.now() - coldStartTime),
      before: beforeCold,
      after: afterCold,
      resultKeys: coldResult ? Object.keys(coldResult) : null,
      resultSummary: coldResult ? {
        entities: Array.isArray(coldResult.entities) ? coldResult.entities.length : 0,
        relations: Array.isArray(coldResult.relations) ? coldResult.relations.length : 0,
        narrativeChars: String(coldResult.narrative || '').length,
        worldSummaryChars: String(coldResult.world?.summary || '').length
      } : null
    };
    samples.push(memSample('after_cold_only_cold_start'));

    const beforeReanalysis = summarizeLore(exports, char, chat);
    const reStart = performance.now();
    let reResult = null;
    try {
      reResult = await exports.ColdStartManager.reanalyzeHistoricalConversation({ confirmationGranted: true, trigger: 'test' });
    } catch (e) {
      errors.push({ stage: 'reanalysis', message: e?.message || String(e), stack: e?.stack || '' });
    }
    await sleep(50);
    const afterReanalysis = summarizeLore(exports, char, chat);
    results.stages.reanalysis = {
      elapsedMs: Math.round(performance.now() - reStart),
      before: beforeReanalysis,
      after: afterReanalysis,
      resultKeys: reResult ? Object.keys(reResult) : null,
      resultSummary: reResult ? {
        entities: Array.isArray(reResult.entities) ? reResult.entities.length : 0,
        relations: Array.isArray(reResult.relations) ? reResult.relations.length : 0,
        narrativeChars: String(reResult.narrative || '').length,
        worldSummaryChars: String(reResult.world?.summary || '').length
      } : null
    };
    samples.push(memSample('after_cold_only_reanalysis'));

    const recallStart = performance.now();
    let recall = [];
    try {
      const lore = exports.MemoryEngine.getLorebook(char, chat) || [];
      recall = await exports.MemoryEngine.retrieveMemories('도현과 아리엘의 신뢰 변화와 별핵 월식 의식 단서', exports.MemoryEngine.getCurrentTurn(), lore, { focusNames: ['도현', '아리엘'], directFocusNames: ['도현', '아리엘'], relatedFocusNames: ['별핵', '월식', '노아'], narrativeArcKeys: ['별핵 봉인과 월식 의식'], suppressionPlan: null }, 8);
    } catch (e) {
      errors.push({ stage: 'recall', message: e?.message || String(e), stack: e?.stack || '' });
    }
    results.stages.recall = {
      elapsedMs: Math.round(performance.now() - recallStart),
      count: Array.isArray(recall) ? recall.length : 0,
      sample: (Array.isArray(recall) ? recall : []).slice(0, 3).map(e => ({ key: e.key, comment: e.comment, score: e._score || null, preview: String(e._recallWindow || e.content || '').slice(0, 240) })),
      debug: exports.MemoryEngine.getLastRetrievalDebug?.() || null
    };
    samples.push(memSample('after_cold_only_recall'));

    const finalLore = summarizeLore(exports, char, chat);
    const assertions = [];
    function assertCheck(name, ok, details = {}) { assertions.push({ name, ok: !!ok, details }); if (!ok) results.warnings.push({ name, details }); }
    // Cold-only mode intentionally skips the live afterRequest stage.  Assertions
    // for liveDrain/live97 belong to the live path and used to make this recovery
    // simulator crash before it could inspect cold start or reanalysis.
    assertCheck('cold_only_entities_present', afterCold.entities >= 4, { entities: afterCold.entities, names: afterCold.sampleEntityNames });
    assertCheck('cold_only_relations_present', afterCold.relations >= 2, { relations: afterCold.relations });
    assertCheck('cold_only_narrative_present', finalLore.narrativeStorylines >= 1, { storylines: finalLore.narrativeStorylines, turnLog: finalLore.narrativeTurnLog });
    assertCheck('cold_only_world_present', (finalLore.byComment.lmai_world_states || 0) >= 1 && finalLore.worldGraph?.present === true && finalLore.worldGraph?.nodeCount > 0 && finalLore.worldGraph?.ruleFactCount > 0, { byComment: finalLore.byComment, worldGraph: finalLore.worldGraph });
    assertCheck('cold_only_reanalysis_exactly_idempotent', afterReanalysis.totalLore === afterCold.totalLore && afterReanalysis.memories === afterCold.memories && afterReanalysis.hmeRows === afterCold.hmeRows, { before: { totalLore: afterCold.totalLore, memories: afterCold.memories, hmeRows: afterCold.hmeRows }, after: { totalLore: afterReanalysis.totalLore, memories: afterReanalysis.memories, hmeRows: afterReanalysis.hmeRows } });
    assertCheck('cold_only_reanalysis_preserves_semantic_domains', afterReanalysis.entities >= afterCold.entities
      && afterReanalysis.relations >= afterCold.relations
      && afterReanalysis.narrativeStorylines >= afterCold.narrativeStorylines
      && afterReanalysis.narrativeTurnLog >= afterCold.narrativeTurnLog
      && afterReanalysis.worldGraph?.nodeCount >= afterCold.worldGraph?.nodeCount
      && afterReanalysis.worldGraph?.ruleFactCount >= afterCold.worldGraph?.ruleFactCount, {
      before: { entities: afterCold.entities, relations: afterCold.relations, narrativeStorylines: afterCold.narrativeStorylines, narrativeTurnLog: afterCold.narrativeTurnLog, worldGraph: afterCold.worldGraph },
      after: { entities: afterReanalysis.entities, relations: afterReanalysis.relations, narrativeStorylines: afterReanalysis.narrativeStorylines, narrativeTurnLog: afterReanalysis.narrativeTurnLog, worldGraph: afterReanalysis.worldGraph }
    });
    assertCheck('cold_only_recall_returns_results', results.stages.recall.count > 0, { count: results.stages.recall.count });
    appendOrchestrationAssertions(assertCheck, finalLore, TURN_COUNT, 'cold_only');
    appendAxisIntegrityAssertions(assertCheck, finalLore, TURN_COUNT);
    const maxTransientHeap = Math.max(...samples.map(s => s.preGcHeapUsedMB ?? s.heapUsedMB));
    const settledGrowth = samples[samples.length - 1].heapUsedMB - samples[0].heapUsedMB;
    assertCheck('cold_only_transient_heap_bounded', maxTransientHeap < TRANSIENT_HEAP_LIMIT_MB, { maxTransientHeapMB: maxTransientHeap, limitMB: TRANSIENT_HEAP_LIMIT_MB });
    assertCheck('cold_only_settled_heap_growth_bounded', !heapGrowthAssertable() || settledGrowth < SETTLED_HEAP_GROWTH_LIMIT_MB, { settledGrowthMB: Math.round(settledGrowth * 100) / 100, limitMB: SETTLED_HEAP_GROWTH_LIMIT_MB, gcAvailable: heapGrowthAssertable(), skipped: heapGrowthAssertable() ? '' : heapGrowthSkipNote });
    results.assertions = assertions;
    results.ok = errors.length === 0 && assertions.every(item => item.ok);
    results.finalLore = finalLore;
    results.samples = samples;
    results.errors = errors;
    results.logs = logs.slice(-200);
    try { for (const fn of unloadHandlers) await fn(); } catch (e) { errors.push({ stage: 'unload', message: e?.message || String(e) }); }
    fs.writeFileSync(LOG_PATH, JSON.stringify(results, null, 2), 'utf8');
    finalExitCode = results.ok ? 0 : 1;
    console.log(JSON.stringify({ ok: results.ok, logPath: LOG_PATH, assertions, finalLore, stages: results.stages, samples }, null, 2));
    return;
  }

  // Stage A: live 97-turn before/afterRequest simulator from empty lore.
  const turnDurations = [];
  const domainCheckpoints = [];
  const checkpointTurns = new Set([1, 2, 5, 10, TURN_COUNT]);
  for (let checkpointTurn = 20; checkpointTurn < TURN_COUNT; checkpointTurn += 10) checkpointTurns.add(checkpointTurn);
  const stageLiveStart = performance.now();
  for (let i = 1; i <= TURN_COUNT; i++) {
    const t0 = performance.now();
    const pair = makePair(i);
    const requestMessages = [
      { role: 'system', content: 'You are running the LIBRA 97-turn test.' },
      ...chat.msgs.slice(-16).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' })),
      { role: 'user', content: pair.user }
    ];
    try {
      const userMsg = { role: 'user', content: pair.user, m_id: `live-u-${i}`, id: `live-u-${i}`, time: Date.now() };
      chat.msgs.push(userMsg);
      chat.message = chat.msgs;
      char.chats[0] = chat;
      await withTimeout(beforeHandler(requestMessages, 'model'), TURN_CALL_TIMEOUT_MS, `beforeHandler turn ${i}`);
      await withTimeout(afterHandler(pair.assistant, 'model'), TURN_CALL_TIMEOUT_MS, `afterHandler turn ${i}`);
      const aiMsg = { role: 'assistant', content: pair.assistant, m_id: `live-a-${i}`, id: `live-a-${i}`, time: Date.now() };
      chat.msgs.push(aiMsg);
      chat.message = chat.msgs;
      char.chats[0] = chat;
    } catch (e) {
      errors.push({ stage: 'live_turn', turn: i, message: e?.message || String(e), stack: e?.stack || '' });
    }
    const dt = performance.now() - t0;
    turnDurations.push(dt);
    if (true) process.stderr.write(`[LIBRA_HARNESS] turn ${i}/${TURN_COUNT} dt=${Math.round(dt)}ms errors=${errors.length}\n`);
    if (checkpointTurns.has(i)) {
      // ★ 체크포인트 드레인 예산 — **측정값에 맞춘다** (커밋 `1c1440f` 의 A/B/C 실측).
      //   종전 30s 는 턴 60+ 에서 **정착 직전에** 끊겼다(실측: 필요 45.4s vs 예산 30s,
      //   최대 관측 46.7s @ turn 90). 그 30s 는 **하네스가 만든 값**이지 제품 계약이 아니다 —
      //   제품 코드에 이 env/예산은 없다. 제품의 실제 상한은 아래 **최종 드레인 240s**(5분)다.
      //   90s = 관측 최대의 약 2배. 실제로 멈추면 여전히 실패하고, 그때는 `unmet[]` 이
      //   어느 조건이 안 맞았는지 남긴다(추정으로 메우지 않는다).
      const checkpointDrain = await waitForLiveDrain(
        pluginStorage,
        exports,
        char,
        chat,
        i,
        Math.max(5000, Number(process.env.LIBRA_CHECKPOINT_WAIT_MS || 90000) || 90000)
      );
      domainCheckpoints.push(summarizeCheckpoint(summarizeLore(exports, char, chat), i, checkpointDrain));
    }
    if (i % 10 === 0 || i === TURN_COUNT || checkpointTurns.has(i)) samples.push(memSample(`live_turn_${i}`));
  }
  // afterRequest is intentionally detached. Wait on durable completion state,
  // not an arbitrary sleep, while enforcing the product's sub-five-minute cap.
  const liveDrain = await waitForLiveDrain(
    pluginStorage,
    exports,
    char,
    chat,
    TURN_COUNT,
    Math.min(285000, Math.max(1000, Number(process.env.LIBRA_POST_LIVE_WAIT_MS || 240000) || 240000))
  );
  const liveSummary = summarizeLore(exports, char, chat);
  const liveRuntimeRequests = Array.from(exports.MemoryState.runtimeDebugRequestsByKey?.values?.() || [])
    .slice(-12)
    .map(item => clone(item));
  results.stages.live97 = {
    elapsedMs: Math.round(performance.now() - stageLiveStart),
    drain: liveDrain,
    turnLatencyMs: { avg: Math.round(avg(turnDurations)), p95: Math.round(p95(turnDurations)), max: Math.round(Math.max(...turnDurations)) },
    domainCheckpoints,
    lore: liveSummary,
    turnLedger: summarizeTurnLedger(pluginStorage),
    workerState: {
      scopedRuntimeTransaction: clone(exports.MemoryState.scopedRuntimeTransaction || null),
      afterRequestOriginsByType: Array.from(exports.MemoryState.afterRequestOriginsByType?.entries?.() || []).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0]),
      pendingTurnCommits: Array.from(exports.MemoryState.pendingTurnCommits?.keys?.() || []),
      pendingTurnCommitLocks: Array.from(exports.MemoryState.pendingTurnCommitLocksByScope?.keys?.() || []),
      turnMaintenanceSchedules: Array.from(exports.MemoryState.turnMaintenanceSchedulesByChatId?.keys?.() || []),
      turnMaintenanceLocks: Array.from(exports.MemoryState.turnMaintenanceLocksByChatId?.keys?.() || []),
      foregroundTasks: Array.from(exports.MemoryState.afterRequestForegroundTasksByScope?.keys?.() || []),
      runtimeRequests: liveRuntimeRequests
    },
    cacheStats: exports.MemoryEngine.getCacheStats?.() || null,
    retrievalDebug: exports.MemoryEngine.getLastRetrievalDebug?.() || null
  };
  samples.push(memSample('after_live97'));

  if (String(process.env.LIBRA_LIVE_ONLY || '') === '1') {
    const finalLore = summarizeLore(exports, char, chat);
    const assertions = [];
    function assertCheck(name, ok, details = {}) { assertions.push({ name, ok: !!ok, details }); if (!ok) results.warnings.push({ name, details }); }
    assertCheck('live_created_expected_memories', results.stages.live97.lore.memories >= TURN_COUNT, { memories: results.stages.live97.lore.memories, turnCount: TURN_COUNT });
    assertCheck('live_turn_advanced_to_turn_count', results.stages.live97.lore.currentTurn >= TURN_COUNT, { currentTurn: results.stages.live97.lore.currentTurn, turnCount: TURN_COUNT });
    assertCheck('live_entities_present', results.stages.live97.lore.entities >= 4, { entities: results.stages.live97.lore.entities, names: results.stages.live97.lore.sampleEntityNames });
    assertCheck('live_relations_present', results.stages.live97.lore.relations >= 2, { relations: results.stages.live97.lore.relations });
    appendCheckpointAssertions(assertCheck, results.stages.live97.domainCheckpoints || []);
    appendOrchestrationAssertions(assertCheck, finalLore, TURN_COUNT, 'live');
    appendAxisIntegrityAssertions(assertCheck, finalLore, TURN_COUNT);
    assertCheck('live_latency_no_turn_freeze_gt_5s', Math.max(...turnDurations) < 5000, { maxMs: Math.round(Math.max(...turnDurations)), p95Ms: Math.round(p95(turnDurations)) });
    const maxTransientHeap = Math.max(...samples.map(s => s.preGcHeapUsedMB ?? s.heapUsedMB));
    const settledGrowth = samples[samples.length - 1].heapUsedMB - samples[0].heapUsedMB;
    assertCheck('live_transient_heap_bounded', maxTransientHeap < TRANSIENT_HEAP_LIMIT_MB, { maxTransientHeapMB: maxTransientHeap, limitMB: TRANSIENT_HEAP_LIMIT_MB });
    assertCheck('live_settled_heap_growth_bounded', !heapGrowthAssertable() || settledGrowth < SETTLED_HEAP_GROWTH_LIMIT_MB, { settledGrowthMB: Math.round(settledGrowth * 100) / 100, limitMB: SETTLED_HEAP_GROWTH_LIMIT_MB, gcAvailable: heapGrowthAssertable(), skipped: heapGrowthAssertable() ? '' : heapGrowthSkipNote });
    results.assertions = assertions;
    results.ok = errors.length === 0 && assertions.every(item => item.ok);
    results.finalLore = finalLore;
    results.samples = samples;
    results.errors = errors;
    results.logs = logs.slice(-200);
    try { for (const fn of unloadHandlers) await fn(); } catch (e) { errors.push({ stage: 'unload', message: e?.message || String(e) }); }
    fs.writeFileSync(LOG_PATH, JSON.stringify(results, null, 2), 'utf8');
    finalExitCode = results.ok ? 0 : 1;
    console.log(JSON.stringify({ ok: results.ok, logPath: LOG_PATH, assertions, finalLore, stages: { live97: results.stages.live97 }, samples }, null, 2));
    return;
  }

  // Stage B: run cold start over the 97-turn chat; it should augment, not wipe.
  const beforeCold = summarizeLore(exports, char, chat);
  const coldStartTime = performance.now();
  let coldResult = null;
  try {
    coldResult = await exports.ColdStartManager.startAutoSummarization({ confirmationGranted: true, trigger: 'test' });
  } catch (e) {
    errors.push({ stage: 'cold_start', message: e?.message || String(e), stack: e?.stack || '' });
  }
  await sleep(50);
  const afterCold = summarizeLore(exports, char, chat);
  results.stages.coldStart = {
    elapsedMs: Math.round(performance.now() - coldStartTime),
    before: beforeCold,
    after: afterCold,
    resultKeys: coldResult ? Object.keys(coldResult) : null,
    resultSummary: coldResult ? {
      entities: Array.isArray(coldResult.entities) ? coldResult.entities.length : 0,
      relations: Array.isArray(coldResult.relations) ? coldResult.relations.length : 0,
      narrativeChars: String(coldResult.narrative || '').length,
      worldSummaryChars: String(coldResult.world?.summary || '').length
    } : null
  };
  samples.push(memSample('after_cold_start'));

  // Stage C: historical reanalysis merge.
  const beforeReanalysis = summarizeLore(exports, char, chat);
  const reStart = performance.now();
  let reResult = null;
  try {
    reResult = await exports.ColdStartManager.reanalyzeHistoricalConversation({ confirmationGranted: true, trigger: 'test' });
  } catch (e) {
    errors.push({ stage: 'reanalysis', message: e?.message || String(e), stack: e?.stack || '' });
  }
  await sleep(50);
  const afterReanalysis = summarizeLore(exports, char, chat);
  results.stages.reanalysis = {
    elapsedMs: Math.round(performance.now() - reStart),
    before: beforeReanalysis,
    after: afterReanalysis,
    resultKeys: reResult ? Object.keys(reResult) : null,
    resultSummary: reResult ? {
      entities: Array.isArray(reResult.entities) ? reResult.entities.length : 0,
      relations: Array.isArray(reResult.relations) ? reResult.relations.length : 0,
      narrativeChars: String(reResult.narrative || '').length,
      worldSummaryChars: String(reResult.world?.summary || '').length
    } : null
  };
  samples.push(memSample('after_reanalysis'));

  // Stage D: recall/retrieval check to force scoring/index read path.
  const recallStart = performance.now();
  let recall = [];
  try {
    const lore = exports.MemoryEngine.getLorebook(char, chat) || [];
    recall = await exports.MemoryEngine.retrieveMemories('도현과 아리엘의 신뢰 변화와 별핵 월식 의식 단서', exports.MemoryEngine.getCurrentTurn(), lore, { focusNames: ['도현', '아리엘'], directFocusNames: ['도현', '아리엘'], relatedFocusNames: ['별핵', '월식', '노아'], narrativeArcKeys: ['별핵 봉인과 월식 의식'], suppressionPlan: null }, 8);
  } catch (e) {
    errors.push({ stage: 'recall', message: e?.message || String(e), stack: e?.stack || '' });
  }
  results.stages.recall = {
    elapsedMs: Math.round(performance.now() - recallStart),
    count: Array.isArray(recall) ? recall.length : 0,
    sample: (Array.isArray(recall) ? recall : []).slice(0, 3).map(e => ({ key: e.key, comment: e.comment, score: e._score || null, preview: String(e._recallWindow || e.content || '').slice(0, 240) })),
    debug: exports.MemoryEngine.getLastRetrievalDebug?.() || null
  };
  samples.push(memSample('after_recall'));

  // Stage E: dedicated World Additional manual analysis.  This path must only
  // mutate its own DB and must remain independent from cold start/reanalysis.
  const manualWorldAdditional = { result: null, before: null, after: null, error: null };
  try {
    const targetLore = exports.MemoryEngine.getLorebook(char, chat) || [];
    exports.WorldAdditionalCore.loadState(targetLore, {
      scopeKey: exports.MemoryState?._activeScopeKey || String(chat.id || ''),
      chatId: String(chat.id || '')
    });
    manualWorldAdditional.before = summarizeLore(exports, char, chat);
    const manualResult = await exports.TurnMaintenanceOptimizer.runWorldAdditionalManual({
      turn: exports.MemoryEngine.getCurrentTurn(),
      historyText: chat.msgs.slice(-40).map(message => `${message.role}: ${String(message.content || '')}`).join('\n'),
      worldPrompt: '루멘 아카데미의 별핵 연구 금지와 월식 접근 시 시간 잠금 불안정 규칙.',
      worldStatePrompt: '현재 위치는 시계탑 관측실이며 별핵 파편 공명 조사가 진행 중이다.',
      narrativePrompt: '별핵 봉인의 진실과 월식 의식의 선택을 향한 조사 아크.',
      entityContext: '도현, 아리엘, 미라, 노아는 이미 정본 인물이다.',
      existingDirectives: exports.WorldAdditionalCore.formatStateForAnalysis?.(4000) || ''
    }, {
      ...exports.MemoryEngine.CONFIG,
      worldAdditionalEnabled: true,
      worldAdditionalMode: 'firm'
    });
    exports.WorldAdditionalCore.ingestMaintenance(manualResult.payload, '', {
      turn: exports.MemoryEngine.getCurrentTurn(),
      source: 'manual_world_additional_analysis',
      injectedIds: []
    }, {
      ...exports.MemoryEngine.CONFIG,
      worldAdditionalEnabled: true,
      worldAdditionalMode: 'firm'
    });
    await exports.WorldAdditionalCore.saveState(targetLore);
    exports.MemoryEngine.setLorebook(char, chat, targetLore);
    manualWorldAdditional.result = {
      source: manualResult.source,
      turn: manualResult.turn,
      profile: manualResult.profile,
      rawChars: manualResult.rawChars,
      payloadCounts: {
        sceneInterventions: manualResult.payload?.sceneInterventions?.length || 0,
        worldDeltas: manualResult.payload?.worldDeltas?.length || 0,
        characterAdditions: manualResult.payload?.characterAdditions?.length || 0
      }
    };
    manualWorldAdditional.after = summarizeLore(exports, char, chat);
  } catch (error) {
    manualWorldAdditional.error = error?.message || String(error);
    errors.push({ stage: 'world_additional_manual', message: manualWorldAdditional.error, stack: error?.stack || '' });
  }
  results.stages.worldAdditionalManual = manualWorldAdditional;
  samples.push(memSample('after_world_additional_manual'));

  // Stage F: GUI-visible narrative inspector conversion.  This is intentionally
  // a DOM-independent renderer check so it remains deterministic in Node.
  results.stages.narrativeGui = inspectNarrativeGui(exports, char, chat);

  // Stage G: analysis recovery behavior under malformed and transient provider output.
  const recoveryChecks = { deferred: null, transient: null, errors: [] };
  const originalLlmCall = exports.LLMProvider.call;
  try {
    exports.LLMProvider.call = async () => ({ content: '{"status":"failed"}', usage: {} });
    recoveryChecks.deferred = await exports.TurnMaintenanceOptimizer.runUnified(
      98,
      { strictUserMsg: '별핵 조사 상태를 확인한다.', strictAiResponse: '아리엘이 별핵 파편의 공명을 확인했다.', involvedEntities: ['아리엘'] },
      '아리엘이 별핵 파편의 공명을 확인했다.',
      exports.MemoryEngine.getLorebook(char, chat) || [],
      { ...exports.MemoryEngine.CONFIG, afterRequestParallelAnalysis: false, analysisRecoveryImmediateAttempts: 1 },
      { sourceMessageId: 'a-recovery-98', entityStoredInfo: '아리엘' }
    );

    let transientCalls = 0;
    exports.LLMProvider.call = async (...args) => {
      transientCalls += 1;
      if (transientCalls === 1) return { content: '{"status":"failed"}', usage: {} };
      return originalLlmCall(...args);
    };
    recoveryChecks.transient = await exports.TurnMaintenanceOptimizer.runUnified(
      99,
      { strictUserMsg: '관측 기록을 재확인한다.', strictAiResponse: '도현과 아리엘이 관측 기록을 대조했다.', involvedEntities: ['도현', '아리엘'] },
      '도현과 아리엘이 관측 기록을 대조했다.',
      exports.MemoryEngine.getLorebook(char, chat) || [],
      { ...exports.MemoryEngine.CONFIG, afterRequestParallelAnalysis: false, analysisRecoveryImmediateAttempts: 1 },
      { sourceMessageId: 'a-recovery-99', entityStoredInfo: '도현, 아리엘' }
    );
    recoveryChecks.transientCalls = transientCalls;
  } catch (e) {
    recoveryChecks.errors.push(e?.message || String(e));
  } finally {
    exports.LLMProvider.call = originalLlmCall;
  }

  // Stage H: create the next LIBRA session, verify inherited DBs, then process
  // one more real before/afterRequest pair in the destination chat.
  const transitionStage = {
    success: false,
    beforeChatId: String(chat.id || ''),
    beforeChatCount: Array.isArray(char.chats) ? char.chats.length : 0,
    before: summarizeLore(exports, char, chat),
    afterTransition: null,
    afterContinuation: null,
    continuationDrain: null,
    error: null
  };
  try {
    transitionStage.success = await exports.TransitionManager.executeTransition();
    transitionStage.afterChatId = String(chat.id || '');
    transitionStage.afterChatCount = Array.isArray(char.chats) ? char.chats.length : 0;
    transitionStage.afterTransition = summarizeLore(exports, char, chat);
    if (transitionStage.success) {
      // 활성 채팅을 전환 결과(새 채팅)로 맞춘다 — 실제 Risu 호스트 동작.
      // TransitionManager 는 nextChar.chats 를 새로 만들고 chatPage=0 으로 두는데,
      // 하네스의 char 는 옛 스냅샷이라 그대로 두면 옛 채팅에 계속 커밋한다.
      const transitioned = await risuai.getCharacter();
      if (Array.isArray(transitioned?.chats) && transitioned.chats.length > 0) {
        const newChat = transitioned.chats[0];
        // 옛 chat 객체를 새 채팅 내용으로 교체한다 (const 라 재바인딩 불가).
        for (const k of Object.keys(chat)) delete chat[k];
        Object.assign(chat, newChat);
        chat.msgs = Array.isArray(newChat.msgs) ? newChat.msgs : [];
        chat.message = chat.msgs;
        Object.assign(char, transitioned);
        char.chats[0] = chat;
      }
      const continuationLabelTurn = TURN_COUNT + 1;
      const destinationAdmission = await exports.LibraDataStorage.preparePersonaContext(char, chat);
      const destinationScope = exports.LibraDataStorage.scopeKeyFor(char, chat);
      const destinationReadback = await exports.LibraDataStorage.readVerified(destinationScope);
      transitionStage.destinationAdmission = { ...destinationAdmission, canonicalRaw: undefined };
      transitionStage.destinationRejectedEntries = (destinationReadback.entries || []).map(entry => {
        const inspection = exports.LibraDataStorage.inspectHydrationEntries([entry], {
          char, chat: { ...chat, bindedPersona: destinationAdmission.personaId }, scopeKey: destinationScope, runtimeScopeKey: destinationAdmission.runtimeScopeKey,
          runtimeChatId: chat.id, canonicalEnvelopeVerified: !destinationReadback.missing
        });
        return { comment: entry.comment, key: entry.key, inspection };
      }).filter(item => !item.inspection.ok);
      const pair = makePair(continuationLabelTurn);
      const requestMessages = [
        { role: 'system', content: 'Continue the inherited LIBRA session without resetting canon.' },
        { role: 'user', content: pair.user }
      ];
      transitionStage.destinationBeforeUser = {
        messageCount: chat.msgs.length,
        messageFields: { msgs: chat.msgs?.length, message: chat.message?.length }
      };
      chat.msgs.push(
        { role: 'user', content: pair.user, m_id: `continued-u-${continuationLabelTurn}`, id: `continued-u-${continuationLabelTurn}`, time: Date.now() }
      );
      chat.message = chat.msgs;
      // 전환은 nextChar.chats.unshift(newChat) 으로 **새 채팅**을 활성(인덱스 0)으로
      // 만든다. 하네스가 옛 chat 객체를 char.chats[0] 에 되돌려 놓으면 전환 자체가
      // 무효가 된다 (실측: currentTurn 98→98 로 정체). 실제 호스트처럼 활성 채팅을
      // 새 채팅으로 바꾼다.
      char.chats[0] = chat;
      await withTimeout(beforeHandler(requestMessages, 'model'), TURN_CALL_TIMEOUT_MS, 'beforeHandler transition continuation');
      transitionStage.continuationBeforeRequest = {
        samplePhase: 'after-beforeRequest-before-afterRequest',
        activeScopeKey: exports.MemoryState._activeScopeKey,
        activeChatId: exports.MemoryState._activeChatId,
        messageCount: chat.msgs.length,
        messageFields: { msgs: chat.msgs?.length, message: chat.message?.length },
        origins: Array.from(exports.MemoryState.afterRequestOriginsByType?.entries?.() || []).map(([key, value]) => [key, clone(value)]),
        requests: Array.from(exports.MemoryState.runtimeDebugRequestsByKey?.values?.() || []).slice(-2)
          .map(item => ({ flow: item.flow, status: item.status, scopeKey: item.scopeKey, chatId: item.chatId, reason: item.result?.reason || '' }))
      };
      await withTimeout(afterHandler(pair.assistant, 'model'), TURN_CALL_TIMEOUT_MS, 'afterHandler transition continuation');
      chat.msgs.push(
        { role: 'assistant', content: pair.assistant, m_id: `continued-a-${continuationLabelTurn}`, id: `continued-a-${continuationLabelTurn}`, time: Date.now() }
      );
      chat.message = chat.msgs;
      char.chats[0] = chat;
      transitionStage.continuationDrain = await waitForLiveDrain(
        pluginStorage,
        exports,
        char,
        chat,
        TURN_COUNT + 1,
        Math.max(10000, Number(process.env.LIBRA_TRANSITION_WAIT_MS || 60000) || 60000)
      );
      transitionStage.afterContinuation = summarizeLore(exports, char, chat);
      transitionStage.continuationMessages = chat.msgs.length;
      transitionStage.canonicalStorage = require('./libra_generation_capture_receipt_fixture.cjs').readCanonicalRecords(pluginStorage)
        .map(({key, record}) => {
          return { key, scopeKey: record.scopeKey, resetGeneration: record.resetGeneration,
            entries: (record.entries || []).map(entry => ({ comment: entry.comment, key: entry.key, hash: stableHash(entry.content) })) };
        });
    }
  } catch (error) {
    transitionStage.error = error?.message || String(error);
    errors.push({ stage: 'transition', message: transitionStage.error, stack: error?.stack || '' });
  }
  results.stages.transition = transitionStage;
  results.stages.narrativeGuiAfterTransition = inspectNarrativeGui(exports, char, chat);
  samples.push(memSample('after_transition_continuation'));

  // Basic consistency assertions.
  const finalLore = summarizeLore(exports, char, chat);
  const finalRawLore = exports.MemoryEngine.getLorebook(char, chat) || [];
  const rpLongTermEntry = finalRawLore.find(entry => entry?.comment === 'lmai_rp_longterm');
  const rpLongTermState = parseJsonObject(rpLongTermEntry?.content || '{}');
  const rpCategories = ['stableFacts', 'preferences', 'commitments', 'openLoops', 'relationshipMilestones', 'stateChanges', 'callbacks', 'episodes'];
  const rpItems = rpCategories.flatMap(key => Array.isArray(rpLongTermState[key]) ? rpLongTermState[key] : []);
  const rpEvidenceRefCount = rpItems.reduce((count, item) => count + (Array.isArray(item?.evidenceRefs) ? item.evidenceRefs.length : 0), 0);
  const assertions = [];
  function assertCheck(name, ok, details = {}) { assertions.push({ name, ok: !!ok, details }); if (!ok) results.warnings.push({ name, details }); }
  assertCheck('live_detached_pipeline_settled', results.stages.live97.drain?.settled === true, results.stages.live97.drain || {});
  assertCheck('live_wal_committed_and_analyzed', results.stages.live97.turnLedger.byStatus.committed >= TURN_COUNT && results.stages.live97.turnLedger.byAnalysisStatus.done >= TURN_COUNT, results.stages.live97.turnLedger);
  assertCheck('live_wal_user_assistant_pairs_aligned', results.stages.live97.turnLedger.alignedPairs >= TURN_COUNT, { alignedPairs: results.stages.live97.turnLedger.alignedPairs, turnCount: TURN_COUNT, records: results.stages.live97.turnLedger.records });
  assertCheck('live_created_memories', results.stages.live97.lore.memories >= Math.max(1, Math.min(50, TURN_COUNT)), { memories: results.stages.live97.lore.memories, turnCount: TURN_COUNT });
  assertCheck('live_turn_advanced', results.stages.live97.lore.currentTurn >= TURN_COUNT, { currentTurn: results.stages.live97.lore.currentTurn, turnCount: TURN_COUNT });
  assertCheck('entities_present_after_cold', afterCold.entities >= 4, { entities: afterCold.entities, names: afterCold.sampleEntityNames });
  assertCheck('relations_present_after_cold', afterCold.relations >= 2, { relations: afterCold.relations });
  assertCheck('narrative_present', finalLore.narrativeStorylines >= 1, { storylines: finalLore.narrativeStorylines, turnLog: finalLore.narrativeTurnLog });
  assertCheck('world_state_entries_present', (finalLore.byComment.lmai_world_states || 0) >= 1 && finalLore.worldGraph?.present === true && finalLore.worldGraph?.ruleFactCount > 0, { byComment: finalLore.byComment, worldGraph: finalLore.worldGraph });
  appendCheckpointAssertions(assertCheck, results.stages.live97.domainCheckpoints || []);
  appendOrchestrationAssertions(assertCheck, results.stages.live97.lore, TURN_COUNT, 'live');
  assertCheck('cold_start_preserves_orchestration_domains',
    afterCold.storyAuthor?.lastTurn >= beforeCold.storyAuthor?.lastTurn
      && afterCold.director?.lastTurn >= beforeCold.director?.lastTurn
      && afterCold.worldAdditional?.totalDirectives >= beforeCold.worldAdditional?.totalDirectives
      && afterCold.worldGraph?.nodeCount >= beforeCold.worldGraph?.nodeCount
      && afterCold.worldGraph?.ruleFactCount >= beforeCold.worldGraph?.ruleFactCount,
    { before: { storyAuthor: beforeCold.storyAuthor, director: beforeCold.director, worldAdditional: beforeCold.worldAdditional, worldGraph: beforeCold.worldGraph }, after: { storyAuthor: afterCold.storyAuthor, director: afterCold.director, worldAdditional: afterCold.worldAdditional, worldGraph: afterCold.worldGraph } });
  assertCheck('reanalysis_preserves_orchestration_domains',
    afterReanalysis.storyAuthor?.lastTurn >= afterCold.storyAuthor?.lastTurn
      && afterReanalysis.director?.lastTurn >= afterCold.director?.lastTurn
      && afterReanalysis.worldAdditional?.totalDirectives >= afterCold.worldAdditional?.totalDirectives
      && afterReanalysis.worldGraph?.nodeCount >= afterCold.worldGraph?.nodeCount
      && afterReanalysis.worldGraph?.ruleFactCount >= afterCold.worldGraph?.ruleFactCount,
    { afterCold: { storyAuthor: afterCold.storyAuthor, director: afterCold.director, worldAdditional: afterCold.worldAdditional, worldGraph: afterCold.worldGraph }, afterReanalysis: { storyAuthor: afterReanalysis.storyAuthor, director: afterReanalysis.director, worldAdditional: afterReanalysis.worldAdditional, worldGraph: afterReanalysis.worldGraph } });
  assertCheck('reanalysis_no_large_duplicate_explosion', afterReanalysis.totalLore <= Math.max(30, Math.ceil(afterCold.totalLore * 1.7)), { before: afterCold.totalLore, after: afterReanalysis.totalLore });
  assertCheck('recall_returns_results', results.stages.recall.count > 0, { count: results.stages.recall.count });
  assertCheck('canonical_v3_evidence_refs_persisted', rpEvidenceRefCount > 0, { itemCount: rpItems.length, evidenceRefCount: rpEvidenceRefCount });
  assertCheck('analysis_failure_returns_safe_deferred_result', recoveryChecks.deferred?.analysisDeferred === true && !!recoveryChecks.deferred?.maintenance && recoveryChecks.deferred?.canonicalPacket == null, recoveryChecks.deferred || recoveryChecks.errors);
  assertCheck('analysis_transient_failure_recovers_immediately', recoveryChecks.transient?.recovered === true && !!recoveryChecks.transient?.canonicalPacket && recoveryChecks.transientCalls >= 2, { recovered: recoveryChecks.transient?.recovered, hasPacket: !!recoveryChecks.transient?.canonicalPacket, calls: recoveryChecks.transientCalls, errors: recoveryChecks.errors });
  assertCheck('world_additional_manual_analysis_only_mutates_own_db',
    !manualWorldAdditional.error
      && manualWorldAdditional.result?.source === 'manual_world_additional_analysis'
      && Number(manualWorldAdditional.after?.worldAdditional?.totalDirectives || 0) > Number(manualWorldAdditional.before?.worldAdditional?.totalDirectives || 0)
      && manualWorldAdditional.after?.nonWorldAdditionalFingerprint === manualWorldAdditional.before?.nonWorldAdditionalFingerprint,
    manualWorldAdditional);
  assertCheck('narrative_gui_renders_story_author_and_director',
    results.stages.narrativeGui?.available === true
      && !results.stages.narrativeGui?.error
      && results.stages.narrativeGui?.snapshot?.storyAuthor?.stored === true
      && results.stages.narrativeGui?.snapshot?.director?.stored === true
      && results.stages.narrativeGui?.authorContainsState === true
      && results.stages.narrativeGui?.directorContainsState === true
      && results.stages.narrativeGui?.authorContainsTurn === true
      && results.stages.narrativeGui?.directorContainsTurn === true,
    results.stages.narrativeGui || {});
  const transitionBefore = transitionStage.before || {};
  const transitionInherited = transitionStage.afterTransition || {};
  const transitionContinued = transitionStage.afterContinuation || {};
  const memoryIdentity = item => String(item?.canonicalMemoryId || `${item?.source || ''}|${item?.sourceHash || ''}|${item?.summaryHash || ''}`);
  const transitionInheritedMemoryIds = new Set((transitionInherited.memoryInventory || []).map(memoryIdentity).filter(Boolean));
  const missingInheritedMemoryIds = Array.from(new Set((transitionBefore.memoryInventory || []).map(memoryIdentity).filter(Boolean)))
    .filter(id => !transitionInheritedMemoryIds.has(id));
  assertCheck('transition_creates_new_chat_and_inherits_all_domain_dbs',
    transitionStage.success === true
      && transitionStage.beforeChatId !== transitionStage.afterChatId
      && transitionStage.afterChatCount === transitionStage.beforeChatCount + 1
      && missingInheritedMemoryIds.length === 0
      && (transitionInherited.memoryInventory || []).some(item => item?.source === 'transition_scene_context')
      && transitionInherited.entities === transitionBefore.entities
      && transitionInherited.relations === transitionBefore.relations
      && transitionInherited.narrativeStorylines === transitionBefore.narrativeStorylines
      && transitionInherited.narrativeTurnLog === transitionBefore.narrativeTurnLog
      && transitionInherited.worldStateTurnLog === transitionBefore.worldStateTurnLog
      && transitionInherited.worldStateLastTurn === transitionBefore.worldStateLastTurn
      && transitionInherited.storyAuthor?.currentArc === transitionBefore.storyAuthor?.currentArc
      && transitionInherited.storyAuthor?.lastTurn === transitionBefore.storyAuthor?.lastTurn
      && transitionInherited.director?.sceneMandate === transitionBefore.director?.sceneMandate
      && transitionInherited.director?.lastTurn === transitionBefore.director?.lastTurn
      && transitionInherited.worldAdditional?.totalDirectives === transitionBefore.worldAdditional?.totalDirectives
      && transitionInherited.worldGraph?.nodeCount === transitionBefore.worldGraph?.nodeCount
      && transitionInherited.worldGraph?.ruleFactCount === transitionBefore.worldGraph?.ruleFactCount,
    { ...transitionStage, missingInheritedMemoryIds });
  assertCheck('transition_destination_chat_starts_empty',
    transitionStage.destinationBeforeUser?.messageCount === 0,
    { messageCount: transitionStage.destinationBeforeUser?.messageCount });
  assertCheck('transition_destination_admits_owned_canon',
    transitionStage.destinationAdmission?.ok === true && transitionStage.destinationRejectedEntries?.length === 0,
    { admission: transitionStage.destinationAdmission, rejected: transitionStage.destinationRejectedEntries });
  assertCheck('transition_destination_continues_accumulating',
    transitionStage.continuationDrain?.settled === true
      && Number(transitionContinued.currentTurn || 0) > Number(transitionInherited.currentTurn || 0)
      && Number(transitionContinued.memoryTurnMax || 0) > Number(transitionInherited.memoryTurnMax || 0)
      && Number(transitionContinued.storyAuthor?.lastTurn || 0) > Number(transitionInherited.storyAuthor?.lastTurn || 0)
      && Number(transitionContinued.director?.lastTurn || 0) > Number(transitionInherited.director?.lastTurn || 0)
      && Number(transitionContinued.worldAdditional?.lastTurn || 0) > Number(transitionInherited.worldAdditional?.lastTurn || 0)
      && Number(transitionContinued.narrativeTurnLog || 0) > Number(transitionInherited.narrativeTurnLog || 0)
      && Number(transitionContinued.worldStateLastTurn || 0) > Number(transitionInherited.worldStateLastTurn || 0)
      && transitionContinued.worldAdditional?.chatId === transitionStage.afterChatId,
    transitionStage);
  assertCheck('narrative_gui_survives_transition_and_refresh',
    results.stages.narrativeGuiAfterTransition?.available === true
      && !results.stages.narrativeGuiAfterTransition?.error
      && results.stages.narrativeGuiAfterTransition?.authorContainsState === true
      && results.stages.narrativeGuiAfterTransition?.directorContainsState === true,
    results.stages.narrativeGuiAfterTransition || {});
  appendAxisIntegrityAssertions(assertCheck, finalLore, TURN_COUNT);
  assertCheck('latency_no_turn_freeze_gt_5s', Math.max(...turnDurations) < 5000, { maxMs: Math.round(Math.max(...turnDurations)), p95Ms: Math.round(p95(turnDurations)) });
  const maxTransientHeap = Math.max(...samples.map(s => s.preGcHeapUsedMB ?? s.heapUsedMB));
  const heapGrowth = samples[samples.length - 1].heapUsedMB - samples[0].heapUsedMB;
  assertCheck('transient_heap_bounded', maxTransientHeap < TRANSIENT_HEAP_LIMIT_MB, { maxTransientHeapMB: maxTransientHeap, limitMB: TRANSIENT_HEAP_LIMIT_MB });
  assertCheck('settled_heap_growth_bounded', !heapGrowthAssertable() || heapGrowth < SETTLED_HEAP_GROWTH_LIMIT_MB, { settledGrowthMB: Math.round(heapGrowth * 100) / 100, limitMB: SETTLED_HEAP_GROWTH_LIMIT_MB, gcAvailable: heapGrowthAssertable(), skipped: heapGrowthAssertable() ? '' : heapGrowthSkipNote });
  results.assertions = assertions;
  results.ok = errors.length === 0 && assertions.every(item => item.ok);
  results.finalLore = finalLore;
  results.samples = samples;
  results.errors = errors;
  results.logs = logs.slice(-200);

  try {
    for (const fn of unloadHandlers) await fn();
  } catch (e) {
    errors.push({ stage: 'unload', message: e?.message || String(e) });
  }

  fs.writeFileSync(LOG_PATH, JSON.stringify(results, null, 2), 'utf8');
  // 캡처/재생 산출물 — 실행 종료 시점에 남긴다. 캡처는 **나간 프롬프트 전부**를, 재생은 서빙 통계를 남긴다.
  if (CAPTURE_DIR && captureRecords.length) {
    const capturePath = path.join(CAPTURE_DIR, 'captured_prompts.jsonl');
    fs.writeFileSync(capturePath, captureRecords.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const byLabel = new Map();
    for (const record of captureRecords) {
      const entry = byLabel.get(record.label) || { label: record.label, reason: record.reason, count: 0, systemChars: [], userChars: [] };
      entry.count += 1;
      entry.systemChars.push(record.systemChars);
      entry.userChars.push(record.userChars);
      byLabel.set(record.label, entry);
    }
    const summary = {
      capturedAt: nowIso(),
      runId: RUN_ID,
      distSha256: crypto.createHash('sha256').update(fs.readFileSync(DIST)).digest('hex'),
      distBytes: fs.statSync(DIST).size,
      turns: TURN_COUNT,
      totalRequests: captureRecords.length,
      uniqueRequests: captureIndex.size,
      labels: Array.from(byLabel.values()).map(entry => ({
        label: entry.label,
        reason: entry.reason,
        count: entry.count,
        systemChars: { min: Math.min(...entry.systemChars), max: Math.max(...entry.systemChars) },
        userChars: { min: Math.min(...entry.userChars), max: Math.max(...entry.userChars) }
      }))
    };
    fs.writeFileSync(path.join(CAPTURE_DIR, 'capture_summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    results.capture = { dir: CAPTURE_DIR, file: capturePath, totalRequests: captureRecords.length, uniqueRequests: captureIndex.size };
  }
  if (REPLAY_FILE && globalThis.__LIBRA_REPLAY_STATS__) {
    results.replay = { file: REPLAY_FILE, ...globalThis.__LIBRA_REPLAY_STATS__.get() };
  }
  finalExitCode = results.ok ? 0 : 1;
  console.log(JSON.stringify({ ok: results.ok, logPath: LOG_PATH, assertions: assertions.filter(a => !a.ok).length ? assertions : assertions.filter(a => a.ok).slice(0, 3), finalLore, stages: { live97: results.stages.live97, coldStart: results.stages.coldStart, reanalysis: results.stages.reanalysis, recall: results.stages.recall }, samples }, null, 2));
}

main().then(() => {
  if (String(process.env.LIBRA_KEEP_ALIVE || '') !== '1') process.exit(finalExitCode);
}).catch(err => {
  const fail = { ok: false, error: err?.message || String(err), stack: err?.stack || '', logPath: LOG_PATH };
  try { fs.writeFileSync(LOG_PATH, JSON.stringify(fail, null, 2), 'utf8'); } catch (_) {}
  console.error(JSON.stringify(fail, null, 2));
  process.exitCode = 1;
  if (String(process.env.LIBRA_KEEP_ALIVE || '') !== '1') process.exit(1);
});
