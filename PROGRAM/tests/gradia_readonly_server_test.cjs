'use strict';
// Real server request handler and SQLite, with no HTTP listen/network or live DATA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { test, before, after } = require('node:test');
const { createMemorySuiteServer } = require('../server/server.cjs');
const ID = 'serial_gradation_agents_for_rp';
const CAPTURE = '/v1/libra/read-session/capture';
const CURRENT = '/v1/libra/read-session/current';
const scope = { scopeKey: 'gradia-offline', characterId: 'character-one', chatId: 'chat-one' };
const manifestKey = `libra:v1:scope:${scope.scopeKey}:manifest`;
const key = (start = 1, revision = 1) => `libra:v1:scope:${scope.scopeKey}:memory:${start}:r${revision}`;
let app, dir, bootstrap, token;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const request = async (route, body, options = {}) => new Promise((resolve, reject) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method: options.method || (body === undefined ? 'GET' : 'POST'), url: route,
    headers: { 'x-memory-suite-plugin': ID, ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(bootstrap ? { 'x-memory-suite-data-instance': bootstrap.dataInstanceId,
        'x-memory-suite-reset-epochs': JSON.stringify(bootstrap.resetEpochs) } : {}), ...options.headers },
    socket: { remoteAddress: '127.0.0.1' }, complete: true });
  const res = new EventEmitter(); res.statusCode = 200; res.headers = {};
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.getHeader = name => res.headers[name];
  res.end = body => { res.finished = true; res.emit('finish'); resolve({ status: res.statusCode, body: JSON.parse(String(body || '{}')) }); };
  Promise.resolve(app.server.listeners('request')[0](req, res)).catch(reject);
});
function store(storageKey, value, { revision = 1, deleted = 0, raw } = {}) {
  const json = raw === undefined ? JSON.stringify(value) : raw;
  app.repositories.libra.database.prepare('INSERT OR REPLACE INTO kv(space,key,value_json,deleted,revision,digest,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('plugin', storageKey, json, deleted, revision, hash(json), 1000);
}
function record(text = 'Full canonical text', extra = {}) {
  return { schema: 'libra.canonical_memory.v1', status: 'committed', scopeKey: scope.scopeKey, memoryId: 'memory-one', revision: 1,
    sourceDigest: 'source-one', turnRange: { start: 1, end: 5 }, text, ...extra };
}
function ref(extra = {}) {
  return { key: key(), memoryId: 'memory-one', revision: 1, sourceDigest: 'source-one', status: 'committed',
    turnRange: { start: 1, end: 5 }, sessionEpoch: 0, ...extra };
}
function seed({ text, manifest = {}, memory = {}, nested = true } = {}) {
  app.repositories.libra.database.exec('DELETE FROM kv; DELETE FROM operations;');
  const m = { schema: 'libra.manifest.v1', ...scope, branchGuard: { schema: 'libra.branch_guard.v1', status: 'ready' }, memories: { 1: ref() }, inheritedMemories: [], ...manifest };
  store(manifestKey, nested ? JSON.stringify(m) : m);
  const r = record(text, memory); store(key(), nested ? JSON.stringify(r) : r);
}
function unchangedSnapshot() {
  return hash(JSON.stringify(app.repositories.libra.database.prepare('SELECT * FROM kv ORDER BY space,key').all())) + ':' +
    app.repositories.libra.database.prepare('SELECT COUNT(*) AS n FROM operations').get().n;
}
async function capture(maxCorpusBytes) {
  const result = await request(CAPTURE, { scope, ...(maxCorpusBytes === undefined ? {} : { maxCorpusBytes }) });
  assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.result;
}
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gradia-readonly-offline-'));
  app = createMemorySuiteServer({ dataDir: dir, port: 0, autoBackup: false, computeEnabled: false, token: 'offline-synthetic-gradia-token' });
  const reply = await request('/bootstrap'); bootstrap = reply.body; token = bootstrap.token;
});
after(async () => { await app?.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

test('GRADIA bootstrap grants only a dedicated read-only LIBRA principal', () => {
  assert.equal(bootstrap.ok, true, JSON.stringify(bootstrap));
  assert.equal(bootstrap.capabilities['libra-read-session.v1'], true);
  assert.deepEqual(bootstrap.authorization, { schema: 'memory-suite.bootstrap-authorization.v1', pluginId: ID,
    namespace: 'libra', roles: ['readonly'], readNamespaces: ['libra'], writeNamespaces: [] });
});
test('capture reuses exact bounded repository reads, preserves full text, and writes no owner data', async () => {
  seed({ text: 'start\n' + '한국어 full memory '.repeat(6000) + '\nend' });
  const before = unchangedSnapshot(), repo = app.repositories.libra, get = repo.get, calls = [];
  repo.get = (space, storageKey, options) => { calls.push({ space, key: storageKey, options }); return get(space, storageKey, options); };
  try {
    const result = await capture();
    assert.equal(result.schema, 'memory-suite.libra-read-session.v1'); assert.deepEqual(result.scope, scope);
    assert.equal(result.readOnly, true); assert.equal(result.complete, true);
    assert.equal(result.items.length, 1); assert.equal(result.items[0].content, record('start\n' + '한국어 full memory '.repeat(6000) + '\nend').text);
    assert.equal(result.items[0].key, key()); assert.equal(result.items[0].id, 'memory-one');
    assert.equal(result.corpusBytes, Buffer.byteLength(result.items[0].content)); assert.equal(result.maxCorpusBytes, 4 * 1024 ** 2);
    assert.equal(result.dataInstanceId, bootstrap.dataInstanceId); assert.equal(result.resetEpoch, 0);
    assert.equal(result.dependencies.length, 2); assert.equal(result.dependencies[0].key, manifestKey);
    assert.equal(result.evidenceRevision, hash(JSON.stringify(result.dependencies)));
    assert.deepEqual(calls.map(c => c.key), [manifestKey, key()]);
    assert(calls.every(c => Number.isSafeInteger(c.options?.maxValueBytes) && c.options.maxValueBytes > 0));
    assert.equal(unchangedSnapshot(), before);
  } finally { repo.get = get; }
});
test('capture excludes obsolete/pending/unverified current refs and includes committed inherited refs', async () => {
  const archive = 'libra:v1:shared-archive:archive-one:memory:old:r1';
  seed({ manifest: { branchGuard: { schema: 'libra.branch_guard.v1', status: 'bootstrap_pending', verifiedStarts: [1, 2] },
    memories: { 1: ref(), 2: ref({ key: key(2), turnRange: { start: 2, end: 6 } }), 6: ref({ key: key(6), turnRange: { start: 6, end: 10 } }),
      11: ref({ key: key(11), status: 'pending' }) }, inheritedMemories: [ref({ key: archive, sessionEpoch: -1, archiveShared: true })] } });
  store(archive, JSON.stringify(record('inherited full text', { scopeKey: 'archive:archive-one' })));
  store(key(99), record('obsolete unreferenced secret')); store(key(6), record('unverified'));
  const result = await capture(); assert.deepEqual(result.items.map(i => i.key), [archive, key()]);
});
test('missing or malformed branch guard is pending, never silently ready', async () => {
  seed({ manifest: { branchGuard: undefined } }); assert.deepEqual((await capture()).items, []);
  seed({ manifest: { branchGuard: { schema: 'unknown', status: 'ready', verifiedStarts: [1] } } });
  assert.equal((await capture()).items.length, 1);
});
test('empty canonical manifest captures an empty complete session', async () => {
  seed({ manifest: { memories: {} } }); const result = await capture();
  assert.deepEqual(result.items, []); assert.equal(result.corpusBytes, 0); assert.equal(result.dependencies.length, 1);
});
test('identity mismatch, missing/tombstoned bodies, invalid JSON and unsafe pointers fail all-or-nothing', async () => {
  const variants = [
    () => seed({ manifest: { chatId: 'wrong-chat' } }),
    () => seed({ memory: { memoryId: 'wrong' } }),
    () => seed({ memory: { revision: 2 } }),
    () => seed({ memory: { sourceDigest: 'wrong' } }),
    () => { seed(); app.repositories.libra.database.prepare('DELETE FROM kv WHERE key=?').run(key()); },
    () => { seed(); store(key(), record(), { deleted: 1 }); },
    () => { seed(); store(key(), null, { raw: 'not-json' }); },
    () => seed({ memory: { text: undefined, summary: 'not-full-text' } }),
    () => seed({ memory: { schema: 'libra.memory.v1' } }),
    () => seed({ memory: { status: 'candidate' } }),
    () => seed({ memory: { scopeKey: '' } }),
    () => seed({ manifest: { memories: { 1: ref({ key: 'libra:v1:scope:gradia-offline:settings' }) } } }),
    () => seed({ manifest: { memories: { 1: ref({ key: 'libra:v1:scope:foreign:memory:1:r1' }) } } }),
  ];
  for (const setup of variants) { setup(); const r = await request(CAPTURE, { scope }); assert.equal(r.status, 409, JSON.stringify(r)); assert.equal(r.body.result, undefined); }
});
test('corpus limit validates exact integer range and never truncates', async () => {
  seed({ text: 'abc' });
  for (const invalid of [0, -1, 1.1, '3', null, 32 * 1024 ** 2 + 1]) {
    const r = await request(CAPTURE, { scope, maxCorpusBytes: invalid }); assert.equal(r.status, 400, JSON.stringify(r));
  }
  const over = await request(CAPTURE, { scope, maxCorpusBytes: 2 }); assert.equal(over.status, 413); assert.equal(over.body.result, undefined);
  assert.equal((await capture(3)).items[0].content, 'abc');
});
test('raw oversize is rejected from metadata before body materialization', async () => {
  seed(); store(key(), JSON.stringify(record('x'.repeat(200000))));
  const repo = app.repositories.libra, get = repo.get; let bodyReads = 0;
  repo.get = (space, k, options) => { if (k === key()) bodyReads++; return get(space, k, options); };
  try { const r = await request(CAPTURE, { scope, maxCorpusBytes: 1 }); assert.equal(r.status, 413); assert.equal(bodyReads, 0); }
  finally { repo.get = get; }
});
test('full nested escaped control corpus fits its logical cap', async () => {
  const text = '\0'.repeat(400000); seed({ text }); const result = await capture(Buffer.byteLength(text));
  assert.equal(result.items[0].content, text); assert.equal(result.corpusBytes, text.length);
});
test('metadata-only current check detects body and manifest changes without reloading values', async () => {
  seed(); const session = await capture(), repo = app.repositories.libra, get = repo.get;
  repo.get = () => { throw Error('CURRENT_MUST_NOT_RELOAD_VALUE'); };
  try {
    let r = await request(CURRENT, session); assert.equal(r.status, 200); assert.equal(r.body.result.current, true);
    store(key(99), record('unreferenced')); r = await request(CURRENT, session); assert.equal(r.body.result.current, true);
    store(key(), JSON.stringify(record('new body')), { revision: 2 }); r = await request(CURRENT, session); assert.equal(r.body.result.current, false);
  } finally { repo.get = get; }
  seed(); const manifestSession = await capture(); store(manifestKey, {}, { revision: 2 });
  assert.equal((await request(CURRENT, manifestSession)).body.result.current, false);
});
test('current check binds scope, exact dependency hash, DATA identity and reset epoch', async () => {
  seed(); const session = await capture();
  for (const patch of [{ scope: { ...scope, scopeKey: 'other' } }, { evidenceRevision: '0'.repeat(64) }, { dependencies: [] }]) {
    const r = await request(CURRENT, { ...session, ...patch }); assert.equal(r.status, 400, JSON.stringify(r));
  }
  for (const patch of [{ dataInstanceId: 'other' }, { resetEpoch: 1 }]) {
    const r = await request(CURRENT, { ...session, ...patch }); assert.equal(r.status, 200); assert.equal(r.body.result.current, false);
  }
  const wrongHeader = await request(CAPTURE, { scope }, { headers: { 'x-memory-suite-data-instance': 'other' } }); assert.equal(wrongHeader.status, 409);
});
test('dedicated principal denies arbitrary KV, mutation, manager, reset, maintenance and compute routes', async () => {
  seed(); const before = unchangedSnapshot();
  const routes = [
    ['/v1/kv/get?namespace=libra&space=plugin&key=' + encodeURIComponent(key())], ['/v1/kv/keys?namespace=libra&space=plugin'],
    ['/v1/kv/get-many', { namespace: 'libra', space: 'plugin', keys: [key()] }], ['/v1/kv/set', {}], ['/v1/kv/remove', {}],
    ['/v1/integrity?namespace=libra'], ['/v1/libra/scope-health', {}], ['/v1/manager/scopes'], ['/v1/manager/reset/plan', {}],
    ['/v1/manager/control/status'], ['/v1/admin/integrity', {}], ['/v1/shutdown', {}], ['/v1/compute/execute', {}], ['/v1/compute/bootstrap', {}],
  ];
  for (const [route, body] of routes) { const r = await request(route, body); assert.equal(r.status, 403, route + ':' + JSON.stringify(r.body)); }
  assert.equal(unchangedSnapshot(), before);
});
test('owner token cannot claim GRADIA identity or call its narrow routes', async () => {
  const owner = await request('/bootstrap', undefined, { headers: { 'x-memory-suite-plugin': 'libra' } });
  for (const plugin of ['libra', ID]) {
    const r = await request(CAPTURE, { scope }, { headers: { authorization: `Bearer ${owner.body.token}`, 'x-memory-suite-plugin': plugin } });
    assert.equal(r.status, 403);
  }
});


test('raw manifest, per-item auxiliary metadata and reference count limits fail without partial results', async () => {
  const scenarios = [
    () => seed({ manifest: { padding: 'm'.repeat(1024 ** 2) } }),
    () => seed({ memory: { auxiliary: 'm'.repeat(64 * 1024) } }),
    () => seed({ manifest: { memories: Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [i, { status: 'pending' }])) } }),
  ];
  for (const setup of scenarios) { setup(); const result = await request(CAPTURE, { scope }); assert.equal(result.status, 413); assert.equal(result.body.result, undefined); }
});
test('aggregate auxiliary metadata stays bounded even when individual records fit', async () => {
  seed({ manifest: { memories: Object.fromEntries(Array.from({ length: 22 }, (_, i) => [i * 5 + 1, ref({ key: key(i * 5 + 1) })])) } });
  for (let i = 0; i < 22; i++) store(key(i * 5 + 1), record('x', { auxiliary: 'a'.repeat(50000) }));
  const result = await request(CAPTURE, { scope }); assert.equal(result.status, 413); assert.equal(result.body.result, undefined);
});
test('SQL bounded get rejects growth after metadata observation before JSON materialization', async () => {
  seed(); const repo = app.repositories.libra, get = repo.get;
  repo.get = (space, k, options) => {
    if (k === key()) store(k, null, { raw: '!'.repeat(100000) });
    return get(space, k, options);
  };
  try { const result = await request(CAPTURE, { scope, maxCorpusBytes: 1 }); assert.equal(result.status, 413); }
  finally { repo.get = get; }
  assert.equal((await capture()).items[0].content, 'Full canonical text', 'read unit rollback must discard test-local growth');
});
test('upper32MiB logical corpus bound returns one entire item', async () => {
  const text = 'x'.repeat(32 * 1024 ** 2); seed({ text });
  const result = await capture(text.length); assert.equal(result.corpusBytes, text.length); assert.equal(result.items[0].content, text);
});
test('read-only unit freezes request-local data and checks maintenance on both sides', () => {
  seed(); const { createReadSession } = require('../server/core/gradia-libra-read-session.cjs');
  let reads = 0;
  const reader = createReadSession({ getRepository: () => app.repositories.libra, dataInstanceId: bootstrap.dataInstanceId,
    epochs: () => ({}), canRead: () => true });
  const session = reader.capture({ scope });
  assert(Object.isFrozen(session)); assert(Object.isFrozen(session.items)); assert(Object.isFrozen(session.items[0].source));
  const changing = createReadSession({ getRepository: () => app.repositories.libra, dataInstanceId: bootstrap.dataInstanceId,
    epochs: () => ({}), canRead: () => ++reads === 1 });
  assert.throws(() => changing.capture({ scope }), error => error.statusCode === 503);
  assert.equal(reader.capture({ scope }).items.length, 1, 'failed maintenance admission must rollback the read unit');
});

test('committed native-copy predecessor records are included only through inherited refs', async () => {
  const predecessor = `libra:v1:scope:${scope.scopeKey}:predecessor:nativecopy_one:00001:memory-one:r1`;
  const predecessorRef = ref({ key: predecessor, sessionEpoch: -1, inheritedSessionHistory: true });
  seed({ manifest: { inheritedMemories: [predecessorRef] } });
  store(predecessor, JSON.stringify(record('native-copy predecessor')));
  const session = await capture();
  assert.deepEqual(session.items.map(item => item.key), [predecessor, key()]);
  assert.equal((await request(CURRENT, session)).body.result.current, true);
  seed({ manifest: { memories: { 1: predecessorRef } } });
  store(predecessor, JSON.stringify(record('cannot impersonate current')));
  assert.equal((await request(CAPTURE, { scope })).status, 409);
});
