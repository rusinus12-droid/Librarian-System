'use strict';
// Separate no-model lifecycle cells; evaluator facts never enter product scoring.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto');
const bench=require('./libra_hme_provenance_cost_benchmark.cjs');
const {questions}=require(path.join(bench.ART,'fixture/panel.cjs'));
const sha=x=>crypto.createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex'),clone=x=>JSON.parse(JSON.stringify(x));
async function run(version,n){
 assert(['v4','v5','v6'].includes(version));assert([10,100,1000,2000].includes(n));
 const prepared=await bench.prepare(n),file=path.join(bench.ART,version+'-acknowledged-'+n+'.json');assert(!fs.existsSync(file));
 const dist=version==='v4'?'C:/Users/rusin/AppData/Local/Temp/WM-HME-v4-20261003/dist/LIBRA World Manager Full.js':version==='v5'?'C:/Users/rusin/AppData/Local/Temp/WM-HME-v5-20261003/dist/LIBRA World Manager Full.js':path.resolve(__dirname,'../dist/LIBRA World Manager Full.js');
 const io=bench.instrumentStore(path.join(bench.ART,version+'-acknowledged-'+n+'-store'));
 let a=await bench.shared.startAdapter(prepared.initialSource,bench.SCOPE,io.store,dist),scope=a.api.LibraDataStorage.scopeKeyFor(a.char,a.chat),key=a.api.LibraDataStorage.storageKeyFor(scope),reports=[],rows=[];
 const initialQuestion=questions(prepared.initialSource).find(q=>q.id==='integrated-current-and-discovery');assert(initialQuestion);
 io.setCanonicalKey(key);
 const observe=()=>{const original=a.api.MemoryEngine.maintainHmeTypedSourceGraph;a.api.MemoryEngine.maintainHmeTypedSourceGraph=async(...args)=>{const result=await original(...args);reports.push(clone(result));return result;};};
 observe();await a.typed.compat.pluginStorage.setItem(key,JSON.stringify({scopeKey:scope,entries:prepared.initial,resetGeneration:0}));
 const write=()=>fs.writeFileSync(file,JSON.stringify({schema:'wm.unchanged-canonical-acknowledgment-cost.v1',version,n,bundleSha256:sha(fs.readFileSync(dist)),sourceSha256:prepared.sourceSha256,canonicalSha256:prepared.canonicalSha256,rows,realModels:0,limits:['One separately owned fresh Node process per scale/version; shared-PC timing.','Actual registered requests and acknowledged persistence with physical fsync/rename storage; no real model authoring.','Single-source holdout corrections/deletion affect canonical fixture entries; raw transcript stays byte-identical.','IO-boundary heap samples include fixture overhead; not full instruction-level peak or acceptance.']},null,2));
 const request=async(label,question=initialQuestion,forbidden=[])=>{const measured=await io.measure(()=>a.request(question.query)),last=a.typed.rollout.inspect().last,evaluated=bench.provenance(question,measured.value,last);rows.push({label,kind:'registered request',...measured.measurement,evaluated,trace:bench.traceOf(last)});write();assert.equal(evaluated.allRequiredFinalFacts,true,label);assert.equal(evaluated.forbidden.length,0,label);for(const word of forbidden)assert(!JSON.stringify(measured.value).includes(word),label+' excludes '+word);return rows.at(-1);};
 const persist=async(label,entries,options={})=>{const before=reports.length,rawBefore=(await a.api.LibraDataStorage.readVerified(scope)).raw,measured=await io.measure(()=>a.typed.persist(a.chat,clone(entries),options));assert.equal(measured.value.ok,true,measured.value.reason);const read=await a.api.LibraDataStorage.readVerified(scope);assert.equal(read.ok,true,read.reason);rows.push({label,kind:'actual acknowledged persistence',...measured.measurement,maintenance:reports.slice(before),canonicalCount:read.entries.length,canonicalSha256:sha(read.entries),canonicalRawBeforeSha256:sha(rawBefore),canonicalRawAfterSha256:sha(read.raw),exactCanonicalBytesUnchanged:rawBefore===read.raw});write();return read.entries;};
 try{
  await request('cold');let entries=await persist('initial acknowledgment and source normalization',prepared.initial);
  await request('after initial acknowledgment');const stableEntries=clone(entries),before=sha(stableEntries);
  entries=await persist('unchanged acknowledgment',stableEntries);const unchanged=rows.at(-1);
  assert.equal(sha(entries),before);assert.equal(unchanged.graphWrites.length,0);
  if(version==='v5'||version==='v6'){assert.equal(unchanged.exactCanonicalBytesUnchanged,true);assert.equal(Object.values(unchanged.byKey).filter(r=>r.group==='canonical').reduce((s,r)=>s+r.writes,0),0,'identical canonical revision is not rewritten');}
  else assert(unchanged.physicalIo.writeBytes>0,'frozen v4 reproduces whole canonical rewrite');
  const warm=await request('unchanged warm request');assert.equal(warm.graphWrites.length,0);assert.equal(warm.trace.graph.maintenance.rebuiltNodes,0);assert.equal(warm.trace.graph.maintenance.mode,'reused');assert(warm.physicalIo.readBytes>Buffer.byteLength(JSON.stringify(entries)));
  const changed=clone(entries),entry=changed.find(e=>e.key==='lmai_memory::a1');assert(entry);entry.content=entry.content.replaceAll('BENCH_A0','HOLDOUT_SOURCE_CORRECTION');
  entries=await persist('same-ID one-source correction',changed);const update=rows.at(-1);assert.equal(update.maintenance.at(-1).maintenance.sourceChanges,1);assert.equal(update.maintenance.at(-1).maintenance.rebuiltNodes,1);assert.equal(update.graphWrites.length,1);
  const corrected={...initialQuestion,required:initialQuestion.required.map(f=>({...f,value:f.value.replaceAll('BENCH_A0','HOLDOUT_SOURCE_CORRECTION')}))};
  await request('after one-source correction',corrected,['BENCH_A0']);
  entries=await persist('one-source deletion',entries.filter(e=>e.key!=='lmai_memory::a1'),{reason:'manual-delete',allowManagedDrops:true});const deletion=rows.at(-1);assert.equal(deletion.maintenance.at(-1).maintenance.removedNodes,1);assert.equal(deletion.maintenance.at(-1).maintenance.rebuiltNodes,0);
  const deleted={...initialQuestion,required:initialQuestion.required.filter(f=>f.family!=='memory')};
  await request('after deletion',deleted,['BENCH_A0','HOLDOUT_SOURCE_CORRECTION']);
  a.dispose();a=await bench.shared.startAdapter(prepared.initialSource,bench.SCOPE,io.store,dist,false,{expectedCanonicalEntries:entries});observe();
  const restarted=await request('runtime restart',deleted,['BENCH_A0','HOLDOUT_SOURCE_CORRECTION']);assert.equal(restarted.trace.graph.maintenance.mode,'restored');assert.equal(restarted.graphWrites.length,0);
  const physical=fs.readdirSync(io.store.root).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(io.store.root,f))));
  const chunk=physical.find(p=>p.key!==key&&String(p.key).includes(key))||physical.find(p=>p.key===key);assert(chunk);
  const original=chunk.value;await io.store.setItem(chunk.key,original+'CORRUPT_HOLDOUT');
  try{const strict=await a.api.LibraDataStorage.readVerified(scope);assert.equal(strict.ok,false);rows.push({label:'physical corruption negative control',kind:'strict physical read',ok:strict.ok,reason:strict.reason});write();}
  finally{await io.store.setItem(chunk.key,original);assert.equal(await io.store.getItem(chunk.key),original);}
  assert.equal((await a.api.LibraDataStorage.readVerified(scope)).ok,true);assert.equal(a.calls.actualModel,0);assert.equal(a.calls.blockedTransport,0);assert.equal(sha(prepared.initialSource),prepared.sourceSha256);
 }finally{a.dispose();}
 console.log(JSON.stringify({version,n,file,rows:rows.length,passed:true,models:0}));
}
module.exports={run};
if(require.main===module)run(process.argv[2],Number(process.argv[3])).catch(e=>{console.error(e.stack);process.exitCode=1;});
