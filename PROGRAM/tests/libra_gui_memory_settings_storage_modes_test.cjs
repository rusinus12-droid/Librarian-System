'use strict';
// Entire plugin and real storage SDK/server handler; no socket listener or model.
const assert=require('node:assert/strict'),path=require('node:path');
const {create,pause,until}=require('./fixtures/libra_gui_memory_dom_host.cjs');
const {createHandlerFixture}=require('./fixtures/shared_reanalysis_handler_fixture.cjs');
const pluginPath=process.argv[2]||path.resolve(__dirname,'../plugins/LIBRA.js');
const key='libra:v1:memory-settings';
const {goSettings,field}=require('./helpers/libra_approved_gui_navigation.cjs');
async function open(mode,handler,values=[]){
 const seeded = values.length ? values : [
  ['libra:v1:scope-registry:v1', JSON.stringify({'audit-character::audit-chat':{scopeKey:'gui-settings-scope',characterId:'audit-character',chatId:'audit-chat',source:'synthetic_explicit_scope'}})],
  ['__memory_suite_internal_scope_routes_v1__:libra', JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:'libra',legacyGlobalModeImported:true,entries:{'gui-settings-scope':{scopeId:'gui-settings-scope',scopeKey:'gui-settings-scope',characterId:'audit-character',chatId:'audit-chat',mode,origin:'user_explicit'}}})]
 ];
 const s=await create('LIBRA','Full',{pluginPath,initialValues:seeded,args:{memory_suite_server_mode:mode,memory_suite_server_url:handler.url},nativeFetch:handler.nativeFetch});
 await s.open();await pause(400);await goSettings(s,'memory');return s;
}
async function save(s){s.doc.querySelector('[data-settings-room-save]').click();await until(()=>!s.doc.querySelector('[data-settings-room-save]').disabled,'save settles',10000);await pause(100)}
(async()=>{
 const rows=[];
 for(const mode of ['plugin_only','mirror','server_only']){
  const handler=createHandlerFixture();let s,restart;
  try{
   s=await open(mode,handler);
   const observedMode=(await s.api.getUnifiedStorageStatus()).mode;assert.equal(observedMode,mode,'fixture enters intended chat storage mode');
   const input=field(s,'통합 검색 최대 근거 수');assert.equal(input.value,'24');input.value='17';input.dispatchEvent(new s.dom.window.Event('input',{bubbles:true}));
   assert.equal((await s.api.getLibraMemorySettings()).unifiedMaxUnits,24);
   await save(s);assert.equal(s.api.debugGuiSettingsState().dirty,false,s.doc.querySelector('[data-settings-room-save-status]').textContent);
   const localPresent=s.values.has(key);
   const stored=handler.app.repositories.libra.database.prepare('SELECT key,value_json FROM kv WHERE deleted=0 AND key=?').get(key);
   assert.equal(localPresent,true,mode+': global memory settings retain the established plugin-local owner');
   assert.equal(!!stored,false,mode+': global memory settings are not scoped chat data');
   restart=await open(mode,handler,[...s.values]);
   assert.equal(field(restart,'통합 검색 최대 근거 수').value,'17',mode+': durable recall setting survives restart');
   assert.equal(s.wire.length+restart.wire.length,0);assert.deepEqual([...s.errors,...restart.errors],[]);
   rows.push({mode,observedMode,status:'PASS',localPresent,serverPresent:!!stored,internalHandlerRequests:handler.trace.length,realNetworkOrModelCalls:0});
   console.log(JSON.stringify(rows.at(-1)));
  }finally{await restart?.close();await s?.close();await handler.close();}
 }
 console.log(JSON.stringify({pluginPath,rows},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
