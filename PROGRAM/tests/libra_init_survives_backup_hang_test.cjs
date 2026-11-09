'use strict';
// 2026-11-09 export: recall failed open with
// "Cannot access '__LIBRA_NARRATIVE_DIRECTION_LEGACY_SCHEMA' before initialization".
// The portable-backup installer was awaited at the end of the plugin module; when that await never
// settled, everything declared after it stayed in the temporal dead zone. Recall then threw while
// normalizing narrative direction during branch reconcile and returned zero memories.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_lore_link_index_fixture.cjs');

const haltInstaller = source => {
  const anchor = 'const installLibraPortableMemoryBackup = async () => {';
  assert.ok(source.includes(anchor), 'installer anchor');
  return source.replace(anchor, `${anchor} return await new Promise(() => {});`);
};

test('recall survives an installer that never settles', async () => {
  const f = await fixture({ transformSource: haltInstaller });
  try {
    await f.run();
    f.control.onCall = async () => { throw new Error('recall must not invoke a provider'); };
    const before = JSON.stringify(f.control.hooks.beforeRequest);
    const out = await f.control.hooks.beforeRequest([{ role: 'user', content: '은빛 열쇠는 누가 맡지?' }], 'model');
    assert.ok(Array.isArray(out), 'beforeRequest returns messages');
    const meta = f.r.api.getRuntime().lastMemoryInjectionMeta || {};
    assert.equal(
      String(meta.error || '').includes('before initialization'), false,
      `recall must not hit the temporal dead zone: ${JSON.stringify(meta.error)}`
    );
    assert.equal(f.r.api.getRuntime().lastResponseBoundaryFailure?.code || '', '');
  } finally { await f.r.cleanup(); }
});
