'use strict';
// 2026-11-09 export: recall failed open with
// "Cannot access '__LIBRA_NARRATIVE_DIRECTION_LEGACY_SCHEMA' before initialization".
// The portable-backup installer was awaited at the end of the plugin module; when that await never
// settled, everything declared after it stayed in the temporal dead zone. Recall then threw while
// normalizing narrative direction during branch reconcile and returned zero memories.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_lore_link_index_fixture.cjs');

const replaceInstaller = body => source => {
  const anchor = 'const installLibraPortableMemoryBackup = async () => {';
  assert.ok(source.includes(anchor), 'installer anchor');
  return source.replace(anchor, `${anchor} ${body}`);
};

const assertRecallDelivery = async transformSource => {
  const f = await fixture({ transformSource });
  try {
    await f.run();
    f.control.onCall = async () => { throw new Error('recall must not invoke a provider'); };
    const callsBefore = f.control.calls.length;
    const out = await f.control.hooks.beforeRequest([{ role: 'user', content: '은빛 열쇠는 누가 맡지?' }], 'model');
    assert.ok(Array.isArray(out), 'beforeRequest returns messages');
    const runtime = f.r.api.getRuntime();
    const meta = runtime.lastMemoryInjectionMeta || {};
    assert.equal(meta.error || '', '', 'recall must complete without an initialization or replacement error');
    assert.notEqual(meta.failOpen, true, 'returning messages without memories is not recovery');
    assert.equal(meta.injected, true, 'the real recall hook delivers evidence');
    assert.ok(meta.injectedMemories > 0, 'the seeded corpus produces actual memories');
    assert.equal(meta.finalVerification?.status, 'verified', 'owner evidence still passes final verification');
    assert.match(out.filter(message => message.role === 'system').map(message => message.content).join('\n'), /은빛 열쇠/);
    assert.equal(f.control.calls.length, callsBefore, 'recall does not invoke a provider');
    assert.equal(runtime.lastMemoryRecallViewer?.error || '', '');
    assert.equal(runtime.lastMemoryRecallViewer?.injectedMemories, meta.injectedMemories);
    assert.equal(runtime.lastResponseBoundaryFailure?.code || '', '');
    assert.equal(runtime.initFailure || null, null);
    const direction = await f.r.api.getNarrativeDirection({ scopeKey: meta.scopeKey });
    assert.equal(direction.schema, 'libra.planner_narrative_direction.v1');
    assert.equal(direction.scopeKey, meta.scopeKey);
  } finally { await f.r.cleanup(); }
};

test('recall delivers verified memories when the optional backup installer never settles', async () => {
  await assertRecallDelivery(replaceInstaller('return await new Promise(() => {});'));
});

test('recall delivers verified memories when the optional backup installer rejects', async () => {
  await assertRecallDelivery(replaceInstaller("throw new Error('synthetic_optional_backup_failure');"));
});

test('recall delivers verified memories with the ordinary startup path', async () => {
  await assertRecallDelivery();
});
