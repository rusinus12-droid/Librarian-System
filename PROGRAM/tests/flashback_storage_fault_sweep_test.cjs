'use strict';
// Raw durability and semantic availability are different contracts. Hash is deliberately
// unconfigured. Every write outcome is inspected in a NEW VM over reopened disk stores,
// including thrown commits. A prior source/head is seeded before each fault is armed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flashback-store-sweep-'));
const disk = name => {
  const file = path.join(dir, `${name}.json`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, '{}');
  return {
    fault: null,
    get values() { return new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))); },
    getItem(key) { return this.values.get(key) ?? null; },
    setItem(key, value) {
      const outcome = this.fault?.('set', key);
      if (outcome === 'throw') throw new Error('injected_set_throw');
      if (outcome === 'false') return false;
      if (outcome === 'noop') return true;
      if (outcome === 'corrupt') value = '{"corrupted":true}';
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      rows[key] = value; fs.writeFileSync(file, JSON.stringify(rows)); return true;
    },
    removeItem(key) { const rows = JSON.parse(fs.readFileSync(file, 'utf8')); delete rows[key]; fs.writeFileSync(file, JSON.stringify(rows)); return true; },
    keys() { return [...this.values.keys()]; }
  };
};
const INITIAL = [
  { role: 'user', chatId: 'u1', data: 'I open the archive door and read the ledger aloud.' },
  { role: 'assistant', chatId: 'a1', data: 'The ledger lists three names; Alice saved the agreement in winter.' }
];
const ADDED = [
  { role: 'user', chatId: 'u2', data: 'Where is the signed duplicate?' },
  { role: 'assistant', chatId: 'a2', data: 'The signed duplicate rests in the brass drawer below the north window.' }
];
const FACT = 'signed duplicate rests in the brass drawer';
const plain = value => JSON.parse(JSON.stringify(value));
const identity = row => [row.id, row.sourceId, row.sourceHash, row.text];
const errors = [];
async function runOnce(label, fault, seeded = true) {
  const pluginStorage = disk(`${label}-p`), safeLocalStorage = disk(`${label}-l`);
  const faultHits = [], row = { label, seeded };
  let writer, fresh;
  try {
    writer = await createFixture({ pluginStorage, safeLocalStorage });
    await writer.api.saveSettings({ ...await writer.api.loadSettings(), embeddingProvider: 'hash', embeddingModel: 'hash-v1',
      embeddingEnabled: true, embeddingAutoProcess: false, autoEpisodeIndex: false, episodeIndexEnabled: false });
    if (seeded) {
      writer.currentChat.message = plain(INITIAL); writer.currentChat.messages = writer.currentChat.message;
      await writer.api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
    }
    const scope = await writer.api.resolveCurrentScope();
    const prior = await writer.api._test.loadScopeRecords(scope.scopeKey);
    assert.equal(prior.records.length, seeded ? 1 : 0, 'initial state is verified before injection');
    const priorRows = plain(prior.records.map(identity));
    const manifestKey = [...pluginStorage.values.keys()].find(key => /:manifest:v\d+$/.test(key));
    if (seeded) assert.ok(manifestKey && prior.manifest.commitId);
    const priorHead = pluginStorage.getItem(manifestKey);
    const priorShards = [...pluginStorage.values].filter(([key]) => key.includes(`:records:commit:${prior.manifest.commitId}:shard:`));
    if (seeded) assert.ok(priorShards.length, 'seeded immutable shards exist');
    if (fault) pluginStorage.fault = (op, key) => {
      if (op !== 'set') return null;
      const matches = fault.target === 'shard' ? /:records:(commit:[^:]+|shard):shard:\d{4}$/.test(key) : /:manifest:v\d+$/.test(key);
      if (!matches) return null;
      faultHits.push(key); return fault.outcome;
    };
    writer.currentChat.message = plain(seeded ? [...INITIAL, ...ADDED] : ADDED); writer.currentChat.messages = writer.currentChat.message;
    try {
      row.result = plain(await writer.api.ingestLiveChatColdStart({ scope: 'current', canonical: true }));
    } catch (error) { row.writeError = String(error.code || error.message || error); }
    await writer.dispose();
    const oldContext = writer.context; writer = null;
    // Open new store wrappers and an independent VM. Empty live chat prevents recovery
    // from silently rebuilding the lost write before durability has been checked.
    const reopened = disk(`${label}-p`);
    fresh = await createFixture({ pluginStorage: reopened, safeLocalStorage: disk(`${label}-l`), chat: { message: [], messages: [] } });
    assert.notEqual(fresh.context, oldContext, 'readback must run in a new JS VM');
    const freshScope = await fresh.api.resolveCurrentScope();
    assert.equal(freshScope.scopeKey, scope.scopeKey);
    row.freshRuntime = true;
    row.faultFired = faultHits.length;
    row.faultKeys = [...new Set(faultHits)].map(key => key.slice(-70));
    row.priorShardBytesPreserved = priorShards.every(([key, value]) => reopened.getItem(key) === value);
    row.priorHeadBytesPreserved = reopened.getItem(manifestKey) === priorHead;
    const reopenedHead = manifestKey ? reopened.getItem(manifestKey) : null;
    row.priorHeadPreserved = (typeof reopenedHead === 'string' ? JSON.parse(reopenedHead) : reopenedHead)?.commitId === prior.manifest.commitId;
    row.priorCommitId = prior.manifest.commitId;
    let loaded;
    try { loaded = await fresh.api._test.loadScopeRecords(scope.scopeKey); }
    catch (error) { row.readError = String(error.code || error.message || error); }
    row.health = plain(await fresh.api.healthRecovery.inspect());
    if (loaded) {
      row.records = loaded.records.length;
      row.manifest = plain({ commitId: loaded.manifest.commitId, manifestCorrupt: loaded.manifest.manifestCorrupt,
        missingShards: loaded.manifest.missingShards, corruptShards: loaded.manifest.corruptShards,
        recordCountMismatch: loaded.manifest.recordCountMismatch });
      row.addedRawPresent = loaded.records.some(record => record.text.includes(FACT));
      row.priorSourcePreserved = priorRows.every(before => loaded.records.some(record => JSON.stringify(identity(record)) === JSON.stringify(before)));
      assert.ok(loaded.records.every(record => record.text && record.vector.length === 0), 'raw-only storage retains text without invented hash vectors');
      const recall = await fresh.api._selectionTest.prepareFlashbackRecall('Where is the signed duplicate?', await fresh.api.loadSettings(), freshScope,
        { currentUser: 'Where is the signed duplicate?' });
      row.modelReadiness = plain(recall.modelReadiness);
      assert.equal(recall.modelReadiness.status, 'unconfigured');
      assert.equal(recall.modelReadiness.ready, false);
      assert.equal(recall.records.length, 0, 'no successful semantic/lexical result from raw-only storage');
    }
    row.explicitReadUncertainty = Boolean(row.health.known === false && row.health.status === 'unknown' || row.readError || loaded?.manifest.manifestCorrupt || loaded?.manifest.missingShards || loaded?.manifest.corruptShards || loaded?.manifest.recordCountMismatch);
    if (fault) assert.equal(row.priorShardBytesPreserved, true, 'failed new writes must not overwrite old source shards');
    assert.ok(row.priorSourcePreserved || row.explicitReadUncertainty, 'prior source must survive or fresh read must explicitly report uncertainty');
    if (row.explicitReadUncertainty) assert.notEqual(row.health.status, 'no_detected_issue', 'uncertain read must not be reported healthy');
    if (fault) {
      assert.ok(row.faultFired > 0, 'the requested fault must actually fire');
      assert.ok(row.writeError, 'every hostile write outcome must report failure, never apparent success');
      assert.equal(row.result, undefined, 'a failed commit has no success summary');
      assert.equal(row.addedRawPresent, false, 'rejected new source must not appear as a committed success');
      if (fault.target === 'manifest' && fault.outcome === 'corrupt') {
        assert.equal(row.health.status, 'unknown', 'malformed manifest is explicitly unknown after restart');
        assert.equal(row.health.known, false);
        assert.equal(row.health.complete, false);
        assert.ok(row.health.issues.some(issue => issue.code === 'OWNER_METADATA_UNVERIFIED'));
      } else if (seeded) {
        assert.equal(row.priorSourcePreserved, true, 'non-destructive injected fault preserves exact old source');
        assert.equal(row.priorHeadPreserved, true, 'non-destructive injected fault preserves old commit identity');
        assert.equal(row.explicitReadUncertainty, false);
        assert.equal(row.records, prior.records.length);
      }
      assert.ok(!seeded || row.priorHeadPreserved || row.explicitReadUncertainty, 'failed commit preserves old head or explicitly flags unknown/corrupt storage');
    } else {
      assert.equal(row.writeError, undefined);
      assert.equal(row.addedRawPresent, true);
      assert.equal(row.priorSourcePreserved, true);
      assert.equal(row.explicitReadUncertainty, false);
      assert.equal(row.records, seeded ? 2 : 1);
    }
  } catch (error) { row.assertion = String(error.stack || error); errors.push(label); }
  finally { await writer?.dispose(); await fresh?.dispose(); }
  return row;
}
(async () => {
  const results = [];
  for (const seeded of [false, true]) {
    const prefix = seeded ? 'existing-head' : 'first-commit';
    results.push(await runOnce(`${prefix}-healthy`, null, seeded));
    for (const target of ['shard', 'manifest']) for (const outcome of ['throw', 'false', 'noop', 'corrupt'])
      results.push(await runOnce(`${prefix}-${target}-${outcome}`, { target, outcome }, seeded));
  }
  console.log(JSON.stringify({ test: 'flashback_storage_fault_sweep', results, assertionFailures: errors }, null, 2));
  assert.deepEqual(errors, [], 'all fault cases must meet restart integrity and truthful reporting contracts');
  assert.equal(results.filter(row => row.freshRuntime).length, 18, 'two healthy baselines plus all sixteen faults reached actual fresh-runtime readback');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
