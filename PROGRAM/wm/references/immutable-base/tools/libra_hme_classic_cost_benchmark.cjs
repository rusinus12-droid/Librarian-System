'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {runtime,flush}=require('./libra_typed_recall_queue_test.cjs');
const {memoryEntry}=require('./libra_recall_test_runtime.cjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
async function run(version,n){
 assert(['v5','v6'].includes(version));assert([10,100,1000,2000].includes(n));
 const dist=version==='v5'?'C:/Users/rusin/AppData/Local/Temp/WM-HME-v5-20261003/dist/LIBRA World Manager Full.js':path.resolve(__dirname,'../dist/LIBRA World Manager Full.js');
 const r=await runtime(null,{admittedHost:true,dist,transformCode(code){
  const build='        const buildHmeGraphIndexFromScopeIndex = (scopeIndex = null, options = {}) => {';assert(code.includes(build));
  code=code.replace(build,build+'globalThis.__CLASSIC_COST_BUILDS__=(globalThis.__CLASSIC_COST_BUILDS__||0)+(Array.isArray(options.typedNodes)?0:1);');
  const expose='            getRecallDerivedStorageAdapter,';assert(code.includes(expose));return code.replace(expose,expose+'\n            __classicEnsure:ensureHybridScopeIndex,');
 }});
 r.api.MemoryEngine.CONFIG.hmeAssociativeGraphMode='balanced';
 const lore=Array.from({length:n},(_,i)=>memoryEntry(i+1,'Explicit source fact '+(i+1)+' in the same harbor.'));
 const original=JSON.stringify(lore),originalSha256=sha(original),scope=r.snapshot.scopeKey,rows=[];
 let writes=0,writeBytes=0;const set=r.storage.setItem;
 r.storage.setItem=async(k,v)=>{if(k.startsWith('libra:v1:hme-derived:')&&k.endsWith(':graph')){writes++;writeBytes+=Buffer.byteLength(String(v));}return set(k,v);};
 const measure=async label=>{const before={builds:r.context.__CLASSIC_COST_BUILDS__||0,writes,writeBytes},at=performance.now();
  const value=r.api.MemoryEngine.__classicEnsure(lore,{scopeKey:scope,currentTurn:n});await flush();assert.equal(value.ok,true);
  rows.push({label,graphMode:value.graphMode,graphChanged:value.graphChanged,indexMode:value.mode,builds:(r.context.__CLASSIC_COST_BUILDS__||0)-before.builds,graphWrites:writes-before.writes,graphWriteBytes:writeBytes-before.writeBytes,wallMs:performance.now()-at});
 };
 await measure('cold');await measure('unchanged warm');
 const source=lore.find(e=>e.key==='lmai_memory::1');source.content+=' One explicit current source correction.';
 await measure('one-source correction');await measure('unchanged after correction');
 assert.equal(rows[0].builds,1);assert.equal(rows[2].builds,1);
 for(const row of [rows[1],rows[3]]){assert.equal(row.builds,version==='v5'?1:0);assert.equal(row.graphWrites,version==='v5'?1:0);}
 assert.equal(r.state.calls.length,0);
 const file=path.resolve(__dirname,'../test-output/wm-hme-v6-20261003',version+'-classic-'+n+'.json');assert(!fs.existsSync(file));
 fs.writeFileSync(file,JSON.stringify({version,n,bundleSha256:sha(fs.readFileSync(dist)),sourceSha256:originalSha256,rows,models:0,limits:['Classic graph API in offline VM with same explicit source bytes; not a registered response or retrieval quality evaluation.','Counts describe classic whole-graph builds/writes independently from persistent typed source graph.','Existing balanced preset and retention caps unchanged.','Mock graph storage bytes; no independent host durability proof.','Shared-PC wall time is descriptive, not an isolated or universal speed claim.']},null,2));
 console.log(JSON.stringify({version,n,rows,file}));
}
if(require.main===module)run(process.argv[2],Number(process.argv[3])).catch(e=>{console.error(e.stack);process.exitCode=1;});
