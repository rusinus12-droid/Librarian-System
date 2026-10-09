'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createArchiveOwnerFixture, canonicalIdentity, canonicalNonVector, plain }
  = require('./fixtures/archive_owner_fixture.cjs');
const PROGRAM = path.resolve(__dirname, '..');
const artifacts = process.env.FLASHBACK_ARCHIVE_ARTIFACTS;

for (const kind of ['source', 'Full', 'Min']) {
  test(`${kind} archive worker executes the actual unmodified consumer public route`,
    { skip: kind !== 'source' && !artifacts, timeout: 30000 }, async () => {
      const f = await createArchiveOwnerFixture();
      try {
        const sourcePath = kind === 'source' ? path.join(PROGRAM, 'plugins/Flashback_Memory.js')
          : path.join(artifacts, kind, 'plugins/Flashback_Memory.js');
        assert(fs.existsSync(sourcePath), `${kind} artifact must exist when explicitly requested`);
        const expectedInput = f.selectedRows.slice().sort((a, b) => a.chunkIndex - b.chunkIndex)
          .map(row => f.audit.prepareEmbeddingInput(row.text, 'document', f.targetSettings));
        await f.restart(sourcePath);
        assert.equal(f.context.__FlashbackEmbeddingAudit, undefined, 'consumer runtime has no injected fixture exports');
        if (kind !== 'source') assert.equal(f.api._test, undefined, 'built artifact has no private test surface');
        const before = f.snapshot(), preview = await f.archive().preview();
        assert.equal(preview.actionable, true, JSON.stringify(preview));
        assert.equal(preview.counts.eligibleRecords, f.selectedRows.length);
        assert.equal(preview.counts.eligibleGroups, 1);
        assert.equal(preview.counts.remainingGroups, 1);
        assert.equal(f.requests, 0);
        assert.equal(f.observation.writes.length, 0);
        assert.equal(f.observation.removals.length, 0);
        assert.deepEqual(f.snapshot(), before);
        const result = await f.archive().repair(preview.ticket);
        assert.equal(result.status, 'verified', JSON.stringify(result));
        assert.equal(result.archiveReembedded, f.selectedRows.length);
        assert.equal(result.provider.state, 'completed');
        assert.equal(result.candidates.state, 'verified');
        assert.equal(result.publication.state, 'verified');
        assert.equal(result.journal.state, 'verified');
        assert.equal(f.requests, 1);
        assert.deepEqual(f.observation.requests[0].body.input, expectedInput);
        assert.equal(f.observation.writes.filter(write => write.store === 'local').length, 0);
        assert.equal(f.observation.argumentWrites.length, 0);
        assert.equal(f.observation.removals.length, 0);
        f.assertProtectedUnchanged();
        const durable = f.physicalManifest(f.scope.scopeKey);
        assert.equal(durable.count, 0, 'archive rows were never materialized into active local storage');
        assert.notEqual(durable.archiveRef.archiveScopeKey, f.originalRef.archiveScopeKey);
        assert.equal(durable.archiveRef.deltaCount, f.selectedRows.length);
        assert.equal(durable.archiveRef.recordCount, f.beforeRows.length);
        assert.equal(durable.archiveRepairReceipt?.status, 'complete');
        assert.equal(durable.archiveRepairReceipt.candidateScopeKey, durable.archiveRef.archiveScopeKey);
        assert.deepEqual([...durable.archiveRepairReceipt.memberIds].sort(), f.selectedRows.map(canonicalIdentity).sort());
        assert.equal((await f.archive().repair(preview.ticket)).status, 'blocked');
        assert.equal(f.requests, 1);

        // Only a fresh source inspection VM reads private physical data. The
        // source/Full/Min action above used the public consumer route exclusively.
        await f.restart();
        const after = await f.readChain();
        assert.equal(after.verified, true);
        assert.equal(after.records, f.beforeRows.length);
        assert.equal((await f.readLocal()).length, 0);
        for (const old of f.beforeRows) {
          const row = after.recordsList.find(item => canonicalIdentity(item) === canonicalIdentity(old));
          assert(row);
          assert.deepEqual(canonicalNonVector(row), canonicalNonVector(old));
          if (old.sourceHash === f.firstSourceHash) assert.deepEqual(Array.from(row.vector), [0, 1, 0, 0]);
          else assert.deepEqual(plain(row), old);
        }
        assert.equal(f.requests, 0, 'restart inspection does not submit a second request');
      } finally { await f.dispose(); }
    });
}
