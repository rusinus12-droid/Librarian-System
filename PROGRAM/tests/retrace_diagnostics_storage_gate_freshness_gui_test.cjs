'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require('jsdom'),{declaration}=require('./helpers/libra_navigation_contract.cjs');
const source=fs.readFileSync(path.join(__dirname,'../plugins/RETRACE.js'),'utf8');
(async()=>{
 const dom=new JSDOM('<div id="root"><div id="diagnosticsBody"></div></div>');
 const Runtime={root:dom.window.document.querySelector('#root'),visible:true,overviewRefreshToken:0,lastPreview:{},memorySuiteOwnerStorageGate:{ready:true},warnings:[]};
 let selected={character:{id:'character'},chat:{id:'A',name:'Chat <A>',message:['A']}},switchDuringRead=false,fail=false;
 const clone=value=>JSON.parse(JSON.stringify(value));
 const ctx={Runtime,Date,Promise,Map,clone,text:v=>String(v??''),compact:v=>String(v),scopeManagerArray:v=>Array.isArray(v)?v:[],formatNumber:String,scopeManagerFormatTime:String,
  escapeHtml:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  inspectTransition:async()=>{if(fail)throw Error('no active character');const preview={context:clone(selected)};Runtime.lastPreview=preview;return preview;},
  refreshMemorySuiteOwnerStorageDashboard:async()=>{if(!Runtime.memorySuiteOwnerStorageLoading)Runtime.memorySuiteOwnerStorage={gate:{ready:true}};return Runtime.memorySuiteOwnerStorage;},
  inspectCompatibilitySuite:async()=>{if(switchDuringRead)selected.chat={id:'B',name:'Chat B',message:['B']};},getCurrentContext:async()=>selected,
  MemorySuiteHostLineage:{inspect:(character,chat)=>({hostChatId:chat.id,characterId:character.id}),fingerprint:JSON.stringify},
  renderOverviewPanel:()=>{},bindOverviewControls:()=>{},bindDebugExportButton:()=>{},syncRetraceDiagnosticIndicator:()=>{},retraceOverviewState:()=>({})
 };
 vm.createContext(ctx);vm.runInContext(['refreshOverview','renderDiagnosticsPanel'].map(n=>declaration(source,n)).join('\n')+'\nthis.api={refresh:refreshOverview,render:renderDiagnosticsPanel};',ctx);
 const gateRow=()=>Runtime.root.querySelector('[data-diagnostics-storage-gate]').textContent;
 try{
  ctx.api.render();assert.match(gateRow(),/미검사/,'shared cached ready gate alone is not a verified chat result');
  await ctx.api.refresh();assert.match(gateRow(),/마지막 채팅 점검.*Chat <A>.*저장 Gate 통과/);
  assert.doesNotMatch(gateRow(),/현재 채팅.*통과/,'a cached result must never claim the current selection');
  assert.equal(Runtime.root.querySelector('small A'),null,'chat titles are escaped');
  Runtime.memorySuiteOwnerStorage.gate.ready=false;Runtime.memorySuiteOwnerStorageGate={ready:false};ctx.api.render();
  assert.match(gateRow(),/저장 Gate 통과/,'other panels cannot overwrite the gate paired with the verified preview');
  selected.chat={id:'B',name:'Chat B',message:['B']};ctx.api.render();
  assert.match(gateRow(),/Chat <A>/,'last checked chat stays explicitly named until another full check');
  Runtime.lastPreview={context:clone(selected)};ctx.api.render();assert.match(gateRow(),/미검사/,'a new preview cannot inherit another preview\'s gate');
  switchDuringRead=true;selected.chat={id:'A',name:'Chat A',message:['A']};await ctx.api.refresh();
  assert.match(gateRow(),/미검사/,'selection changing during the check cannot publish a ready gate');
  assert.equal(Runtime.overviewStorageGate,null);assert.match(Runtime.overviewError,/바뀌어/);
  switchDuringRead=false;Runtime.memorySuiteOwnerStorageLoading=true;await ctx.api.refresh();
  assert.match(gateRow(),/미검사/,'an already loading dashboard can return stale data, which is not check evidence');
  Runtime.memorySuiteOwnerStorageLoading=false;await ctx.api.refresh();assert.match(gateRow(),/Chat B.*저장 Gate 통과/);
  fail=true;await ctx.api.refresh();assert.match(gateRow(),/미검사/);assert.equal(Runtime.overviewStorageGate,null);
  console.log('PASS diagnostics Gate: verified preview binding, named cached results, selection races, stale dashboard and failed refresh');
 }finally{dom.window.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
