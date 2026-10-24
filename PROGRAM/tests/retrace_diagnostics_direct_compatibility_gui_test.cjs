'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require('jsdom'),{declaration}=require('./helpers/libra_navigation_contract.cjs');
const source=fs.readFileSync(path.join(__dirname,'../plugins/RETRACE.js'),'utf8');
(async()=>{
 const dom=new JSDOM('<div id="root"><div id="diagnosticsBody"></div></div>');
 const oldSessionSuite={compatible:false,blocking:[{}],peers:[]};
 const Runtime={root:dom.window.document.querySelector('#root'),compatibilitySuite:oldSessionSuite,lastPreview:{includeLibra:true},overviewError:'현재 캐릭터를 불러올 수 없습니다.',memorySuiteOwnerStorageGate:{ready:true},warnings:[]};
 let probes=[],contexts=0,servers=0,unreachable=false,mismatch=false,rejectProbe=false;
 const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const ctx={Runtime,Date,Promise,text:v=>String(v??''),compact:v=>String(v),scopeManagerArray:v=>Array.isArray(v)?v:[],formatNumber:String,scopeManagerFormatTime:String,escapeHtml,
  ACTIVE_RETRACE_PEER_KEYS:['flashback','hayaku','libra','lia'],RETRACE_PEER_PROTOCOL_MAJOR:1,PLUGIN_VERSION:'fixture',
  isLiaLivePersonaId:()=>false,probeUniversalPeerCompatibility:async(key,options)=>{probes.push({key,options});await Promise.resolve();if(rejectProbe)throw Error('probe failed');return{key,label:key,installed:true,ownerReachable:!(unreachable==='all'||unreachable&&key==='lia'),compatible:!(mismatch&&key==='libra'),blocking:options.required&&mismatch&&key==='libra',pluginVersion:'1.0',reason:'<unsafe>'};},
  inspectTransition:async()=>{contexts++;throw Error('no active character');},refreshOverview:async()=>{contexts++;throw Error('no active character');},refreshServerControl:async()=>{servers++;},
  handleServerControl:async()=>{throw Error('manager action is absent in this fixture');},bindOverviewControls:()=>{},bindDebugExportButton:()=>{},syncRetraceDiagnosticIndicator:()=>{},retraceOverviewState:()=>({})
 };
 vm.createContext(ctx);vm.runInContext(['compatibilityRequiredForPreview','inspectCompatibilitySuite','refreshRetraceDiagnostics','renderDiagnosticsPanel'].map(n=>declaration(source,n)).join('\n')+'\nthis.api={render:renderDiagnosticsPanel,run:refreshRetraceDiagnostics,inspect:inspectCompatibilitySuite};',ctx);
 try{
  const api=ctx.api;api.render();
  const click=selector=>{const button=Runtime.root.querySelector(selector);assert(button);button.click();return Runtime.diagnosticsPending;};
  const first=click('[data-diagnose-compatibility]');
  assert.equal(Runtime.root.querySelector('[data-diagnose-now]').disabled,true);
  const duplicate=api.run({compatibilityOnly:true});await Promise.all([first,duplicate]);
  assert.equal(probes.length,4);assert(probes.every(p=>p.options.forceProbe&&p.options.required===false));
  assert.equal(contexts,0,'contract-only UI never reads the current chat');assert.equal(servers,0,'contract-only UI never needs server availability');
  assert.equal(Runtime.compatibilitySuite,oldSessionSuite,'diagnosis must not replace session authorization');
  assert.equal(Runtime.compatibilityDiagnostics.handoffAllowed,false);
  assert.equal(Runtime.root.querySelectorAll('[data-diagnostics-peer-results] article').length,4);
  assert.match(Runtime.root.querySelector('[data-diagnostics-contract]').textContent,/응답 4 \/ 4/);
  assert.match(Runtime.root.querySelector('[data-diagnostics-storage-gate]').textContent,/미검사/,'stale ready gate is not shown without current context');
  assert.equal(Runtime.root.querySelector('unsafe'),null);
  await click('[data-diagnose-now]');assert.equal(contexts,1);assert.equal(servers,1);
  assert.match(Runtime.root.querySelector('[data-diagnostics-contract]').textContent,/응답 4 \/ 4/,'context failure does not skip capability diagnostics');
  unreachable=true;await click('[data-diagnose-compatibility]');
  assert.equal(Runtime.compatibilityDiagnostics.complete,false);assert.match(Runtime.root.querySelector('[data-diagnostics-contract]').textContent,/응답 3 \/ 4/);
  mismatch=true;await click('[data-diagnose-compatibility]');assert.equal(Runtime.compatibilityDiagnostics.compatible,false);assert.equal(Runtime.compatibilityDiagnostics.contractIssues,1);
  assert.match(Runtime.root.querySelector('[data-diagnostics-peer-results]').textContent,/계약 불일치/);
  unreachable='all';mismatch=false;await click('[data-diagnose-compatibility]');
  assert.equal(Runtime.compatibilityDiagnostics.respondingPeers,0);assert.equal(Runtime.compatibilityDiagnostics.compatible,false);
  rejectProbe=true;await click('[data-diagnose-compatibility]');assert.match(Runtime.root.querySelector('[data-diagnostics-contract]').textContent,/검사 실패/);
  assert.equal(Runtime.root.querySelector('[data-diagnose-compatibility]').disabled,false);
  rejectProbe=false;unreachable=false;mismatch=false;
  const session=await api.inspect({includeLibra:true});assert.equal(Runtime.compatibilitySuite,session);assert.equal(session.handoffAllowed,true,'the original session path remains separate');
  console.log('PASS direct diagnostics: both GUI buttons, no-chat/no-server protocol probe, coalescing, partial/mismatch states, separate handoff authority');
 }finally{dom.window.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
