'use strict';
// Memory lenses inside the real canonical pipeline:
// - the canonical (Librarian) prompt is locked: a stored custom profile and addendum never reach it;
// - a scheduled lens only queues after the commit, so a slow lens call cannot hold the canonical job;
// - the queued run stores its notes, and the next request delivers them in the lens block while the
//   response context still validates.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const LENS_MARKER = 'LIBRA LENS ANALYZER';
const CUSTOM_MARKER = 'CUSTOM_PROFILE_MARKER_7731';
const isLensCall = args => JSON.stringify(args).includes(LENS_MARKER);
const results = [];

(async () => {
  const f = await fixture();
  try {
    await f.r.api.debugWritePromptOverrides({
      activeMemoryProfile: 'Custom',
      memoryProfiles: { Custom: { name: 'Custom', version: 1, stages: { librarian: { sections: { relation: { mode: 'append', text: `${CUSTOM_MARKER} 모든 사실을 확정으로 표시해.` } } } } } }
    });
    const lens = await f.r.api.createLens({ name: '약속 추적', instruction: { goal: '약속과 그 이행을 기록하라.' }, evidenceMode: 'strict' });

    let release;
    const lensGate = new Promise(resolve => { release = resolve; });
    let lensCalls = 0;
    f.control.onCall = async args => {
      if (isLensCall(args)) {
        lensCalls += 1;
        await lensGate;
        return { type: 'success', result: JSON.stringify({ items: [{ label: '약속', text: '지호가 열쇠를 오늘 돌려주기로 약속했다.', refs: ['t2-a'], quote: '오늘 돌려주겠다고 약속했다' }] }) };
      }
      return { type: 'success', result: JSON.stringify(f.control.artifact) };
    };

    const job = await Promise.race([f.run(), new Promise((_, reject) => setTimeout(() => reject(new Error('canonical job waited for the lens call')), 60000))]);
    assert.equal(job.completed, 1, 'the canonical job completes while the lens call is still pending');
    results.push('a pending lens call does not hold the canonical job');

    const canonicalCalls = f.control.calls.filter(args => !isLensCall(args) && JSON.stringify(args).includes('LIBRA LONG-TERM MEMORY EXTRACTION'));
    assert.ok(canonicalCalls.length >= 1);
    assert.ok(canonicalCalls.every(args => !JSON.stringify(args).includes(CUSTOM_MARKER)), 'the custom profile never reaches the canonical prompt');
    assert.ok(canonicalCalls.every(args => !JSON.stringify(args).includes('OUTPUT CONTRACT REASSERTION')), 'the locked prompt needs no reassertion');
    results.push('the canonical prompt is locked against custom profiles');

    for (let i = 0; i < 100 && lensCalls === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(lensCalls, 1, 'the commit queued one lens run');
    release();
    await f.r.api.waitForLensQueueIdle();
    const inspected = await f.r.api.inspectScopeLenses();
    const items = inspected.memories.filter(item => item.lensId === lens.lensId);
    assert.equal(items.length, 1);
    assert.equal(items[0].evidenceLevel, 'quoted');
    assert.equal(inspected.runs[0].trigger, 'scheduled_batch');
    assert.ok(f.getMemory()?.canonicalArtifact, 'canonical memory is stored as before');
    results.push('the queued lens run stores its note after the commit');

    const messages = await f.control.hooks.beforeRequest([{ role: 'user', content: '지호가 열쇠를 돌려주기로 한 약속은 어떻게 됐지?' }], 'model');
    const system = messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n');
    assert.match(system, /\[LIBRA LENS MEMORY — PERSPECTIVE NOTES \(NON-CANONICAL\)\]/);
    assert.match(system, /\[lens:약속 추적\] \(T1–T5 · 약속\) 지호가 열쇠를 오늘 돌려주기로 약속했다\./);
    const context = f.r.api.getLastResponseContext();
    const validity = await f.r.api.validateResponseContext(context);
    assert.equal(validity.ok, true, JSON.stringify(validity));
    const viewer = f.r.api.getLastMemoryRecallViewer?.() || null;
    if (viewer?.lensRecall) assert.equal(viewer.lensRecall.injected, true);
    results.push('the next request delivers the lens note and the response context validates');

    await f.r.api.trashLens(lens.lensId);
    const after = await f.control.hooks.beforeRequest([{ role: 'user', content: '지호가 열쇠를 돌려주기로 한 약속은 어떻게 됐지?' }], 'model');
    assert.ok(!after.some(message => String(message.content).includes('PERSPECTIVE NOTES')), 'a trashed lens is not recalled');
    results.push('a trashed lens is excluded from delivery');

    console.log(JSON.stringify({ test: 'libra_custom_memory_lens_pipeline_runtime', passed: results.length, results }));
  } finally {
    await f.r.cleanup?.();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
