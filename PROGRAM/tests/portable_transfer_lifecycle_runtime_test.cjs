'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createMemorySuiteServer}=require('../server/server.cjs');
(async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'portable-lifecycle-')),app=createMemorySuiteServer({dataDir:dir,port:0,autoBackup:false,computeEnabled:false});try{
 const addr=await app.listen(),url='http://127.0.0.1:'+addr.port,b=await fetch(url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'flashback_hayaku_bridge'}}).then(r=>r.json());
 const headers={'Content-Type':'application/json','X-Memory-Suite-Plugin':'flashback_hayaku_bridge','X-Memory-Suite-Manager':'retrace',Authorization:'Bearer '+b.token};
 const call=async(action,body={},code=200)=>{const r=await fetch(url+'/v1/manager/portable/'+action,{method:'POST',headers,body:JSON.stringify(body)}),p=await r.json();assert.equal(r.status,code,action+' '+JSON.stringify(p));return p.result||p;};
 const wait=async h=>{for(let i=0;i<500;i++){const p=await call('status',h);if(['ready','failed'].includes(p.status))return p;await new Promise(r=>setTimeout(r,20));}throw Error('poll_timeout');};
 const owner=await fetch(url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'hayaku_locator_continuity'}}).then(r=>r.json());
 const unauthorized=await fetch(url+'/v1/manager/portable/capabilities',{method:'POST',headers:{...headers,Authorization:'Bearer '+owner.token,'X-Memory-Suite-Plugin':'hayaku_locator_continuity'},body:'{}'});assert.equal(unauthorized.status,403);
 const refs=[];for(let i=0;i<3;i++)refs.push(await call('upload-start',{operationId:'reserve-test-'+i,size:22}));await call('upload-start',{operationId:'reserve-test-full',size:22},429);
 await call('upload-start',{operationId:'reserve-test-0',size:23},409);await call('upload-finish',refs[0],409);
 await call('upload-chunk',{...refs[0],offset:0,base64:'not-base64'},400);
 await call('upload-chunk',{...refs[0],offset:0,base64:Buffer.from('a').toString('base64'),sha256:'0'.repeat(64)},422);
 for(const r of refs)await call('cancel',r);await call('status',refs[0],404);
 const original=crypto.randomBytes(1024*1024).toString('hex');app.repositories.libra.mutate({kind:'set',space:'plugin',key:'large-fixture',value:original,operationId:'large_fixture_seed_001'});
 let ex=await call('export-start',{operationId:'large-export-0001'});ex=await wait(ex);assert.equal(ex.status,'ready',JSON.stringify(ex));assert.ok(ex.totalBytes>256*1024);
 let upload=await call('upload-start',{operationId:'large-upload-0001',size:ex.totalBytes}),chunkCount=0;
 for(let offset=0;offset<ex.totalBytes;){const p=await call('download-chunk',{...ex,offset});await call('upload-chunk',{...upload,offset,base64:p.base64,sha256:p.sha256});offset+=Buffer.from(p.base64,'base64').length;chunkCount++;}
 await call('upload-finish',{...upload,sha256:'0'.repeat(64)});const invalid=await wait(upload);assert.equal(invalid.status,'failed');assert.equal(invalid.error,'portable_zip_archive_digest');assert.equal(app.repositories.libra.get('plugin','large-fixture').value,original);
 await call('cancel',upload);await call('cancel',ex);
 assert.equal(fs.readdirSync(path.join(dir,'runtime','portable-transfers')).length,0);
 console.log(JSON.stringify({test:'portable_transfer_lifecycle_runtime',pass:true,chunkCount,archiveBytes:ex.totalBytes,ownerRejected:true,reservationLimit:true,cancelCleanup:true,wholeDigestRejected:true,liveDataUnchanged:true}));
 }finally{await app.close();fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
