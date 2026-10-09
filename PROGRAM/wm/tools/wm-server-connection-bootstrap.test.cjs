'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadGui}=require('./libra_management_gui_integration_test.cjs');
const C=require('../src/wm-storage-contracts.source.js');
const KEY='wm.server-connection.v1',baseUrl='https://wm.example.test';
const credential='mscap1.'+Buffer.from(JSON.stringify({schema:'memory-suite.capability-token.v1',pluginId:'libra_world_manager'})).toString('base64url')+'.'+'a'.repeat(43);
const caps={schema:'wm.service-capabilities.v1',owner:'wm',protocol:C.PROTOCOL,backendId:'fake-wm-server',limits:{maxBodyBytes:524288,maxChunkBytes:262144,maxCanonicalBytes:1048576},storage:true,inventory:{chunkReads:true,put:'complete_payload_only',partialChunkUpload:false,migrationStaging:true},externalFenceVerification:false};
const state={schema:'wm.service-status.v1',available:true,initialized:false,closed:false};
const wait=async fn=>{for(let n=0;n<100&&!fn();n++)await new Promise(r=>setTimeout(r,5));assert(fn());};
test('assembled shipped default constructs saved connection controller and performs only explicit metadata checks before a separately selected manual migration',async()=>{
 const store=new Map([[KEY,JSON.stringify({schema:'wm.server-connection-config.v1',baseUrl,credential})]]),requests=[];
 const fetch=async(url,init)=>{requests.push({url,init});return new Response(JSON.stringify({ok:true,result:url.endsWith('/capabilities')?caps:state}),{status:200})};
 const f=await loadGui({store,fetch,nativeFetch:fetch,nativeInitialization:true});
 try{
 assert.equal(requests.length,0);f.overlay.querySelector('[data-tab="settings"]').click();
 const root=f.overlay.querySelector('[data-wm-storage-panel]');await wait(()=>!!root.querySelector('[data-wm-connection-url]'));
 assert.equal(root.querySelector('[data-wm-connection-url]').value,baseUrl);assert.equal(root.querySelector('[data-wm-connection-credential]').value,'');assert.equal(requests.length,0);
 await f.click(root.querySelector('[data-wm-storage-action="connection"]'));await wait(()=>root.querySelector('[data-wm-storage-connection]').textContent.includes('연결 확인됨'));
 assert.equal(requests.length,2);assert(requests.every(x=>x.init.method==='GET'));assert.equal(root.querySelector('[data-wm-storage-action="preview"]').disabled,false);assert.match(root.querySelector('[data-wm-storage-mode]').textContent,/플러그인에만 저장/);
 assert.equal(f.calls.writes.length,0);assert.equal(f.calls.hostWrites.length,0);assert(!root.outerHTML.includes(credential));
 const exported=f.w.LibraSettingsSchema.buildPublicExport({wmServerConnection:{baseUrl,credential}});assert(!JSON.stringify(exported).includes(baseUrl));assert(!JSON.stringify(exported).includes(credential));
 if(process.env.WM_CONNECTION_UI_EVIDENCE){require('node:fs').writeFileSync(process.env.WM_CONNECTION_UI_EVIDENCE,'<!doctype html><meta charset="utf-8">'+root.outerHTML);}
 }finally{f.close();}
});
