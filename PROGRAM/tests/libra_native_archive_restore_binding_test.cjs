'use strict';
// Synthetic request-handler integration, NOT live HTTP: no listener, socket,
// network, model or worker is used. Real server source runs without edits;
// test-only appended hooks substitute only backup-worker dispatch and inject a
// restore-journal fault. The unchanged backup worker body snapshots real SQLite
// fixtures in-process. Every DATA directory and credential is temporary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Module, createRequire } = require('node:module');
const { test } = require('node:test');
require('node:worker_threads').Worker = class { constructor() { throw Error('BINDING_TEST_WORKER_FORBIDDEN'); } };
const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server/server.cjs');
const workerPath = path.join(root, 'server/backup_worker.cjs');
const serverSource = fs.readFileSync(serverPath, 'utf8');
const workerSource = fs.readFileSync(workerPath, 'utf8');
const workerRequire = createRequire(workerPath);
const route = '/v1/admin/libra/native-archive-repair';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => {
  const body = JSON.stringify(value); let hash = 2166136261;
  for (let i = 0; i < body.length; i++) { hash ^= body.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  hash ^= 31; hash = Math.imul(hash, 16777619);
  return `${(hash >>> 0).toString(16).padStart(8, '0')}:${body.length + 1}`;
};
function loadServer() {
  const loaded = new Module(serverPath, module);
  loaded.filename = serverPath;
  loaded.paths = Module._nodeModulePaths(path.dirname(serverPath));
  loaded._compile(serverSource + `\nmodule.exports.__fixtureHooks = {
    setBackupRunner: runner => { createBackupStoresInWorker = runner; },
    getJournalWriter: () => writeRestoreJournal,
    setJournalWriter: writer => { writeRestoreJournal = writer; }
  };\n`, serverPath);
  return loaded.exports;
}
async function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libra-repair-binding-'));
  const loaded = loadServer();
  let app, backups = 0;
  const snapshot = async tasks => {
    backups++;
    for (const task of tasks) for (const key of ['sourcePath', 'targetPath']) {
      assert(path.resolve(task[key]).startsWith(dir + path.sep), 'fixture-only backup path');
    }
    let result;
    vm.runInNewContext(workerSource, {
      require(name) {
        if (name === 'node:worker_threads') return { workerData: { tasks }, parentPort: { postMessage(value) { result = value; } } };
        return workerRequire(name);
      },
      Buffer, process: { exitCode: 0 }
    }, { filename: workerPath });
    assert.equal(result?.ok, true, result?.error);
    return result.stores;
  };
  loaded.__fixtureHooks.setBackupRunner(snapshot);
  try {
    app = loaded.createMemorySuiteServer({ dataDir: dir, host: '127.0.0.1', port: 0,
      autoBackup: false, computeEnabled: false, token: crypto.randomBytes(32).toString('hex') });
    assert.equal(app.server.listening, false);
    const handlers = app.server.listeners('request');
    assert.equal(handlers.length, 1);
    const handler = handlers[0];
    function startRequest(url, body, options = {}) {
      const request = new EventEmitter();
      request.url = url;
      request.method = options.method || 'POST';
      request.headers = { 'content-type': 'application/json', authorization: `Bearer ${app.token}`,
        'x-memory-suite-admin': '1', ...options.headers };
      request.resume = () => {};
      request.destroy = () => {};
      const response = new EventEmitter();
      let result;
      response.writeHead = (status, headers) => { response.statusCode = status; response.headers = headers; };
      response.getHeader = name => response.headers?.[name];
      response.end = bytes => { result = { status: response.statusCode, body: bytes ? JSON.parse(bytes.toString()) : null }; response.emit('finish'); };
      const handled = handler(request, response);
      const finish = () => { request.emit('data', Buffer.from(JSON.stringify(body ?? {}))); request.emit('end'); };
      if (!options.defer) finish();
      return { finish, result: handled.then(() => { assert(result, 'route must finish its response'); return result; }) };
    }
    const request = (url, body, options) => startRequest(url, body, options).result;
    const scope = 'fixture-child', sourceScope = 'fixture-parent';
    const archiveKey = `libra:v1:scope:${scope}:micro-handoff-archive:inherited`;
    const manifestKey = `libra:v1:scope:${scope}:manifest`;
    const markerKey = 'libra.fixture.binding.marker';
    const sentinelKey = 'libra:v1:scope:unrelated:manifest';
    const core = { schema: 'libra.micro_handoff_archive.v1', sourceScopeKey: 'older-parent', activeWorldlineId: 'main',
      recordCount: 0, recordsDigest: digest([]), records: [] };
    const archive = { ...core, archiveDigest: digest(core) };
    const ref = { schema: 'libra.micro_handoff_archive_ref.v1', archiveKey, archiveDigest: archive.archiveDigest,
      sourceScopeKey: archive.sourceScopeKey, nativeCopiedFromScopeKey: sourceScope };
    const manifest = { schema: 'libra.manifest.v1', scopeKey: scope, nativeChatCopy: {
      schema: 'libra.native_chat_copy.v2', complete: true, durableVerified: true, sourceScopeKey: sourceScope, targetScopeKey: scope },
      inheritedMicroArchives: [ref] };
    let op = 0;
    const put = (key, value, kind = 'set', namespace = 'libra') => app.repositories[namespace].mutate({ kind, space: 'plugin', key,
      ...(kind === 'set' ? { value } : {}), operationId: `fixture-${++op}` });
    put(manifestKey, JSON.stringify(manifest)); put(archiveKey, JSON.stringify(archive)); put(sentinelKey, 'unchanged');
    const repairBackup = await app.createBackup('manual', 'pre-owner-scope-delete');
    assert.equal(repairBackup.ok, true);
    const backupId = repairBackup.result.id;
    put(archiveKey, null, 'remove');
    app.repositories.libra.database.prepare('INSERT INTO libra_deleted_owner_scopes(scope_id,scope_key,backup_id,deleted_at) VALUES(?,?,?,?)')
      .run('fixture-deleted-owner', sourceScope, backupId, Date.now());
    put(markerKey, 'RESTORED'); put(manifestKey, JSON.stringify({ ...manifest, fixtureMarker: 'RESTORED' }));
    put('hayaku.fixture.marker', 'RESTORED', 'set', 'hayaku');
    const restoreBackup = await app.createBackup('manual', 'binding-restore-fixture');
    assert.equal(restoreBackup.ok, true);
    put(markerKey, 'BEFORE'); put(manifestKey, JSON.stringify({ ...manifest, fixtureMarker: 'BEFORE' }));
    put('hayaku.fixture.marker', 'BEFORE', 'set', 'hayaku');
    const input = { backupId, targetScopeKey: scope, targetArchiveKey: archiveKey };
    const plan = async () => {
      const result = await request(route + '/plan', input);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body.result;
    };
    const restore = namespaces => request('/v1/admin/restore', { backupId: restoreBackup.result.id, namespaces });
    const checkReadback = () => {
      assert.equal(app.repositories.libra.get('plugin', archiveKey).value, JSON.stringify(archive));
      assert.equal(app.repositories.libra.get('plugin', sentinelKey).value, 'unchanged');
      assert.equal(app.repositories.libra.isOwnerScopeDeleted('fixture-deleted-owner'), true);
      assert.equal(app.integrityAll().ok, true);
    };
    await run({ app, request, startRequest, input, plan, restore, put, archive, archiveKey, manifest, manifestKey,
      markerKey, ref, snapshot, hooks: loaded.__fixtureHooks, checkReadback, dir });
    assert(backups >= 2);
    assert.equal(app.server.listening, false);
  } finally {
    if (app) {
      await app.close();
      app.diagnosticJournal.close();
      for (const repository of Object.values(app.repositories)) repository.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const expectStale = result => {
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error, 'libra_native_archive_repair_plan_stale');
};
const expectRepaired = result => {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.result.schema, 'libra.native_archive_backup_repair_receipt.v1');
  assert.equal(result.body.result.physicalReadback, true);
  assert.equal(result.body.result.durable, true);
  assert.equal(result.body.result.nativeCopyCompleteness, 'pending_revalidation');
};

test('new repair plan and physical readback use the replacement after successful LIBRA restore', () => fixture(async f => {
  const old = f.app.repositories.libra;
  await f.plan(); // Initialize the original service before replacement.
  assert.equal((await f.restore(['libra'])).status, 200);
  assert.notEqual(f.app.repositories.libra, old);
  assert.equal(f.app.repositories.libra.get('plugin', f.markerKey).value, 'RESTORED');
  const current = await f.plan();
  expectRepaired(await f.request(route + '/execute', current));
  f.checkReadback();
}));

test('unexecuted plans are stale after LIBRA replacement', () => fixture(async f => {
  const before = await f.plan();
  assert.equal((await f.restore(['libra'])).status, 200);
  expectStale(await f.request(route + '/execute', before));
  assert.equal(f.app.repositories.libra.get('plugin', f.archiveKey).exists, false);
}));

test('cached repair receipts are stale after LIBRA replacement', () => fixture(async f => {
  const before = await f.plan();
  const repaired = await f.request(route + '/execute', before);
  expectRepaired(repaired);
  assert.deepEqual(await f.request(route + '/execute', before), repaired);
  assert.equal((await f.restore(['libra'])).status, 200);
  expectStale(await f.request(route + '/execute', before));
  assert.equal(f.app.repositories.libra.get('plugin', f.archiveKey).exists, false);
}));

test('rollback reopening invalidates old plans and permits repair on the rolled-back repository', () => fixture(async f => {
  const before = await f.plan(), old = f.app.repositories.libra;
  const original = f.hooks.getJournalWriter();
  let injected = false;
  f.hooks.setJournalWriter((dir, journal) => {
    if (journal.phase === 'INSTALLED') { injected = true; throw Error('fixture_installed_journal_failure'); }
    return original(dir, journal);
  });
  const result = await f.restore(['libra']);
  assert.equal(result.status, 500);
  assert.equal(result.body.error, 'fixture_installed_journal_failure');
  assert.equal(injected, true);
  assert.notEqual(f.app.repositories.libra, old);
  assert.equal(f.app.repositories.libra.get('plugin', f.markerKey).value, 'BEFORE');
  expectStale(await f.request(route + '/execute', before));
  expectRepaired(await f.request(route + '/execute', await f.plan()));
  f.checkReadback();
}));

test('HAYAKU-only restore preserves LIBRA repository and valid plan', () => fixture(async f => {
  const before = await f.plan(), old = f.app.repositories.libra;
  assert.equal((await f.restore(['hayaku'])).status, 200);
  assert.equal(f.app.repositories.libra, old);
  assert.equal(f.app.repositories.hayaku.get('plugin', 'hayaku.fixture.marker').value, 'RESTORED');
  expectRepaired(await f.request(route + '/execute', before));
  f.checkReadback();
}));

test('missing LIBRA repository refuses plan and execute rather than falling back to an old object', () => fixture(async f => {
  const before = await f.plan(), old = f.app.repositories.libra;
  delete f.app.repositories.libra;
  try {
    for (const [action, body] of [['plan', f.input], ['execute', before]]) {
      const result = await f.request(route + '/' + action, body);
      assert.equal(result.status, 503, JSON.stringify(result.body));
      assert.equal(result.body.error, 'libra_native_archive_repair_unavailable');
      assert.equal(old.get('plugin', f.archiveKey).exists, false);
    }
  } finally { f.app.repositories.libra = old; }
  expectStale(await f.request(route + '/execute', before));
}));

test('plan resolves repository only after an awaited request body completes', () => fixture(async f => {
  await f.plan();
  const pending = f.startRequest(route + '/plan', f.input, { defer: true });
  assert.equal((await f.restore(['libra'])).status, 200);
  pending.finish();
  const planned = await pending.result;
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  expectRepaired(await f.request(route + '/execute', planned.body.result));
  f.checkReadback();
}));

test('execute resolves repository after the body and rejects pre-restore plan', () => fixture(async f => {
  const before = await f.plan();
  const pending = f.startRequest(route + '/execute', before, { defer: true });
  assert.equal((await f.restore(['libra'])).status, 200);
  pending.finish();
  expectStale(await pending.result);
}));

test('repair remains busy while real restore maintenance waits on backup completion', () => fixture(async f => {
  const before = await f.plan();
  let resume, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.hooks.setBackupRunner(async tasks => { entered(); await new Promise(resolve => { resume = resolve; }); return f.snapshot(tasks); });
  const restoring = f.restore(['libra']);
  await started;
  try {
    for (const [action, body] of [['plan', f.input], ['execute', before]]) {
      const result = await f.request(route + '/' + action, body);
      assert.equal(result.status, 409);
      assert.equal(result.body.error, 'libra_native_archive_repair_busy');
    }
  } finally { resume(); }
  assert.equal((await restoring).status, 200);
  expectRepaired(await f.request(route + '/execute', await f.plan()));
}));

test('synthetic routes preserve authorization, body limits, owner proof and backup validation', () => fixture(async f => {
  const noAuth = await f.request(route + '/plan', f.input, { headers: { authorization: '' } });
  assert.equal(noAuth.status, 403);
  const boot = await f.request('/bootstrap', {}, { method: 'GET', headers: { 'x-memory-suite-plugin': 'libra' } });
  assert.equal(boot.status, 200);
  const notAdmin = await f.request(route + '/plan', f.input, { headers: {
    authorization: `Bearer ${boot.body.token}`, 'x-memory-suite-plugin': 'libra', 'x-memory-suite-admin': '' } });
  assert.equal(notAdmin.status, 403);
  assert.equal(notAdmin.body.error, 'admin_capability_required');
  const huge = await f.request(route + '/plan', f.input, { headers: { 'content-length': '8193' } });
  assert.equal(huge.status, 413);
  assert.equal(huge.body.error, 'native_archive_repair_body_limit');
  f.put(f.manifestKey, JSON.stringify({ ...f.manifest, inheritedMicroArchives: [f.ref, f.ref] }));
  const duplicate = await f.request(route + '/plan', f.input);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, 'libra_native_archive_repair_target_ref_invalid');
  f.put(f.manifestKey, JSON.stringify(f.manifest));
  const backup = f.app.listBackups().find(row => row.id === f.input.backupId);
  const file = path.join(backup.path, 'libra.sqlite'), bytes = fs.readFileSync(file);
  try {
    fs.appendFileSync(file, Buffer.from([0]));
    const corrupt = await f.request(route + '/plan', f.input);
    assert.equal(corrupt.status, 409);
    assert.equal(corrupt.body.error, 'libra_native_archive_repair_backup_unverified');
  } finally { fs.writeFileSync(file, bytes); }
  f.app.repositories.libra.database.prepare('DELETE FROM libra_deleted_owner_scopes').run();
  const noProof = await f.request(route + '/plan', f.input);
  assert.equal(noProof.status, 409);
  assert.equal(noProof.body.error, 'libra_native_archive_repair_deletion_proof_missing');
  assert.equal(f.app.repositories.libra.get('plugin', f.archiveKey).exists, false);
}));

test('repair still rejects a source changed after planning', () => fixture(async f => {
  const before = await f.plan();
  f.put(f.manifestKey, JSON.stringify({ ...f.manifest, fixtureMarker: 'changed-after-plan' }));
  const result = await f.request(route + '/execute', before);
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'libra_native_archive_repair_source_changed');
  assert.equal(f.app.repositories.libra.get('plugin', f.archiveKey).exists, false);
}));

test('repair still refuses a receipt when physical readback fails after the conditional write', () => fixture(async f => {
  const before = await f.plan(), repository = f.app.repositories.libra;
  const actualGet = repository.get, actualBatch = repository.applyConditionalBatch;
  let committed = false;
  repository.applyConditionalBatch = (...args) => { const result = actualBatch(...args); committed = true; return result; };
  repository.get = (space, key) => {
    const row = actualGet(space, key);
    return committed && key === f.archiveKey ? { ...row, exists: false } : row;
  };
  try {
    const result = await f.request(route + '/execute', before);
    assert.equal(committed, true);
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'libra_native_archive_repair_readback_failed');
    assert.equal(actualGet('plugin', f.archiveKey).value, JSON.stringify(f.archive));
  } finally { repository.get = actualGet; repository.applyConditionalBatch = actualBatch; }
}));
