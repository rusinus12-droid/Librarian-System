'use strict';
// The home screen must answer one question per turn: is the text stored, and does its embedding
// vector exist? Storage integrity alone let the header claim "기본 정상" while 51 of 74 records
// had no vector.
const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

(async () => {
  const chat = { id: 'coverage-chat', name: 'Coverage', message: [
    { role: 'user', chatId: 'u1', data: '질문 1' }, { role: 'assistant', chatId: 'a1', data: '응답 1' },
    { role: 'user', chatId: 'u2', data: '질문 2' }, { role: 'assistant', chatId: 'a2', data: '응답 2' }
  ] };
  const f = await createFixture({ chat });
  const results = [];
  try {
    const t = f.api._test;
    const scope = await f.api.resolveCurrentScope();
    const cfg = t.normalizeSettings({ embeddingProvider: 'hash', hashDimensions: 8, shardSize: 50 });

    const chunk = (turn, index, count, state) => ({
      id: `raw-${turn}-${index}`, scopeKey: scope.scopeKey, sourceType: 'response',
      sourceId: `turn:${turn}`, sourceHash: `src${turn}`, text: `User:\n질문 ${turn}\n\n---\n\nAssistant:\n응답 ${turn} (${index})`,
      title: `Turn ${turn}`, pairIndex: turn, turnIndex: turn, chunkIndex: index, chunkCount: count,
      ...(state === 'ready' || state === 'partial' ? { vector: [1, 0, 0, 0, 0, 0, 0, 0] } : {}),
      ...(state === 'running' ? { embeddingWork: { schema: 'flashback.embedding_work.v1', status: 'running' } } : {}),
      createdAt: Date.now(), updatedAt: Date.now()
    });

    // The real load path still returns a snapshot for the saved scope.
    await t.saveAllRecords([chunk(1, 0, 2, 'ready'), chunk(1, 1, 2, 'ready')], cfg, scope);
    const live = await t.turnVectorCoverageSnapshot(scope.scopeKey, { force: true });
    assert.ok(live, 'coverage reads the stored scope');
    assert.equal(live.storedTurns, 1);
    assert.equal(live.vectorTurns, 1);
    assert.equal(live.rows[0].embeddedChunks, 2);
    results.push('coverage reads the stored scope through the real loader');

    // Synthetic states: full vector set, partial vector set, in flight, and none at all.
    const synthetic = [
      chunk(1, 0, 2, 'ready'), chunk(1, 1, 2, 'ready'),
      chunk(2, 0, 2, 'partial'), chunk(2, 1, 2, 'missing'),
      chunk(3, 0, 1, 'running'),
      chunk(4, 0, 1, 'missing')
    ];
    const coverage = await t.turnVectorCoverageSnapshot(scope.scopeKey, { force: true, records: synthetic });
    const byTurn = Object.fromEntries(coverage.rows.map(row => [row.turn, row]));
    assert.equal(byTurn[1].stored, true);
    assert.equal(byTurn[1].vector, true);
    assert.equal(byTurn[2].stored, true);
    assert.equal(byTurn[2].vector, false, 'a stored turn without every chunk vector is not counted');
    assert.equal(byTurn[2].embeddedChunks, 1);
    assert.equal(byTurn[3].state, 'running', 'an in-flight turn is distinguishable from a missing one');
    assert.equal(byTurn[4].stored, true);
    assert.equal(byTurn[4].vector, false);
    assert.equal(coverage.storedTurns, 4);
    assert.equal(coverage.vectorTurns, 1);
    assert.equal(coverage.partialTurns, 3);
    results.push('per-turn rows separate stored text from stored vectors');

    const card = t.turnVectorCardModel(coverage, value => String(value));
    assert.match(card.summary, /저장된 턴 4/);
    assert.match(card.summary, /임베딩 벡터 저장 턴 1/);
    assert.match(card.summary, /벡터 없음 3/);
    assert.match(card.rows, /<dt>T1<\/dt><dd><span class="badge badge--ok">저장<\/span> <span class="badge badge--ok">벡터 있음<\/span>/);
    assert.match(card.rows, /T2<\/dt><dd><span class="badge badge--ok">저장<\/span> <span class="badge badge--warn">벡터 없음 1\/2<\/span>/);
    assert.match(card.rows, /벡터 처리 중/);
    assert.equal(t.turnVectorCardModel(null).empty, true, 'before the first load the card says so instead of inventing numbers');
    results.push('the card renders one row per turn with stored and vector state');
    const work = { pending: 1, running: 0, failed: 0, uncertain: 0, repairNeeded: 0, unconfigured: 0 };
    const incomplete = t.flashbackOverviewHealth({ scope, manifest: {}, stats: { recordTotal: 4, statsPartial: false, embeddingWork: work }, turnVectors: coverage });
    assert.equal(incomplete.tone, 'warning', 'missing vectors must not read as healthy');
    assert.equal(incomplete.title, '임베딩 미완료');
    assert.match(incomplete.meta, /벡터 저장 턴 1/);
    results.push('the header chip reports embedding incompleteness with the turn numbers');

    const emptyQueue = t.flashbackOverviewHealth({ scope, manifest: {}, turnVectors: coverage,
      stats: { recordTotal: 4, statsPartial: false, embeddingWork: { pending: 0, running: 0, failed: 0, uncertain: 0, repairNeeded: 0, unconfigured: 0 } } });
    assert.equal(emptyQueue.tone, 'warning', 'an empty queue does not hide a stored turn without a vector');
    results.push('an empty queue does not hide a missing vector');

    const complete = { ...coverage, rows: coverage.rows.map(row => ({ ...row, vector: true })), vectorTurns: 4, partialTurns: 0 };
    const healthy = t.flashbackOverviewHealth({ scope, manifest: {}, turnVectors: complete,
      stats: { recordTotal: 4, statsPartial: false, embeddingWork: { pending: 0, running: 0, failed: 0, uncertain: 0, repairNeeded: 0, unconfigured: 0 } } });
    assert.equal(healthy.tone, 'success', 'complete coverage still reports normal');
    assert.equal(healthy.title, '기본 저장 상태에서 이상 없음');
    results.push('full coverage still reads as normal');

    const failed = t.flashbackOverviewHealth({ scope, manifest: {}, turnVectors: coverage,
      stats: { recordTotal: 4, statsPartial: false, embeddingWork: { pending: 0, running: 0, failed: 2, uncertain: 0, repairNeeded: 0, unconfigured: 0 } } });
    assert.equal(failed.tone, 'danger');
    assert.equal(failed.title, '임베딩 확인 필요');
    results.push('failed vectors escalate to a danger verdict');

    console.log(JSON.stringify({ test: 'flashback_turn_vector_coverage', passed: results.length, results,
      boundary: 'full plugin in native runtime fixture; live RisuAI server mirror untested' }));
  } finally {
    await f.close?.();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
