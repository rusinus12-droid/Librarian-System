'use strict';

// 상설(durable) 인덱스 자동 구축: 첫 cold 회수 뒤 한 번, 정본 커밋 뒤 idle 시점에 갱신한다.
// 설정 autoDurableIndex 로 끌 수 있어야 한다.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const expose = source => {
  const coreAnchor = '      getUnifiedStorageStatus,';
  const apiAnchor = '    async getUnifiedStorageStatus() { return safeClone(await LibraMemoryCore.getUnifiedStorageStatus()); },';
  assert.ok(source.includes(coreAnchor), 'core anchor');
  assert.ok(source.includes(apiAnchor), 'api anchor');
  source = source.replace(coreAnchor,
    '      debugScheduleDurable: (reason = "test", delay = 0) => scheduleDurableIndexBuild(reason, delay),\n' +
    '      debugCancelDurable: () => { if (durableIndexTimer) { clearTimeout(durableIndexTimer); durableIndexTimer = null; } },\n' +
    '      debugDurableState: () => safeClone({ running: durableIndexRuntime().running, scheduled: durableIndexTimerPending(),\n' +
    '        pendingReason: durableIndexRuntime().pendingReason, attempts: durableIndexRuntime().attempts,\n' +
    '        lastResult: durableIndexRuntime().lastResult }),\n' + coreAnchor);
  return source.replace(apiAnchor,
    '    debugScheduleDurable(reason, delay) { return LibraMemoryCore.debugScheduleDurable(reason, delay); },\n' +
    '    debugCancelDurable() { return LibraMemoryCore.debugCancelDurable(); },\n' +
    '    debugDurableState() { return LibraMemoryCore.debugDurableState(); },\n' + apiAnchor);
};

const waitFor = async (fn, ms = 30000) => {
  const started = Date.now();
  while (Date.now() - started < ms) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('timed out');
};

(async () => {
  const f = await fixture({ transformSource: expose });
  try {
    const result = await f.run();
    assert.equal(result.completed, 1, JSON.stringify(result));
    const api = f.r.api;

    const settings = await api.getLibraMemorySettings();
    assert.equal(settings.autoDurableIndex, true, '자동 구축은 기본 켜짐');

    // 첫 cold 회수에서 예약되는 경로는 beforeRequest 회수 안에서만 발생한다.
    // 여기서는 같은 스케줄러를 회수 트리거와 동일한 이유로 직접 호출해 게시까지 확인한다.
    api.debugCancelDurable();
    api.debugScheduleDurable('cold_recall', 0);
    const built = await waitFor(() => { const s = api.debugDurableState(); return s.lastResult ? s : null; });
    assert.equal(built.lastResult.ok, true, JSON.stringify(built.lastResult));
    assert.ok(built.lastResult.windowCount >= 1, '게시된 구간이 있어야 한다');

    // 설정을 끄면 다시 예약해도 아무 일도 일어나지 않는다.
    await api.saveLibraMemorySettings({ ...settings, autoDurableIndex: false });
    api.debugCancelDurable();
    const beforeOff = api.debugDurableState().attempts;
    api.debugScheduleDurable('disabled', 0);
    await new Promise(r => setTimeout(r, 400));
    const afterOff = api.debugDurableState();
    assert.equal(afterOff.attempts, beforeOff, '꺼진 설정에서는 구축을 시작하지 않는다');

    console.log(JSON.stringify({ test: 'libra_auto_durable_index', status: 'PASS',
      windows: built.lastResult.windowCount, defaultOn: true, disabledSkips: true }));
  } finally {
    await f.r.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
