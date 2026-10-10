'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const net=require('node:net');const crypto=require('node:crypto');
const {fixture}=require('./helpers/updater_fixture.cjs');
const core=require('../../UPDATER/core/program-only.cjs');
const source=path.resolve(__dirname,'..');
const sourceVersion=fs.readFileSync(path.join(source,'VERSION.txt'),'utf8').trim();
const targetVersion=sourceVersion.replace(/(\d+)$/,n=>String(Number(n)+1));
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});
async function api(data,route,body){const config=JSON.parse(fs.readFileSync(path.join(data,'config/server-config.json')));const token=fs.readFileSync(path.join(data,'runtime-token.txt'),'utf8').trim();const r=await fetch(`http://127.0.0.1:${config.port}${route}`,{method:body?'POST':'GET',headers:{'Authorization':'Bearer '+token,'x-memory-suite-admin':'1','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});return{status:r.status,body:await r.json()};}
const put=(data,marker)=>api(data,'/v1/kv/set',{namespace:'libra',space:'plugin',key:'phase3-proof',operationId:crypto.randomUUID(),value:{marker}});
const get=data=>api(data,'/v1/kv/get?namespace=libra&space=plugin&key=phase3-proof');
(async()=>{let failures=0;
 for(const mode of ['success','candidate_failure','committed_live_failure']){const f=await fixture();try{
   fs.rmSync(f.p('PROGRAM'),{recursive:true});fs.cpSync(source,f.p('PROGRAM'),{recursive:true});
   fs.rmSync(f.p('.update/PROGRAM.next'),{recursive:true});fs.cpSync(source,f.p('.update/PROGRAM.next'),{recursive:true});
   fs.writeFileSync(f.p('.update/PROGRAM.next/VERSION.txt'),targetVersion+'\n');
   const serverPath=f.p('.update/PROGRAM.next/server/server.cjs');fs.writeFileSync(serverPath,fs.readFileSync(serverPath,'utf8').replace(/const SERVER_VERSION = '[^']+';/,`const SERVER_VERSION = '${targetVersion}';`));
   f.receipt.targetVersion=targetVersion;
   fs.writeFileSync(f.p('DATA/config/server-config.json'),JSON.stringify({schema:'memory-suite.server-config.v1',host:'127.0.0.1',port:await freePort(),autoBackup:false,computeEnabled:false,computeWorkers:1}));
   await core.startServer(f.p('PROGRAM'),f.p('DATA'));assert.equal((await put(f.p('DATA'),'BEFORE')).status,200);
   const hooks={startServer:async(program,data,options)=>{
     if(!options.verifyMode){const j=JSON.parse(fs.readFileSync(f.p('UPDATER/update-state.json')));assert.equal(j.decision,'commit');assert.ok(j.committedAt);}
     const health=await core.startServer(program,data,options);
     if(options.verifyMode){assert.equal((await get(data)).status,503,'real candidate blocks ordinary storage route');if(mode==='candidate_failure'){fs.writeFileSync(f.p('DATA/value'),'CANDIDATE-DAMAGE');throw new Error('injected_real_candidate_failure');}}
     else {assert.equal((await put(data,'POST-COMMIT')).status,200);if(mode==='committed_live_failure')throw new Error('injected_after_live_http_write');}
     return health;
   }};
   if(mode==='success')assert.equal((await core.applyProgramOnly({rootDir:f.root,receipt:f.receipt,hooks})).status,'complete');
   else await assert.rejects(()=>core.applyProgramOnly({rootDir:f.root,receipt:f.receipt,hooks}),mode==='candidate_failure'?/injected_real_candidate_failure/:/injected_after_live_http_write/);
   if(mode==='committed_live_failure')assert.equal((await core.recoverInterruptedProgramOnly({rootDir:f.root})).journal.status,'complete');
   const live=await core.fetchHealth(f.p('DATA'));assert.equal(live.version,mode==='candidate_failure'?sourceVersion:targetVersion);assert.equal(live.maintenanceMode,false);
   const readback=await get(f.p('DATA'));assert.equal(readback.status,200);assert.equal(readback.body.result.value.marker,mode==='candidate_failure'?'BEFORE':'POST-COMMIT');
   assert.equal(fs.readFileSync(f.p('DATA/value'),'utf8'),'BEFORE');core.runIntegrity(f.p('PROGRAM'),f.p('DATA'));
   console.log('PASS: real HTTP + SQLite + launcher '+mode);
 }catch(e){failures++;console.error('FAIL: real-server '+mode+' :: '+e.stack);}finally{try{await core.stopServerIfRunning(f.p('PROGRAM'),f.p('DATA'));}catch(_){}f.cleanup();}}
 assert.equal(failures,0);console.log('remote_update_real_server_runtime_test: PASS');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
