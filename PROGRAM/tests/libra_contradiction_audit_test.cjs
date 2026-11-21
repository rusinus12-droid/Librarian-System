'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

function makeCanonicalReply(args) {
  const text = JSON.stringify(args);
  if (text.includes('[LIBRA MICRO SOURCE CONTRACT]')) {
    return require('./fixtures/libra_reanalysis_kinds_fixture.cjs').microReply(args);
  }
  const m = text.match(/t(\d+)-[ua]/);
  const baseTurn = m ? Math.floor((Number(m[1]) - 1) / 5) * 5 : 0;
  const art = artifact();
  for (const item of [...art.entities, ...art.facts]) {
    for (const span of item.evidenceSpans) {
      span.ref = span.ref.replace(/^t(\d+)/, (_, n) => 't' + (Number(n) + baseTurn));
    }
  }
  return { type: 'success', result: JSON.stringify(art) };
}

test('LIBRA manual source-contradiction audit supports 1-call, automatic chunking, recentCount, and feedback-guided batch fix', { timeout: 60000 }, async () => {
  const fixture = await serverFixture({ mode: 'plugin_only' });
  try {
    const { f } = fixture;
    // 15 turns = 3 canonical batches (T1-T5, T6-T10, T11-T15)
    fiveMore(f);
    fiveMore(f);
    assert.equal(f.chat.message.length, 30);

    f.control.onCall = args => makeCanonicalReply(args);
    const cold = await f.r.api.runManualColdStart();
    assert.equal(cold.total, 3);
    assert.equal(cold.completed, 3);
    assert.equal(cold.failed, 0);

    // 1) Short chat default: must make exactly 1 LLM call containing all 3 committed batches + raw sources
    const auditCalls = [];
    f.control.onCall = args => {
      const payload = JSON.stringify(args);
      if (payload.includes('[LIBRA SOURCE CONTRADICTION AUDIT]')) {
        auditCalls.push(payload);
        return {
          type: 'success',
          result: JSON.stringify({
            contradictions: [
              {
                startTurn: 6,
                recordText: '세라가 열쇠를 받아들였다.',
                sourceQuote: '나는 열쇠를 받지 않았다.',
                reason: '원문에서는 열쇠를 받지 않았는데 기록에는 받아들였다고 되어 있음'
              },
              {
                startTurn: 1,
                recordText: '아린이 북쪽 탑으로 떠났다.',
                sourceQuote: '아린은 남쪽 항구에 남았다.',
                reason: '원문 위치와 기록 위치가 반대임'
              },
              {
                startTurn: 999,
                recordText: '존재하지 않는 구간',
                sourceQuote: '없음',
                reason: '필터링되어야 하는 잘못된 startTurn'
              }
            ]
          })
        };
      }
      return makeCanonicalReply(args);
    };

    const audit = await f.r.api.auditCanonicalContradictions();
    assert.equal(auditCalls.length, 1, 'Short chat audit must make exactly 1 LLM call');
    assert.equal(audit.chunkCount, 1);
    assert.ok(auditCalls[0].includes('=== BATCH startTurn=1 (T1-T5) ==='));
    assert.ok(auditCalls[0].includes('=== BATCH startTurn=6 (T6-T10) ==='));
    assert.ok(auditCalls[0].includes('=== BATCH startTurn=11 (T11-T15) ==='));
    assert.ok(auditCalls[0].includes('[RECORDED]') && auditCalls[0].includes('[SOURCE]'));

    assert.equal(audit.ok, true);
    assert.equal(audit.auditedCount, 3);
    assert.equal(audit.totalCommitted, 3);
    assert.equal(audit.contradictions.length, 2, 'Invalid startTurn 999 must be filtered out');
    assert.deepEqual(Array.from(audit.affectedStartTurns), [1, 6]);

    // 2) Automatic chunking when batches exceed maxBatchesPerChunk
    const chunkCalls = [];
    const progressEvents = [];
    f.control.onCall = args => {
      const payload = JSON.stringify(args);
      if (payload.includes('[LIBRA SOURCE CONTRADICTION AUDIT]')) {
        chunkCalls.push(payload);
        if (chunkCalls.length === 1) {
          // Chunk 1 has T1 and T6; include a cross-chunk hallucinated startTurn=11 that must be ignored
          return {
            type: 'success',
            result: JSON.stringify({
              contradictions: [
                { startTurn: 1, recordText: '청크1 모순', sourceQuote: '원문1', reason: '사유1' },
                { startTurn: 11, recordText: '다른 청크 환각', sourceQuote: '없음', reason: '무시되어야 함' }
              ]
            })
          };
        }
        return {
          type: 'success',
          result: JSON.stringify({
            contradictions: [
              { startTurn: 11, recordText: '청크2 모순', sourceQuote: '원문11', reason: '사유11' }
            ]
          })
        };
      }
      return makeCanonicalReply(args);
    };

    const chunkedAudit = await f.r.api.auditCanonicalContradictions({
      maxBatchesPerChunk: 2,
      onProgress: info => progressEvents.push(`${info.chunkIndex}/${info.chunkCount}`)
    });
    assert.equal(chunkedAudit.ok, true);
    assert.equal(chunkedAudit.chunkCount, 2);
    assert.equal(chunkCalls.length, 2);
    assert.deepEqual(progressEvents, ['1/2', '2/2']);
    assert.equal(chunkedAudit.auditedCount, 3);
    assert.equal(chunkedAudit.contradictions.length, 2);
    assert.deepEqual(Array.from(chunkedAudit.affectedStartTurns), [1, 11]);

    // 3) recentCount filter audits only the latest N committed batches
    const recentCalls = [];
    f.control.onCall = args => {
      const payload = JSON.stringify(args);
      if (payload.includes('[LIBRA SOURCE CONTRADICTION AUDIT]')) {
        recentCalls.push(payload);
        return { type: 'success', result: JSON.stringify({ contradictions: [] }) };
      }
      return makeCanonicalReply(args);
    };
    const recentAudit = await f.r.api.auditCanonicalContradictions({ recentCount: 2 });
    assert.equal(recentAudit.ok, true);
    assert.equal(recentAudit.auditedCount, 2);
    assert.deepEqual(Array.from(recentAudit.auditedStartTurns), [6, 11]);
    assert.ok(!recentCalls[0].includes('=== BATCH startTurn=1 (T1-T5) ==='));

    // 4) Batch fix: must reanalyze ONLY batches T1 and T6, injecting each batch's own contradiction feedback
    const reanalyzedPromptsByBatch = new Map();
    f.control.onCall = args => {
      const text = JSON.stringify(args);
      if (!text.includes('[LIBRA MICRO SOURCE CONTRACT]')) {
        const m = text.match(/\[EXACT FIVE U\+A\][^]*?t(\d+)-[ua]/);
        if (m) {
          const batchStart = Math.floor((Number(m[1]) - 1) / 5) * 5 + 1;
          reanalyzedPromptsByBatch.set(batchStart, text);
        }
      }
      return makeCanonicalReply(args);
    };

    const fix = await f.r.api.fixCanonicalContradictions(audit);
    assert.equal(fix.ok, true);
    assert.equal(fix.fixedCount, 2);
    assert.deepEqual(Array.from(fix.affectedStartTurns), [1, 6]);
    assert.deepEqual([...reanalyzedPromptsByBatch.keys()].sort((a, b) => a - b), [1, 6], 'Only contradicted batches T1 and T6 should be reanalyzed');

    const promptT1 = reanalyzedPromptsByBatch.get(1);
    const promptT6 = reanalyzedPromptsByBatch.get(6);
    assert.ok(promptT1.includes('[PRIOR CONTRADICTION AUDIT FEEDBACK'), 'T1 reanalysis must include contradiction feedback');
    assert.ok(promptT1.includes('아린이 북쪽 탑으로 떠났다.'), 'T1 reanalysis must include T1 contradiction');
    assert.ok(!promptT1.includes('세라가 열쇠를 받아들였다.'), 'T1 reanalysis must not include T6 contradiction');
    assert.ok(promptT6.includes('[PRIOR CONTRADICTION AUDIT FEEDBACK'), 'T6 reanalysis must include contradiction feedback');
    assert.ok(promptT6.includes('세라가 열쇠를 받아들였다.'), 'T6 reanalysis must include T6 contradiction');
    assert.ok(!promptT6.includes('아린이 북쪽 탑으로 떠났다.'), 'T6 reanalysis must not include T1 contradiction');

    // 5) No-op fix when 0 contradictions -> 0 LLM calls
    let extraCalls = 0;
    f.control.onCall = args => {
      extraCalls += 1;
      return makeCanonicalReply(args);
    };
    const noopFix = await f.r.api.fixCanonicalContradictions(recentAudit);
    assert.equal(noopFix.ok, true);
    assert.equal(noopFix.fixedCount, 0);
    assert.equal(extraCalls, 0, 'No-op fix must not trigger any LLM calls');
  } finally {
    await fixture.cleanup();
  }
});
