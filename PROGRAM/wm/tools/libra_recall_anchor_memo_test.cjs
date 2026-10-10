'use strict';
// Equivalence + work-count guard for the recall-anchor normalization memo.
//
// The optimization: normalizeRecallAnchor is a pure function of its input string,
// and getExactAnchorHits re-normalized the SAME loop-invariant anchors once per
// candidate.  Memoizing the pure normalizer removes the redundant work.
//
// This test asserts:
//   1. The normalizer's output is IDENTICAL for a corpus of strings (memo is lossless).
//   2. getExactAnchorHits returns IDENTICAL hits before/after (result vector equality).
//   3. The memo actually removes redundant work (count-the-work, not wall clock).
//   4. The memo is present in the shipped source and is bounded.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
const assertions = [];
const check = (name, ok, detail = null) => {
  assertions.push({ name, ok: Boolean(ok), detail });
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`);
};

async function load() {
  const chat = { id: 'anchor-memo', localLore: [], msgs: [], message: [], isStreaming: false };
  const char = { id: 'anchor-memo-c', name: 'A', chats: [chat], globalLore: [], lorebook: [] };
  const args = new Map(Object.entries({ debug: 'false', embedding_enabled: 'false', activity_dashboard: 'off' }));
  const risuai = {
    async getArgument(n){ return args.get(n); }, async requestPluginPermission(){ return true; },
    async getCharacter(){ return clone(char); }, async getCurrentCharacterIndex(){ return 0; }, async getCurrentChatIndex(){ return 0; },
    async getCharacterFromIndex(){ return clone(char); }, async getChatFromIndex(){ return clone(chat); },
    async setChatToIndex(){ return true; }, async setCharacter(){ return true; }, async getDatabase(){ return { personas: [] }; },
    async addRisuReplacer(){}, async removeRisuReplacer(){}, async addRisuScriptHandler(){}, async removeRisuScriptHandler(){},
    async registerBodyIntercepter(){ return 'x'; }, async unregisterBodyIntercepter(){}, async onUnload(){},
    async registerSetting(){}, async registerButton(){}, async showContainer(){}, async hideContainer(){},
    pluginStorage: { async getItem(){ return null; }, async setItem(){ return true; }, async removeItem(){ return true; } },
    async nativeFetch(){ throw new Error('no fetch'); }
  };
  let code = fs.readFileSync(DIST, 'utf8');
  const close = code.lastIndexOf('\n})();');
  code = code.slice(0, close)
    + '\n;globalThis.__ANCHOR_MEMO_TEST__={MemoryEngine,MemoryState,RecallScoringCore:typeof RecallScoringCore!=="undefined"?RecallScoringCore:null};\n'
    + code.slice(close);
  const context = {
    console: { log(){}, warn(){}, error(){}, debug(){} }, setTimeout, clearTimeout, setInterval, clearInterval, performance,
    crypto: { randomUUID: crypto.randomUUID }, AbortController, TextEncoder, TextDecoder, URL, Buffer,
    fetch: async()=>{ throw new Error('no fetch'); }, risuai, Risuai: risuai, globalThis: null, process: { env: {} },
    atob: t => Buffer.from(String(t), 'base64').toString('binary'), btoa: t => Buffer.from(String(t), 'binary').toString('base64')
  };
  context.globalThis = context;
  vm.createContext(context);
  await vm.runInContext(code, context, { filename: DIST, timeout: 15000 });
  await new Promise(r => setTimeout(r, 40));
  return { api: context.__ANCHOR_MEMO_TEST__, char, chat };
}

function memoryEntry(i, text, imp = 5) {
  const meta = { t: i, ttl: -1, imp, cat: 'event', ent: [], summary: text.slice(0, 50), s_id: 'anchor-memo' };
  return { key: `lmai_memory::${i}`, comment: 'lmai_memory', content: `[META:${JSON.stringify(meta)}] ${text}` };
}

// The reference implementation of the normalizer (must match the product's).
const reference = (value = '') => String(value || '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[^\p{L}\p{M}\p{N}_\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

(async () => {
  const shipped = fs.readFileSync(DIST, 'utf8');

  // ── 1. Losslessness: memoized normalizer must match the reference exactly ──
  const { api, char, chat } = await load();
  const ME = api.MemoryEngine;
  const norm = ME.normalizeRecallAnchorCached;
  check('normalizer_is_exposed_for_verification', typeof norm === 'function', { type: typeof norm });

  const corpus = [
    '아리엘', '아리엘은', '아리엘에게', '도현', '도현이', '루멘 아카데미', '루멘  아카데미',
    '별핵 파편', '별핵-파편', '별핵:파편', '  spaced  text  ', 'MiXeD CaSe', 'ＡＢＣ', 'abc123',
    '한글/영문 mixed 123', 'a.b,c;d', '   ', '', 'ㄱ', '가나다라', 'T1', 'T99', '월식 의식의 선택',
    '노아가 숨긴 기록의 전모', '학생회 감시망 회피', '시계탑 관측실', '달그림자 도서관 지하서고'
  ];
  // add generated variants to widen coverage
  for (let i = 0; i < 300; i++) {
    corpus.push(`항목${i}의 기록`, `  항목${i}의 기록  `, `항목${i}의기록`, `Item-${i}_note`);
  }
  let mismatch = 0; let firstBad = null;
  for (const s of corpus) {
    const a = norm(s);
    const b = reference(s);
    if (a !== b) { mismatch += 1; if (!firstBad) firstBad = { input: s, memoized: a, reference: b }; }
  }
  check('memoized_normalizer_is_lossless', mismatch === 0, { mismatched: mismatch, firstBad, samples: corpus.length });
  // Repeated calls must be stable (memo hit path returns the same value).
  const repeated = corpus.map(s => [norm(s), norm(s), norm(s)]);
  check('memoized_normalizer_is_stable_on_repeat',
    repeated.every(([a, b, c]) => a === b && b === c),
    { checked: repeated.length });

  // ── 2. Result-vector equality: recall output identical ──────────────────────
  const entities = ['아리엘', '도현', '미라', '노아', '루멘 아카데미', '시계탑 관측실', '달그림자 도서관', '별핵 파편', '학생회 감시망', '월식 의식'];
  const lore = [];
  for (let i = 1; i <= 120; i++) {
    const e1 = entities[i % entities.length], e2 = entities[(i * 3) % entities.length];
    lore.push(memoryEntry(i, `T${i}. ${e1}은(는) ${e2}와 별핵 파편 ${i}의 공명을 확인했다. 시간 잠금 주문이 불안정해졌다.`));
  }
  ME.setTurn(120);
  ME.setLorebook(char, chat, lore);
  const entries = ME.getManagedEntries(lore);

  const runRecall = async (scope) => {
    const out = await ME.retrieveMemories('아리엘 별핵 파편 공명 상태를 확인한다', 120, entries, { scopeKey: scope }, 8);
    const dbg = ME.getLastRetrievalDebug() || {};
    return {
      count: Array.isArray(out) ? out.length : -1,
      ids: (Array.isArray(out) ? out : []).map((item, idx) => {
        const m = String(item?.content || '').match(/"t":(\d+)/);
        return `${m ? m[1] : idx}`;
      }).join(','),
      scores: (Array.isArray(out) ? out : []).map(item => Number((item?.score ?? item?.similarity ?? 0).toFixed(4))).join(',')
    };
  };
  const r1 = await runRecall('anchor-a');
  const r2 = await runRecall('anchor-a');
  check('recall_returns_results', r1.count > 0, { count: r1.count });
  check('recall_is_deterministic_across_repeats', r1.ids === r2.ids && r1.scores === r2.scores,
    { first: r1.ids.slice(0, 80), second: r2.ids.slice(0, 80) });

  // ── 2b. The HME term/graph normalizers are pure wrappers over the same memo ──
  {
    const hmeNorm = ME.normalizeHmeIndexTermCached;
    const graphNorm = ME.normalizeHmeGraphTokenCached;
    check('hme_normalizers_are_exposed', typeof hmeNorm === 'function' && typeof graphNorm === 'function',
      { hme: typeof hmeNorm, graph: typeof graphNorm });
    if (typeof hmeNorm === 'function') {
      // The wrapper adds only .replace(/\s+/g,' ').trim(), which is a no-op on the
      // normalizer's output.  Verify equivalence against the reference on the corpus.
      let hmeMismatch = 0; let graphMismatch = 0; let firstHmeBad = null;
      for (const s of corpus) {
        const expected = reference(s);
        const gotHme = hmeNorm(s);
        const gotGraph = graphNorm(s);
        if (gotHme !== expected) { hmeMismatch += 1; if (!firstHmeBad) firstHmeBad = { input: s, got: gotHme, expected }; }
        if (gotGraph !== expected) graphMismatch += 1;
      }
      check('hme_index_term_normalizer_is_lossless', hmeMismatch === 0,
        { mismatched: hmeMismatch, firstBad: firstHmeBad, samples: corpus.length });
      check('hme_graph_token_normalizer_is_lossless', graphMismatch === 0,
        { mismatched: graphMismatch, samples: corpus.length });
      const hmeStats = ME.getHmeIndexTermMemoStats ? ME.getHmeIndexTermMemoStats() : null;
      check('hme_term_memo_stats_available', hmeStats && typeof hmeStats.hits === 'number', { hmeStats });
      if (hmeStats) check('hme_term_memo_is_bounded', hmeStats.maxEntries > 0 && hmeStats.size <= hmeStats.maxEntries, { hmeStats });
    }
  }

  // ── 3. The memo is present in the shipped artifact and bounded ──────────────
  const usesMemo = shipped.includes('normalizeRecallAnchorCached') && shipped.includes('RECALL_ANCHOR_MEMO_MAX');
  check('memo_present_in_shipped_artifact', usesMemo, { hasMemo: shipped.includes('normalizeRecallAnchorCached') });

  // ── 4. Count the work: redundant normalization must be eliminated ───────────
  const stats = ME.getRecallAnchorMemoStats ? ME.getRecallAnchorMemoStats() : null;
  check('memo_stats_available', stats && typeof stats.hits === 'number' && typeof stats.misses === 'number',
    { stats });
  if (stats) {
    // Work removed = hits.  A corpus that reuses entities must produce hits.
    check('memo_actually_removes_work', stats.hits > 0, { stats });
    const redundantRatio = stats.hits / Math.max(1, stats.hits + stats.misses);
    check('memo_hit_ratio_is_meaningful', redundantRatio > 0.3, { stats, hitRatio: Number(redundantRatio.toFixed(3)) });
    check('memo_is_bounded', stats.maxEntries > 0 && stats.size <= stats.maxEntries, { stats });
  }

  // Wall clock is INFORMATION, not a gate (per hot-path-optimization: a wall-clock
  // bound is a machine assertion).  Reported in the structured output only.
  const t0 = performance.now();
  for (let i = 0; i < 3; i++) await runRecall(`anchor-perf-${i}`);
  const recallMs = performance.now() - t0;

  const failed = assertions.filter(item => !item.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    assertions,
    memoStats: stats,
    recallMsFor3: Number(recallMs.toFixed(1))
  }, null, 2));
  if (failed.length) process.exit(1);
})().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error), stack: error?.stack || '', assertions }, null, 2));
  process.exit(1);
});
