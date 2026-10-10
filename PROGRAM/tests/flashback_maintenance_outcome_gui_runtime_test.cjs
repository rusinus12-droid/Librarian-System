'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {test}=require('node:test');
const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM=path.resolve(__dirname,'..');
// The failure this test must detect: a completed operation with healthy=false
// is rendered as recovery success and loses the explicit failed-work guidance.
// Provider responses below are synthetic values, never an HTTP/model request.
class UiNode{
 constructor(doc,tag='div',id=''){this.doc=doc;this.tagName=tag;this.id=id;this.children=[];this.dataset={};this.style={};this.listeners=new Map();this.disabled=false;this.isConnected=true;this.className='';this.textContent='';this.classList={add(){},remove(){},toggle(){}};}
 set innerHTML(value){this.html=value;}get innerHTML(){return this.html||'';}
 appendChild(node){this.children.push(node);node.parent=this;return node;}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);this.isConnected=false;}
 addEventListener(name,fn){this.listeners.set(name,fn);}removeEventListener(name){this.listeners.delete(name);}
 setAttribute(name,value){this[name]=value;}getAttribute(name){return this[name]||'';}
 focus(){this.doc.activeElement=this;}contains(node){return this===node||this.children.some(child=>child.contains(node));}
 async click(){assert(this.listeners.has('click'),'actual product click handler registered');return this.listeners.get('click')({target:this,preventDefault(){},stopPropagation(){}});}
}
function mount(h){
 const doc={listeners:new Map(),createElement(tag){return new UiNode(doc,tag);},addEventListener(name,fn){this.listeners.set(name,fn);},removeEventListener(name){this.listeners.delete(name);}};
 doc.body=new UiNode(doc,'body');doc.head=new UiNode(doc,'head');doc.activeElement=doc.body;
 doc.all=()=>{const out=[];const walk=n=>{out.push(n);n.children.forEach(walk);};walk(doc.body);walk(doc.head);return out;};
 doc.getElementById=id=>doc.all().find(n=>n.id===id)||null;doc.byClass=name=>doc.all().find(n=>n.className===name)||null;
 const root=new UiNode(doc,'div','root');root.nodes=new Map();
 for(const id of ['maintenanceAutoBtn','maintenanceExecutionBadge','maintenanceExecutionStatus','maintenanceCompletedBatches','maintenanceRequests','maintenancePending','maintenanceUnknown','maintenanceRequestedDimensions','maintenanceResolvedDimensions','maintenanceUsageReported','maintenanceResumedBatches','maintenanceExecutionScope','maintenanceExecutionMetrics','maintenanceExecutionActions','maintenanceExecutionCancelNote'])root.nodes.set(id,new UiNode(doc,id.endsWith('Btn')?'button':'div',id));
 root.querySelector=selector=>selector.startsWith('#')?root.nodes.get(selector.slice(1))||null:null;root.querySelectorAll=()=>[];
 doc.body.appendChild(root);h.context.document=doc;h.context.__maintenanceOutcome.mount(root);
 return{doc,root};
}
async function actualAuto(h,ui){
 let done=false,caught;const dialogs=[],seen=new Set();
 const run=ui.root.nodes.get('maintenanceAutoBtn').click().then(()=>{done=true;},error=>{done=true;caught=error;});
 // Same bound as the established real GUI maintenance fixture, not enlarged.
 for(let i=0;i<1000&&!done;i++){
  const button=ui.doc.byClass('vrmDialogOk');if(button&&!seen.has(button)){seen.add(button);dialogs.push({title:ui.doc.byClass('vrmDialogTitle')?.textContent||'',body:ui.doc.byClass('vrmDialogMessage')?.textContent||''});await button.click();}
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 assert(done,'actual GUI executor/dialog settles');await run;if(caught)throw caught;
 h.context.__maintenanceOutcome.render();return{dialogs,result:h.audit.Runtime.lastImport,badge:ui.root.nodes.get('maintenanceExecutionBadge'),summary:ui.root.nodes.get('maintenanceExecutionStatus').textContent};
}
const messages=n=>[{role:'user',id:'u'+n,chatId:'u'+n,data:`Inspect archive turn ${n}.`},{role:'assistant',id:'a'+n,chatId:'a'+n,data:`For turn ${n}, Alice inspected the sealed blue ledger at the archive desk. The key remains in the wooden cabinet beside the red envelope.`}];
async function setup(){
 const h=await createFlashback(PROGRAM,{transformSource:source=>source.replace('  globalThis.__FlashbackMemory = publicApi;',
  "  globalThis.__maintenanceOutcome = { mount(root) { guiRoot=root;guiMounted=true;guiVisible=true;Runtime.guiTab='import';bindUiEvents(root);renderMaintenanceExecution(); },render:renderMaintenanceExecution };\n  globalThis.__FlashbackMemory = publicApi;")});
 const cfg=h.api._test.normalizeSettings({...await h.api.loadSettings(),embeddingProvider:'openai_compat',embeddingModel:'outcome-model',embeddingUrl:'https://provider.invalid/v1',embeddingDimensions:3,embeddingEnabled:true,fallbackHashEmbedding:false,embeddingAutoProcess:false,embeddingMaxRetries:0,autoEpisodeIndex:false,episodeIndexEnabled:false,autoColdStart:false});
 let fail=false;const submitted=[];
 h.host.nativeFetch=async(_url,init)=>{const inputs=JSON.parse(init.body).input;submitted.push(inputs.slice());return{ok:true,status:200,async json(){return{data:inputs.map((text,index)=>({index,embedding:fail&&String(text).includes('turn 2')?[0,0,0]:[1,0,0]}))};}};};
 await h.api.saveSettings(cfg);
 // Keep the real startup timer; settle it on the empty synthetic host.
 await new Promise(resolve=>setTimeout(resolve,5000));
 const chat=await h.host.getCurrentChat();chat.message=messages(1);chat.messages=chat.message;
 await h.api.ingestLiveChatColdStart({scope:'current',canonical:true,settings:cfg,skipEpisodeRebuild:true});
 const scope=await h.api.resolveCurrentScope(false);
 return{h,cfg,chat,scope,submitted,setFailure(value){fail=value;}};
}
test('registered automatic GUI reports failed work as repair pending, explicit retry resolves and subsequent auto is stable',async()=>{
 const x=await setup();try{
  x.chat.message.push(...messages(2));x.setFailure(true);
  const partial=await x.h.api.runMemoryMaintenance('auto',{settings:x.cfg});assert.equal(partial.healthy,false);assert.equal(partial.after.missingVectors,1);
  const rows=await x.h.api._test.loadScopeRecords(x.scope.scopeKey),literal=JSON.stringify(x.chat.message),rowBytes=JSON.stringify(rows.records),calls=x.submitted.length;
  const failed=rows.records.find(row=>row.embeddingWork?.status==='failed');assert(failed);assert.equal(failed.embeddingWork.lastError.code,'INVALID_RESPONSE');
  x.setFailure(false);const ui=mount(x.h),out=await actualAuto(x.h,ui);
  assert.equal(out.result.healthy,false);assert.equal(out.result.after.missingVectors,1);assert.equal(out.result.operation.cleanup.reason,'failed_requires_retry');
  assert.equal(x.submitted.length,calls,'ordinary auto repair does not authorize failed-work resubmission');assert.equal(JSON.stringify(x.chat.message),literal);assert.equal(JSON.stringify((await x.h.api._test.loadScopeRecords(x.scope.scopeKey)).records),rowBytes,'all raw/vector/receipt rows preserved');
  assert.equal(x.h.audit.Runtime.maintenanceJournal.status,'completed','execution lifecycle remains completed');
  assert.equal(out.badge.getAttribute('data-tone'),'warning');assert.equal(out.badge.textContent,'점검 완료 · 복구 대기');
  assert.equal(out.dialogs.length,2);assert.equal(out.dialogs[1].title,'점검 완료 · 복구 대기');assert.match(out.dialogs[1].body,/실패 작업 재시도/);assert.match(out.summary,/실패 작업 재시도/);
  const retry=await x.h.api.processPendingEmbeddingWork({sourceHash:failed.sourceHash,retryFailed:true});assert.equal(retry.ok,true);assert.equal(retry.ready,1);
  const ready=await x.h.api._test.loadScopeRecords(x.scope.scopeKey),afterRetry=x.submitted.length;
  assert.equal(ready.records.length,2);assert.equal(JSON.stringify(x.chat.message),literal);assert(ready.records.every(row=>row.vector.length===3&&row.embeddingReceipt?.status==='ready'));
  const repeated=await x.h.api.runMemoryMaintenance('auto',{settings:x.cfg});assert.equal(repeated.healthy,true);assert.equal(repeated.operation.strategy,'no_action');assert.equal(x.submitted.length,afterRetry);assert.equal((await x.h.api._test.loadScopeRecords(x.scope.scopeKey)).manifest.commitId,ready.manifest.commitId);
  x.h.context.__maintenanceOutcome.render();assert.equal(ui.root.nodes.get('maintenanceExecutionBadge').getAttribute('data-tone'),'success');
  assert.equal(x.h.networkCalls.length,0,'no real provider/SDK network route');
 }finally{await x.h.cleanup();}
});
test('registered automatic GUI preserves verified healthy recovery success',async()=>{
 const x=await setup();try{
  x.chat.message.push(...messages(2));const ui=mount(x.h),out=await actualAuto(x.h,ui);
  assert.equal(out.result.healthy,true);assert.equal(out.result.after.missingVectors,0);assert.equal(out.dialogs.length,2);assert.equal(out.badge.getAttribute('data-tone'),'success');assert.notEqual(out.dialogs[1].title,'점검 완료 · 복구 대기');assert.doesNotMatch(out.dialogs[1].body,/실패 작업 재시도/);
  assert.equal((await x.h.api._test.loadScopeRecords(x.scope.scopeKey)).records.length,2);assert.equal(x.h.networkCalls.length,0);
 }finally{await x.h.cleanup();}
});
test('completed legacy journal with unknown verification is never displayed as verified recovery success',async()=>{
 const x=await setup();try{
  await x.h.api.runMemoryMaintenance('auto',{settings:x.cfg});const rows=JSON.stringify((await x.h.api._test.loadScopeRecords(x.scope.scopeKey)).records),calls=x.submitted.length;
  const journal=x.h.audit.Runtime.maintenanceJournal;x.h.audit.Runtime.lastImport=null;const ui=mount(x.h);
  for(const result of [null,{healthy:'false'},{healthy:1}]){
   x.h.audit.Runtime.maintenanceJournal=x.h.api._test.normalizeMaintenanceJournal({...journal,result});x.h.context.__maintenanceOutcome.render();
   assert.equal(ui.root.nodes.get('maintenanceExecutionBadge').getAttribute('data-tone'),'warning','unknown or malformed journal health is not verification');assert.match(ui.root.nodes.get('maintenanceExecutionBadge').textContent,/결과 확인 필요/);
  }
  assert.match(x.h.api._test.maintenanceResultText({healthy:'false'}),/결과 확인 필요/);assert.doesNotMatch(x.h.api._test.maintenanceResultText({healthy:'false'}),/최종 판정: 정상/);
  assert.equal(x.submitted.length,calls);assert.equal(JSON.stringify((await x.h.api._test.loadScopeRecords(x.scope.scopeKey)).records),rows);assert.equal(x.h.audit.Runtime.maintenanceJournal.status,'completed');assert.equal(x.h.networkCalls.length,0);
 }finally{await x.h.cleanup();}
});
