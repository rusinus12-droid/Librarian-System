'use strict';
// Whole unmodified owner artifact, real mounted GUI, existing in-process handlers.
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {create,pause,until,META}=require('./fixtures/libra_gui_memory_dom_host.cjs');
const {createHandlerFixture}=require('./fixtures/shared_reanalysis_handler_fixture.cjs');
const owners={LIBRA:'libra',HAYAKU:'hayaku',Flashback:'flashback'};
const artifactRoot=process.env.GLOBAL_MODE_ARTIFACT_ROOT;
const kinds=artifactRoot?['Full','Min']:['Full'];
const hash=value=>{let h=0x811c9dc5;for(const c of value)h=Math.imul(h^c.charCodeAt(0),0x01000193);return (h>>>0).toString(36);};
const hash64=value=>{let h=0xcbf29ce484222325n;for(const c of value)h=BigInt.asUintN(64,(h^BigInt(c.charCodeAt(0)))*0x100000001b3n);return 'h64'+h.toString(36);};
const seedRoots=name=>Array.from({length:2},(_,i)=>{
 const characterId='preserved-character-'+i,chatId='inactive-chat-'+i;
 if(name==='LIBRA'){const scopeKey='preserved-index-'+i;return [`libra:v1:scope:${scopeKey}:manifest`,JSON.stringify({schema:'libra.manifest.v1',scopeKey,characterId,chatId,memories:{},inheritedMemories:[],note:'exact root bytes '+i})];}
 if(name==='HAYAKU'){const scopeKey='chat_'+hash64(characterId+'\n'+chatId);return ['hayaku.v2.ledger.'+scopeKey,JSON.stringify({version:'hayaku_storage_ledger_v2',scopeKey,identity:{schema:'hayaku.scope_identity.v1',scopeKey,characterId,chatId},records:[],slotHeads:[],tombstones:[],note:'exact root bytes '+i})];}
 const scopeKey=`char:${hash(characterId)}|chat:${hash(chatId)}`,storageHash=hash(scopeKey);return [`vector_rag_memory:scope:${storageHash}:manifest:v2`,JSON.stringify({schema:'vector_rag_memory.scope_manifest.v2',version:2,scopeKey,storageHash,characterId,chatId,canonicalCharacterId:characterId,canonicalChatId:chatId,canonicalScopeId:scopeKey,shardCount:0,count:0,shardSummaries:[],note:'exact root bytes '+i})];
});
async function settleOwnerStore(s){let before=JSON.stringify([...s.values]),stable=0;for(let i=0;i<30;i++){await pause(100);const next=JSON.stringify([...s.values]);stable=next===before?stable+1:0;if(stable===3)return;before=next;}throw Error('owner startup store did not settle');}
async function openPanel(s){
 await s.open();await pause(180);
 // A real pointer click moves focus to the clicked control. jsdom's click() does not, and LIBRA's
 // desk now opens with the quick-connect API key field focused, which (by design) defers re-renders
 // while a text field has focus. Focus each target first so navigation behaves as in a browser.
 const press=async selector=>{const node=s.doc.querySelector(selector);if(!node)throw Error('Missing '+selector);node.focus();await s.click(selector);};
 if(s.name==='LIBRA'){await press('[data-go="settings"]');await until(()=>s.doc.querySelector('.setnav [data-subtab="store"]'),'LIBRA settings room rendered',10000);await press('.setnav [data-subtab="store"]');}
 else if(s.name==='HAYAKU')await s.click('[data-hayaku-viewer-goto="server"]');
 else {await s.click('[data-go="connect"]');await s.click('button[data-group="c"][data-subtab="srv"]');}
 await until(()=>s.doc.querySelector('[data-apply]'),'global panel mounted',10000);
 assert(!s.doc.querySelector('[data-scope-perchat]'),'public owner artifact renders global-only selection');await settleOwnerStore(s);
}
async function apply(s,mode){
 const input=s.doc.querySelector(`input[value="${mode}"]`);assert(input);input.checked=true;input.dispatchEvent(new s.dom.window.Event('change',{bubbles:true}));
 s.context.confirm=()=>true;
 const button=s.doc.querySelector('[data-apply]');await button.onclick();
 // A read-only preview may observe the owner's own startup schema write. Exercise
 // the documented fresh confirmation path once, never skip an unknown-data blocker.
 if(s.doc.querySelector('[data-status]').textContent.includes('inventory_changed_during_preview')){s.globalInventoryRefreshes=(s.globalInventoryRefreshes||0)+1;await settleOwnerStore(s);const selected=s.doc.querySelector(`input[value="${mode}"]`);selected.checked=true;selected.dispatchEvent(new s.dom.window.Event('change',{bubbles:true}));await s.doc.querySelector('[data-apply]').onclick();}
 await until(()=>s.doc.querySelector('[data-job].terminal'),'completed global job card',4000);
 const text=[s.doc.querySelector('[data-status]').textContent,s.doc.querySelector('[data-job-title]').textContent,s.doc.querySelector('[data-job-count]').textContent].join('\n');
 const diagnostics=JSON.parse(s.doc.querySelector('[data-job-diagnostics]').value);assert.equal(diagnostics.result.completeKnownScopes,true,text);assert.equal(diagnostics.result.mode,mode,text);assert.equal(diagnostics.result.verifiedScopes,3);assert.match(s.doc.querySelector('[data-job-count]').textContent,/3 \/ 3/,text);
 return text;
}
(async()=>{const results=[];for(const name of (process.env.GLOBAL_MODE_OWNER?[process.env.GLOBAL_MODE_OWNER]:Object.keys(owners)))for(const kind of kinds){
 const handler=createHandlerFixture(),namespace=owners[name],pluginPath=artifactRoot?path.join(artifactRoot,kind,META[name][0]):path.resolve(__dirname,'../plugins',META[name][0]);let s,restart;
 try{
  s=await create(name,kind,{pluginPath,separateLocalStorage:true,initialValues:seedRoots(name),args:{memory_suite_server_url:handler.url},nativeFetch:handler.nativeFetch});
  await openPanel(s);
  const before=[...s.values.entries()].filter(([key])=>!key.startsWith('__memory_suite_'));
  // Ordinary startup may normalize a minimal legacy manifest before confirmation.
  // Freeze the actual durable source while requiring every seeded identity/data field.
  const frozenRoots=seedRoots(name).map(([key,seed])=>{const value=s.values.get(key);assert.equal(typeof value,'string');const body=JSON.parse(value);for(const [field,expected]of Object.entries(JSON.parse(seed)))assert.deepEqual(body[field],expected,'startup preserves seeded field '+key+'/'+field);return [key,value];});
  console.log('FROZEN_OWNER_ROOTS',JSON.stringify({name,kind,roots:frozenRoots.map(([key,value])=>({key,bytes:Buffer.byteLength(value),sha256:require('node:crypto').createHash('sha256').update(value).digest('hex')}))}));
  const forward=await apply(s,'server_only');const forwardRefreshes=s.globalInventoryRefreshes||0;
  const rows=handler.app.repositories[namespace].database.prepare('SELECT key,value_json FROM kv WHERE deleted=0').all();
  for(const [key,value]of frozenRoots)assert(rows.some(row=>row.key===key&&JSON.parse(row.value_json)===value),'actual owner root transferred '+key);
  assert(rows.some(row=>row.key===`__memory_suite_scope_routes_v1__:${namespace}`),'global policy published to actual handler');
  for(const [key,value]of before)assert.equal(s.values.get(key),value,'forward preserves local source '+key);
  const saved=[...s.values],savedDevice=[...s.deviceValues];await s.close();s=null;
  restart=await create(name,kind,{pluginPath,separateLocalStorage:true,initialValues:saved,initialDeviceValues:savedDevice,args:{memory_suite_server_url:handler.url},nativeFetch:handler.nativeFetch});
  await openPanel(restart);
  assert.equal(restart.doc.querySelector('input[value="server_only"]').checked,true,'restart sees committed global policy');
  const reverseRows=handler.app.repositories[namespace].database.prepare('SELECT key,value_json FROM kv WHERE deleted=0').all();
  console.log('REVERSE_PREFLIGHT_DIAGNOSTIC',JSON.stringify({name,kind,differences:reverseRows.filter(row=>restart.values.has(row.key)&&JSON.stringify(restart.values.get(row.key))!==row.value_json).map(row=>({key:row.key,local:restart.values.get(row.key),server:JSON.parse(row.value_json)}))}));
  const reverse=await apply(restart,'plugin_only');
  for(const [key,value]of frozenRoots)assert.equal(restart.values.get(key),value,'exact pre-confirmation native root survives roundtrip '+key);
  const registry=JSON.parse(restart.values.get(`__memory_suite_internal_scope_routes_v1__:${namespace}`));assert.equal(registry.entries.__memory_suite_global__.mode,'plugin_only');
  assert(Object.values(registry.entries).filter(row=>row.scopeId!=='__memory_suite_global__').every(row=>row.origin==='inherited'));
  assert.equal(restart.wire.length,0,'no external network/model fallback');
  const result={name,kind,sourceSha256:restart.sourceSha256,status:'PASS',forward,reverse,handlerRequests:handler.trace.length,readOnlyPreviewRefreshes:forwardRefreshes+(restart.globalInventoryRefreshes||0)};results.push(result);console.log(JSON.stringify(result));
 }catch(error){const active=restart||s;if(active)console.error(JSON.stringify({name,kind,keys:[...active.values.keys()],localValues:[...active.values],deviceValues:[...active.deviceValues],serverRows:handler.app.repositories[namespace].database.prepare('SELECT key,value_json FROM kv WHERE deleted=0').all(),journal:active.values.get(`__memory_suite_internal_sync_job_v1__:${namespace}`),registry:active.values.get(`__memory_suite_internal_scope_routes_v1__:${namespace}`),status:active.doc.querySelector('[data-status]')?.textContent,errors:active.errors,logs:active.logs.slice(-8)},null,2));throw error;}
 finally{await restart?.close();await s?.close();await handler.close();}
}console.log(JSON.stringify({flows:results.length,results},null,2));})().catch(error=>{console.error(error);process.exitCode=1;});
