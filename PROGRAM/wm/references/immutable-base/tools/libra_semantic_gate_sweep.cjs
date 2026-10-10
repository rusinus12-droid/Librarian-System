'use strict';
// Phase 3 — 계획서 §12 실험: 의미 단독 증거(semanticIndependentEvidence)를 relevanceGate 에 넣으면
//             교차언어가 살아나는가, 그리고 **무관 후보가 얼마나 늘어나는가**를 함께 잰다.
//
// 임계값은 하드코딩하지 않는다 — 스윕하고, 오검색 증가분(대조군)과 같이 보고한다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { load } = require('./libra_recall_test_runtime.cjs');
const fixture = require('./fixtures/multilingual-recall.cjs');
const probe = require('./libra_semantic_lane_probe.cjs');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const cos = (a, b) => { if (!a || !b || a.length !== b.length) return 0; let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return (na && nb) ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0; };

(async () => {
  const RANDOM_CONTROL = process.env.LIBRA_GATE_RANDOM === '1';
  const THRESHOLDS = String(process.env.LIBRA_GATE_SWEEP || (RANDOM_CONTROL ? '0.45,0.55' : '0.35,0.40,0.45,0.50,0.55,0.60')).split(',').map(Number);
  const topN = 16, topK = 4;

  const runtime = await load({ transformCode: c => probe.transform(c, 'shadow', 'RUNTIME') });
  const loop = (u, i) => {
    const s = String(u);
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(s)) throw new Error('BLOCKED ' + s.slice(0, 60));
    return globalThis.fetch(s, i);
  };
  runtime.context.risuai.nativeFetch = loop;
  runtime.context.fetch = loop;

  const api = runtime.api, ME = api.MemoryEngine, CMC = api.CompactMemoryCodec, H = ME.__semantic;
  ME.CONFIG.debug = true;
  ME.CONFIG.coldArchiveHydrationEnabled = false;
  ME.CONFIG.hmeAssociativeGraphMode = 'light';
  ME.CONFIG.embed = Object.assign({}, ME.CONFIG.embed, { enabled: true, provider: 'ollama', url: 'http://127.0.0.1:11434', key: '', model: 'qwen3-embedding:8b', timeout: 120000 });
  ME.setTurn(40);

  const queryList = [...fixture.queries(), ...fixture.domainControls()];
  const perQuery = [];   // 질의별 사전계산(코사인 맵) — 문턱은 여기서 바꿔 끼운다
  const embCache = new Map();
  const embed = async (t) => {
    const k = crypto.createHash('sha256').update(String(t || '')).digest('hex');
    if (embCache.has(k)) return embCache.get(k);
    const v = await H.EmbeddingEngine.getEmbedding(String(t || ''), { source: 'gate_sweep' });
    embCache.set(k, v); return v;
  };

  // ── 1) 질의별 재료 수집 ──
  for (const q of queryList) {
    const scope = 'gate-sweep-' + q.id;
    const corpus = fixture.corpus(q.memoryLanguage);
    let worldlineState;
    if (q.reroll) {
      const pair = t => ({ pairIndex: t, userText: 'u' + t, assistantText: 'a' + t });
      await api.LibraTurnWorldline.observe(scope, [pair(1), pair(2)], { now: 1000 });
      const old = api.LibraTurnWorldline.get(scope).nodes.find(n => n.pairIndex === 2 && n.assistantHash);
      await api.LibraTurnWorldline.observe(scope, [pair(1), Object.assign({}, pair(2), { assistantText: 'rerolled' })], { now: 2000 });
      worldlineState = api.LibraTurnWorldline.get(scope);
      corpus.push(fixture.make('old-variant', fixture.text[q.memoryLanguage].origin, { imp: 10, vh: old.assistantHash }));
    }
    const eligible = ME.filterRecallEligibleEntries(corpus, { currentTurn: 40, scopeKey: scope, worldlineState }).entries;
    const memories = eligible.filter(e => String(e.comment || '').trim() === 'lmai_memory');
    api.MemoryState._activeScopeKey = scope;
    H.cacheHybridScopeIndex(H.buildHybridScopeIndexFromEntries(eligible, { scopeKey: scope, currentTurn: 40 }), scope);

    const cosMap = {};
    for (const e of memories) {
      const t = CMC.buildRecallScoringTextFromEntry(e, 800) || CMC.buildSearchTextFromEntry(e);
      const v = await embed(t);
      cosMap[String(t)] = v ? cos(await embed(q.query), v) : 0;
    }
    const ranked = Object.entries(cosMap).sort((a, b) => b[1] - a[1]).map(([t, c]) => ({ t, c }));
    perQuery.push({ q, scope, corpus, worldlineState, memories, cosMap, ranked });
  }
  console.log('[sweep] 재료 수집 완료 — 질의', perQuery.length, '| 임베딩', embCache.size, '건');
  fs.writeFileSync(path.join(ROOT, 'test-output', 'phase3-baseline-cos.json'), JSON.stringify(
    perQuery.map(p => ({ id: p.q.id, category: p.q.category, relevant: p.q.relevant, top5: p.ranked.slice(0, 5).map(r => ({ cos: Number(r.c.toFixed(4)), key: null })), cosValues: p.ranked.slice(0, 20).map(r => Number(r.c.toFixed(4))) })), null, 2));

  // ── 2) 문턱별 측정 ──
  const results = [];
  const textOf = new Map();  // 정답 키 → 검색 텍스트 (gold cos 판정용)
  for (const p of perQuery) {
    for (const e of p.memories) {
      const t = CMC.buildRecallScoringTextFromEntry(e, 800) || CMC.buildSearchTextFromEntry(e);
      textOf.set(p.q.id + '|' + String(e.key || ''), String(t));
    }
  }

  for (const th of [null, ...THRESHOLDS]) {   // null = 기준선(패치 off)
    runtime.context.__semanticGateEnabled = th !== null;
    runtime.context.__semanticGateThreshold = th === null ? 1.1 : th;
    const rows = [];
    for (const p of perQuery) {
      runtime.context.__semanticCosMap = p.cosMap;
      if (RANDOM_CONTROL) {
        // ★ 실패 대조군: 게이트는 **같은 문턱으로 열리지만** 코사인은 다른 질의의 것(무관한 신호)이다.
        //   여기서 성능이 오르면 "게이트를 열어서" 오른 것이고, 의미 신호 자체는 기여가 없다.
        const donor = perQuery[(perQuery.indexOf(p) + 7) % perQuery.length];
        runtime.context.__semanticCosMap = donor.cosMap;
      }
      // 의미 후보 주입 (색인 선별·숏리스트 우회)
      const byKey = new Map(p.memories.map(e => [String(e.key || ''), e]));
      const topKeys = p.ranked.slice(0, topN).map(r => null); // text→ key 매핑은 아래에서
      const keyByText = new Map();
      for (const e of p.memories) keyByText.set(CMC.buildRecallScoringTextFromEntry(e, 800) || CMC.buildSearchTextFromEntry(e), String(e.key || ''));
      const top16Keys = p.ranked.slice(0, topN).map(r => keyByText.get(r.t)).filter(Boolean);
      runtime.context.__semanticShadow = {
        error: '', scoredError: '',
        inject: (f = []) => {
          const have = new Set(f.map(e => String(e.key || '')));
          const add = [];
          for (const k of top16Keys) { if (have.has(k)) continue; const e = byKey.get(k); if (e) { add.push(e); have.add(k); } }
          return f.concat(add);
        }
      };
      const selected = await ME.retrieveMemories(q0(p), 40, p.corpus,
        { embeddingAllowed: false, scopeKey: p.scope, worldlineState: p.worldlineState, effectiveLorebook: p.corpus }, topK);
      const ids = selected.map(e => String(e.key || ''));
      const rel = p.q.relevant || [];
      const inapp = ids.filter(k => !rel.includes(k)).length;
      // 금지 기억 반환 검사
      const forbidden = ['deleted', 'expired', 'foreign-signed', 'old-variant'];
      rows.push({
        id: p.q.id, category: p.q.category, supplementary: !!p.q.supplementary, relevant: rel,
        top: ids, hit: rel.length ? (rel.some(k => ids.includes(k)) ? 1 : 0) : null,
        inappropriate: inapp, returnedForbidden: ids.filter(k => forbidden.includes(k)).length,
        goldCos: rel.length ? Math.max(0, ...rel.map(k => p.cosMap[textOf.get(p.q.id + '|' + k)] || 0)) : null,
        top4Cos: ids.map(k => Number((p.cosMap[textOf.get(p.q.id + '|' + k)] || 0).toFixed(4)))
      });
    }
    const main = rows.filter(r => !r.supplementary);
    const supp = rows.filter(r => r.supplementary);
    const agg = rs => ({
      n: rs.length,
      recall: avg(rs.filter(r => r.hit !== null).map(r => r.hit)),
      inappropriate: rs.reduce((n, r) => n + r.inappropriate, 0),
      slots: rs.reduce((n, r) => n + r.top.length, 0),
      forbidden: rs.reduce((n, r) => n + r.returnedForbidden, 0),
      cross: avg(rs.filter(r => r.category === 'cross_language').map(r => r.hit))
    });
    results.push({
      threshold: th, main: agg(main), supplementary: agg(supp),
      byCategory: Object.fromEntries([...new Set(main.map(r => r.category))].map(c => [c, agg(main.filter(r => r.category === c))])),
      rows
    });
    const m = results[results.length - 1].main;
    console.log(`[sweep] T=${th === null ? 'OFF(기준선)' : th}  Recall@4 ${m.recall.toFixed(3)}  무관슬롯 ${m.inappropriate}/${m.slots}  금지 ${m.forbidden}  cross ${m.cross === null ? '--' : m.cross.toFixed(3)}`);
  }

  const out = { schema: 'libra.semantic_gate.sweep.v1', randomControl: RANDOM_CONTROL, distSha256: crypto.createHash('sha256').update(fs.readFileSync(DIST)).digest('hex'), topN, topK, results };
  fs.writeFileSync(path.join(ROOT, 'test-output', 'phase3-gate-sweep.json'), JSON.stringify(out, null, 2));
  console.log('[sweep] 저장: test-output/phase3-gate-sweep.json');

  function q0(p) { return p.q.query; }
  function avg(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
})().catch(e => { console.error('SWEEP FAIL:', e && e.stack || e); process.exitCode = 1; });
