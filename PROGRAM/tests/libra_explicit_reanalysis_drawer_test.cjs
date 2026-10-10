'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
const code=source.slice(source.indexOf('  const closeCanonicalRangeDrawer ='),source.indexOf('  const buildBookMemoryModelSummary ='));
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(options={}){
 const dom=new JSDOM('<main></main>'),document=dom.window.document,Gui={visible:true,root:document.querySelector('main')},calls=[];
 const inventory={scopeKey:'scope-a',observedTurns:10,completeBatches:2,pendingTurns:0,ranges:[1,6].map(startTurn=>({startTurn,endTurn:startTurn+4,status:'saved',sourceDigest:'source-'+startTurn,identityDigest:'identity-'+startTurn}))};
 const guiEl=(tag,attrs={},children=[])=>{const el=document.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k==='text')el.textContent=v;else if(k==='class')el.className=v;else if(k==='dataset')Object.assign(el.dataset,v);else if(k.startsWith('on'))el.addEventListener(k.slice(2).toLowerCase(),v);else if(k in el)el[k]=v;else el.setAttribute(k,v);}for(const child of children.flat())if(child)el.append(child);return el;};
 const context=vm.createContext({document,Gui,guiEl,Set,String,Error,confirm:()=>{throw Error('unexpected_extra_approval');},
  LibraMemoryCore:{listCanonicalBatchRanges:async()=>options.inventory?options.inventory():inventory,startSelectedCanonicalBatches:async input=>{calls.push(JSON.parse(JSON.stringify(input)));return options.run?options.run():{ok:true};}},
  runCanonicalGuiCommand:async(_message,fn)=>fn(),libraMemoryFailureDiagnostic:error=>({title:'error',message:String(error)})});
 vm.runInContext(code+'\nglobalThis.show=showCanonicalRangeDrawer;',context);
 return {dom,document,Gui,calls,show:context.show,close:()=>dom.window.close()};
}
test('reading desk exposes reanalysis directly without entering the missing-range workflow',()=>{
 const panel=source.slice(source.indexOf('  const buildBookMemoryProgressPanel ='),source.indexOf('  const buildCanonicalActionPanel ='));
 assert.equal(/bookMemoryReanalyze/.test(panel),true);assert.equal(/showCanonicalRangeDrawer\('source_edit'\)/.test(panel),true);
});
test('saved ranges are selectable and one submit click dispatches reanalysis without preview or approval',async()=>{const f=fixture();try{
 await f.show('source_edit');const tile=f.document.querySelector('[data-start-turn="1"]');assert.equal(tile.disabled,false);tile.click();
 const submit=f.document.querySelector('.libra-range-footer button');assert.equal(submit.textContent,'선택한 구간 재분석');submit.click();await flush();
 assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0],{scopeKey:'scope-a',mode:'source_edit',ranges:[{startTurn:1,sourceDigest:'source-1',identityDigest:'identity-1'}]});assert.equal(f.document.querySelector('[data-canonical-range-drawer]'),null);
 }finally{f.close();}});
test('repeated submit while the first operation is pending dispatches once',async()=>{let release;const f=fixture({run:()=>new Promise(r=>release=r)});try{
 await f.show('source_edit');f.document.querySelector('[data-start-turn="1"]').click();const button=f.document.querySelector('.libra-range-footer button');button.click();button.click();await flush();assert.equal(f.calls.length,1);assert.equal(button.disabled,true);release({ok:true});await flush();
 }finally{release?.({ok:true});f.close();}});
test('failed operation leaves the drawer usable with the error and no extra dispatch',async()=>{const f=fixture({run:()=>({ok:false,reason:'replacement_failed'})});try{
 await f.show('source_edit');f.document.querySelector('[data-start-turn="1"]').click();f.document.querySelector('.libra-range-footer button').click();await flush();
 assert.equal(f.calls.length,1);assert.equal(f.document.querySelector('.libra-range-footer button').disabled,false);assert.match(f.document.querySelector('[role="status"]').textContent,/replacement_failed/);
 }finally{f.close();}});
test('closing before inventory resolves cannot create work or reopen a stale drawer',async()=>{let release;const f=fixture({inventory:()=>new Promise(r=>release=r)});try{
 const showing=f.show('source_edit');f.Gui.canonicalRangeDrawerClose();release({scopeKey:'scope-a',observedTurns:0,completeBatches:0,pendingTurns:0,ranges:[]});await showing;assert.equal(f.calls.length,0);assert.equal(f.document.querySelector('[data-canonical-range-drawer]'),null);
 }finally{f.close();}});
