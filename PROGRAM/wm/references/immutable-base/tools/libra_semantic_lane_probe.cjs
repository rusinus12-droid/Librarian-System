'use strict';
// Phase 1 — 독립 의미 검색 엔진 프로토타입 (제품 리콜에 연결하지 않는다).
//
// 목적: 어휘 게이트를 통과하지 못한 기억을 **임베딩이 직접 찾아낼 수 있는가**를
//       실모델(qwen3-embedding:8b)로 측정한다. 주입은 하지 않는다.
//
// 측정 대상 3개 (같은 corpus · 같은 질의):
//   ① heuristic  : 현행 제품 경로 (ME.retrieveMemories) — 그대로
//   ② semantic   : 전체 유효 기억 × 질의 벡터 cosine top-N — 어휘 게이트 없음
//   ③ union      : ① ∪ ②  (점수 혼합 없이 후보만 합침)
//
// 저장 시점 벡터화를 **시뮬레이션**한다: corpus 의 각 기억을 미리 임베딩해 두고
// 질의 시점에는 질의 벡터 1개만 만든다 (계획 §17).
//
// 안전: 두 lane 모두 filterRecallEligibleEntries 를 통과한 기억만 본다 (계획 §4.3).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { load } = require('./libra_recall_test_runtime.cjs');
const fixture = require('./fixtures/multilingual-recall.cjs');

const ROOT = path.resolve(__dirname, '..');
const DIST = process.env.LIBRA_RECALL_TEST_DIST || path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const CACHE_FILE = process.env.LIBRA_SEMANTIC_CACHE
  || path.join(process.env.LOCALAPPDATA || ROOT, 'Temp', 'libra-semantic-lane-embeddings.json');

const EMBED = {
  provider: 'ollama',
  url: process.env.LIBRA_EMBED_URL || 'http://127.0.0.1:11434',
  model: process.env.LIBRA_EMBED_MODEL || 'qwen3-embedding:8b'
};

const clone = x => JSON.parse(JSON.stringify(x));
const ids = rows => Array.from(rows || [], x => String((x && x.entry ? x.entry : x).key));
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

function replaceOnce(code, from, to) {
  if (code.split(from).length !== 2) throw new Error('hook boundary missing or ambiguous: ' + from.slice(0, 95));
  return code.replace(from, to);
}

// 제품 소스에 테스트 경계만 주입한다. 임베딩/네트워크를 막지 않는다(실모델 실측).
function transform(source, mode = 'probe', gateThreshold = null) {
  let code = source;
  code = replaceOnce(code,
    '            inspectRecallEligibility,',
    '            __semantic:{buildHybridScopeIndexFromEntries,cacheHybridScopeIndex,EmbeddingEngine},\n            inspectRecallEligibility,');
  if (gateThreshold !== null && gateThreshold !== undefined) {
    // ★ 계획서 §12 실험: 의미 단독 증거를 relevanceGate 에 추가한다.
    //   임계값은 하드코딩하지 않는다 — 인자로 받아 스윕하고 오검색 증가분과 함께 보고한다.
    //   문턱은 **런타임 전역**에서 읽는다 — VM 재로딩 없이 한 번에 스윕하기 위함이다.
    code = replaceOnce(code,
      'const semanticEvidence = !!(detail?.semanticAliasBridge || (detail?.semanticGate && Number(detail?.semanticEntityOverlap || 0) >= 1));',
      'const semanticIndependentEvidence = !!globalThis.__semanticGateEnabled && !!globalThis.__semanticGate && (Number(globalThis.__semanticGate.cos || 0) >= Number(globalThis.__semanticGateThreshold ?? 1.1));\n' +
      '            const semanticEvidence = !!(semanticIndependentEvidence || detail?.semanticAliasBridge || (detail?.semanticGate && Number(detail?.semanticEntityOverlap || 0) >= 1));');
    code = replaceOnce(code,
      'const relevanceGate = !!(sparseGate || weakSparseGate || directEvidence || semanticEvidence || intentAligned || graphStrongEvidence);',
      'const relevanceGate = !!(sparseGate || weakSparseGate || directEvidence || semanticEvidence || semanticIndependentEvidence || intentAligned || graphStrongEvidence);');
    // 스코어링 직전에 현재 후보의 의미 코사인을 노출한다(text 로 매칭 — entry 신원이 스코어러에 오지 않는다).
    code = replaceOnce(code,
      'const scoringV2 = scoreRecallItemV2({',
      'if (globalThis.__semanticGateEnabled) { try { const _t = String(text || \'\'); globalThis.__semanticGate = { cos: (globalThis.__semanticCosMap && globalThis.__semanticCosMap[_t]) || 0 }; } catch (_) { globalThis.__semanticGate = { cos: 0 }; } }\n' +
      '                    const scoringV2 = scoreRecallItemV2({');
  }
  if (mode === 'shadow') {
    // ★ Phase 2 shadow: 의미 후보를 안전 필터 **직후**에 주입한다.
    //   색인 사전선별·하이브리드 숏리스트를 우회하되, 이후의 스코어링·MMR·주입 예산은 **그대로** 태운다.
    code = replaceOnce(code,
      'let belowThresholdCount = 0;',
      'if (globalThis.__semanticShadow && typeof globalThis.__semanticShadow.inject === \'function\') {\n' +
      '                    try { filtered = globalThis.__semanticShadow.inject(filtered); } catch (e) { globalThis.__semanticShadow.error = String(e && e.message || e); }\n' +
      '                }\n                let belowThresholdCount = 0;');
    // 스코어링 결과를 관찰한다 (왜 주입된 의미 후보가 탈락하는가)
    code = replaceOnce(code,
      'const accepted = scoredResults.filter(item => item && item.accepted)',
      'if (globalThis.__semanticShadow && typeof globalThis.__semanticShadow.scored === \'function\') { try { globalThis.__semanticShadow.scored(scoredResults); } catch (e) { globalThis.__semanticShadow.scoredError = String(e && e.message || e); } }\n                const accepted = scoredResults.filter(item => item && item.accepted)');
  }
  return code;
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function metric(ordered, relevant, k) {
  const rows = ordered.slice(0, k);
  const rank = rows.findIndex(x => relevant.includes(x));
  const dcg = rows.reduce((s, x, i) => s + (relevant.includes(x) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(k, relevant.length) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return {
    recall: relevant.length ? new Set(rows.filter(x => relevant.includes(x))).size / relevant.length : null,
    mrr: relevant.length ? (rank < 0 ? 0 : 1 / (rank + 1)) : null,
    ndcg: ideal ? dcg / ideal : 0,
    inappropriate: rows.filter(x => !relevant.includes(x)).length
  };
}

const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// ── 임베딩 클라이언트: 파일 캐시 + 실패 시 null (fail-open) ──
function makeEmbedClient(getEmbedding, stats) {
  let cache = new Map();
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.model === EMBED.model && parsed.dim > 0 && parsed.vectors) {
      cache = new Map(Object.entries(parsed.vectors));
      stats.cacheLoaded = cache.size;
    }
  } catch (_) {}
  const persist = () => {
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify({
        model: EMBED.model, dim: stats.dim, updatedAt: new Date().toISOString(),
        vectors: Object.fromEntries(cache)
      }));
    } catch (_) {}
  };
  return {
    async embed(text) {
      const key = sha256(String(text || ''));
      if (cache.has(key)) { stats.cacheHits += 1; return cache.get(key); }
      stats.providerCalls += 1;
      let vec = null;
      try { vec = await getEmbedding(String(text || ''), { source: 'semantic_lane_probe' }); } catch (e) {
        stats.errors.push(String(e && e.message || e).slice(0, 160)); return null;
      }
      if (Array.isArray(vec) && vec.length) { stats.dim = vec.length; cache.set(key, vec); stats.created += 1; }
      else stats.empty += 1;
      return Array.isArray(vec) && vec.length ? vec : null;
    },
    persist
  };
}

async function run(options = {}) {
  // ★ 실패 대조군: 벡터↔기억 대응을 결정적으로 섞는다.
  //   질의 벡터는 그대로 두므로, 의미 lane 의 성능이 벡터에서 나온다면 chance 로 붕괴해야 한다.
  //   붕괴하지 않으면 우리가 '의미'를 재고 있지 않다는 뜻이다(측정기 무효).
  const shuffleVectors = options.shuffle === true || process.env.LIBRA_SEMANTIC_SHUFFLE === '1';
  const topN = Math.max(1, Number(options.topN || 16));
  const topK = Math.max(1, Number(options.topK || 4));
  const languages = options.languages || fixture.languages;

  const raw = fs.readFileSync(DIST, 'utf8');
  const distSha256 = crypto.createHash('sha256').update(raw).digest('hex');

  const stats = { providerCalls: 0, cacheHits: 0, cacheLoaded: 0, created: 0, empty: 0, errors: [], dim: 0 };

  const shadow = options.shadow === true;
  let shadowSink = null;
  const runtime = await load({
    transformCode: (code) => transform(code, shadow ? 'shadow' : 'probe'),
    globals: {
      // 실모델 실측: 네트워크를 막지 않는다. 루프백만 사용한다(스킬 규칙 6).
      fetch: (...a) => globalThis.fetch(...a)
    }
  });
  // 제품의 provider 호출은 RisuCompat.request → host('nativeFetch') 를 먼저 탄다.
  // 런타임 스텁이 throw 하므로 **루프백 전용** 실제 fetch 로 바인딩한다.
  // 외부 호스트는 허용하지 않는다 — 127.0.0.1/localhost 이외는 거부한다.
  const loopbackFetch = async (url, init) => {
    const u = String(url || '');
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(u)) {
      throw new Error('SEMANTIC_PROBE_NON_LOOPBACK_BLOCKED: ' + u.slice(0, 120));
    }
    return globalThis.fetch(u, init);
  };
  runtime.context.risuai.nativeFetch = loopbackFetch;
  runtime.context.fetch = loopbackFetch;
  const api = runtime.api;
  const ME = api.MemoryEngine;
  const CMC = api.CompactMemoryCodec;
  const H = ME.__semantic;
  const S = api.MemoryEngine;

  ME.CONFIG.debug = true;
  ME.CONFIG.coldArchiveHydrationEnabled = false;
  ME.CONFIG.hmeAssociativeGraphMode = 'light';
  ME.CONFIG.embed = Object.assign({}, ME.CONFIG.embed, {
    enabled: true, provider: EMBED.provider, url: EMBED.url, key: '', model: EMBED.model, timeout: 120000
  });
  ME.setTurn(40);

  const emb = makeEmbedClient(H.EmbeddingEngine.getEmbedding, stats);

  // ── 워밍업 겸 preflight: 실제 모델이 응답하는지 먼저 확인한다 ──
  const warm = await emb.embed('preflight');
  const preflight = { ok: !!warm, dim: warm ? warm.length : 0 };
  if (!preflight.ok) {
    return {
      schema: 'libra.semantic_lane.probe.v1', distSha256, embedding: EMBED, preflight,
      fatal: 'embedding_preflight_failed', stats,
      note: '실모델 임베딩이 응답하지 않아 측정을 중단했다. mock 으로 대체하지 않는다.'
    };
  }

  const rows = [];
  const queryList = [...fixture.queries(), ...fixture.domainControls()];

  for (const q of queryList) {
    const scope = 'semantic-probe-' + q.id;
    const corpus = fixture.corpus(q.memoryLanguage);
    const forbidden = ['deleted', 'expired'];

    let worldlineState;
    if (q.reroll) {
      const pair = t => ({ pairIndex: t, userText: 'u' + t, assistantText: 'a' + t });
      await api.LibraTurnWorldline.observe(scope, [pair(1), pair(2)], { now: 1000 });
      const old = api.LibraTurnWorldline.get(scope).nodes.find(n => n.pairIndex === 2 && n.assistantHash);
      await api.LibraTurnWorldline.observe(scope, [pair(1), Object.assign({}, pair(2), { assistantText: 'rerolled' })], { now: 2000 });
      worldlineState = api.LibraTurnWorldline.get(scope);
      corpus.push(fixture.make('old-variant', fixture.text[q.memoryLanguage].origin, { imp: 10, vh: old.assistantHash }));
      forbidden.push('old-variant');
    }
    const signed = await ME.prepareMemory(
      { content: fixture.text[q.memoryLanguage].origin, importance: 10 }, 2, [], [], null,
      { id: 'foreign-chat' }, 'semantic-probe-source', { scopeKey: 'foreign-scope', sourceHash: 'semantic-probe-source' });
    signed.key = 'foreign-signed';
    corpus.push(signed);
    forbidden.push(signed.key);

    const rotation = crypto.createHash('sha256').update(q.id).digest()[0] % corpus.length;
    corpus.push(...corpus.splice(0, rotation));

    const eligibility = { currentTurn: 40, scopeKey: scope, worldlineState };
    const eligible = ME.filterRecallEligibleEntries(corpus, eligibility).entries;
    const memories = eligible.filter(e => String(e.comment || '').trim() === 'lmai_memory');

    api.MemoryState._activeScopeKey = scope;
    H.cacheHybridScopeIndex(H.buildHybridScopeIndexFromEntries(eligible, { scopeKey: scope, currentTurn: 40 }), scope);

    // ── ② 독립 의미 lane (어휘 게이트 없음) — shadow 주입을 위해 **먼저** 계산한다 ──
    const t1 = performance.now();
    const memVectors = [];
    for (const entry of memories) {
      // 저장 시점 벡터화 시뮬레이션: Compact Memory 의 검색 표현 1개 = 1 검색 단위(§7.2)
      const text = CMC.buildRecallScoringTextFromEntry(entry, ME.CONFIG.recallScoringTextMaxChars || 800)
        || CMC.buildSearchTextFromEntry(entry);
      const vec = await emb.embed(text);
      memVectors.push({ key: String(entry.key || ''), vec, chars: String(text || '').length });
    }
    if (shuffleVectors) {
      // 결정적 Fisher-Yates (질의 ID seed) — 재현 가능
      const perm = memVectors.map((_, i) => i);
      let seed = parseInt(sha256(q.id).slice(0, 8), 16) || 1;
      const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
      const vecs = memVectors.map(m => m.vec);
      memVectors.forEach((m, i) => { m.vec = vecs[perm[i]]; });
    }
    const queryVec = await emb.embed(q.query);
    const semanticMs = performance.now() - t1;
    const semanticRanked = queryVec
      ? memVectors.filter(m => m.vec).map(m => ({ key: m.key, cos: cosine(queryVec, m.vec) }))
        .sort((a, b) => b.cos - a.cos)
      : [];
    const semanticIds = semanticRanked.map(x => x.key);

    // ── Phase 2 shadow: 의미 후보를 주입한다 (색인 선별·숏리스트 우회, 이후 계층은 그대로) ──
    const entryByKey = new Map(memories.map(e => [String(e.key || ''), e]));
    let injectedKeys = [];
    let shadowPoolKeys = [];
    let shadowScoredGold = null;
    if (shadow) {
      const topSet = semanticIds.slice(0, topN);
      runtime.context.__semanticShadow = {
        error: '',
        scoredError: '',
        scored: (rows) => {
          const g = (q.relevant || []).find(k => (rows || []).some(x => String(x.entry?.key || '') === k));
          if (!g) { shadowScoredGold = { present: false }; return; }
          const r = rows.find(x => String(x.entry?.key || '') === g);
          shadowScoredGold = {
            present: true, key: g, accepted: !!r.accepted, reason: String(r.rejectReason || ''),
            score: Number(r.finalScore || 0),
            gate: { relevance: !!r.scoringV2?.relevanceGate, sparse: !!r.scoringV2?.sparseGate, sem: !!r.scoringV2?.semanticEvidence, direct: !!r.scoringV2?.directEvidence, intent: !!r.scoringV2?.intentAligned },
            sparse: Number(r.detail?.sparseScore || 0), sim: Number(r.detail?.similarity || 0)
          };
        },
        inject: (filtered = []) => {
          const have = new Set(filtered.map(e => String(e.key || '')));
          const add = [];
          for (const k of topSet) {
            if (have.has(k)) continue;
            const e = entryByKey.get(k);
            if (e) { add.push(e); have.add(k); }
          }
          shadowPoolKeys = filtered.map(e => String(e.key || ''));
          injectedKeys = add.map(e => String(e.key || ''));
          return filtered.concat(add);
        }
      };
    }

    // ── ① 현행 휴리스틱 경로 (제품 그대로, shadow 면 위에서 주입된 상태로 스코어링) ──
    const t0 = performance.now();
    const heuristic = await ME.retrieveMemories(
      q.query, 40, corpus,
      { embeddingAllowed: false, scopeKey: scope, worldlineState, effectiveLorebook: corpus, focusNames: q.focusNames || [] },
      topK);
    const heuristicMs = performance.now() - t0;
    const heuristicIds = ids(heuristic);
    const shadowError = shadow ? String(runtime.context.__semanticShadow?.error || '') : '';
    const semanticCosine = Object.fromEntries(semanticRanked.slice(0, topN).map(x => [x.key, Number(x.cos.toFixed(4))]));
    const goldCos = q.relevant.length
      ? Object.fromEntries(q.relevant.map(id => {
        const hit = semanticRanked.find(x => x.key === id);
        return [id, hit ? { cos: Number(hit.cos.toFixed(4)), rank: semanticRanked.indexOf(hit) + 1 } : null];
      }))
      : {};

    // ── ③ union (점수 혼합 없음 — 후보만 합침) ──
    //   ③a 단순 연결: 휴리스틱 순서를 앞에 두고 slice → 휴리스틱 결과가 그대로 남는다(실측 확인).
    //   ③b RRF 순위 융합: 점수 스케일이 다른 두 엔진을 rank 로만 합성한다(계획 §11).
    const RRF_K = Number(options.rrfK || 60);
    const unionConcat = [...heuristicIds];
    for (const id of semanticIds.slice(0, topN)) if (!unionConcat.includes(id)) unionConcat.push(id);
    const rrfOf = (id) => {
      const hi = heuristicIds.indexOf(id);
      const si = semanticIds.indexOf(id);
      return (hi >= 0 ? 1 / (RRF_K + hi + 1) : 0) + (si >= 0 ? 1 / (RRF_K + si + 1) : 0);
    };
    const unionRrf = Array.from(new Set([...heuristicIds, ...semanticIds.slice(0, topN)]))
      .sort((a, b) => rrfOf(b) - rrfOf(a));
    const unionOrder = unionRrf;

    const heuristicCandidates = ids(
      (function () { try { return ME.getLastRetrievalDebug()?.candidates || []; } catch (_) { return []; } })());
    const debug = ME.getLastRetrievalDebug() || {};

    rows.push({
      id: q.id,
      memoryLanguage: q.memoryLanguage,
      queryLanguage: q.queryLanguage,
      category: q.category,
      supplementary: !!q.supplementary,
      query: q.query,
      relevant: q.relevant || [],
      forbidden,
      // ①
      heuristicTop: heuristicIds,
      heuristicMetrics: metric(heuristicIds, q.relevant || [], topK),
      // ②
      semanticTop: semanticIds.slice(0, topN),
      semanticFull: semanticIds,          // ★ 전체 순위 — 융합 스윕이 잘린 목록으로 오판하지 않게
      semanticCosineFull: Object.fromEntries(semanticRanked.map(x => [x.key, Number(x.cos.toFixed(5))])),
      heuristicFull: heuristicIds,
      semanticRank: Object.fromEntries(semanticRanked.slice(0, topN).map((x, i) => [x.key, i + 1])),
      semanticCosine,
      goldCosine: goldCos,
      semanticTopNMetrics: metric(semanticIds, q.relevant || [], topN),
      semanticTopKMetrics: metric(semanticIds, q.relevant || [], topK),
      // ③ union — 단순 연결 vs RRF (둘 다 기록해 차이를 남긴다)
      unionConcatTopK: unionConcat.slice(0, topK),
      unionConcatMetrics: metric(unionConcat, q.relevant || [], topK),
      unionTopK: unionRrf.slice(0, topK),
      unionMetrics: metric(unionRrf, q.relevant || [], topK),
      rrfRank: Object.fromEntries(unionRrf.slice(0, topN).map((x, i) => [x, i + 1])),
      // 안전
      semanticSafety: {
        eligibleOnly: true,
        sourceMemories: memories.length,
        returnedForbidden: unionRrf.slice(0, topK).filter(id => forbidden.includes(id)),
        embeddedForbidden: memVectors.filter(m => forbidden.includes(m.key)).length
      },
      embeddedMemoryCount: memVectors.filter(m => m.vec).length,
      shadowInjected: injectedKeys,
      shadowInjectionCount: injectedKeys.length,
      shadowError,
      shadowGoldInjected: (q.relevant || []).filter(k => injectedKeys.includes(k)),
      shadowGoldInPool: shadow ? (q.relevant || []).filter(k => shadowPoolKeys.includes(k)) : [],
      shadowGoldScored: shadowScoredGold,
      shadowScoredError: shadow ? String(runtime.context.__semanticShadow?.scoredError || '') : '',
      latency: { heuristicMs: Number(heuristicMs.toFixed(1)), semanticMs: Number(semanticMs.toFixed(1)) },
      pipeline: {
        scopeIndex: debug.hybridMemoryEngine?.scopeIndex,
        preShortlist: debug.hybridMemoryEngine?.preShortlistCount,
        graph: debug.hmeAssociativeGraph
      }
    });
  }
  emb.persist();

  const main = rows.filter(r => !r.supplementary);
  const controls = rows.filter(r => r.supplementary);
  const agg = (rs) => ({
    queries: rs.length,
    heuristicRecallAtK: mean(rs.map(r => r.heuristicMetrics.recall).filter(v => v !== null)),
    heuristicMrrAtK: mean(rs.map(r => r.heuristicMetrics.mrr).filter(v => v !== null)),
    semanticRecallAtK: mean(rs.map(r => r.semanticTopKMetrics.recall).filter(v => v !== null)),
    semanticMrrAtK: mean(rs.map(r => r.semanticTopKMetrics.mrr).filter(v => v !== null)),
    unionConcatRecallAtK: mean(rs.map(r => r.unionConcatMetrics.recall).filter(v => v !== null)),
    unionConcatCaught: rs.filter(r => r.relevant.length && r.heuristicMetrics.recall === 0 && r.unionConcatMetrics.recall > 0).length,
    unionRecallAtK: mean(rs.map(r => r.unionMetrics.recall).filter(v => v !== null)),
    unionMrrAtK: mean(rs.map(r => r.unionMetrics.mrr).filter(v => v !== null)),
    unionInappropriate: rs.reduce((n, r) => n + r.unionMetrics.inappropriate, 0),
    heuristicMisses: rs.filter(r => r.relevant.length && r.heuristicMetrics.recall === 0).length,
    semanticCaught: rs.filter(r => r.relevant.length && r.heuristicMetrics.recall === 0 && r.semanticTopKMetrics.recall > 0).length,
    unionCaught: rs.filter(r => r.relevant.length && r.heuristicMetrics.recall === 0 && r.unionMetrics.recall > 0).length,
    unionLost: rs.filter(r => r.relevant.length && r.heuristicMetrics.recall > 0 && r.unionMetrics.recall === 0).length,
    safetyViolations: rs.reduce((n, r) => n + r.semanticSafety.returnedForbidden.length, 0)
  });
  const byCategory = Object.fromEntries(
    [...new Set(main.map(r => r.category))].map(c => [c, agg(main.filter(r => r.category === c))]));

  return {
    schema: 'libra.semantic_lane.probe.v1',
    createdAt: new Date().toISOString(),
    distSha256,
    embedding: EMBED,
    preflight,
    config: { topN, topK, languages, shuffleVectors },
    stats,
    summary: agg(main),
    supplementary: { queries: controls.length, ...agg(controls) },
    byCategory,
    limitations: [
      'Phase 1 프로토타입 — 제품 리콜 경로에 연결하지 않았다. 주입 결과가 아니라 후보 발굴만 측정한다.',
      '저장 시점 벡터화를 시뮬레이션했다(측정 중 생성 + 파일 캐시). 제품 저장 경로는 아직 바뀌지 않았다.',
      '합성 fixture 이며 실모델 언어 성능 등급이 아니다. 교차언어 결과를 제품 개선폭으로 승격하지 않는다.',
      '실패 대조군 없이는 "개선"이 아니라 "후보 커버리지 변화"로만 읽는다.'
    ],
    rows
  };
}

module.exports = { run, transform, metric, cosine };

if (require.main === module) {
  run({ topN: Number(process.env.LIBRA_SEMANTIC_TOPN || 16), topK: 4 })
    .then(report => {
      const file = process.argv[2] || path.join(ROOT, 'test-output', 'semantic-lane-phase1.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({
        distSha256: report.distSha256,
        preflight: report.preflight,
        stats: { providerCalls: report.stats.providerCalls, cacheHits: report.stats.cacheHits, dim: report.stats.dim, errors: report.stats.errors.slice(0, 3) },
        summary: report.summary,
        byCategory: Object.fromEntries(Object.entries(report.byCategory).map(([k, v]) => [k, {
          n: v.queries, heur: v.heuristicRecallAtK, sem: v.semanticRecallAtK, union: v.unionRecallAtK, caught: v.unionCaught
        }])),
        report: file
      }, null, 2));
    })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
