'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('../wm/tools/wm-handoff-fixture.cjs'),{connect,W}=require('./helpers/retrace-wm-fixture.cjs');
test('WM materialized receipt is separate from unchanged core zero-copy validator',async t=>{
 const f=await fixture(t),v=await connect(t,f),prepared=await f.prepare('receipt-transfer'),receipt=await f.adopt(prepared);
 const expected={...prepared,sourceRoute:f.route};
 assert.equal(v.api.wmMaterializedHandoffReceiptMatches(v.into(receipt),v.into(expected)),true);
 assert.equal(v.api.sourcePreservationReceiptMatches(v.into({handoffContract:'core-zero-copy',sourcePreserved:true,sourceMutationAllowed:false,sourceCompactionAllowed:false,sourceFingerprintBefore:'same',sourceFingerprintAfter:'same',physicalCopies:1}),v.into({handoffContract:'core-zero-copy'})),false);
 const partial=structuredClone(receipt);partial.domains.cold.complete=false;assert.equal(W.matches(partial,expected),false);
});
test('authenticated sender, request/action and source/target wire binding gate WM responses',async t=>{
 const f=await fixture(t),v=await connect(t,f);await v.api.registerWmIpc();
 const request=W.makeRequest('spoof-request','verifyHandoff',{},{sourceIdentity:f.source,targetIdentity:f.target,transferId:'spoof-transfer'});
 let resolved=false;v.sandbox.Runtime.wmIpcPending.set(request.requestId,{requestId:request.requestId,action:request.action,binding:v.into(W.binding(request)),timer:null,resolve:()=>{resolved=true;},reject:()=>{}});
 const response={...request,kind:'response',ok:true,result:{ok:true},reason:''};delete response.payload;
 const listener=v.callbacks.get('r:'+W.RESPONSE_CHANNEL);listener(v.into(response),{sender:'spoof'});assert.equal(resolved,false);
 listener(v.into({...response,targetIdentity:f.source}),{sender:W.PLUGIN_ID});assert.equal(resolved,false);
 listener(v.into(response),{sender:W.PLUGIN_ID});assert.equal(resolved,true);
});
