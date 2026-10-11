'use strict';
// Diagnostic comparison only. The eager arm restores the previous genuine
// physical digest capture; it does not bypass proof or qualify an alternate product.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {fixture}=require('./libra_unified_runtime_fixture.cjs');
const sourcePath=path.resolve(__dirname,'../../plugins/LIBRA.js');
const source=fs.readFileSync(sourcePath,'utf8');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
async function arm(mode,snapshot){
 const transformSource=()=>{
  let text=source;
  if(mode==='eager'){
   const capture='const bodySnapshot = captureCanonicalBodySnapshot(stored);';assert.equal(text.split(capture).length,2);
   text=text.replace(capture,'const bodySnapshot = canonicalConsumptionDigest(stored);');
   const start=text.indexOf('    const rememberConsumedCanonical ='),end=text.indexOf('    const getConsumedCanonicalProof =',start);assert.ok(start>0&&end>start);
   text=text.slice(0,start)+`    const rememberConsumedCanonical = (memory, recordKey, recordDigest) => {
      if (memory) consumedCanonicalProofsByMemory.set(memory, unifiedDeepFreeze({ kind: 'canonical-memory', recordKey: clone(recordKey), recordDigest }));
      return memory;
    };
`+text.slice(end);
  }
  const seam='    const removeMemoryRecord = async ref => {';assert.equal(text.split(seam).length,2);
  return text.replace(seam,'    globalThis.__LOADER_AB__={loadMemoryRef,getConsumedCanonicalProof,snapshotChars:memory=>consumedCanonicalProofsByMemory.get(memory)?.bodySnapshot?.length||0};\n'+seam);
 };
 return fixture({transformSource,...(snapshot?{snapshot}:{})});
}
async function benchmark(){
 const lazy=await arm('lazy');let eager;
 try{
  assert.equal((await lazy.run()).completed,1);await lazy.r.api.retryPendingUnifiedVectors();
  const snapshot={chat:JSON.parse(JSON.stringify(lazy.chat)),values:[...lazy.r.values.entries()]};eager=await arm('eager',snapshot);
  const ref=lazy.getManifest().memories['1'],arms={lazy,eager},rounds=[];
  const initial=await lazy.r.context.__LOADER_AB__.loadMemoryRef(ref),old=await eager.r.context.__LOADER_AB__.loadMemoryRef(ref);
  assert.equal(JSON.stringify(initial),JSON.stringify(old));assert.deepEqual(JSON.parse(JSON.stringify(lazy.r.context.__LOADER_AB__.getConsumedCanonicalProof(initial))),JSON.parse(JSON.stringify(eager.r.context.__LOADER_AB__.getConsumedCanonicalProof(old))));
  for(let round=0;round<3;round++)for(const name of round%2?['eager','lazy']:['lazy','eager']){
   const api=arms[name].r.context.__LOADER_AB__,start=performance.now();for(let i=0;i<30;i++)assert.ok(await api.loadMemoryRef(ref));
   rounds.push({round,arm:name,loads:30,elapsedMs:performance.now()-start});
  }
  const api=lazy.r.context.__LOADER_AB__,retained=[];for(let i=0;i<30;i++)retained.push(await api.loadMemoryRef(ref));
  const retainedSnapshotChars=retained.reduce((n,memory)=>n+api.snapshotChars(memory),0);
  for(const memory of retained)api.getConsumedCanonicalProof(memory);
  assert.equal(retained.reduce((n,memory)=>n+api.snapshotChars(memory),0),0);
  const summary=Object.fromEntries(Object.keys(arms).map(name=>[name,{loads:90,totalMs:rounds.filter(row=>row.arm===name).reduce((n,row)=>n+row.elapsedMs,0)}]));
  return {diagnostic:true,sourceSHA256:sha(source),physicalRecords:1,bodyBytes:Buffer.byteLength(JSON.stringify(initial)),rounds,summary,eagerOverLazyRatio:summary.eager.totalMs/summary.lazy.totalMs,genuinePrivateProofParity:true,retainedObjects:30,retainedSnapshotChars,snapshotCharsAfterPromotion:0,limits:'Local fixture-generated persisted JSON; alternating bounded actual loader calls. Eager arm restores prior genuine proof capture for diagnostic comparison only. Timing is observational under concurrent CPU load. Snapshot chars measure string length, not process heap. Unconsumed strings live with returned objects via WeakMap; promotion drops strings, object GC drops entries; no strong registry.'};
 }finally{if(eager)await eager.r.cleanup();await lazy.r.cleanup();}
}
module.exports={benchmark};
if(require.main===module)benchmark().then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
