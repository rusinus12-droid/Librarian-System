'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createMemorySuiteServer,NAMESPACES}=require('../server/server.cjs');
const {readZipEntries}=require('../tools/zip_writer.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function server(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'portable-http-'));const app=createMemorySuiteServer({dataDir:dir,port:0,autoBackup:false,computeEnabled:false});const addr=await app.listen(),url='http://127.0.0.1:'+addr.port;
 const b=await fetch(url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'flashback_hayaku_bridge'}}).then(r=>r.json());
 const headers={'Content-Type':'application/json','X-Memory-Suite-Plugin':'flashback_hayaku_bridge','X-Memory-Suite-Manager':'retrace',Authorization:'Bearer '+b.token};
 const call=async(action,body={},expected=200)=>{const r=await fetch(url+'/v1/manager/portable/'+action,{method:'POST',headers,body:JSON.stringify(body)}),p=await r.json();assert.equal(r.status,expected,action+' '+JSON.stringify(p));return p.result||p;};
 return {dir,app,url,headers,call};}
async function wait(s,ref,end='ready'){for(let i=0;i<400;i++){const r=await s.call('status',ref);if(r.status===end)return r;if(r.status==='failed')throw Error(JSON.stringify(r));await sleep(30);}throw Error('poll_timeout');}
(async()=>{let a,b;const carry=fs.mkdtempSync(path.join(os.tmpdir(),'portable-carry-'));try{
 a=await server();b=await server();
 for(const ns of NAMESPACES)a.app.repositories[ns].mutate({kind:'set',space:'plugin',key:'snapshot-'+ns,value:{owner:ns,text:'원문 데이터 '+ns+' 가나다'.repeat(1000)},operationId:'fixture_'+ns+'_012345',expectedRevision:0});
 const cap=await a.call('capabilities');assert.equal(cap.fullNamespaces.length,5);
 const unauthorized=await fetch(a.url+'/v1/manager/portable/capabilities',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(unauthorized.status,403);
 let ex=await a.call('export-start',{operationId:'export-test-0001'}),again=await a.call('export-start',{operationId:'export-test-0001'});assert.equal(ex.transferId,again.transferId);ex=await wait(a,ex);
 const chunks=[];for(let off=0;off<ex.totalBytes;){const r=await a.call('download-chunk',{...ex,offset:off});const bytes=Buffer.from(r.base64,'base64');assert.equal(r.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));chunks.push(bytes);off+=bytes.length;}
 const zip=Buffer.concat(chunks);assert.equal(crypto.createHash('sha256').update(zip).digest('hex'),ex.sha256);
 const zpath=path.join(carry,'download.zip');fs.writeFileSync(zpath,zip);assert.equal(readZipEntries(zpath).length,7,'new streaming export is legacy reader compatible');
 let up=await b.call('upload-start',{operationId:'upload-test-0001',size:zip.length});
 await b.call('upload-chunk',{...up,offset:1,base64:zip.subarray(0,20).toString('base64')},409);
 for(let off=0;off<zip.length;){const part=zip.subarray(off,off+cap.limits.chunkBytes),body={...up,offset:off,base64:part.toString('base64')};await b.call('upload-chunk',body);const dupe=await b.call('upload-chunk',body);assert.equal(dupe.idempotent,true);off+=part.length;}
 await b.call('upload-finish',{...up,sha256:ex.sha256});up=await wait(b,up);
 assert.equal(b.app.repositories.libra.get('plugin','snapshot-libra').exists,false,'upload alone never restores');
 let plan=await b.call('restore-plan',up);assert.equal(plan.hasExistingData,false);
 await b.call('restore-execute',{...up,planId:plan.planId,confirmation:'wrong'},409);
 await b.call('restore-execute',{...up,planId:plan.planId,confirmation:plan.confirmation});up=await wait(b,up,'restored');assert.equal(up.restored,true);
 for(const ns of NAMESPACES)assert.deepEqual(b.app.repositories[ns].get('plugin','snapshot-'+ns).value,a.app.repositories[ns].get('plugin','snapshot-'+ns).value);
 assert.notEqual(a.app.token,b.app.token,'destination token retained');
 // A second import onto populated DATA requires explicit replacement acknowledgement.
 let u2=await b.call('upload-start',{operationId:'upload-test-0002',size:zip.length});await b.call('upload-chunk',{...u2,offset:0,base64:zip.toString('base64')});await b.call('upload-finish',u2);u2=await wait(b,u2);plan=await b.call('restore-plan',u2);
 assert.equal(plan.hasExistingData,true);assert.ok(plan.warning.includes('기존에 사용하던 데이터가 있습니다.'));
 await b.call('restore-execute',{...u2,planId:plan.planId,confirmation:plan.confirmation},409);
 // A new write after preview invalidates the restore plan.
 b.app.repositories.libra.mutate({kind:'set',space:'plugin',key:'post-preview',value:{keep:true},operationId:'fixture_postpreview_001',expectedRevision:0});
 await b.call('restore-execute',{...u2,planId:plan.planId,confirmation:plan.confirmation,replaceAcknowledged:true});
 let failed;for(let i=0;i<100;i++){failed=await b.call('status',u2);if(failed.status==='failed')break;await sleep(20);}assert.equal(failed.error,'restore_plan_changed');assert.equal(b.app.repositories.libra.get('plugin','post-preview').exists,true);
 const wrong={...ex,transferToken:'wrong'};await a.call('status',wrong,404);
 await a.call('cancel',ex);await a.call('status',ex,404);
 console.log(JSON.stringify({test:'portable_transfer_runtime',result:'pass',namespaces:5,downloadBytes:zip.length,emptyRestore:true,replaceConfirmation:true,stalePlanRejected:true,duplicateChunkIdempotent:true,legacyZipReadback:true}));
 }finally{for(const s of [a,b].filter(Boolean)){await s.app.close();fs.rmSync(s.dir,{recursive:true,force:true});}fs.rmSync(carry,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
