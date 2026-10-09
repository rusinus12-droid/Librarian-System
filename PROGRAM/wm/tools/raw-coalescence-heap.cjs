'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),v8=require('node:v8');
const {fixture,seed,store,rawFor,copyRaw,tick}=require('./raw-coalescence-support.cjs');
(async()=>{
 const [artifact,out,tag]=process.argv.slice(2);assert.ok(artifact&&out&&/^[A-Za-z0-9-]+$/.test(tag));
 const f=await fixture(artifact);let raw=rawFor(f.scope);await store(f,raw);seed(f,{postRaw:copyRaw(raw)});raw=null;
 const result=await f.d.readVerified(f.scope,{readonly:true});assert.equal(result.ok,true);assert.equal(result.raw.length,568340);await tick();
 const owned=f.r.context.__RAW_OWNER_VALUES__(),proof=f.r.context.__RAW_READ_PROOF__();assert.equal(proof,result);
 const markers=[{label:'baseline_before',value:owned.beforeRaw,category:'owner'},{label:'baseline_post',value:owned.postRaw,category:'owner'},{label:'readonly_raw',value:proof.raw,category:'owner'}];
 globalThis.__WM_EQUAL_RAW_MARKERS__=markers;
 const privateDir='/tmp/wm-private-heap-d09f18a13aaa';fs.mkdirSync(privateDir,{recursive:true,mode:0o700});fs.chmodSync(privateDir,0o700);
 if(global.gc){global.gc();await tick();global.gc();}
 const snapshot=v8.writeHeapSnapshot(path.join(privateDir,'coalescence-'+tag+'.heapsnapshot'));
 const groups=[];for(let i=0;i<markers.length;i++){const row=markers[i];let g=groups.find(x=>markers[x.representative].value===row.value);if(!g){g={group:groups.length,representative:i,logicalChars:row.value.length,members:[]};groups.push(g);}g.members.push({label:row.label,category:row.category});}
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'RAW-EQUALITY.json'),JSON.stringify({method:'exact === after snapshot',groups:groups.map(({representative,...g})=>g)},null,2)+'\n');
 fs.writeFileSync(path.join(out,'PRIVATE-SNAPSHOT-LOCATION.json'),JSON.stringify({snapshot,rawHeapIncluded:false},null,2)+'\n');
 fs.writeFileSync(path.join(out,'READ-PARITY.json'),JSON.stringify({physicalReads:f.physical.length,physicalBytes:f.physical.reduce((n,x)=>n+x.bytes,0),parses:f.counts.total,proofKeys:Object.keys(result).sort(),baselineBeforeChars:owned.beforeRaw.length,postChars:owned.postRaw.length},null,2)+'\n');
 console.log(JSON.stringify({snapshotWritten:true,rawHeapIncluded:false,physicalReads:f.physical.length,parses:f.counts.total,postChars:owned.postRaw.length}));globalThis.__WM_EQUAL_RAW_MARKERS__=null;
})().catch(error=>{console.error(error.stack);process.exitCode=1});
