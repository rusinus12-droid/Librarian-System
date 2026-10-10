'use strict';
// Runs the entire deployed plugin against neutral U+A fixtures. Host/model/storage
// boundaries are controlled; assertions inspect actual persisted owner records.
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
let passed=0;const ok=(v,m)=>{assert.ok(v,m);passed++;};const eq=(a,b,m)=>{assert.deepEqual(JSON.parse(JSON.stringify(a)),b,m);passed++;};
const msg=(role,n,data)=>({role,id:role[0]+n,chatId:role[0]+n,data});
const quote=n=>`Alice completed workshop task ${n}.`;
function messages(missing=[],count=4){return Array.from({length:count},(_,i)=>{const n=i+1,p=createValidPacket({turn:n,subject:'Alice',scene:'workshop',summary:quote(n)});return [msg('user',n,`Please complete task ${n}.`),msg('assistant',n,missing.includes(n)?quote(n):hiddenPacketMessage(quote(n),p))];}).flat();}
function envelope(n,q=quote(n)){const p=createValidPacket({turn:n,subject:'Alice',scene:'workshop',summary:q});p.entity.characters=[{name:'Alice'}];p.planner.continuity_locks=[q];const grounding=[];const walk=(v,path)=>{if(Array.isArray(v)){v.forEach((x,i)=>{if(x!=null&&(typeof x!=='string'||x.trim()))grounding.push({path:`${path}[${i}]`,source:'target',evidence:[q]});});return;}if(v&&typeof v==='object')for(const[k,x]of Object.entries(v))walk(x,path?path+'.'+k:k);};for(const a of ['entity','world','narrative','planner'])walk(p[a],a);grounding.push({path:'meta.summary_memory.summary',source:'target',evidence:[q]});return{schema:'hayaku.native_repair_output.v1',packet:p,grounding};}
async function observe(r){const s=await r.hayaku._test.currentChatScope();return r.hayaku._test.reconcileObservedChatTopology(s,r.hayaku._test.authoritativeChatSnapshot(s.chatMessages,s),'v348_test',{prompt:false});}
async function coverage(r){return (await r.hayaku.recovery.status({includeDebts:true,refreshDebts:true})).debt.coverage;}
async function caseRun(name,fn,opts={}){const r=await createHayakuRuntime({autoRepair:false,...opts});try{await fn(r);console.log('PASS '+name);}finally{await r.dispose();}}
(async()=>{
 await caseRun('read-only missing coverage finds leading and middle gaps, ignores pending/comment',async r=>{
  r.setMessages([...messages([1,3]),{role:'comment',data:'Branch info'},{role:'system',data:'system'},{role:'user',id:'pending',data:'Not completed'}]);
  const c=await coverage(r);eq(c.completedTurns,4);eq(c.coveredTurns,[2,4]);eq(c.missingTurns,[1,3]);eq(c.manualRepairableTurns,[1,3]);eq(r.llmCalls.length,0);
  ok(c.rows.every(row=>row.sourceDigest),'every row source identity');eq(c.rows.filter(row=>row.state==='source_edit_pending').length,0);
 });
 await caseRun('selected multi-turn recovery only calls missing targets, immediate verified adoption',async r=>{
  r.setMessages(messages([1,3]));const c=await coverage(r),source=r.chat.message.map(m=>m.data);
  let n=0;r.setLlmResponder(async()=>({type:'success',result:JSON.stringify(envelope([1,3][n++]))}));
  const result=await r.hayaku.recovery.repairSelected({scopeKey:(await r.hayaku._test.currentChatScope()).key,targetTurns:[3,1,3],rows:c.rows});
  ok(result.ok,JSON.stringify(result));eq(result.targetTurns,[1,3]);eq(result.completed,2);eq(r.llmCalls.length,2);
  eq((await coverage(r)).missingTurns,[]);eq((await coverage(r)).coveredTurns,[1,2,3,4]);eq(r.chat.message.map(m=>m.data),source,'host source byte-preserved');
  const again=await r.hayaku.recovery.repairSelected({targetTurns:[1,3]});ok(again.ok,JSON.stringify(again));eq(again.repaired,0);eq(r.llmCalls.length,2,'already saved never re-generated');
  const ledger=await r.hayaku.ledger.inspect({includeRecords:true});eq(ledger.records.filter(x=>x.recordState==='active'&&x.captureSource==='bridge_incremental_recovery').map(x=>x.targetPairIndex).sort(),[1,3]);
 });
 await caseRun('real edit holds old packet active without creating missing debt or model calls',async r=>{
  r.setMessages(messages([],1));await observe(r);const before=await r.hayaku.ledger.inspect({includeRecords:true});const original=before.records[0];
  r.chat.message[1].data=r.chat.message[1].data.replace(quote(1),'Alice postponed workshop task 1.');await observe(r);
  const c=await coverage(r);eq(c.missingTurns,[]);eq(c.sourceEditPendingTurns,[1]);eq(r.llmCalls.length,0);
  const old=(await r.hayaku.ledger.inspect({includeRecords:true})).records.find(x=>x.hash===original.hash);eq(old.recordState,'active');eq(old.ownerTurnNodeId,original.ownerTurnNodeId);eq(old.assistantVisibleHash,original.assistantVisibleHash);ok(!old.auditRetained,'not quarantined on observation');
  const attempt=await r.hayaku.recovery.repairSelected({targetTurns:[1]});ok(!attempt.ok);eq(r.llmCalls.length,0,'missing worker cannot approve a real edit');
  const edited='Alice postponed workshop task 1.';r.setLlmResponder(async()=>({type:'success',result:JSON.stringify(envelope(1,edited))}));
  await r.callBeforeRequest([{role:'user',data:'Continue after the source edit.'}]);
  eq(r.llmCalls.length,1,'the real beforeRequest path automatically reanalyzes the changed source');
  eq(r.hayaku.getSourceEditSyncStatus().tasks[0].state,'applied');
  const replaced=(await r.hayaku.ledger.inspect({includeRecords:true})).records;
  eq(replaced.find(x=>x.hash===original.hash).recordState,'superseded','old packet retires only after durable replacement');
  ok(replaced.some(x=>x.targetPairIndex===1&&x.recordState==='active'&&x.hash!==original.hash),'new source has an active replacement');
 });
 await caseRun('illustration insertion and ID refresh do not alter turn identity, non-image prose does',async r=>{
  r.setMessages(messages([],1));await observe(r);const c0=await coverage(r),before=(await r.hayaku.ledger.inspect({includeRecords:true})).records[0];
  const tag='<lb-xnai id="scene-9" operation="abc" scene="9">{{inlay::1234}}</lb-xnai>';
  const original=r.chat.message[1].data;r.chat.message[1].data=original+'\n'+tag;await observe(r);let c=await coverage(r);
  eq(c.sourceFingerprint,c0.sourceFingerprint);eq(c.coveredTurns,[1]);eq(c.sourceEditPendingTurns,[]);eq(r.hayaku.getSourceEditSyncStatus().tasks.length,0);eq(r.chat.message[1].data,original+'\n'+tag);
  r.chat.message[1].data=original+'\n'+tag.replace('abc','def').replace('1234','5678');await observe(r);c=await coverage(r);eq(c.sourceFingerprint,c0.sourceFingerprint);eq(c.missingTurns,[]);
  const after=(await r.hayaku.ledger.inspect({includeRecords:true})).records.find(x=>x.hash===before.hash);eq(after.recordState,'active');eq(after.ownerTurnNodeId,before.ownerTurnNodeId);
  r.chat.message[1].data=original+'\n<lb-xnai>Alice left the workshop.</lb-xnai>';await observe(r);c=await coverage(r);eq(c.sourceEditPendingTurns,[1],'substantive prose is not ignored');eq(r.llmCalls.length,0);
 });
 await caseRun('selection staleness rejected before model calls',async r=>{
  r.setMessages(messages([3]));const c=await coverage(r);r.chat.message[5].data='Alice cancelled workshop task 3.';
  const result=await r.hayaku.recovery.repairSelected({targetTurns:[3],rows:c.rows});ok(!result.ok);eq(result.reason,'selected_turn_source_changed');eq(r.llmCalls.length,0);
 });
 await caseRun('one failed selected turn is saved for review and does not block another selected turn',async r=>{
  r.setMessages(messages([1,3]));let n=0;r.setLlmResponder(async()=>({type:'success',result:++n===1?'not JSON':JSON.stringify(envelope(3))}));
  const result=await r.hayaku.recovery.repairSelected({targetTurns:[1,3]});ok(!result.ok);eq(result.completed,1);eq(r.llmCalls.length,2);eq((await coverage(r)).missingTurns,[1]);ok(result.results[0].failureId,'failed raw saved');
  r.setLlmResponder(async()=>({type:'success',result:JSON.stringify(envelope(1))}));const retry=await r.hayaku.recovery.repairSelected({targetTurns:[1]});ok(retry.ok,JSON.stringify(retry));eq(r.llmCalls.length,3);eq((await coverage(r)).missingTurns,[]);
 });

 await caseRun('a real edit in another turn cannot block an unrelated missing repair',async r=>{
  r.setMessages(messages([3]));await observe(r);r.chat.message[1].data=r.chat.message[1].data.replace(quote(1),'Alice postponed workshop task 1.');await observe(r);
  eq((await coverage(r)).sourceEditPendingTurns,[1,2,4],'dependent existing packets remain separately pending');eq((await coverage(r)).missingTurns,[3]);
  r.setLlmResponder(async()=>({type:'success',result:JSON.stringify(envelope(3))}));
  const result=await r.hayaku.recovery.repairSelected({targetTurns:[3]});ok(result.ok,JSON.stringify(result));eq(r.llmCalls.length,1);
  const c=await coverage(r);eq(c.missingTurns,[]);eq(c.sourceEditPendingTurns,[1,2,4]);
  ok((await r.hayaku.ledger.inspect({includeRecords:true})).records.some(x=>x.targetPairIndex===1&&x.recordState==='active'&&!x.auditRetained));
 });
 await caseRun('old packet remains active during automatic analysis; retires only after verified replacement',async r=>{
  r.setMessages(messages([],1));await observe(r);const old=(await r.hayaku.ledger.inspect({includeRecords:true})).records[0];
  const q='Alice postponed workshop task 1.';r.chat.message[1].data=r.chat.message[1].data.replace(quote(1),q);await observe(r);
  let release;
  r.setLlmResponder(async()=>{await new Promise(resolve=>release=resolve);return {type:'success',result:JSON.stringify(envelope(1,q))};});
  const request=r.callBeforeRequest([{role:'user',data:'Continue while the edited source is reconciled.'}]);
  await waitFor(()=>release,'automatic analysis starts');
  let row=(await r.hayaku.ledger.inspect({includeRecords:true})).records.find(x=>x.hash===old.hash);eq(row.recordState,'active');ok(!row.auditRetained);eq(r.hayaku.getSourceEditSyncStatus().tasks[0].state,'running');
  release();await request;eq(r.llmCalls.length,1);
  const after=await r.hayaku.ledger.inspect({includeRecords:true});row=after.records.find(x=>x.hash===old.hash);ok(row.recordState!=='active','old is not active after durable replacement');
  ok(after.records.some(x=>x.targetPairIndex===1&&x.recordState==='active'&&x.hash!==old.hash));eq(r.hayaku.getSourceEditSyncStatus().tasks[0].state,'applied');eq((await coverage(r)).missingTurns,[]);
 });
 await caseRun('failed automatic reanalysis preserves old packet and reports the provider error',async r=>{
  r.setMessages(messages([],1));await observe(r);const old=(await r.hayaku.ledger.inspect({includeRecords:true})).records[0];
  r.chat.message[1].data=r.chat.message[1].data.replace(quote(1),'Alice postponed workshop task 1.');await observe(r);
  r.setLlmResponder(async()=>{throw Error('provider offline');});
  await r.callBeforeRequest([{role:'user',data:'Continue after the edit.'}]);
  eq(r.llmCalls.length,1);const task=r.hayaku.getSourceEditSyncStatus().tasks[0];eq(task.state,'failed');
  ok(String(task.error||r.hayaku.getSourceEditSyncStatus().error).includes('provider offline'),'failure is visible with its provider cause');
  const row=(await r.hayaku.ledger.inspect({includeRecords:true})).records.find(x=>x.hash===old.hash);eq(row.recordState,'active');ok(!row.auditRetained);eq((await coverage(r)).missingTurns,[]);
 });
 console.log(JSON.stringify({test:'hayaku_exact_missing_source_v348',passed}));
})().catch(e=>{console.error(e);process.exitCode=1});
