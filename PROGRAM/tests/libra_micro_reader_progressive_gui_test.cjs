'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function setup(t){
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true});
 const f=await fixture({transformSource:s=>s.replace('  const publicApi = Object.freeze({',
  '  globalThis.__microUI={Gui,loadMicroReaderDetail,microReaderState,microReaderPublicationKey,buildBookMicroReaderProjection}; const publicApi = Object.freeze({'),
  contextGlobals:{document:dom.window.document,window:dom.window,MutationObserver:dom.window.MutationObserver,
   requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)}});
 t.after(async()=>{f.r.context.__microUI.Gui.visible=false;await f.r.cleanup();dom.window.close();});
 await f.run();const inventory=await f.r.api.listReanalysisRanges({kind:'micro'});
 assert.equal((await f.r.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(r=>r.start<=2)})).ok,true);
 const ui=f.r.context.__microUI;
 ui.Gui.visible=true;ui.Gui.bookPage='memory';ui.Gui.bookMemoryKind='micro';
 const reader=ui.microReaderState(),page=await f.r.api.listMicroReaderTurns({expectedScopeKey:reader.scopeKey});
 Object.assign(reader,{items:page.items,loaded:true,hostWorldlineId:page.worldlineId,totalTurns:page.totalTurns,publicationKey:ui.microReaderPublicationKey(reader)});
 const api={...f.r.api};f.r.context.__LIBRA__=api;
 return {f,ui,reader,api,render:()=>ui.buildBookMicroReaderProjection()};
}
test('verified body renders before slow State; repeated clicks join one read and show an explicit State stage',async t=>{
 const {f,ui,reader,api,render}=await setup(t),gate=deferred();t.after(()=>gate.resolve());
 let bodies=0,states=0;const read=api.readActiveMicroMemoryForTurn;
 api.readActiveMicroMemoryForTurn=async(...args)=>{bodies++;return read(...args);};
 api.readMicroStateAdmissionForTurn=async(_turn,_scope,revision)=>{states++;await gate.promise;return {status:'verified',analysisRevisionId:revision,decisions:[]};};
 const first=ui.loadMicroReaderDetail(1,reader);await waitFor(()=>states===1);
 assert.equal(reader.detailLoading,false);assert.ok(reader.detail.record);
 let node=render();assert.match(node.textContent,/T1의 Micro 기억/);assert.ok(node.querySelector('[data-micro-reader-claim]'));
 assert.ok(node.querySelector('[data-micro-state-admission="loading"]'));assert.doesNotMatch(node.textContent,/승인을 확인하지 못했습니다|반영 0개/);
 const second=ui.loadMicroReaderDetail(1,reader),third=ui.loadMicroReaderDetail(1,reader);
 assert.equal(first,second);assert.equal(second,third);assert.equal(bodies,1);assert.equal(states,1);
 gate.resolve();await first;node=render();assert.ok(node.querySelector('[data-micro-state-admission="ready"]'));
 assert.equal(reader.detailRequest,null);
 // A completed request is not an authority cache: a fresh explicit check re-reads.
 await ui.loadMicroReaderDetail(1,reader);assert.equal(bodies,2);assert.equal(states,2);
 assert.equal(f.control.calls.length,3,'UI reads never call the model');
});
test('switching turns stops the old body request before State and rejects late State results',async t=>{
 const {ui,reader,api,render}=await setup(t),bodyGate=deferred(),stateGate=deferred();
 t.after(()=>{bodyGate.resolve();stateGate.resolve();});
 const read=api.readActiveMicroMemoryForTurn;let stateTurns=[];
 api.readActiveMicroMemoryForTurn=async(turn,...args)=>{const body=await read(turn,...args);if(turn===1)await bodyGate.promise;return body;};
 api.readMicroStateAdmissionForTurn=async(turn,_scope,revision)=>{stateTurns.push(turn);return {status:'verified',analysisRevisionId:revision,decisions:[]};};
 const old=ui.loadMicroReaderDetail(1,reader),next=ui.loadMicroReaderDetail(2,reader);await next;bodyGate.resolve();await old;
 assert.deepEqual(stateTurns,[2]);assert.equal(reader.detail.record.turn,2);assert.match(render().textContent,/T2의 Micro 기억/);
 api.readActiveMicroMemoryForTurn=read;
 api.readMicroStateAdmissionForTurn=async(turn,_scope,revision)=>{stateTurns.push(turn);if(turn===1)await stateGate.promise;return {status:'verified',analysisRevisionId:revision,decisions:[]};};
 const late=ui.loadMicroReaderDetail(1,reader);await waitFor(()=>reader.detail?.record?.turn===1&&reader.detail?.admission?.status==='loading');
 await ui.loadMicroReaderDetail(2,reader);stateGate.resolve();await late;
 assert.equal(reader.detail.record.turn,2);assert.equal(reader.detail.admission.status,'verified');assert.match(render().textContent,/T2의 Micro 기억/);
});
test('State failure leaves the verified body visible; a changed scope discards pending results',async t=>{
 const {ui,reader,api,render}=await setup(t),gate=deferred();t.after(()=>gate.resolve());
 api.readMicroStateAdmissionForTurn=async()=>{throw Error('fixture_state_failure');};
 await ui.loadMicroReaderDetail(1,reader);assert.equal(reader.detailError,'');assert.match(render().textContent,/T1의 Micro 기억/);
 assert.ok(render().querySelector('[data-micro-state-admission="unavailable"]'));
 api.readMicroStateAdmissionForTurn=async()=>{await gate.promise;return {status:'verified',decisions:[]};};
 const pending=ui.loadMicroReaderDetail(1,reader);await waitFor(()=>reader.detail?.admission?.status==='loading');
 ui.Gui.openSerial=Number(ui.Gui.openSerial||0)+1;gate.resolve();await pending;
 assert.equal(reader.detail.admission.status,'loading','late result cannot certify an expired view');
 assert.notEqual(ui.microReaderState(),reader);
});
