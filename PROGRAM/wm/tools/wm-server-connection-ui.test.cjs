'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const UI=require('../src/wm-storage-ui.source.js'),M=require('../src/wm-server-connection.source.js');
const credential='mscap1.'+Buffer.from(JSON.stringify({schema:'memory-suite.capability-token.v1',pluginId:'libra_world_manager'})).toString('base64url')+'.'+'a'.repeat(43);
const wait=async check=>{for(let n=0;n<100&&!check();n++)await new Promise(r=>setTimeout(r,5));assert(check());};
test('real storage panel saves private connection config and preserves closed migration gates',async()=>{
 const data=new Map(),requests=[];const connection=M.createWmServerConnection({storage:{async getItem(k){return data.get(k)??null},async setItem(k,v){data.set(k,v);return true}},fetch:async(url,init)=>{requests.push(url);throw Error('PRIVATE_REPLY '+credential)}});
 const vm=UI.createWmStorageViewModel({connection});const view=await vm.inspect();assert.equal(view.connectionConfigurationSupported,true);
 const dom=new JSDOM('<div id="root"></div>'),root=dom.window.document.querySelector('#root');const panel=UI.mountWmStoragePanel({root,viewModel:vm});
 try{
 await panel.ready;const endpoint=root.querySelector('[data-wm-connection-url]'),secret=root.querySelector('[data-wm-connection-credential]');assert(endpoint);assert(secret);assert.equal(secret.type,'password');
 endpoint.value='https://wm.example.test';secret.value=credential;root.querySelector('[data-wm-storage-action="save-connection"]').click();
 await wait(()=>data.has(M.STORAGE_KEY)&&!root.querySelector('[data-wm-storage-action="save-connection"]').disabled);
 assert.equal(JSON.parse(data.get(M.STORAGE_KEY)).credential,credential);assert.equal(requests.length,0);assert.equal(root.querySelector('[data-wm-connection-credential]').value,'');assert(!root.innerHTML.includes(credential));
 assert.equal(root.querySelector('[data-wm-storage-action="preview"]').disabled,true);assert.equal(root.querySelector('[data-wm-storage-action="confirm"]').disabled,true);assert.match(root.textContent,/연결 확인.*서버 저장.*활성화/);
 root.querySelector('[data-wm-storage-action="connection"]').click();await wait(()=>requests.length===1&&!root.querySelector('[data-wm-storage-action="connection"]').disabled);
 assert(!root.textContent.includes(credential));assert(!root.textContent.includes('PRIVATE_REPLY'));assert.equal((await vm.inspect()).mode,'plugin_only');assert.equal(data.size,1);
 root.querySelector('[data-wm-storage-action="clear-connection"]').click();await wait(()=>JSON.parse(data.get(M.STORAGE_KEY)).credential==='');assert.equal((await vm.inspect()).connection,'unknown');
 }finally{panel.dispose();connection.dispose();dom.window.close();}
});
test('connection private root is excluded from inventory without reading its value',async()=>{
 const s=require('./wm-storage-test-support.cjs'),plugin=s.store([[M.STORAGE_KEY,'PRIVATE_SECRET_MUST_NOT_READ']]);const original=plugin.getItem;let read=false;plugin.getItem=async k=>{if(k===M.STORAGE_KEY)read=true;return original(k)};
 const f=s.setup({plugin});const snapshot=await f.inventory.open({fence:f.fence});assert.equal(snapshot.complete,true);assert.equal(read,false);assert(!JSON.stringify(snapshot).includes('PRIVATE_SECRET'));
});
test('another runtime changing saved configuration clears the previous connection-success label',async()=>{
 const data=new Map(),storage={getItem:async k=>data.get(k)??null,setItem:async(k,v)=>{data.set(k,v);return true}};
 const C=require('../src/wm-storage-contracts.source.js'),caps={schema:'wm.service-capabilities.v1',owner:'wm',protocol:C.PROTOCOL,backendId:'server-one',limits:{maxBodyBytes:100000,maxChunkBytes:1000,maxCanonicalBytes:10000},storage:true,inventory:{chunkReads:true,put:'complete_payload_only',partialChunkUpload:false,migrationStaging:true},externalFenceVerification:false};
 const fetch=async(url)=>new Response(JSON.stringify({ok:true,result:url.endsWith('/capabilities')?caps:{schema:'wm.service-status.v1',available:true,initialized:false,closed:false}}),{status:200});
 const one=M.createWmServerConnection({storage,fetch}),two=M.createWmServerConnection({storage,fetch}),vm=UI.createWmStorageViewModel({connection:one});
 await vm.saveConnectionConfiguration({baseUrl:'https://one.example.test',credential});await vm.checkConnection();assert.equal((await vm.inspect()).connection,'connected');
 await two.saveConfiguration({baseUrl:'https://two.example.test',credential});const view=await vm.inspect();assert.equal(view.connectionConfiguration.baseUrl,'https://two.example.test');assert.equal(view.connection,'unknown');assert.equal(view.connectionResult,null);
 one.dispose();two.dispose();
});
test('an older check cannot relabel newly saved settings as connected',async()=>{
 let resolveCheck,resolveSave;const configuration={revision:0,baseUrl:'https://one.example.test',credentialSaved:true,configured:true,transportAvailable:true};
 const checked=new Promise(r=>resolveCheck=r),saving=new Promise(r=>resolveSave=r);
 const controller={inspectConfiguration:async()=>({...configuration}),checkConnection:()=>checked,saveConfiguration:async()=>{await saving;configuration.revision++;return {...configuration}}};
 const vm=UI.createWmStorageViewModel({connection:controller});await vm.inspect();const old=vm.checkConnection(),save=vm.saveConnectionConfiguration({baseUrl:'https://two.example.test',credential});
 resolveCheck({ok:true,backendId:'old-server',protocol:require('../src/wm-storage-contracts.source.js').PROTOCOL,limits:{maxBodyBytes:1}});await old;resolveSave();await save;
 assert.equal((await vm.inspect()).connection,'unknown');
});
