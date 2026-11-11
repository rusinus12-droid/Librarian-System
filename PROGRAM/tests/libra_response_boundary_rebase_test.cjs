'use strict';

// 회수 도중 LIBRA 자신이 continuity head 를 갱신하면(예: pending state tracking 복구) 회수 전체를
// 버리지 않고 새 head 로 재기준한다. 외부/설명되지 않은 변경은 기존대로 권한 변경으로 거부한다.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const expose = source => {
  const coreAnchor = '      getUnifiedStorageStatus,';
  const apiAnchor = '    async getUnifiedStorageStatus() { return safeClone(await LibraMemoryCore.getUnifiedStorageStatus()); },';
  assert.ok(source.includes(coreAnchor), 'core debug injection anchor must exist');
  assert.ok(source.includes(apiAnchor), 'public debug injection anchor must exist');
  source = source.replace(coreAnchor,
    '      debugBoundary: async () => captureUnifiedResponseBoundary(await resolveContext()),\n' +
    '      debugAssertBoundary: boundary => assertUnifiedResponseBoundary(boundary),\n' +
    '      debugMarkSelfWrite: () => markUnifiedStateSelfWrite(),\n' +
    '      debugRebaseRecord: () => safeClone(state.lastResponseBoundaryRebase),\n' + coreAnchor);
  return source.replace(apiAnchor,
    '    async debugBoundary() { return safeClone(await LibraMemoryCore.debugBoundary()); },\n' +
    '    async debugAssertBoundary(boundary) { return safeClone(await LibraMemoryCore.debugAssertBoundary(boundary)); },\n' +
    '    debugMarkSelfWrite() { return LibraMemoryCore.debugMarkSelfWrite(); },\n' +
    '    debugRebaseRecord() { return LibraMemoryCore.debugRebaseRecord(); },\n' + apiAnchor);
};

(async () => {
  const f = await fixture({ transformSource: expose });
  try {
    const result = await f.run();
    assert.equal(result.completed, 1, JSON.stringify(result));
    const api = f.r.api;
    const boundary = await api.debugBoundary();
    const headKey = [...f.r.values.keys()].find(key => String(key).endsWith(':continuity-state'));
    assert.ok(headKey, 'continuity state exists in the fixture');

    // LIBRA 자신의 상태 쓰기(리플레이)를 흉내낸 뒤 head 를 갱신한다.
    api.debugMarkSelfWrite();
    const head = JSON.parse(f.r.values.get(headKey) || '{}');
    head.updatedAt = '2099-01-01T00:00:00.000Z';
    head.characters = Array.isArray(head.characters) ? head.characters : [];
    await f.r.context.risuai.pluginStorage.setItem(headKey, JSON.stringify(head));

    const rebound = await api.debugAssertBoundary(boundary);
    assert.equal(typeof rebound, 'object', 'rebase returns the fresh boundary instead of throwing');
    assert.equal(rebound.scopeKey, boundary.scopeKey);
    assert.notEqual(rebound.headDigest, boundary.headDigest, 'the fresh head digest is adopted');
    assert.equal(rebound.sourceDigest, boundary.sourceDigest, 'the transcript authority is unchanged');
    const record = api.debugRebaseRecord();
    assert.ok(record, 'the rebase is recorded for diagnostics');
    assert.equal(record.code, 'UNIFIED_RESPONSE_BOUNDARY_REBASED');
    assert.ok(record.changedFields.includes('headDigest'), JSON.stringify(record.changedFields));

    console.log(JSON.stringify({ test: 'libra_response_boundary_rebase', status: 'PASS',
      rebased: record.changedFields, transcriptUnchanged: true,
      boundary: 'captured production response boundary, test-only debug access' }));
  } finally {
    await f.r.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
