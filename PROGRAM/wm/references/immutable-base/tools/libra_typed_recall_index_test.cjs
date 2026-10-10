'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { load } = require('./libra_recall_test_runtime.cjs');
const fixture = require('./fixtures/typed-recall-v1.json');
const clone = x => JSON.parse(JSON.stringify(x));
const OUT = path.resolve(__dirname, '../test-output/typed-recall/task2');
const PREFIX = 'libra:v1:typed-semantic:';
const provider = () => ({ spaceFingerprint: 'fixture-space-v1', provider: 'offline-fixture', model: 'tiny-3', modelRevision: 'rev1', endpoint: 'fixture://no-network', dimension: 3, queryMode: 'search_query', documentMode: 'search_document', options: { normalize: true } });
const results = [];
async function check(name, fn) { try { await fn(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: error.stack }); } }
const typedBytes = store => [...store].filter(([k]) => k.startsWith(PREFIX)).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(String(v ?? '')), 0);

function backend({ owned = true, local = false, quota = Infinity, lyingCas = false, cacheFirst = false, readOnly = false } = {}) {
  const store = new Map();
  const cache = new Map();
  const state = { quota, writes: 0, cas: 0, networkCalls: 0, corrupt: false, failSet: false, afterSet: null };
  const save = (key, value) => {
    const old = store.get(key);
    store.set(key, value);
    if (typedBytes(store) > state.quota) { if (old === undefined) store.delete(key); else store.set(key, old); throw new Error('QuotaExceededError'); }
    state.writes++;
  };
  const storage = {
    async getItem(key) { const v = (cacheFirst && cache.has(key) ? cache.get(key) : store.get(key)) ?? null; return state.corrupt && (key.includes(':bank:') || key.includes(':row:')) && v ? v + 'corrupt' : v; },
    async setItem(key, value) {
      if (cacheFirst) cache.set(key, value);
      if (state.failSet) throw new Error('fixture_set_failure');
      save(key, value);
      if (state.afterSet) await state.afterSet(key, value);
      return true;
    }
  };
  if (readOnly) delete storage.setItem;
  if (owned) {
    storage.getCapabilities = async () => ({ schema: 'libra.recall-derived-storage-capabilities.v1', atomicCompareAndSwap: true, consistency: 'linearizable', domain: local ? 'localPluginStorage' : 'pluginStorage' });
    // Actual single atomic Map operation shared by independently loaded VM runtimes.
    storage.compareAndSwap = async (key, expected, value) => {
      state.cas++;
      if (!lyingCas && (store.get(key) ?? null) !== expected) return false;
      save(key, value); return true;
    };
  }
  const host = {
    async getArgument(name) { return name === 'activity_dashboard' ? 'off' : name === 'embedding_enabled' ? 'false' : undefined; },
    async getCharacter() { return null; }, async registerSetting() {}, async registerButton() {}, async onUnload() {},
    async nativeFetch() { state.networkCalls++; throw new Error('external calls forbidden'); },
    pluginStorage: storage
  };
  if (local) host.getLocalPluginStorage = async () => storage;
  return { store, storage, state, host, cache };
}

async function runtime(back = backend()) {
  const r = await load({ globals: { Risuai: back.host, risuai: back.host }, transformCode(code) {
    const i = code.lastIndexOf('\n})();');
    return code.slice(0, i) + '\n;globalThis.__INDEX_TEST__={corpus:typeof TypedRecallCorpus!=="undefined"?TypedRecallCorpus:null,index:typeof SemanticRecallIndex!=="undefined"?SemanticRecallIndex:null};\n' + code.slice(i);
  } });
  const { corpus, index } = r.context.__INDEX_TEST__;
  const empty = corpus.capture(r.char, r.chat, { currentTurn: 10 });
  const signed = (obj, domain, id) => { const c = clone(obj); r.api.IntegrityMetaManager.applyIntegrityMeta(c, { domain, recordId: id, scopeKey: empty.scopeKey, turn: 4 }); return c; };
  const row = (comment, key, value) => ({ comment, key, content: JSON.stringify(value) });
  r.chat.localLore = [
    ...fixture.memory.map(m => ({ comment: 'lmai_memory', key: `lmai_memory::${m.id}`, content: `[META:${JSON.stringify(m.meta)}]\n${m.text}` })),
    ...fixture.entity.map(e => row('lmai_entity', `lmai_entity::${e.name}`, signed(e, 'entity', e.name))),
    row('lmai_world_graph', 'lmai_world_graph::compact', fixture.worldGraph),
    row('lmai_narrative', 'lmai_narrative::core', signed(fixture.narrative, 'narrative', 'narrative_state'))
  ];
  // A reload must use the exact persisted canon, not newly timestamped integrity signatures.
  if (back.canonicalLore) r.chat.localLore = clone(back.canonicalLore);
  else back.canonicalLore = clone(r.chat.localLore);
  const snapshot = corpus.capture(r.char, r.chat, { currentTurn: 10 });
  const all = corpus.enumerate(snapshot).filter(u => corpus.inspect(u, snapshot).eligible);
  const units = ['memory', 'entity', 'world', 'narrative'].map(f => all.find(u => u.family === f));
  assert.ok(units.every(Boolean), 'real typed corpus has an eligible unit for each family');
  return { ...r, corpus, index, snapshot, units, all, back };
}

function record(r, unit = r.units[0], p = provider(), vector = [1, 0.25, -0.5]) {
  let checksum; try { checksum = r.index.vectorChecksum(vector); } catch (_) { checksum = 'invalid-vector'; }
  return { schema: r.index.ROW_SCHEMA, scopeKey: r.snapshot.scopeKey, branchId: r.snapshot.branchId,
    identity: unit.identity, family: unit.family, subtype: unit.subtype, locator: clone(unit.locator),
    contentHash: unit.persistentContentHash, dependencyHash: unit.persistentDependencyHash, representationVersion: unit.representationVersion,
    sourceHash: r.index.sourceHash(unit.text), provider: r.index.providerDescriptor(p), mode: p.documentMode, dimension: p.dimension,
    viewerId: r.snapshot.viewerId, vector, vectorChecksum: checksum };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const r = await runtime();
  await check('strict_index_api_exists', () => {
    assert.ok(r.index && typeof r.index.open === 'function', 'strict derived index API must exist in built bundle');
    assert.equal(typeof r.api.MemoryEngine.getRecallDerivedStorageAdapter, 'function');
  });
  if (!r.index) return finish();
  const p = provider();
  const policy = { storage: { maxRowBytes: 8192, maxJobBytes: 65536, maxExpectedBytes: 131072, maxExpectedRows: 64 } };
  const canonicalBefore = JSON.stringify(r.chat.localLore);
  await check('source_hash_has_no_legacy_hash32_collision', () => {
    assert.notEqual(r.index.sourceHash('Aa'), r.index.sourceHash('BB'), 'equal-length legacy stableHash collision must not match embedding sources');
    for (const value of ['', 'abc', '한글 🌍 日本語 中文', 'x'.repeat(1000)]) {
      assert.equal(r.index.sourceHash(value), 'sha256:' + crypto.createHash('sha256').update(value).digest('hex'));
    }
  });
  await check('source_hash_preserves_utf8_padding_and_large_raw_bytes', () => {
    const cases = [55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 16383, 16384, 16385]
      .flatMap(length => ['x'.repeat(length), '한🙂'.repeat(Math.ceil(length / 3)).slice(0, length)]);
    cases.push('\ud800', '\udc00', '\ud800x\udc00', 'a\u0000b\r\nc', JSON.stringify({ source: '原文🙂\n'.repeat(32768) }));
    for (const value of cases) {
      assert.equal(r.index.sourceHash(value), 'sha256:' + crypto.createHash('sha256').update(value).digest('hex'),
        `UTF-8 source bytes=${Buffer.byteLength(value)}`);
    }
  });
  await check('strict_dimension_mode_hash', () => {
    const good = record(r);
    assert.equal(r.index.validate(good, r.units[0], p, p.documentMode).ok, true);
    for (const [field, value] of [['contentHash', 'wrong'], ['dependencyHash', 'wrong'], ['sourceHash', 'wrong'], ['representationVersion', 'old'], ['scopeKey', 'other'], ['identity', 'wrong'], ['family', 'world'], ['dimension', 2], ['mode', p.queryMode], ['schema', 'legacy']]) {
      assert.equal(r.index.validate({ ...good, [field]: value }, r.units[0], p, p.documentMode).ok, false, field);
    }
    assert.equal(r.index.validate({ ...good, locator: { ...good.locator, id: 'wrong' } }, r.units[0], p, p.documentMode).ok, false);
    for (const [field, value] of [['spaceFingerprint', 'old'], ['model', 'other'], ['modelRevision', 'rev2'], ['provider', 'other'], ['endpoint', 'fixture://other'], ['dimension', 2], ['queryMode', 'other'], ['documentMode', 'other'], ['options', { normalize: false }]]) {
      assert.equal(r.index.validate(good, r.units[0], { ...p, [field]: value }, p.documentMode).ok, false, `provider ${field}`);
    }
    // Both claimed record/fingerprint dimensions may agree yet disagree with actual provider dimension.
    const wrongDim = { ...good, dimension: 2, vector: [1, 2], provider: r.index.providerDescriptor({ ...p, dimension: 2 }) };
    assert.equal(r.index.validate(wrongDim, r.units[0], p, p.documentMode).ok, false);
    assert.equal(r.index.validate(good, r.units[0], p, p.queryMode).ok, false, 'document row is not a query row');
  });
  await check('nan_zero_rejected', () => {
    for (const vector of [[0, 0, 0], [NaN, 1, 2], [Infinity, 1, 2], [1, 2], ['1', 2, 3], [1.79e308, 1.79e308, 1.79e308]]) {
      assert.equal(r.index.validate(record(r, r.units[0], p, vector), r.units[0], p, p.documentMode).ok, false);
    }
  });
  await check('legacy_cache_not_strict_index', async () => {
    r.api.MemoryState.embeddingCache = new Map(); // Legacy cache normally initializes lazily.
    r.api.MemoryState.embeddingCache.set('legacy', [1, 2, 3]);
    r.back.store.set('libra:v1:hme-derived:legacy', JSON.stringify({ rows: [record(r)] }));
    const h = await r.index.open(r.snapshot, p, policy);
    assert.equal(r.index.read(h, r.units).rows.length, 0);
    assert.equal(r.index.validate([1, 2, 3], r.units[0], p, p.documentMode).ok, false);
    assert.equal(r.api.MemoryState.embeddingCache.get('legacy')[0], 1);
  });
  await check('normal_host_has_no_exclusive_writer_assumption', async () => {
    const u = await runtime(backend({ owned: false }));
    const h = await u.index.open(u.snapshot, p, policy);
    assert.equal(h.writable, true);
    assert.equal(h.storageContract.exclusiveWriter, false);
    assert.equal((await u.index.publish(h, [record(u)], u.snapshot)).ok, true);
    assert.equal(u.back.state.cas, 0);
    assert.equal(u.index.read(h, u.units).readiness.status, 'partial');
  });
  await check('irrelevant_broken_cas_is_never_called', async () => {
    const u = await runtime(backend({ lyingCas: true }));
    const h = await u.index.open(u.snapshot, p, policy);
    assert.equal(h.writable, true);
    assert.equal((await u.index.publish(h, [record(u)], u.snapshot)).ok, true);
    assert.equal(u.back.state.cas, 0);
  });
  await check('fallback_adapter', async () => {
    const fallback = await r.api.MemoryEngine.getRecallDerivedStorageAdapter();
    assert.equal(fallback.kind, 'pluginStorage');
    const u = await runtime(backend({ local: true }));
    const local = await u.api.MemoryEngine.getRecallDerivedStorageAdapter();
    assert.equal(local.kind, 'localPluginStorage');
    const h = await u.index.open(u.snapshot, p, policy);
    assert.equal(h.writable, true);
    assert.equal((await u.index.publish(h, [record(u)], u.snapshot)).ok, true);
  });
  let first;
  await check('partial_coverage_per_type', async () => {
    first = await r.index.open(r.snapshot, p, policy);
    const out = await r.index.publish(first, [record(r, r.units[0])], r.snapshot);
    assert.equal(out.ok, true);
    const read = r.index.read(first, r.units);
    assert.equal(read.rows.length, 1);
    assert.equal(read.readiness.status, 'partial');
    for (const family of ['memory', 'entity', 'world', 'narrative']) {
      const c = read.readiness.byType[family];
      const expected = r.all.filter(u => u.family === family).length;
      assert.equal(c.eligible, expected); assert.equal(c.valid, family === 'memory' ? 1 : 0);
      assert.equal(c.coverage, family === 'memory' ? 1 / expected : 0);
    }
    assert.equal(read.readiness.coldArchive.status, 'not_indexed');
  });
  await check('reload_readback', async () => {
    const h = await r.index.open(r.snapshot, p, policy);
    assert.equal((await r.index.publish(h, r.all.map(u => record(r, u)), r.snapshot)).ok, true);
    const fresh = await runtime(r.back); // Independent VM reload, no shared runtime state.
    const reloaded = await fresh.index.open(fresh.snapshot, p, policy);
    const view = fresh.index.read(reloaded, fresh.units);
    assert.equal(view.rows.length, 4);
    assert.equal(view.readiness.status, 'ready');
    assert.ok(reloaded.storageBytes > 0);
    assert.equal(JSON.stringify(r.chat.localLore), canonicalBefore, 'canonical lore remains vector-free and unchanged');
  });
  await check('old_content_key_cannot_replace_current_content_key', async () => {
    const u=await runtime(); const old=await u.index.open(u.snapshot,p,policy), oldUnit=u.units[0], oldSnapshot=u.snapshot;
    u.chat.localLore.find(x=>x.key===oldUnit.entry.key).content+=' REVISION_NEW';
    const latest=u.corpus.capture(u.char,u.chat,{currentTurn:10}), unit=u.corpus.enumerate(latest).find(x=>x.identity===oldUnit.identity);
    const next=await u.index.open(latest,p,policy);
    assert.equal((await u.index.publish(next,[record({...u,snapshot:latest},unit)],latest)).ok,true);
    assert.equal((await u.index.publish(old,[record(u,oldUnit)],oldSnapshot)).ok,true);
    const loaded=await u.index.open(latest,p,policy), rows=u.index.read(loaded,[unit]).rows;
    assert.equal(rows.length,1); assert.equal(rows[0].sourceHash,u.index.sourceHash(unit.text));
  });
  await check('cross_runtime_independent_expected_rows_both_survive', async () => {
    const b = backend({owned:false}); const a = await runtime(b), z = await runtime(b);
    const ha = await a.index.open(a.snapshot, p, policy), hz = await z.index.open(z.snapshot, p, policy);
    const out = await Promise.all([a.index.publish(ha, [record(a, a.units[0])], a.snapshot), z.index.publish(hz, [record(z, z.units[1])], z.snapshot)]);
    assert.equal(out.filter(x=>x.ok).length,2);
    const h = await a.index.open(a.snapshot,p,policy); assert.equal(a.index.read(h,a.units).rows.length,2);
  });
  await check('canonical_revision_drift_rejects_publish', async () => {
    const h = await r.index.open(r.snapshot, p, policy);
    const before = typedBytes(r.back.store);
    for (const changed of [{ ...r.snapshot, scopeKey: 'foreign' }, { ...r.snapshot, branchId: 'foreign' }, { ...r.snapshot, corpusRevision: 'changed' }, { ...r.snapshot, worldlineRevision: 'changed' }]) {
      assert.equal((await r.index.publish(h, [record(r)], changed)).ok, false);
    }
    assert.equal(typedBytes(r.back.store), before);
  });
  await check('quota_degrades', async () => {
    const u = await runtime(); const h = await u.index.open(u.snapshot, p, policy);
    u.back.state.quota = typedBytes(u.back.store) + 1000;
    assert.equal((await u.index.publish(h, u.units.map(x => record(u, x)), u.snapshot)).ok, false);
    assert.equal(u.index.read(h, u.units).readiness.status, 'degraded');
    assert.equal(JSON.stringify(u.chat.localLore).includes('vector'), false);
  });
  await check('readback_corruption_degrades', async () => {
    const u = await runtime(); const h = await u.index.open(u.snapshot, p, policy);
    u.back.state.corrupt = true;
    assert.equal((await u.index.publish(h, [record(u)], u.snapshot)).ok, false);
    assert.equal(u.index.read(h, u.units).readiness.status, 'degraded');
    const reloaded = await u.index.open(u.snapshot, p, policy);
    assert.equal(u.index.read(reloaded, u.units).rows.length, 0, 'failed bank is not committed');
  });
  await check('bounded_current_rows_have_no_mutable_head_or_banks', async () => {
    const u = await runtime();
    for (let i=0;i<12;i++) {
      const h=await u.index.open(u.snapshot,p,policy);
      assert.equal((await u.index.publish(h,u.units.map(x=>record(u,x)),u.snapshot)).ok,true);
      assert.equal(u.index.read(h,u.units).rows.length,4);
    }
    assert.equal(u.back.store.size,4, 'repeated identical binding uses the same four keys');
    assert.ok([...u.back.store.keys()].every(k=>k.includes(':row:')));
    const limited=await u.index.open(u.snapshot,p,{storage:{maxExpectedRows:1}});
    assert.equal(limited.writable,false); assert.equal(u.index.read(limited,u.units).readiness.status,'degraded');
    assert.equal(u.index.read(limited,u.units).readiness.historicalStorageBounded,false);
  });
  await check('retire_is_logical_and_strict_scope_namespace', async () => {
    const h=await r.index.open(r.snapshot,p,policy), before=typedBytes(r.back.store);
    assert.equal((await r.index.retire(h,[r.units[0].identity])).ok,true);
    assert.ok(!r.index.read(h,r.units).rows.some(row=>row.identity===r.units[0].identity));
    assert.equal(typedBytes(r.back.store),before,'no physical deletion or mutable tombstone');
    const fresh=await r.index.open(r.snapshot,p,policy);
    assert.ok(r.index.read(fresh,r.units).rows.some(row=>row.identity===r.units[0].identity), 'fresh canonical corpus remains authoritative');
    const branch=await r.index.open({...r.snapshot,branchId:'another-branch'},p,policy);
    assert.notEqual(branch.namespace,fresh.namespace); assert.equal(r.index.read(branch,r.units).rows.length,0);
    const changed=await r.index.open(r.snapshot,{...p,options:{normalize:false}},policy);
    assert.notEqual(changed.namespace,fresh.namespace); assert.equal(r.index.read(changed,r.units).rows.length,0);
  });
  await check('immutable_provider_rows_and_read_only_reload', async () => {
    const mutable = provider(); const h = await r.index.open(r.snapshot, mutable, policy);
    mutable.model = 'changed-after-open'; mutable.options.normalize = false;
    assert.equal(h.provider.model, p.model); assert.equal(h.provider.options.normalize, true);
    assert.equal((await r.index.publish(h, r.all.map(u => record(r, u)), r.snapshot)).ok, true);
    const read = r.index.read(h, r.units);
    assert.throws(() => { read.rows[0].vector[0] = 999; }, TypeError);
    const b = backend({ owned: false, readOnly: true }); b.canonicalLore = clone(r.chat.localLore); b.store.clear(); for (const [k, v] of r.back.store) b.store.set(k, v);
    const u = await runtime(b); const ro = await u.index.open(u.snapshot, p, policy);
    assert.equal(ro.writable, false);
    assert.equal(u.index.read(ro, u.units).rows.length, 4, 'valid stored rows remain readable');
    assert.equal(u.index.read(ro, u.units).readiness.status, 'degraded', 'read-only host is explicitly degraded');
  });
  await check('duplicate_or_invalid_batch_never_published', async () => {
    const u = await runtime(); const h = await u.index.open(u.snapshot, p, policy);
    const good = record(u), invalid = { ...good, vector: [0, 0, 0] };
    const before = typedBytes(u.back.store);
    assert.equal((await u.index.publish(h, [invalid, good], u.snapshot)).ok, false, 'duplicate ID cannot hide an earlier invalid vector');
    assert.equal((await u.index.publish(h, [good, good], u.snapshot)).ok, false, 'duplicate batch ID is ambiguous');
    assert.equal((await u.index.publish(h, [invalid], u.snapshot)).ok, false);
    assert.equal(typedBytes(u.back.store), before);
  });
  await check('stale_content_coverage_and_reload_corruption', async () => {
    const u = await runtime(); const h = await u.index.open(u.snapshot, p, policy);
    assert.equal((await u.index.publish(h, u.units.map(x => record(u, x)), u.snapshot)).ok, true);
    const memory = u.chat.localLore.find(row => row.key === u.units[0].entry.key);
    memory.content += ' NEW_CANONICAL_CONTENT';
    const changed = u.corpus.capture(u.char, u.chat, { currentTurn: 10 });
    const changedUnits = u.corpus.enumerate(changed).filter(x => u.units.some(old => old.identity === x.identity));
    const reloaded = await u.index.open(changed, p, policy);
    const view = u.index.read(reloaded, changedUnits);
    assert.equal(view.readiness.byType.memory.missing, 1, 'old content key is never read into current corpus');
    assert.equal(view.readiness.byType.memory.coverage, 0);
    assert.equal(view.readiness.status, 'partial');
    u.back.state.corrupt = true;
    const broken = await u.index.open(changed, p, policy);
    assert.equal(u.index.read(broken, changedUnits).rows.length, 0);
    assert.equal(u.index.read(broken, changedUnits).readiness.status, 'degraded');
  });
  await check('obsolete_mutable_head_and_writer_tokens_are_ignored', async () => {
    const u=await runtime(), h=await u.index.open(u.snapshot,p,policy);
    assert.equal((await u.index.publish(h,[record(u)],u.snapshot)).ok,true);
    const key=h.namespace+':manifest'; u.back.store.set(key,JSON.stringify({writer:{token:'stopped-other-runtime'},head:{bank:0,generation:999}}));
    const reloaded=await u.index.open(u.snapshot,p,policy);
    assert.equal(reloaded.writable,true); assert.equal(u.index.read(reloaded,u.units).rows.length,1);
    assert.equal((await u.index.publish(reloaded,[record(u,u.units[1])],u.snapshot)).ok,true);
    assert.equal(JSON.parse(u.back.store.get(key)).writer.token,'stopped-other-runtime');
  });
  await check('captured_representation_policy_is_source_contract', async () => {
    const u = await runtime(); const limited = { ...policy, representation: { maxChars: 64 } };
    const row = u.chat.localLore.find(x => x.key === u.units[1].entry.key), entity = JSON.parse(row.content);
    entity.identity = { ...entity.identity, summary: 'LONG_REPRESENTATION_CANARY '.repeat(80) };
    u.api.IntegrityMetaManager.applyIntegrityMeta(entity, { domain: 'entity', recordId: entity.name, scopeKey: u.snapshot.scopeKey, turn: 4 });
    row.content = JSON.stringify(entity);
    const oldIds = new Set(u.units.map(x => x.identity));
    u.snapshot = u.corpus.capture(u.char, u.chat, { currentTurn: 10 });
    u.units = u.corpus.enumerate(u.snapshot).filter(x => oldIds.has(x.identity));
    const units = u.corpus.enumerate(u.snapshot, limited).filter(x => u.units.some(old => old.identity === x.identity));
    assert.ok(units.some(x => x.text.length < u.units.find(old => old.identity === x.identity).text.length));
    const h = await u.index.open(u.snapshot, p, limited);
    limited.representation.maxChars = 10000;
    assert.equal((await u.index.publish(h, units.map(x => record(u, x)), u.snapshot)).ok, true, 'publishing uses immutable captured representation limits');
    assert.equal(u.index.read(h, units).rows.length, 4);
  });
  await check('coverage_is_resident_corpus_not_requested_subset', async () => {
    const u = await runtime(); const h = await u.index.open(u.snapshot, p, policy);
    assert.equal((await u.index.publish(h, [record(u)], u.snapshot)).ok, true);
    const view = u.index.read(h, [u.units[0]]);
    assert.equal(view.rows.length, 1);
    assert.equal(view.readiness.status, 'partial', 'one requested/indexed unit cannot imply full resident readiness');
    assert.ok(view.readiness.byType.entity.eligible > 0);
    assert.equal(view.readiness.eligible, u.all.length);
  });
  await check('handle_binding_is_immutable_without_shared_generation', async () => {
    const u=await runtime(), h=await u.index.open(u.snapshot,p,policy), generation=h.generation;
    assert.equal((await u.index.publish(h,[record(u)],u.snapshot)).ok,true);
    assert.equal(h.generation,generation);
    assert.equal((await u.index.publish(h,[record(u,u.units[0],p,[2,3,4])],u.snapshot)).ok,true,'same-binding valid vectors may replace each other');
    const next=await u.index.open(u.snapshot,p,policy); assert.equal(next.generation,generation);
    assert.equal((await u.index.publish(next,[{...record(u),indexGeneration:generation}],u.snapshot)).ok,false,'old mutable-head row generations are not part of v2');
  });
  const measurement = { N: r.all.length, D: p.dimension, float32PayloadBytes: r.all.length * p.dimension * 4,
    actualStorageBytesIncludingKeys: typedBytes(r.back.store), typedKeyCount: [...r.back.store.keys()].filter(k => k.startsWith(PREFIX)).length,
    estimatedVectorHeapBytes: r.all.length * p.dimension * 8, decodedRowJsonBytes: Buffer.byteLength(JSON.stringify(r.index.read(await r.index.open(r.snapshot, p, policy), r.all).rows)), networkCalls: r.back.state.networkCalls };
  fs.writeFileSync(path.join(OUT, 'storage-measurement.json'), JSON.stringify(measurement, null, 2));
  assert.equal(measurement.networkCalls, 0);
  return finish(measurement);
}
function finish(measurement) {
  const output = { ok: results.every(x => x.ok), passed: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok).length, assertions: results, measurement };
  fs.writeFileSync(path.join(OUT, 'index-result.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2)); process.exitCode = output.ok ? 0 : 1;
}
module.exports = { runtime, backend, provider, record, typedBytes };
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
