'use strict';
const assert=require('node:assert/strict');const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
(async()=>{const old='Alice signed the agreement.',next='Alice did not sign the agreement.',packet=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:old});const r=await createHayakuRuntime({autoRepair:false,messages:[{role:'user',id:'u1',chatId:'u1',data:'What does Alice do?'},{role:'assistant',id:'a1',chatId:'a1',data:hiddenPacketMessage(old,packet)}]});try{
 await r.callBeforeRequest([{role:'user',content:'Initial recall.'}]);await r.callAfterRequest('');await r.hayaku.ledger.inspect({includeRecords:true});
 r.chat.message[1].data=hiddenPacketMessage(next,packet);await r.callBeforeRequest([{role:'user',content:'Continue.'}]);await r.callAfterRequest('');
 const ticket=await r.hayaku.previewSourceEdits(['1']);let cancelled=false;const get=r.pluginStorage.getItem.bind(r.pluginStorage);
 r.pluginStorage.getItem=async key=>{if(!cancelled&&String(key).startsWith('hayaku.v2.source-evidence.')){cancelled=true;r.hayaku.clearSourceEditPreview()}return get(key)};
 r.setLlmResponder(async()=>({type:'fail',result:'Controlled stub; no external request'}));const result=await r.hayaku.applySourceEdits(ticket);
 assert.equal(ticket.allowed,true,JSON.stringify(ticket));assert.equal(cancelled,true);assert.equal(r.llmCalls.length,0);assert.equal(r.fetchCalls.length,0);assert.notEqual(result.ok,true);
 console.log(JSON.stringify({test:'hayaku_explicit_cancel_before_dispatch',passed:true,modelCallsAfterCancel:0,network:0}));
 }finally{await r.dispose()}})().catch(e=>{console.error(e);process.exitCode=1});
