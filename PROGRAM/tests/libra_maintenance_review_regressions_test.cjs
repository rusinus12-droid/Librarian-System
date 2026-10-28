'use strict';
// Real owner storage and DOM, with test-only access to the private job controller.
// External provider access is disabled; canonical fixtures use synthetic replies.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { create, until } = require('./fixtures/libra_gui_memory_dom_host.cjs');
const { fixture: createCanonicalRuntime } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const program = process.argv[2] || path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(program, 'plugins/LIBRA.js'), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'libra-maintenance-regression-'));
const pluginPath = path.join(temp, 'LIBRA.js');
const coreMarker = '    const loadCanonicalJob = async';
const guiMarker = '  const runLibraMemoryMaintenance = async';
const scanMarker = '    const runManagedScan = async (kind, options = {}) => {';
assert(source.includes(coreMarker) && source.includes(guiMarker) && source.includes(scanMarker));
fs.writeFileSync(pluginPath, source
  .replace(coreMarker, '    globalThis.__patchPersistJob = persistCanonicalJob;\n' + coreMarker)
  .replace(scanMarker, scanMarker + '\n      if (kind === "cold_start") { globalThis.__patchColdStartRequest = options; await globalThis.__patchBeforeColdStart?.(); }')
  .replace(guiMarker, '  globalThis.__patchJobProbe = { core: LibraMemoryCore, gui: Gui, render: renderCanonicalJobSurface };\n' + guiMarker));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const messages = (count = 5) => Array.from({ length: count }, (_, i) => [
  { role: 'user', data: `User ${i + 1}`, chatId: `u${i + 1}` },
  { role: 'assistant', data: `Assistant ${i + 1}`, chatId: `a${i + 1}` }
]).flat();
async function fixture(run) {
  const f = await create('LIBRA', 'Full', { pluginPath, initialChat: messages() });
  try { await run(f, f.context.__patchJobProbe); } finally { await f.close(); }
}
const switchChat = async f => {
  const chat = await f.host.getChat();
  chat.id = chat.chatId = 'another-chat';
};
const canonicalWrites = f => f.writes.filter(row => row.key.includes(':canonical-job'));

test('a plan from another chat is rejected before any canonical job starts', () => fixture(async (f, probe) => {
  const plan = await f.api.inspectMemoryMaintenance();
  const before = canonicalWrites(f).length, calls = f.wire.length;
  await switchChat(f);
  await assert.rejects(f.api.runMemoryMaintenance('auto', { preflight: plan }), /점검한 채팅 범위/);
  assert.equal(canonicalWrites(f).length, before);
  assert.equal(f.wire.length, calls);
  assert.equal(probe.core.state.canonicalJob, null);
}));

test('edited source and newly added complete ranges invalidate an earlier plan', () => fixture(async f => {
  const plan = await f.api.inspectMemoryMaintenance(), chat = await f.host.getChat();
  const before = canonicalWrites(f).length, calls = f.wire.length;
  const oldText = chat.message[1].data;
  chat.message[1].data = 'A changed answer';
  await assert.rejects(f.api.runMemoryMaintenance('auto', { preflight: plan }), /원문 또는 구간/);
  chat.message[1].data = oldText;
  chat.message.push(...messages().map(row => ({ ...row, chatId: row.chatId + '-extra' })));
  await assert.rejects(f.api.runMemoryMaintenance('auto', { preflight: plan }), /원문 또는 구간/);
  assert.equal(canonicalWrites(f).length, before);
  assert.equal(f.wire.length, calls);
}));

test('cold start retains the approved scope and exact range bindings at the controller boundary', () => fixture(async f => {
  const plan = await f.api.inspectMemoryMaintenance();
  await f.api.runMemoryMaintenance('auto', { preflight: plan });
  const request = f.context.__patchColdStartRequest;
  assert.equal(request.expectedScopeKey, plan.scopeKey);
  assert.deepEqual(Array.from(request.startTurns), [1]);
  assert.equal(request.selectionBindings[0].sourceDigest, plan.ranges[0].sourceDigest);
  assert.equal(request.selectionBindings[0].identityDigest, plan.ranges[0].identityDigest);
}));

test('a chat switch inside cold-start admission is refused by the real canonical controller', () => fixture(async f => {
  const plan = await f.api.inspectMemoryMaintenance();
  const before = canonicalWrites(f).length, calls = f.wire.length;
  f.context.__patchBeforeColdStart = () => switchChat(f);
  await assert.rejects(f.api.runMemoryMaintenance('auto', { preflight: plan }), /점검한 채팅 범위/);
  assert.equal(canonicalWrites(f).length, before);
  assert.equal(f.wire.length, calls);
}));

test('terminal Micro/Lens results yield the real popup and cancellation to the next canonical job', () => fixture(async (f, probe) => {
  await f.open();
  const scope = (await probe.core.resolveContext()).scope;
  await probe.core.refreshSnapshot();
  assert.equal(probe.core.peekSnapshot()?.scope?.scopeKey, scope.scopeKey);
  for (const kind of ['micro', 'lens']) for (const terminal of ['completed', 'failed', 'cancelled']) {
    const oldJob = { jobId: `${kind}-${terminal}`, jobType: kind, scopeKey: scope.scopeKey,
      kind: 'source_edit', state: terminal, total: 1, completed: terminal === 'completed' ? 1 : 0,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    probe.core.state.activeAuxiliaryJob = oldJob;
    probe.gui.canonicalJobObservedIds.add(oldJob.jobId);
    probe.gui.canonicalJobMinimized = true;
    probe.render(oldJob);
    assert(f.doc.querySelector(`[data-canonical-job-chip][data-canonical-job-id="${oldJob.jobId}"]`));

    const jobId = `successor-${oldJob.jobId}`;
    probe.gui.canonicalJobMinimized = false;
    await f.context.__patchPersistJob(scope, { jobId, scopeKey: scope.scopeKey, state: 'running', kind: 'cold_start',
      total: 1, completed: 0, failed: 0, skipped: 0, targetStarts: [1], currentStart: 1,
      startedAt: new Date().toISOString(), cancellable: true });
    assert.equal(probe.core.state.activeAuxiliaryJob, null);
    probe.render(probe.core.state.canonicalJob);
    const portal = f.doc.querySelector('[data-canonical-job-portal]');
    assert.equal(portal?.dataset.canonicalJobId, jobId);
    const cancel = [...portal.querySelectorAll('button')].find(button => button.textContent === '작업 취소');
    assert(cancel, 'the new live job exposes its cancel action');
    cancel.click();
    await until(() => probe.core.state.canonicalJob?.cancelRequested, 'canonical successor cancellation');
    await f.context.__patchPersistJob(scope, { ...probe.core.state.canonicalJob, state: 'cancelled', finishedAt: new Date().toISOString() });
  }
}));

test('loading actionable stored jobs replaces terminal auxiliary results and exposes the pending actions', () => fixture(async (f, probe) => {
  await f.open();
  await probe.core.refreshSnapshot();
  const scope = (await probe.core.resolveContext()).scope;
  for (const state of ['running', 'awaiting_choice', 'awaiting_edit', 'interrupted']) {
    const jobId = 'restored-' + state;
    await f.context.__patchPersistJob(scope, { jobId, scopeKey: scope.scopeKey, state, kind: 'regenerate',
      total: 1, targetStarts: [1], completed: 0, startedAt: new Date().toISOString(),
      comparison: { active: { text: 'Previous memory' }, candidate: { text: 'Candidate memory', revision: 2 }, beforeState: {}, afterState: {} } });
    // The durable job belongs to a scope whose job has not yet been loaded.
    probe.core.state.canonicalJob = null;
    probe.gui.canonicalJob = null;
    const oldJob = { jobId: 'old-micro-' + state, scopeKey: scope.scopeKey, jobType: 'micro', state: 'completed',
      total: 1, completed: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    probe.core.state.activeAuxiliaryJob = oldJob;
    probe.gui.canonicalJobObservedIds.add(oldJob.jobId);
    probe.gui.canonicalJobMinimized = false;
    probe.render(oldJob);
    assert.equal(f.doc.querySelector('[data-canonical-job-portal]')?.dataset.canonicalJobId, oldJob.jobId);

    const restored = await f.api.getCanonicalJobStatus({ jobId });
    assert.equal(probe.core.state.activeAuxiliaryJob, null, state + ' yields to the loaded job');
    probe.render(restored);
    const portal = f.doc.querySelector('[data-canonical-job-portal]');
    assert.equal(portal?.dataset.canonicalJobId, jobId);
    const labels = [...portal.querySelectorAll('button')].map(button => button.textContent);
    const expected = { running: '작업 취소', awaiting_choice: '후보 비교 후 정본 채택', awaiting_edit: '수정본 저장', interrupted: '중단된 작업 재개' };
    assert(labels.some(label => label.includes(expected[state])), `${state} actions: ${labels.join(', ')}`);
    await f.context.__patchPersistJob(scope, { ...restored, state: 'cancelled', finishedAt: new Date().toISOString() });
  }
}));

async function failedRangeFixture(run) {
  const markers = [
    ['const listCanonicalReanalysisRanges = async () => {', "globalThis.__maintenanceSourceHook?.('inventory');"],
    ['const startSelectedCanonicalBatchesOnce = async (selection = {}) => {', "globalThis.__maintenanceSourceHook?.('selection');"],
    ['const runManagedScan = async (kind, options = {}) => {', "if(kind==='source_edit')globalThis.__maintenanceSourceHook?.('dispatch');"],
    ['const callMemoryProvider = async (stageName, systemPrompt, userPrompt, options = {}) => {', "globalThis.__maintenanceSourceHook?.('provider');"]
  ];
  const f = await createCanonicalRuntime({ transformSource: source => {
    for (const [marker, hook] of markers) { assert(source.includes(marker)); source = source.replace(marker, marker + '\n      ' + hook); }
    return source;
  } });
  try {
    assert.equal((await f.run()).completed, 1);
    f.chat.message.push(...f.chat.message.slice(0, 10).map((row, i) => ({ ...row, chatId: 'extra-' + i })));
    f.control.modelFails = true;
    await f.run();
    const plan = await f.r.api.inspectMemoryMaintenance();
    assert.equal(plan.savedRangesCount, 1);
    assert.equal(plan.failedRangesCount, 1);
    assert.equal(plan.missingRangesCount, 0);
    f.control.modelFails = false;
    for (const item of [...f.control.artifact.entities, ...f.control.artifact.facts]) {
      for (const span of item.evidenceSpans) span.ref = span.ref.replace(/^t(\d+)/, (_, n) => 't' + (Number(n) + 5));
    }
    await run(f, plan);
  } finally { await f.r.cleanup(); }
}

for (const [stage, occurrence] of [['inventory', 1], ['inventory', 2], ['selection', 1], ['dispatch', 1], ['provider', 1]]) {
  test(`failed-range recovery refuses source edits at ${stage} #${occurrence} before provider submission`, () => failedRangeFixture(async (f, plan) => {
    let visits = 0, edited = false;
    f.r.context.__maintenanceSourceHook = where => {
      if (where !== stage || ++visits !== occurrence) return;
      edited = true;
      f.chat.message[11].data += ' SOURCE_CHANGED_AFTER_PREFLIGHT';
    };
    const before = f.control.calls.length;
    const result = await f.r.api.runMemoryMaintenance('auto', { preflight: plan });
    assert(edited, 'the selected async boundary was reached');
    assert.equal(f.control.calls.length, before, 'a changed source cannot authorize a provider call');
    assert.equal(result.after.failedRangesCount, 1);
    assert(!result.actionsTaken.some(action => action.includes('재분석 및 자동 복구 완료')));
  }));
}

test('failed-range recovery still publishes unchanged approved source', () => failedRangeFixture(async (f, plan) => {
  const before = f.control.calls.length;
  const result = await f.r.api.runMemoryMaintenance('auto', { preflight: plan });
  assert.equal(f.control.calls.length, before + 1);
  assert.equal(result.after.savedRangesCount, 2);
  assert.equal(result.after.failedRangesCount, 0);
}));
