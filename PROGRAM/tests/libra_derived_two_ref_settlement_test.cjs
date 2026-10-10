'use strict';
// Actual two-ref flush settlement after an earlier ref publishes a fresh manifest.
// Each returned completion must match its own durable current canonical ref.
const assert = require('node:assert/strict');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const DIMENSIONS = 256;
const EMBED_CONFIG = {
  enabled: true, provider: 'openai', url: 'https://synthetic.invalid/v1/embeddings',
  model: 'text-embedding-3-small', key: 'synthetic-not-a-real-key',
  dimensions: DIMENSIONS, maxRetries: 0
};
const RETRYABLE = new Set(['pending', 'retry_pending']);
const isRetryable = status => RETRYABLE.has(String(status || ''));

const embeddingResponse = init => new Response(JSON.stringify({
  data: JSON.parse(init.body).input.map((_, index) => ({
    index, embedding: Array.from({ length: DIMENSIONS }, (_, k) => (k === 0 ? 1 : 0))
  })),
  usage: { total_tokens: 10 }
}), { status: 200 });

const parse = value => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
};

const localEntry = (snapshot, re) => {
  const key = [...snapshot.local.keys()].find(k => re.test(k));
  return key ? { key, value: parse(snapshot.local.get(key)) } : null;
};

// Owner records of whichever side owns them for this mode.
const readRef = (snapshot, mode) => (mode === 'plugin_only'
  ? localEntry(snapshot, /:manifest$/)?.value?.memories?.['1']
  : snapshot.getManifest()?.memories?.['1']) || null;
const readMemory = (snapshot, mode) => (mode === 'plugin_only'
  ? localEntry(snapshot, /:memory:1:r1$/)?.value
  : snapshot.getMemory(1)) || null;

// The durable state an interrupted commit leaves behind: the row is embedded, but the
// manifest ref still says the commit is outstanding.
async function injectOutstandingRef(snapshot, mode) {
  if (mode === 'plugin_only') {
    const entry = localEntry(snapshot, /:manifest$/);
    assert.ok(entry, 'plugin_only: local manifest must exist');
    entry.value.memories['1'].embeddingStatus = 'pending';
    await snapshot.backend.setItem(entry.key, JSON.stringify(entry.value));
    return;
  }
  const row = snapshot.storedRows().find(r => r.key.endsWith(':manifest'));
  assert.ok(row, `${mode}: server manifest row must exist`);
  row.value.memories['1'].embeddingStatus = 'pending';
  await snapshot.mutate(row.key, row.value);
}

// Block the MANIFEST commit so this isolates "the commit failed" from "storage is broken";
// every other write still succeeds. Reports whether the block actually intercepted a write,
// so the test can say which modes had the outage genuinely enforced.
//
// MEASURED: the manifest write does NOT travel as a batch in the server modes. `saveManifest`
// publishes through the single-key route — `/v1/kv/set` in server_only, and `/v1/kv/set` AFTER
// the local mirror write in mirror. Watching only `/v1/kv/batch` (what this helper did first)
// therefore intercepted NOTHING in mirror/server_only, blockIntercepted stayed 0, and the
// "outage" those modes were tested under was not an outage at all. Both routes are watched now,
// and the assertions below require interception in every mode.
function blockManifestCommit(snapshot, mode) {
  const backend = snapshot.backend;
  const state = { armed: true, intercepted: 0 };
  if (mode === 'plugin_only') {
    const rawSet = backend.setItem.bind(backend);
    backend.setItem = async (k, v) => {
      if (state.armed && String(k).endsWith(':manifest')) { state.intercepted += 1; throw new Error('P01_FORCED_COMMIT_FAILURE'); }
      return rawSet(k, v);
    };
    state.release = () => { backend.setItem = rawSet; };
  } else {
    const manifestKeysIn = (url, init) => {
      let body = null;
      try { body = init?.body ? JSON.parse(init.body) : null; } catch (_) { return []; }
      if (!body) return [];
      const target = String(url);
      if (target.endsWith('/v1/kv/set') || target.endsWith('/v1/kv/remove')) {
        return String(body.key || '').endsWith(':manifest') ? [body.key] : [];
      }
      if (target.endsWith('/v1/kv/batch')) {
        return (body.mutations || []).map(m => String(m.key)).filter(k => k.endsWith(':manifest'));
      }
      return [];
    };
    snapshot.hooks.beforeServerRequest = (url, init) => {
      if (!state.armed) return;
      const keys = manifestKeysIn(url, init);
      if (keys.length) {
        state.intercepted += keys.length;
        throw new Error('P01_FORCED_COMMIT_FAILURE');
      }
    };
    state.release = () => { snapshot.hooks.beforeServerRequest = null; };
  }
  return state;
}


(async()=>{
 const rows=[];
 for(const mode of ['plugin_only','server_only']){
  const x=await serverFixture({mode});
  try{
   await x.f.r.api.saveEmbeddingSettings(EMBED_CONFIG);x.hooks.externalFetch=async(_url,init)=>embeddingResponse(init);
   assert.equal((await x.f.run()).completed,1);fiveMore(x.f);assert.equal((await x.f.run()).completed,1);
   await x.f.r.api.retryPendingUnifiedVectors();await x.f.r.api.retryPendingUnifiedVectors();
   const manifestEntry=()=>mode==='plugin_only'?localEntry(x,/:manifest$/):x.storedRows().find(r=>r.key.endsWith(':manifest'));
   const rowFor=key=>mode==='plugin_only'?parse(x.local.get(key)):x.storedRows().find(r=>r.key===key)?.value;
   const write=async(k,v)=>mode==='plugin_only'?x.backend.setItem(k,JSON.stringify(v)):x.mutate(k,v);
   const m=manifestEntry();assert(m);const first=rowFor(m.value.memories['1'].key),second=rowFor(m.value.memories['6'].key);
   assert.equal(first.embedding.status,'ready');assert.equal(second.embedding.status,'ready');
   const canon=[first.artifactDigest,second.artifactDigest];first.embedding.status='pending';await write(m.value.memories['1'].key,first);
   m.value.memories['1'].embeddingStatus='pending';m.value.memories['6'].embeddingStatus='pending';await write(m.key,m.value);
   const result=await x.f.r.api.retryPendingUnifiedVectors();const after=manifestEntry().value;
   const current=[rowFor(after.memories['1'].key),rowFor(after.memories['6'].key)];
   assert.deepEqual(current.map(r=>r.artifactDigest),canon,'derived settlement preserves both canonical artifacts');
   rows.push({mode,result,refStatuses:['1','6'].map(k=>after.memories[k].embeddingStatus),rowStatuses:current.map(r=>r.embedding.status)});
  }finally{await x.cleanup();}
 }
 console.log(JSON.stringify({test:'libra_derived_two_ref_settlement',rows},null,2));
 for(const row of rows){assert.equal(row.result.attempted,2);assert.equal(row.result.completed,2,`${row.mode}: both admitted derived refs settle from fresh durable basis`);assert.equal(row.result.ok,true);assert.deepEqual(row.refStatuses,['ready','ready']);}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
