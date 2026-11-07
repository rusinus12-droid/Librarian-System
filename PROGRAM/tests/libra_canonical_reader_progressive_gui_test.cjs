'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {fiveMore}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const gate=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};};
async function setup(t){
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true});
 const f=await fixture({transformSource:s=>s.replace('  const publicApi = Object.freeze({',
  '  globalThis.__chapterUI={Gui,loadCanonicalReaderDetail,ensureCanonicalReaderLifetime,buildBookMemoryReadingSheet}; const publicApi = Object.freeze({'),
  contextGlobals:{document:dom.window.document,window:dom.window,MutationObserver:dom.window.MutationObserver,
   requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)}});
 t.after(async()=>{f.r.context.__chapterUI.Gui.visible=false;await f.r.cleanup();dom.window.close();});
 await f.run();fiveMore(f);await f.run();
 const ui=f.r.context.__chapterUI;ui.Gui.visible=true;ui.Gui.bookPage='memory';ui.Gui.bookMemoryKind='canonical';
 const binding=ui.ensureCanonicalReaderLifetime(),page=await f.r.api.listCanonicalReaderChapters({expectedScopeKey:binding.scopeKey});
 ui.Gui.canonicalReaderItems=page.items;ui.Gui.canonicalReaderLoaded=true;
 const api={...f.r.api};f.r.context.__LIBRA__=api;
 return {f,ui,api,items:page.items,render:()=>ui.buildBookMemoryReadingSheet()};
}
test('Canonical body precedes covered-turn evidence; repeated selection joins one request',async t=>{
 const {f,ui,api,items,render}=await setup(t),hold=gate();t.after(()=>hold.release());
 let chapters=0,micro=0;const read=api.getCanonicalReaderChapter;
 api.getCanonicalReaderChapter=async(...args)=>{chapters++;return read(...args);};
 api.readActiveMicroMemoryForTurn=async()=>{micro++;await hold.promise;return {status:'missing'};};
 const item=items.find(i=>i.turnRange.start===1),task=ui.loadCanonicalReaderDetail(item);
 await waitFor(()=>micro===1);
 assert.equal(ui.Gui.canonicalReaderDetailLoading,false);
 const node=render();assert.ok(node.querySelector('[data-canonical-reading]'));
 assert.ok(node.querySelector('[data-book-turn-evidence-loading]'));assert.doesNotMatch(node.textContent,/記憶|기억을 펼치는 중입니다/);
 const again=ui.loadCanonicalReaderDetail(item);assert.equal(task,again);assert.equal(chapters,1);assert.equal(micro,1);
 hold.release();await task;assert.equal(micro,5);assert.equal(ui.Gui.canonicalReaderDetailRequest,null);
 assert.ok(render().querySelector('[data-canonical-reading]'));assert.equal(ui.Gui.bookTurnEvidence.status,undefined);
 const calls=f.control.calls.length;await ui.loadCanonicalReaderDetail(item);assert.equal(chapters,2);assert.equal(f.control.calls.length,calls,'read-only UI makes no model calls');
});
test('switching chapters stops remaining old evidence reads and prevents late evidence publication',async t=>{
 const {ui,api,items,render}=await setup(t),hold=gate();t.after(()=>hold.release());
 const turns=[];api.readActiveMicroMemoryForTurn=async turn=>{turns.push(turn);if(turn===1)await hold.promise;return {status:'missing'};};
 const first=items.find(i=>i.turnRange.start===1),second=items.find(i=>i.turnRange.start===6);
 const old=ui.loadCanonicalReaderDetail(first);await waitFor(()=>turns.includes(1));
 await ui.loadCanonicalReaderDetail(second);hold.release();await old;
 assert.equal(ui.Gui.canonicalReaderDetail.memoryId,second.memoryId);assert.equal(ui.Gui.bookTurnEvidence.start,6);
 assert.ok(!turns.some(turn=>turn>=2&&turn<=5));assert.ok(render().querySelector('[data-canonical-reading]'));
});
test('wrong chapter binding fails closed and leaving the view rejects delayed evidence',async t=>{
 const {ui,api,items,render}=await setup(t),hold=gate();t.after(()=>hold.release());
 const read=api.getCanonicalReaderChapter,item=items[0];
 api.getCanonicalReaderChapter=async(...args)=>({...await read(...args),scopeKey:'other'});
 await ui.loadCanonicalReaderDetail(item);assert.equal(ui.Gui.canonicalReaderDetail,null);assert.match(ui.Gui.canonicalReaderDetailError,/scope\/identity/);
 api.getCanonicalReaderChapter=read;let entered=false;
 api.readActiveMicroMemoryForTurn=async()=>{entered=true;await hold.promise;return {status:'missing'};};
 const task=ui.loadCanonicalReaderDetail(item);await waitFor(()=>entered);assert.ok(render().querySelector('[data-canonical-reading]'));
 ui.Gui.openSerial=Number(ui.Gui.openSerial||0)+1;hold.release();await task;
 assert.equal(ui.Gui.bookTurnEvidence.status,'loading','the expired view cannot receive old evidence');
});
