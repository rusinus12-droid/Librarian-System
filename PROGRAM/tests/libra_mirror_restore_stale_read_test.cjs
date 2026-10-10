'use strict';
// Root-cause guard for `portable_backup_post_restore_mismatch` in mirror mode.
//
// THE DEFECT
//
// `restoreEnvelope` writes every envelope record, then re-reads each one through `adapter.get(key)`
// and throws when the re-read differs:
//
//     const readback = await adapter.get(record.key);
//     if (!equalValues(readback, value)) throw new Error(`portable_backup_..._mismatch:${record.key}`);
//
// In mirror mode that read is NOT passive, BY DESIGN. `scopedGet` resolves an authoritative mirror
// route and calls `mirrorServerRow`, which writes the local copy FROM the server row — the comment
// on that function states why: "The SQLite commit is authoritative. A failed local copy must never
// trigger another server commit or upload an older local Head on a later read/sync."
//
// So the verify read can legitimately observe the PREVIOUS server row: the record's push may still
// be unacknowledged, or a push may have failed and left `local_ahead`. The verify step then reports
// a mismatch for a restore that was in fact correct, and the rollback undoes it. The `manifest`
// record fails first because it is the largest record (slowest push) and is written early
// (recordRank 30, before ledger/registry).
//
// WHAT THIS TEST DOES
//
// The real flake needs a live push/serve race, so it cannot be reproduced on demand. This test
// FORCES the exact state the race produces — the first verify read of the manifest returning the
// pre-restore value — through `transformSource`, then asserts restore still succeeds. That is
// deterministic, and it is the state that used to throw.
//
//   1. With the pre-restore manifest injected as a stale first read, the restore must NOT throw
//      `portable_backup_post_restore_mismatch` for a record whose stored value is in fact correct.
//   2. The repair must be bounded and observable: at most one re-publish per record, and the count
//      reported in the result (`repaired`).
//   3. The read path must stay untouched — only the failing path pays extra I/O — because adding
//      I/O to the mirror read interleaves with the bridge's local/server sequence and breaks the
//      3-mode parity contract (a defect already documented in the source).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

// Inject a stale first read for the manifest record, once.
const STALE_HOOK = [
  'let actual = await adapter.get(record.key);',
  'if (globalThis.__staleOnce === true && String(record.key).endsWith(":manifest")) {',
  '  globalThis.__staleOnce = false;',
  '  actual = globalThis.__staleValue;',
  '}'
].join('\n');

const transformSource = source => {
  assert.ok(source.includes('let actual = await adapter.get(record.key);'),
    'the verify read anchor must exist in the plugin source');
  return source.replace('let actual = await adapter.get(record.key);', STALE_HOOK);
};

(async () => {
  const { serverFixture } = require(path.join(__dirname, 'fixtures', 'libra_server_runtime_fixture.cjs'));

  // Premise checks against the shipped source (the read path is deliberately non-passive).
  assert.match(PLUGIN, /portable_backup_post_restore_mismatch:\$\{record\.key\}/, 'verify loop must exist');
  assert.match(PLUGIN, /The SQLite commit is authoritative/, 'the mirror read contract must still be documented');
  // The repair must exist and be bounded to the failing path.
  assert.match(PLUGIN, /repaired\.push\(record\.key\)/, 'the verify loop must repair a stale first read');
  assert.match(PLUGIN, /repaired: repaired\.length/, 'the repair count must be reported');
  // Boundedness: exactly one re-publish attempt per record — no loop over retries.
  assert.ok(!/while\s*\(.*repaired/.test(PLUGIN), 'the repair must not loop');

  const snapshot = await serverFixture({ mode: 'mirror', transformSource });
  try {
    await snapshot.f.r.api.runManualColdStart({});
    let portable = null;
    for (let i = 0; i < 500; i += 1) {
      if (snapshot.f.r.context.__LIBRAPortableMemoryBackup) { portable = snapshot.f.r.context.__LIBRAPortableMemoryBackup; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(portable, 'the portable API must appear');

    const retry = async operation => {
      for (let i = 0; i < 40; i += 1) {
        try { return await operation(); } catch (error) {
          if (!/BUSY/.test(String(error?.code || ''))) throw error;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
      throw new Error('scope stayed busy');
    };

    const envelope = await retry(() => portable.exportCurrentScope());
    const manifestBefore = snapshot.getManifest();
    assert.ok(manifestBefore, 'the scope must have a committed manifest to back up');

    // Arm the hook: the first verify read of the manifest returns the PRE-restore value, which is
    // exactly what an unacknowledged push produces.
    snapshot.f.r.context.__staleValue = manifestBefore;
    snapshot.f.r.context.__staleOnce = true;

    const restored = await retry(() => portable.restoreCurrentScope(envelope));

    assert.equal(restored?.ok, true,
      'a restore whose record is correctly stored must not fail because a verify read observed a stale server row');
    assert.equal(restored?.repaired, 1,
      'the stale first read must be repaired exactly once and reported');
    assert.equal(restored?.verified, envelope.records.length,
      'every record must end up verified');

    // And the stored manifest must really equal the envelope's, not merely be "not throwing".
    const manifestAfter = snapshot.getManifest();
    const envelopeManifest = envelope.records.find(record => String(record.key).endsWith(':manifest'));
    const expected = typeof envelopeManifest.value === 'string' ? JSON.parse(envelopeManifest.value) : envelopeManifest.value;
    assert.equal(JSON.stringify(manifestAfter), JSON.stringify(expected),
      'storage must equal the envelope after the repair');

    console.log(JSON.stringify({
      test: 'libra_mirror_restore_stale_read',
      staleFirstReadForced: true,
      restoreOk: true,
      repairedCount: restored.repaired,
      verifiedCount: restored.verified,
      storageEqualsEnvelope: true
    }, null, 1));
    process.stdout.write('libra_mirror_restore_stale_read_test: PASS\n');
  } finally {
    await snapshot.cleanup();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
