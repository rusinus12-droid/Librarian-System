'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { runtime } = require('./libra_typed_recall_queue_test.cjs');
// Changing the consumer to construct persistent index proofs must fail this test.
const digestSeam = 'const persistentDigest = value => SemanticRecallIndex.sourceHash(JSON.stringify(persistentRecord(value)));';
const instrument = code => {
  assert.equal(code.split(digestSeam).length, 2, 'exactly one real persistentDigest seam');
  return code.replace(digestSeam, 'const persistentDigest = value => { globalThis.__PERSISTENT_DIGESTS__ = (globalThis.__PERSISTENT_DIGESTS__ || 0) + 1; return SemanticRecallIndex.sourceHash(JSON.stringify(persistentRecord(value))); };');
};
test('production canonical binding pass omits unused persistent proofs, retaining fresh full proof work', async () => {
  const r = await runtime(null, { admittedHost: true, transformCode: instrument });
  const api = r.context.__QUEUE_TEST__, policy = api.rollout.begin().policy;
  assert.equal(policy.mode, 'production');
  const snapshot = r.snap(), unit = r.corpus.enumerate(snapshot).find(u => u.family === 'entity');
  assert.ok(unit && r.corpus.adapters.entity.eligibility(unit, snapshot).eligible);
  const composed = api.consumers.compose({ baseline: [{key:'native-entity',text:'Native entity section',required:true,bindings:[unit]}], snapshot, policy });
  r.context.__PERSISTENT_DIGESTS__ = 0;
  const output = api.consumers.finalize({ sections:composed.sections,currentSnapshot:()=>r.snap(),policy,mode:'hybrid',budget:{maxTokens:20000,maxChars:80000} });
  assert.equal(output.ok, true); assert.equal(api.consumers.verified(output), true);
  assert.equal(output.directBlocks.length, 1);
  assert.equal(r.context.__PERSISTENT_DIGESTS__, 0, 'production canonical binding must not construct unused persistent index proofs');
  const cold = r.snap(); r.corpus.enumerate(cold);
  assert.ok(r.context.__PERSISTENT_DIGESTS__ > 0, 'instrumentation still sees full persistent construction');
});
for (const path of ['inspect', 'formatter']) test(path + ' current resolution omits unused persistent proofs', async () => {
  const r = await runtime(null, { admittedHost: true, transformCode: instrument }), snapshot = r.snap();
  const unit = r.corpus.enumerate(snapshot).find(u => u.family === 'entity');
  r.context.__PERSISTENT_DIGESTS__ = 0;
  if (path === 'inspect') assert.equal(r.corpus.inspect(unit, snapshot).eligible, true);
  else assert.ok(r.corpus.adapters.entity.formatter(unit, snapshot).length > 0);
  assert.equal(r.context.__PERSISTENT_DIGESTS__, 0, path + ' must not construct unused persistent proofs');
});
const {setup,expose}=require('./libra_typed_consumer_projection_support.cjs');
const lookupSeam='enumerateTypedConsumerBindings = (snapshot, policy, identities) => {';
const detailed=(mutate=false)=>code=>{
  code=instrument(code);
  for(const [seam,added]of [
    ['const digest = value => hash(JSON.stringify(value));','const digest = value => { globalThis.__ORDINARY_HASHES__=(globalThis.__ORDINARY_HASHES__||0)+1; return hash(JSON.stringify(value)); };'],
    ['const validateIntegrityMeta = (record = null, context = {}) => {','const validateIntegrityMeta = (record = null, context = {}) => { globalThis.__SIGNED_CHECKS__=(globalThis.__SIGNED_CHECKS__||0)+1;'],
    [lookupSeam,lookupSeam+' globalThis.__PROJECT_LOOKUPS__=(globalThis.__PROJECT_LOOKUPS__||0)+1;'+(mutate?' persistentDigest({deliberateMutation:true});':'')]
  ]){assert.equal(code.split(seam).length,2,'exactly one production counter seam');code=code.replace(seam,added);}
  return expose(code);
};
const resetCounters=r=>{for(const key of ['__PERSISTENT_DIGESTS__','__ORDINARY_HASHES__','__SIGNED_CHECKS__','__PROJECT_LOOKUPS__'])r.context[key]=0;};
const zero=r=>assert.equal(r.context.__PERSISTENT_DIGESTS__,0,'unused persistent proof contract');
for(const size of [0,80])test('signed '+(size?'large':'small')+' corpus keeps all three paths proof-free and each independent verification fresh',async()=>{
  const r=await setup(undefined,detailed(),size);
  for(const family of ['memory','entity','world','narrative'])assert.ok(r.eligible.some(u=>u.family===family));
  for(const subtype of ['state_turn','state_summary','codex_fact'])assert.ok(r.eligible.some(u=>u.subtype===subtype));
  const selected=['memory','entity','world','narrative'].map(f=>r.select(f));
  const baseline=[{key:'opaque-1',text:'Canonical baseline one',bindings:r.eligible.filter(u=>u.family==='world'),required:true},
    {key:'opaque-2',text:'Canonical baseline two',bindings:r.eligible.filter(u=>u.family==='narrative'),required:true}];
  const com=r.compose(selected,baseline);
  resetCounters(r);const output=r.finish(com);
  assert.equal(output.ok,true);assert.ok(r.context.__PROJECT_LOOKUPS__>0,'production canonical lookup actually ran');zero(r);
  for(let i=0;i<3;i++){
    const hashes=r.context.__ORDINARY_HASHES__,checks=r.context.__SIGNED_CHECKS__,lookups=r.context.__PROJECT_LOOKUPS__;
    assert.equal(r.consumer.verified(output),true);zero(r);
    assert.ok(r.context.__ORDINARY_HASHES__>hashes,'fresh ordinary dependency work');
    assert.ok(r.context.__SIGNED_CHECKS__>checks,'fresh signed validation work');
    assert.ok(r.context.__PROJECT_LOOKUPS__>lookups,'later independent binding pass');
  }
  for(const unit of selected){
    for(const cold of [true,false]){
      const snapshot=cold?r.snap():r.snapshot;
      resetCounters(r);assert.equal(r.corpus.inspect(unit,snapshot).eligible,true);zero(r);assert.ok(r.context.__ORDINARY_HASHES__>0);
      resetCounters(r);assert.ok(r.corpus.adapters[unit.family].formatter(unit,snapshot).length);zero(r);assert.ok(r.context.__ORDINARY_HASHES__>0);
      if(unit.family!=='memory')assert.ok(r.context.__SIGNED_CHECKS__>0);
    }
  }
  resetCounters(r);r.corpus.enumerate(r.snap());assert.ok(r.context.__PERSISTENT_DIGESTS__>0,'full cold enumeration still constructs persistent proofs');
});
test('mutation control: one deliberately inserted persistentDigest is detected on real production canonical lookup',async()=>{
  const r=await setup(undefined,detailed(true));
  const com=r.compose([],[{key:'mutation-control',text:'Native entity',bindings:[r.select('entity')],required:true}]);
  resetCounters(r);const output=r.finish(com);assert.equal(output.ok,true);assert.ok(r.context.__PROJECT_LOOKUPS__>0);
  assert.throws(()=>zero(r),/unused persistent proof contract/);assert.ok(r.context.__PERSISTENT_DIGESTS__>0);
});
