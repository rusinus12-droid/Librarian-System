'use strict';
// Production render functions and actual lineage normalizer; DOM/host boundaries
// are controlled. No RisuAI browser, external LLM or real user data is claimed.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const H=fs.readFileSync(path.join(root,'plugins/HAYAKU_Locator_Continuity.js'),'utf8');
const lineage=fs.readFileSync(path.join(root,'sdk/MemorySuiteHostLineage.source.js'),'utf8');
const slice=(a,b)=>{const i=H.indexOf(a),j=H.indexOf(b,i+a.length);assert(i>=0&&j>i,`${a}/${b}`);return H.slice(i,j);};
const results=[];
function setup(){
 const nodes=new Map();
 const make=()=>({innerHTML:'',textContent:'',disabled:false,onclick:null,querySelector(q){if(q==='#reviewHayakuSourceEdits')return this.button||(this.button=make());return null;}});
 for(const id of ['#hayakuSourceEditConsent','#hayakuPacketAuthoring','#hayakuHostLineage'])nodes.set(id,make());
 const viewer={root:{querySelector:q=>nodes.get(q)||null},scope:{key:'A',chatId:'chat-A',chatTitle:'검증용 A',confident:true},ledger:{enabled:true,worldline:{headTurnNodeId:'node-A'}},activeTab:'recovery',visible:true};
 const counts={status:0,review:0};let status={scopeKey:'A',tasks:[]};let review=async()=>false;
 const c=vm.createContext({Memory:{ledgerViewer:viewer},document:{},text:v=>String(v??''),ensureArray:v=>Array.isArray(v)?v:[],viewerEscapeHtml:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),viewerFormatDate:v=>`time:${v}`,getHayakuSourceEdits:()=>({mountControls:()=>{},status:()=>{counts.status++;return status;},review:async v=>{counts.review++;assert.equal(v,true);return await review();}}),RisuCompat:{currentChatScope:async()=>({key:'A',confident:true})},now:()=>Date.now()});
 vm.runInContext(lineage+'\nglobalThis.MemorySuiteHostLineage=createMemorySuiteHostLineage();',c);
 vm.runInContext(slice('  const packetAuthoringViewerSnapshot =','  const viewerRenderOverview =')+'\nObject.assign(globalThis,{viewerRenderPacketAuthoring,viewerRenderSourceEditConsent,viewerRenderHostLineage});',c);
 return {c,viewer,nodes,counts,setStatus:s=>status=s,setReview:f=>review=f,button:()=>nodes.get('#hayakuSourceEditConsent').button};
}
async function test(name,fn){await fn();results.push(name);console.log('PASS '+name);}
(async()=>{
 await test('authoring is below worldline/orphan metrics and not in the health icon grid',()=>{
  const shell=slice('  const renderLedgerViewerShell =','  const showLedgerViewer =');
  const overview=shell.slice(shell.indexOf('<main id="hayakuViewerPanelOverview"'),shell.indexOf('<main id="hayakuViewerPanelPackets"'));
  assert(overview.indexOf('id="hayakuPacketAuthoring"')>overview.indexOf('id="hayakuOverviewOrphans"'));
  assert.match(overview,/<section id="hayakuPacketAuthoring" class="hv-scope-card hv-packet-authoring"/);
  assert(!overview.includes('<details id="hayakuPacketAuthoring"'));assert(!overview.includes('id="hayakuSourceEditConsent"'));assert(!overview.includes('id="hayakuHostLineage"'));
  const world=shell.slice(shell.indexOf('<main id="hayakuViewerPanelWorldline"'),shell.indexOf('<main id="hayakuViewerPanelRecovery"'));
  const recovery=shell.slice(shell.indexOf('<main id="hayakuViewerPanelRecovery"'),shell.indexOf('data-hayaku-viewer-panel="failed_analysis"'));
  assert(world.includes('id="hayakuHostLineage"'));assert(world.indexOf('id="hayakuHostLineage"')<world.indexOf('class="hv-worldline-board"'));
  assert(recovery.includes('id="hayakuSourceEditConsent"'));
  assert(!slice('  const viewerRenderOverview =','  const viewerRenderWorldlineInner =').includes('viewerRenderHostLineage('));
  assert(!slice('  const viewerRenderOverview =','  const viewerRenderWorldlineInner =').includes('viewerRenderSourceEditConsent('));
  assert(slice('  const viewerRenderWorldlineInner =','  const viewerRenderPacketDiagnostics =').includes('viewerRenderHostLineage();'));
  assert(slice('  const viewerRenderNativeRecovery =','  const viewerRunNativeRepair =').includes('viewerRenderSourceEditConsent();'));
 });
 await test('empty authoring has a horizontal heading with the record notice underneath',()=>{const x=setup();x.c.viewerRenderPacketAuthoring();const h=x.nodes.get('#hayakuPacketAuthoring').innerHTML;assert(h.includes('</header><p'));assert.match(h,/이번 패킷 작성<\/h2>/);assert.match(h,/작성 지시 관측 기록이 없습니다/);assert(!h.includes('<summary>'));});
 await test('request-matched authoring preserves stages, no false write success and escaped details',()=>{
  const x=setup();x.c.Memory.lastBeforeRequest={scopeKey:'A',at:100,requestLineage:{requestNonce:'n'},packetWriteActive:true,outputContract:{packetPlacement:{mode:'inside_terminal_wrapper',closingTag:'</Story>'}}};
  x.c.Memory.lastPacketAuthoringObservation={scopeKey:'A',at:101,requestNonce:'n',result:'marker_incomplete'};
  x.c.Memory.lastStorageCapture={scopeKey:'A',at:102,requestNonce:'n',durable:true,packetCount:1,recoveryVault:true};
  x.c.viewerRenderPacketAuthoring();let h=x.nodes.get('#hayakuPacketAuthoring').innerHTML;
  for(const t of ['메인 응답 모델에 적용','미완성','time:100','&lt;/Story&gt;','패킷 저장 완료 아님','관측 경계'])assert(h.includes(t),t);
  x.viewer.scope.key='B';x.c.viewerRenderPacketAuthoring();h=x.nodes.get('#hayakuPacketAuthoring').innerHTML;assert(!h.includes('미완성'));assert(h.includes('관측 기록이 없습니다'));
 });
 await test('hidden Recovery performs no status clone, DOM write or action',()=>{const x=setup();x.viewer.activeTab='overview';x.c.viewerRenderSourceEditConsent();assert.equal(x.counts.status,0);assert.equal(x.counts.review,0);assert.equal(x.nodes.get('#hayakuSourceEditConsent').innerHTML,'');});
 await test('automatic source-edit current-scope states render without a manual review action',()=>{const x=setup();x.setStatus({scopeKey:'A',tasks:[{label:'T8',state:'failed',stateLabel:'재처리 실패',error:'bad <payload>'},{label:'T9',state:'interrupted',stateLabel:'중단'}]});x.c.viewerRenderSourceEditConsent();const h=x.nodes.get('#hayakuSourceEditConsent').innerHTML;assert.match(h,/자동 처리 대기 2건/);assert.match(h,/처리가 필요한 원문 수정 2건/);assert(!h.includes('reviewHayakuSourceEdits'));assert.equal(x.counts.review,0);});
 await test('another scope cannot leak previous tasks or errors',()=>{const x=setup();x.setStatus({scopeKey:'B',error:'OTHER_SECRET',tasks:[{label:'OTHER_TASK',state:'failed'}]});x.c.viewerRenderSourceEditConsent();const h=x.nodes.get('#hayakuSourceEditConsent').innerHTML;assert(!h.includes('OTHER_'));assert(h.includes('아직 조회하지'));assert.equal(x.counts.review,0);});
 await test('unavailable, running, and failed source-edit status is explicit',()=>{const x=setup();x.viewer.scope.confident=false;x.c.viewerRenderSourceEditConsent();assert.match(x.nodes.get('#hayakuSourceEditConsent').innerHTML,/미조회/);x.viewer.scope.confident=true;x.setStatus({scopeKey:'A',running:true,tasks:[]});x.c.viewerRenderSourceEditConsent();assert.match(x.nodes.get('#hayakuSourceEditConsent').innerHTML,/자동 처리 중/);x.setStatus({scopeKey:'A',error:'journal_failed',tasks:[]});x.c.viewerRenderSourceEditConsent();const h=x.nodes.get('#hayakuSourceEditConsent').innerHTML;assert.match(h,/원문 수정 상태를 확인하지 못했습니다/);assert.match(h,/journal_failed/);assert.equal(x.counts.review,0);});
 await test('resolved journal history shows a clear no-change state',()=>{const x=setup();x.setStatus({scopeKey:'A',tasks:Array.from({length:30},(_,i)=>({label:'ROW_'+i,state:i===0?'applied':'superseded',stateLabel:'처리 완료'}))});x.c.viewerRenderSourceEditConsent();const h=x.nodes.get('#hayakuSourceEditConsent').innerHTML;assert(h.includes('확인할 원문 수정이 없습니다'));assert(!h.includes('ROW_'));assert(!h.includes('reviewHayakuSourceEdits'));assert.equal(x.counts.review,0);});
 await test('lineage uses actual shared normalization and no new authority',()=>{const x=setup();x.viewer.scope.hostLineage={schema:'librarian.host_lineage.v1',hostChatId:'chat-A',kind:'native_branch',status:'verified',parentChatId:'parent-id',parentName:'Parent <test>',forkMessageId:'m10',commonPrefixPairs:5,commonPrefixMessages:10,path:['parent-id','chat-A'],pathVerified:false,pathReason:'missing_ancestor',reason:'exact_host_branch_prefix'};x.c.viewerRenderHostLineage();const h=x.nodes.get('#hayakuHostLineage').innerHTML;for(const text of ['공통 원문 검증됨','Parent &lt;test&gt;','5 U+A턴 / 10개 메시지','전체 경로 미검증','missing_ancestor','node-A','확인은 별도'])assert(h.includes(text),text);assert.equal(x.counts.review,0);});
 await test('lineage of another chat does not expose its ancestry',()=>{const x=setup();x.viewer.scope.hostLineage={schema:'librarian.host_lineage.v1',hostChatId:'chat-B',status:'verified',parentChatId:'PRIVATE_PARENT',path:['PRIVATE_PATH']};x.c.viewerRenderHostLineage();const h=x.nodes.get('#hayakuHostLineage').innerHTML;assert(!h.includes('PRIVATE_'));assert(!h.includes('공통 원문 검증됨'));assert(h.includes('분기 근거를 확인하지'));});
 await test('independent and divergent lineage never report successful inheritance',()=>{const x=setup();for(const status of ['independent','diverged','unverified']){x.viewer.scope.hostLineage={schema:'librarian.host_lineage.v1',hostChatId:'chat-A',status};x.c.viewerRenderHostLineage();const h=x.nodes.get('#hayakuHostLineage').innerHTML;assert(!h.includes('공통 원문 검증됨'));assert(!h.includes('승계 완료'));}});

 function refreshSetup() {
   const x=setup();let scope={key:'B',chatId:'chat-B',confident:true},read;let renders=0;
   x.c.clone=(v)=>v;x.c.compact=(v,n)=>String(v).slice(0,n);x.c.viewerRenderData=()=>{renders++;};
   x.c.RisuCompat.currentChatScope=async()=>scope;x.c.RisuCompat.getStorageItem=async()=>null;x.c.partialMemoryKey=k=>"partial:"+k;x.c.pushOperationLog=()=>{};
   x.c.loadStorageLedger=()=>new Promise(resolve=>read=resolve);
   vm.runInContext(slice('  const refreshLedgerViewer =','  const downloadLedgerViewerJson =')+'\nglobalThis.refreshLedgerViewer=refreshLedgerViewer;',x.c);
   return {...x,setScope:s=>scope=s,resolve:l=>read(l),renders:()=>renders};
 }
 await test('refresh publishes scope and ledger together after read and identity check',async()=>{
   const x=refreshSetup(),old=x.viewer.ledger,p=x.c.refreshLedgerViewer();await new Promise(r=>setImmediate(r));
   assert.equal(x.viewer.scope.key,'A');assert.equal(x.viewer.ledger,old);
   x.resolve({enabled:true,records:[],worldline:{headTurnNodeId:'node-B'}});await p;
   assert.equal(x.viewer.scope.key,'B');assert.equal(x.viewer.ledger.worldline.headTurnNodeId,'node-B');assert.equal(x.renders(),1);
 });
 await test('changed host scope cannot publish the late branch/ledger pair',async()=>{
   const x=refreshSetup(),p=x.c.refreshLedgerViewer();await new Promise(r=>setImmediate(r));
   x.setScope({key:'C',chatId:'chat-C',confident:true});x.resolve({enabled:true,records:[{hash:'PRIVATE_B'}]});await p;
   assert.equal(x.viewer.scope,null);assert.equal(x.viewer.ledger.enabled,false);assert.equal(x.viewer.ledger.reason,'viewer_scope_changed_during_refresh');assert.equal(x.viewer.ledger.records.length,0);
 });
 await test('closing the viewer prevents a late refresh from replacing its state',async()=>{
   const x=refreshSetup(),old=x.viewer.ledger,p=x.c.refreshLedgerViewer();await new Promise(r=>setImmediate(r));
   x.viewer.visible=false;x.resolve({enabled:true,records:[]});await p;assert.equal(x.viewer.ledger,old);assert.equal(x.renders(),0);assert.equal(x.viewer.busy,false);
 });
 await test('unavailable host context stays unavailable without reading a ledger',async()=>{
   const x=refreshSetup();let reads=0;x.c.loadStorageLedger=async()=>{reads++;return {enabled:true};};x.setScope({confident:false,reason:'current_chat_indexes_invalid'});
   await x.c.refreshLedgerViewer();assert.equal(reads,0);assert.equal(x.viewer.ledger.enabled,false);assert.equal(x.viewer.ledger.reason,'current_chat_indexes_invalid');
 });
 console.log(JSON.stringify({test:'hayaku_gui_workspace_v346_runtime',passed:results.length,cases:results}));
})().catch(e=>{console.error(e);process.exitCode=1;});
