'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage,waitFor}=require('./hayaku_runtime_harness.cjs');
const {createColdStartGuiDocument}=require('./hayaku_cold_start_gui_dom_fixture.cjs');
const {envelope}=require('./shared_reanalysis_owner_fixture.cjs');
const quotes=['Alice entered the workshop.','Alice opened the cabinet.','Alice returned the key.'];
async function fixture({cold=false,turns=3,mode='plugin_only',server=null}={}){
 const messages=quotes.slice(0,turns).flatMap((quote,i)=>[
  {role:'user',id:'u'+(i+1),chatId:'u'+(i+1),data:'Continue '+(i+1)},
  {role:'assistant',id:'a'+(i+1),chatId:'a'+(i+1),data:cold?quote:hiddenPacketMessage(quote,createValidPacket({turn:i+1,subject:'Alice',summary:quote}))}]);
 const r=await createHayakuRuntime({messages,autoRepair:false,afterRequestAutoRepair:false,nativeFetch:server?.nativeFetch,arguments:{memory_suite_server_mode:mode,memory_suite_server_url:server?.url||''}});let gui;
 try{
  await r.callBeforeRequest([{role:'user',content:'Read the stored history.'}],'model');await r.callAfterRequest('','model');
  r.setLlmResponder(async call=>{
   const target=(call.messages.find(row=>row.role==='user')?.content||'').split('[CONTEXT ONLY')[0];
   const quote=quotes.find(value=>target.includes(value))||quotes[0];
   return {type:'success',result:JSON.stringify(envelope(quote))};
  });
  return {r,api:r.hayaku,get doc(){return gui?.document;},get root(){return gui?.document.getElementById('hayaku-ledger-viewer-root');},
   attachGui(){gui=createColdStartGuiDocument();Object.assign(r.context,{document:gui.document,window:gui.dom.window,Event:gui.dom.window.Event,HTMLElement:gui.dom.window.HTMLElement,MutationObserver:gui.dom.window.MutationObserver,getComputedStyle:gui.dom.window.getComputedStyle.bind(gui.dom.window)});},
   async show(){this.attachGui();assert.equal(await r.hayaku.showUi(),true);await waitFor(()=>this.root?.querySelector('.app')&&!this.root.querySelector('.app').classList.contains('is-busy'),'viewer hydrated');},
   async clickRecord(record){
    this.root.querySelector('[data-hayaku-viewer-goto="packets"]').click();
    await waitFor(()=>[...this.root.querySelectorAll('[data-hayaku-record-select]')].some(node=>node.getAttribute('data-hayaku-record-select')===record.recordId),'record list');
    [...this.root.querySelectorAll('[data-hayaku-record-select]')].find(node=>node.getAttribute('data-hayaku-record-select')===record.recordId).click();
    await waitFor(()=>this.root.querySelector('[data-hayaku-reanalyze-record]')?.getAttribute('data-hayaku-reanalyze-record')===record.recordId,'record detail');
    const button=this.root.querySelector('[data-hayaku-reanalyze-record]');assert.equal(button.disabled,false);button.click();
    await waitFor(()=>this.root.querySelector('[data-reanalysis-ranges] input:checked'),'contextual selection');
   },
   async close(){await r.dispose();gui?.dom.window.close();}
  };
 }catch(error){await r.dispose();gui?.dom.window.close();throw error;}
}
const selected=f=>[...f.root.querySelectorAll('[data-reanalysis-ranges] input:checked')].map(node=>node.value);
async function seedRange(f){
 const ledger=await f.api.ledger.inspect({includeRecords:true}),packet=createValidPacket({turn:2,packetType:'recovery_snapshot',subject:'Alice',summary:quotes[0]});
 packet.meta.source_turn_range={start:1,end:2};packet.meta.source_turn_index=2;
 const seeded=await f.api._test.adoptBridgeIncrementalRecoveryCapsule({schema:'memory-session-bridge-hayaku-incremental-recovery-v1',scopeKey:ledger.scopeKey,recoveryId:'range-fixture',runId:'range-fixture',sourceHash:'range-source',packetCount:1,createdAt:Date.now(),packets:[{ordinal:1,startTurn:1,endTurn:2,targetPairIndex:2,chunkHash:'range-chunk',body:JSON.stringify(packet)}]});
 assert.equal(seeded.ok,true,JSON.stringify(seeded));
 return (await f.api.ledger.inspect({includeRecords:true})).records.find(row=>row.incrementalRecoveryRunId==='range-fixture');
}
module.exports={fixture,quotes,selected,seedRange};
