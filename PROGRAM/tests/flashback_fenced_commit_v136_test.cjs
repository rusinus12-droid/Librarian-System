'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flashback-fenced-'));
const results = [];
const test = async (name, fn) => { await fn(); results.push(name); console.log('PASS', name); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const initial = [{ role:'user', chatId:'u1', data:'Open the archive.' }, { role:'assistant', chatId:'a1', data:'Alice saved the agreement.' }];
const rawTexts = rows => Array.from(rows, r => r.text);
// Startup/worldline maintenance is real production work. Wait only for BUSY
// in non-race setup; never retry a dispatched/indeterminate mutation or conflict.
const afterBackgroundWriter = async fn => {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (error) {
      if (i >= 100 || !/FLASHBACK_WRITER_BUSY/.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
};
// Only setup acquisitions may wait for a competing, already-owned writer.
// An explicit BUSY response proves this owner acquired nothing; transport errors,
// other conflicts and any dispatched mutation are never retried by this helper.
const acquireFixtureWriter = async (send, key, owner) => {
  const outcome = await afterBackgroundWriter(async () => {
    // Keep transport rejections outside the generic BUSY matcher, even if an
    // ambiguous transport error happens to contain that text.
    let reply;
    try { reply = { value:await send('/v1/flashback/writer', { action:'acquire', key, owner }) }; }
    catch (error) { return { failed:true, error }; }
    if (!reply.failed && reply.value?.status === 409 && reply.value.ok === false && reply.value.error === 'FLASHBACK_WRITER_BUSY') {
      throw new Error('FLASHBACK_WRITER_BUSY');
    }
    return reply;
  });
  if (outcome.failed) throw outcome.error;
  return outcome.value;
};
let app, url, fixtures = [], fault = null, legacyCalls = 0;
const writerTrace = [];
const transport = async (u, init) => {
  assert.equal(new URL(u).hostname, '127.0.0.1', 'fence fixture permits disposable loopback server only');
  const go = async () => {
    const r = await fetch(u, init);
    if (u.endsWith('/v1/flashback/writer')) {
      const body = JSON.parse(init.body);
      writerTrace.push({ action:body.action, owner:body.owner, epoch:body.epoch, response:await r.clone().json() });
    }
    return r;
  };
  return fault ? await fault(u, init, go) : await go();
};
async function fixture(mode = 'server_only', options = {}) {
  const f = await createFixture({ arguments:{ memory_suite_server_mode:mode, memory_suite_server_url:url }, nativeFetch:transport, exposeStorageBridge:true, ...options });
  fixtures.push(f);
  return f;
}
async function client(base = url) {
  const boot = await fetch(base + '/bootstrap', { headers:{ 'X-Memory-Suite-Plugin':'flashback_memory' } }).then(r => r.json());
  return async (route, body) => {
    const r = await fetch(base + route, { method:'POST', headers:{ Authorization:`Bearer ${boot.token}`, 'X-Memory-Suite-Plugin':'flashback_memory', 'Content-Type':'application/json' }, body:JSON.stringify(body) });
    return { status:r.status, ...await r.json() };
  };
}
(async () => {
  try {
    app = createMemorySuiteServer({ host:'127.0.0.1', port:0, dataDir:root, autoBackup:false });
    url = `http://127.0.0.1:${(await app.listen()).port}`;
    const a = await fixture();
    const cfg = { ...await a.api.loadSettings(), embeddingProvider:'hash', embeddingModel:'hash-v1', embeddingEnabled:true, autoEpisodeIndex:false };
    await a.api.saveSettings(cfg);
    a.currentChat.message = structuredClone(initial); a.currentChat.messages = a.currentChat.message;
    await a.api.ingestLiveChatColdStart({ scope:'current', canonical:true });
    const scope = await a.api.resolveCurrentScope();
    const records = async f => (await f.api._test.loadScopeRecords(scope.scopeKey)).records;
    const old = await records(a);
    // Create replacement source revisions through the same builder as ingestion.
    // Carry no old work envelope across changed text: the builder binds fresh work.
    const revised = async (f, rows, suffix) => f.api._test.buildRecordsFromSources(rows.map(r => ({
      sourceType: 'response', sourceId: r.sourceId, text: r.text + suffix,
      turnIndex: r.turnIndex, pairIndex: r.pairIndex, sanitizeMemory: false
    })), cfg, scope, { deferEmbedding: true });
    assert.equal(old.length, 1);
    const manifest = await a.api._test.loadScopeManifest(scope);
    const key = `vector_rag_memory:scope:${manifest.storageHash}:manifest:v2`;
    const send = await client();
    await test('actual plugin commits manifest and recovery pointer atomically on SQLite', async () => {
      const row = app.repositories.flashback.get('plugin', key);
      assert.equal(JSON.parse(row.value).count, 1);
      const backup = JSON.parse(app.repositories.flashback.get('plugin', key + ':previous:v1').value);
      assert.equal(backup.raw, row.value);
      assert.ok(app.repositories.flashback.database.prepare('SELECT epoch FROM flashback_writer_fences').all().length);
    });
    const b = await fixture('server_only', { chat:structuredClone(a.currentChat) });
    await test('metadata prepared before another commit cannot overwrite the newer manifest', async () => {
      const stale = await a.api._test.loadScopeManifest(scope);
      await afterBackgroundWriter(async () => b.api._test.saveScopeManifest({ ...await b.api._test.loadScopeManifest(scope), episodeCount:7 }, scope));
      await assert.rejects(() => afterBackgroundWriter(() => a.api._test.saveScopeManifest({ ...stale, episodeCount:99 }, scope)), /FLASHBACK_COMMIT_CONFLICT/);
      assert.equal((await a.api._test.loadScopeManifest(scope)).episodeCount, 7);
    });
    await test('changed source cannot reuse retained embedding work or alter the durable corpus', async () => {
      const before = rawTexts(await records(a));
      await assert.rejects(() => a.api._test.saveAllRecords(old.map(r => ({ ...r, text: r.text + ' INVALID_BINDING' })), cfg, scope),
        error => error.code === 'FLASHBACK_RAW_EMBEDDING_BINDING_INVALID');
      assert.deepEqual(rawTexts(await records(a)), before);
    });
    await test('two isolated plugin VMs cannot both overwrite the same corpus', async () => {
      const gate = deferred(), entered = deferred(); let hit = false;
      fault = async (u, init, go) => {
        if (!hit && u.endsWith('/v1/kv/batch')) { hit = true; entered.resolve(); await gate.promise; }
        return await go();
      };
      const pending = a.api._test.saveAllRecords(await revised(a, old, ' WINNER_A'), cfg, scope);
      try {
        await entered.promise;
        await assert.rejects(async () => b.api._test.saveAllRecords(await revised(a, old, ' LOSER_B'), cfg, scope), /FLASHBACK_WRITER_BUSY/);
      } finally { gate.resolve(); await pending; fault = null; }
      assert.ok(rawTexts(await records(b))[0].includes('WINNER_A'));
      assert.ok(!rawTexts(await records(b))[0].includes('LOSER_B'));
    });
    await test('lost commit reply resolves the same durable receipt without a second batch', async () => {
      let batches = 0, lost = false;
      fault = async (u, init, go) => { const out = await go(); if (u.endsWith('/v1/kv/batch')) { batches++; if (!lost) { lost = true; throw Error('network connection lost after committed response'); } } return out; };
      try { await a.api._test.saveAllRecords(await revised(a, await records(a), ' ACK_RECOVERED'), cfg, scope); }
      finally { fault = null; }
      assert.equal(batches, 1);
      assert.ok(rawTexts(await records(b))[0].includes('ACK_RECOVERED'));
    });
    await test('late real HTTP mutation is rejected after lease release and newer commit', async () => {
      const owner = 'late-owner-0000000001';
      const acquired = await acquireFixtureWriter(send, key, owner);
      assert.equal(acquired.status, 200);
      const stale = { namespace:'flashback', space:'plugin', key, value:'STALE', operationId:'late-mutation-00000001', fence:acquired.result };
      assert.equal((await send('/v1/flashback/writer', { action:'release', key, ...acquired.result })).status, 200);
      await a.api._test.saveAllRecords(await revised(a, await records(a), ' NEWER_B'), cfg, scope);
      assert.equal((await send('/v1/kv/set', stale)).status, 409);
      assert.ok(rawTexts(await records(b))[0].includes('NEWER_B'));
    });
    await test('timed-out production batch stays fenced when its HTTP request eventually arrives', async () => {
      const gate = deferred(); let late, operation;
      fault = async (u, init, go) => {
        if (!late && u.endsWith('/v1/kv/batch')) {
          operation = JSON.parse(init.body).operationId;
          late = gate.promise.then(go).then(async r => ({ status:r.status, body:await r.json() }));
          throw Error('INJECTED_TIMEOUT_WITH_REQUEST_STILL_IN_FLIGHT');
        }
        return await go();
      };
      try {
        await assert.rejects(async () => a.api._test.saveAllRecords(await revised(a, old, ' LATE_A'), cfg, scope));
        assert.ok(late); assert.ok(operation);
        fault = null;
        for (let i = 0; i < 200; i++) {
          const row = app.repositories.flashback.database.prepare('SELECT owner FROM flashback_writer_fences WHERE alias=?').get(manifest.storageHash);
          if (!row?.owner) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        await afterBackgroundWriter(async () => b.api._test.saveAllRecords(await revised(b, await records(b), ' AFTER_TIMEOUT_B'), cfg, scope));
        gate.resolve();
        assert.equal((await late).status, 409);
        assert.equal(app.repositories.flashback.operation(operation), null);
        assert.ok(rawTexts(await records(a))[0].includes('AFTER_TIMEOUT_B'));
      } finally { fault = null; gate.resolve(); if (late) await late; }
    });
    await test('manifest backup SQL failure rolls back the head and receipt together', async () => {
      const before = app.repositories.flashback.get('plugin', key).value;
      let attemptedOperation;
      fault = async (u, init, go) => { if (u.endsWith('/v1/kv/batch')) attemptedOperation = JSON.parse(init.body).operationId; return await go(); };
      app.repositories.flashback.database.exec("CREATE TEMP TRIGGER fail_manifest_backup BEFORE INSERT ON kv WHEN NEW.key LIKE '%:manifest:v2:previous:v1' BEGIN SELECT RAISE(ABORT,'INJECTED_BACKUP_DISK_FAILURE'); END;");
      try { await assert.rejects(async () => a.api._test.saveAllRecords(await revised(a, old, ' PARTIAL'), cfg, scope)); }
      finally { fault = null; app.repositories.flashback.database.exec('DROP TRIGGER fail_manifest_backup'); }
      assert.ok(attemptedOperation, 'valid source fixture must reach the SQL batch');
      assert.equal(app.repositories.flashback.operation(attemptedOperation), null, 'failed atomic batch leaves no success receipt');
      assert.equal(app.repositories.flashback.get('plugin', key).value, before);
      assert.equal(JSON.parse(app.repositories.flashback.get('plugin', key + ':previous:v1').value).raw, before);
    });
    await test('legacy set/remove and conditional batch cannot bypass an activated fence', async () => {
      const row = app.repositories.flashback.get('plugin', key);
      for (const kind of ['set','remove']) {
        const out = await send('/v1/kv/' + kind, { namespace:'flashback', operationId:'old-writer-' + kind + '-00001', space:'plugin', key, ...(kind === 'set' ? { value:'LEGACY' } : {}) });
        assert.equal(out.status, 409); assert.equal(out.error, 'FLASHBACK_WRITER_FENCED');
      }
      const out = await send('/v1/kv/batch', { namespace:'flashback', operationId:'old-batch-writer-00001', mutations:[{ kind:'set', space:'plugin', key, value:'LEGACY', expectedRevision:row.revision, expectedDigest:row.digest, expectedExists:true, expectedTombstone:false }] });
      assert.equal(out.status, 409);
      assert.equal(app.repositories.flashback.get('plugin', key).value, row.value);
    });
    await test('expired writer and re-acquired epoch never authorize an old request', async () => {
      const first = (await acquireFixtureWriter(send, key, 'expire-owner-0000001')).result;
      app.repositories.flashback.database.prepare('UPDATE flashback_writer_fences SET expires_at=0 WHERE alias=?').run(first.alias);
      const second = (await acquireFixtureWriter(send, key, 'expire-owner-0000002')).result;
      assert.ok(second.epoch > first.epoch);
      assert.equal((await send('/v1/kv/set', { namespace:'flashback', operationId:'expired-set-00000001', space:'plugin', key, value:'EXPIRED', fence:first })).status, 409);
      assert.equal((await send('/v1/flashback/writer', { action:'release', key, ...first })).status, 409);
      await send('/v1/flashback/writer', { action:'release', key, ...second });
    });
    await test('same-VM nested and overlapping users share acquisition and hold it until all finish', async () => {
      const bridge = a.context.__fixtureStorageBridge, entered = deferred(), gate = deferred();
      let acquisitions = 0;
      fault = async (u, init, go) => { if (u.endsWith('/v1/flashback/writer') && JSON.parse(init.body).action === 'acquire') acquisitions++; return await go(); };
      const first = bridge.withFlashbackWriter(key, async () => { entered.resolve(); await gate.promise; });
      try {
        await entered.promise;
        await bridge.withFlashbackWriter(key, async () => bridge.withFlashbackWriter(key, async () => true));
        assert.equal(acquisitions, 1);
        assert.ok(app.repositories.flashback.database.prepare('SELECT owner FROM flashback_writer_fences WHERE alias=?').get(manifest.storageHash).owner);
      } finally { gate.resolve(); await first; fault = null; }
      assert.equal(app.repositories.flashback.database.prepare('SELECT owner FROM flashback_writer_fences WHERE alias=?').get(manifest.storageHash).owner, '');
    });
    await test('manager deletion respects active writers and cannot remove persistent protection', async () => {
      const itemKey = key.replace(':manifest:v2', ':fixture-gc');
      const lease = (await acquireFixtureWriter(send, key, 'manager-test-owner-0001')).result;
      assert.equal((await send('/v1/kv/set', { namespace:'flashback', operationId:'gc-seed-0000001', space:'plugin', key:itemKey, value:'fixture', fence:lease })).status, 200);
      const row = app.repositories.flashback.get('plugin', itemKey);
      const mutation = { kind:'purge', space:'plugin', key:itemKey, expectedRevision:row.revision, expectedDigest:row.digest, expectedExists:true, expectedTombstone:false };
      assert.throws(() => app.repositories.flashback.applyConditionalBatch([mutation], { maintenance:true }), /FLASHBACK_WRITER_BUSY/);
      await send('/v1/flashback/writer', { action:'release', key, ...lease });
      app.repositories.flashback.applyConditionalBatch([mutation], { maintenance:true });
      assert.equal(app.repositories.flashback.get('plugin', itemKey).exists, false);
      assert.equal((await send('/v1/kv/set', { namespace:'flashback', operationId:'gc-old-revive-000001', space:'plugin', key:itemKey, value:'old' })).status, 409);
    });
    await test('two actual server processes enforce one shared SQLite writer and revocation', async () => {
      const child = fork(path.join(__dirname, 'fixtures/server_atomic_batch_child.cjs'), [root], { stdio:['ignore','ignore','pipe','ipc'] });
      try {
        const [address] = await once(child, 'message');
        const other = await client(`http://127.0.0.1:${address.port}`);
        const first = (await acquireFixtureWriter(send, key, 'process-owner-00001')).result;
        assert.equal((await other('/v1/flashback/writer', { action:'acquire', key, owner:'process-owner-00002' })).status, 409);
        await send('/v1/flashback/writer', { action:'release', key, ...first });
        const second = (await acquireFixtureWriter(other, key, 'process-owner-00002')).result;
        assert.ok(second.epoch > first.epoch);
        assert.equal((await send('/v1/kv/set', { namespace:'flashback', space:'plugin', key, value:'STALE_PROCESS', operationId:'stale-process-000001', fence:first })).status, 409);
        await other('/v1/flashback/writer', { action:'release', key, ...second });
      } finally { const exit = once(child, 'exit'); child.send({ kind:'close' }); await exit; }
    });
    await test('a rejected real capture keeps its pending input and can retry without losing either turn', async () => {
      const one = await fixture('server_only', { characterId:'capture-race-character', chat:{ id:'capture-race-chat', chatId:'capture-race-chat' } });
      await one.api.saveSettings(cfg);
      one.currentChat.message = structuredClone(initial); one.currentChat.messages = one.currentChat.message;
      await one.api.ingestLiveChatColdStart({ scope:'current', canonical:true });
      const two = await fixture('server_only', { characterId:'capture-race-character', chat:structuredClone(one.currentChat) });
      await two.api.saveSettings(cfg);
      const prepare = async (f, n) => {
        f.currentChat.message = structuredClone(initial);
        for (let i = 2; i < n; i++) f.currentChat.message.push({ role:'user', chatId:'u'+i, data:'Request '+i }, { role:'assistant', chatId:'a'+i, data:'COMMIT_TURN_'+i });
        f.currentChat.message.push({ role:'user', chatId:'u'+n, data:'Request '+n }); f.currentChat.messages = f.currentChat.message;
        await f.api._test.beforeRequest(f.currentChat.message.map(m => ({ role:m.role, chatId:m.chatId, content:m.data })), 'model');
        f.currentChat.message.push({ role:'assistant', chatId:'a'+n, data:'COMMIT_TURN_'+n });
      };
      const capture = f => f.api._test.processRisuChatOutputEvent({ char:f.character, chat:f.currentChat, characterIndex:0, chatIndex:0, messageIndex:f.currentChat.message.length - 1 });
      await prepare(one, 2); await prepare(two, 3);
      const gate = deferred(), entered = deferred(); let hit = false;
      fault = async (u, init, go) => { if (!hit && u.endsWith('/v1/kv/batch')) { hit = true; entered.resolve(); await gate.promise; } return await go(); };
      const pending = capture(one);
      // Observe rejection immediately while waiting for the injected batch gate.
      // The original pending promise is still awaited in finally, so failures
      // remain failures instead of escaping as an unhandled rejection.
      const pendingBeforeEntry = pending.then(() => { throw new Error('capture_completed_before_fixture_gate'); });
      try {
        await Promise.race([entered.promise, pendingBeforeEntry]);
        const rejected = await capture(two).catch(error => ({ error:error.message }));
        assert.notEqual(rejected.captured, 1);
        assert.ok(two.api._test.pendingCaptureRuntimeSnapshot().pendingTurns.length > 0);
      } finally { gate.resolve(); await pending; fault = null; }
      const retried = await capture(two);
      assert.equal(retried.captured, 1, JSON.stringify(retried));
      assert.equal(two.api.getReanalysisStatus().error,'','capture retry must not leave an explicit reanalysis error');
      const captureScope = await two.api.resolveCurrentScope();
      const after = rawTexts((await two.api._test.loadScopeRecords(captureScope.scopeKey)).records);
      assert.ok(after.some(t => t.includes('COMMIT_TURN_2')));
      assert.ok(after.some(t => t.includes('COMMIT_TURN_3')));
    });
    await test('mirror with lying local storage reads canonical server data and rejects offline commit', async () => {
      const values = new Map();
      const fake = { values, async getItem(k) { legacyCalls++; return values.get(k) ?? null; }, async setItem(k,v) { legacyCalls++; values.set(k,v); return true; }, async removeItem(k) { values.delete(k); return true; }, async keys() { return [...values.keys()]; } };
      const mirror = await fixture('mirror', { pluginStorage:fake, chat:structuredClone(a.currentChat) });
      // This case tests mirror readback, after startup/background writers finish.
      // The earlier race cases separately require concurrent writes to be rejected.
      await afterBackgroundWriter(async () => mirror.api._test.saveAllRecords(await revised(a, await records(a), ' SERVER_DURABLE'), cfg, scope));
      const canonical = app.repositories.flashback.get('plugin', key).value;
      values.set(key, JSON.stringify({ ...JSON.parse(canonical), commitId:'STALE_LOCAL_MIRROR' }));
      const sync = await mirror.context.__fixtureStorageBridge.synchronizeNow().catch(error => ({ error:error.message, details:error.details }));
      assert.match(JSON.stringify(sync), /flashback_server_canonical_mismatch|conflict/i);
      assert.equal(app.repositories.flashback.get('plugin', key).value, canonical);
      values.clear();
      assert.ok(rawTexts(await records(mirror))[0].includes('SERVER_DURABLE'));
      fault = async () => { throw Error('INJECTED_SERVER_OFFLINE'); };
      try { await assert.rejects(() => mirror.api._test.saveAllRecords(old, cfg, scope)); }
      finally { fault = null; }
      assert.ok(rawTexts(await records(a))[0].includes('SERVER_DURABLE'));
    });
    if (process.env.FLASHBACK_LEGACY_SOURCE) await test('actual prior release cannot overwrite the protected server corpus', async () => {
      const source = fs.readFileSync(process.env.FLASHBACK_LEGACY_SOURCE, 'utf8');
      const before = rawTexts(await records(a));
      const legacy = await fixture('server_only', { source, chat:structuredClone(a.currentChat) });
      await assert.rejects(async () => legacy.api._test.saveAllRecords(await revised(a, old, ' OLD_VERSION'), cfg, scope));
      assert.deepEqual(rawTexts(await records(a)), before);
    });
    await test('fresh server and fresh plugin recover the raw corpus and persistent write protection', async () => {
      const before = rawTexts(await records(a));
      for (const f of fixtures) await f.dispose(); fixtures = [];
      await app.close();
      app = createMemorySuiteServer({ host:'127.0.0.1', port:0, dataDir:root, autoBackup:false });
      url = `http://127.0.0.1:${(await app.listen()).port}`;
      const fresh = await fixture('server_only', { chat:{ message:initial, messages:initial } });
      assert.deepEqual(rawTexts(await records(fresh)), before);
      const nextSend = await client();
      assert.equal((await nextSend('/v1/kv/set', { namespace:'flashback', operationId:'restart-old-write-00001', space:'plugin', key, value:'OLD' })).status, 409);
    });
    console.log(JSON.stringify({ passed:results.length, results, legacyHostCalls:legacyCalls, boundary:'real local HTTP and SQLite; isolated production plugin VMs; external provider and RisuAI GUI NOT_RUN' }));
  } finally {
    fault = null; for (const f of fixtures) await f.dispose(); if (app) await app.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive:true, force:true });
  }
})().catch(error => { console.error(error); console.error(JSON.stringify(writerTrace.slice(-15), null, 2)); process.exitCode = 1; });
