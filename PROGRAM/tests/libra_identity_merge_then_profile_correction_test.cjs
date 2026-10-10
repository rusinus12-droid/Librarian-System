'use strict';

const assert = require('node:assert/strict');
const { lineageFixture } = require('./fixtures/libra_unified_lineage_fixture.cjs');

const person = (fixture, name) => fixture.head().characters.find(row => row.name === name);
const info = value => JSON.stringify(value);
const results = [];

async function test(name, fn) {
  const fixture = await lineageFixture();
  try {
    await fixture.run();
    await fn(fixture);
    results.push(name);
    process.stdout.write(`PASS ${name}\n`);
  } finally {
    await fixture.r.cleanup();
  }
}

(async () => {
  await test('identity merge stays active when merged target receives profile correction', async fixture => {
    const source = person(fixture, '지호');
    const target = person(fixture, '준호');
    const providerCalls = fixture.control.calls.length;
    const preview = await fixture.r.api.previewWorldManagerIdentityMerge({
      sourceId: source.id,
      targetId: target.id
    });
    const merged = await fixture.r.api.mergeWorldManagerIdentity({
      ...preview,
      fieldChoices: {},
      relationChoices: {}
    });
    assert.equal(merged.ok, true, info(merged));
    const mergeId = merged.correctionId;
    assert.ok(mergeId, 'identity merge must return its correction id');
    assert.equal(fixture.head().characters.length, 2);

    const profile = await fixture.r.api.addWorldManagerCorrection({
      anchorTurn: 5,
      target: { domain: 'characters' },
      patch: {
        characters: [{
          id: target.id,
          set: { condition: '병합 후 프로필 교정' }
        }]
      }
    });
    assert.equal(profile.ok, true, info(profile));
    assert.notEqual(profile.correctionId, mergeId);
    assert.equal(person(fixture, '준호').state.condition, '병합 후 프로필 교정');

    const listed = await fixture.r.api.listWorldManagerCorrections({ status: 'all', limit: 20 });
    const mergeRow = listed.items.find(row => row.correctionId === mergeId);
    const profileRow = listed.items.find(row => row.correctionId === profile.correctionId);
    assert.ok(mergeRow, 'identity merge must remain queryable');
    assert.ok(profileRow, 'profile correction must remain queryable');
    assert.equal(mergeRow.status, 'active');
    assert.notEqual(profileRow.supersedes, mergeId, 'profile correction must not supersede identity merge');
    assert.notEqual(profileRow.supersededCorrectionId, mergeId, 'legacy supersede field must stay clear');

    const rebuilt = await fixture.r.api.rebuildWorldManagerState();
    assert.equal(rebuilt.ok, true, info(rebuilt));
    assert.equal(person(fixture, '준호').state.condition, '병합 후 프로필 교정');
    assert.equal(fixture.head().characters.length, 2);

    const suspended = await fixture.r.api.setWorldManagerCorrectionStatus(mergeId, 'suspended');
    assert.equal(suspended.ok, true, info(suspended));
    assert.equal(fixture.head().characters.length, 3);
    assert.equal(person(fixture, '준호').state.condition, '병합 후 프로필 교정');
    const suspendedList = await fixture.r.api.listWorldManagerCorrections({ status: 'all', limit: 20 });
    assert.equal(suspendedList.items.find(row => row.correctionId === mergeId)?.status, 'suspended');
    assert.equal(suspendedList.items.find(row => row.correctionId === profile.correctionId)?.status, 'active');

    const resumed = await fixture.r.api.setWorldManagerCorrectionStatus(mergeId, 'active');
    assert.equal(resumed.ok, true, info(resumed));
    assert.equal(fixture.head().characters.length, 2);
    assert.equal(person(fixture, '준호').state.condition, '병합 후 프로필 교정');
    assert.equal(fixture.control.calls.length, providerCalls, 'correction/replay must not call provider');
  });

  process.stdout.write(`${JSON.stringify({
    test: 'libra_identity_merge_then_profile_correction',
    passed: results.length,
    results,
    boundary: 'full deployed LIBRA plugin; synthetic source/model; no live provider'
  })}\n`);
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
