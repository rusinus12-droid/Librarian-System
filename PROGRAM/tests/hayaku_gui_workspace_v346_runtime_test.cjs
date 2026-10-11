'use strict';
// Production render functions and actual lineage normalizer; DOM/host boundaries
// are controlled. No RisuAI browser, external LLM or real user data is claimed.
const {JSDOM}=require('jsdom');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const H=fs.readFileSync(path.join(root,'plugins/HAYAKU_Locator_Continuity.js'),'utf8');
const lineage=fs.readFileSync(path.join(root,'sdk/MemorySuiteHostLineage.source.js'),'utf8');
const slice=(a,b)=>{const i=H.indexOf(a),j=H.indexOf(b,i+a.length);assert(i>=0&&j>i,`${a}/${b}`);return H.slice(i,j);};
const results=[];
function setup(){
 const dom=new JSDOM('<main><section id="hayakuSourceEditConsent"></section><section id="hayakuPacketAuthoring"></section><section id="hayakuHostLineage"></section></main>');
 const nodes=new Map(['#hayakuSourceEditConsent','#hayakuPacketAuthoring','#hayakuHostLineage'].map(id=>[id,dom.window.document.querySelector(id)]));
 const viewer={root:dom.window.document.querySelector('main'),scope:{key:'A',chatId:'chat-A',chatTitle:'검증용 A',confident:true},ledger:{enabled:true,worldline:{headTurnNodeId:'node-A'}},activeTab:'recovery',visible:true};
 const counts={status:0,review:0};let status={scopeKey:'A',topology:'topology-A',ranges:[]};let review=async()=>({ok:true}),read=()=>status;
 const c=vm.createContext({Memory:{ledgerViewer:viewer},document:dom.window.document,text:v=>String(v??''),ensureArray:v=>Array.isArray(v)?v:[],viewerEscapeHtml:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),viewerFormatDate:v=>`time:${v}`,getHayakuSourceInput:()=>({mountControls:()=>{}}),listHayakuReanalysisRanges:async()=>{counts.status++;return await read();},runHayakuSelectedReanalysis:async selection=>{counts.review++;return await review(selection);},RisuCompat:{currentChatScope:async()=>({key:'A',confident:true})},now:()=>Date.now()});
 vm.runInContext(lineage+'\nglobalThis.MemorySuiteHostLineage=createMemorySuiteHostLineage();',c);
 vm.runInContext(slice('  const packetAuthoringViewerSnapshot =','  const viewerRenderOverview =')+'\nObject.assign(globalThis,{viewerRenderPacketAuthoring,viewerRenderSourceEditConsent,viewerRenderHostLineage});',c);
 return {c,viewer,nodes,counts,setStatus:s=>status=s,setRead:f=>read=f,setReview:f=>review=f,button:()=>nodes.get('#hayakuSourceEditConsent').querySelector('[data-reanalysis-run]')};
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
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 await test('empty explicit inventory shows no ranges or enabled execution',async()=>{const x=setup();x.c.viewerRenderSourceEditConsent();await settle();const h=x.nodes.get('#hayakuSourceEditConsent').innerHTML;assert.match(h,/직접 재분석/);assert.match(h,/재분석할 저장 구간이 없습니다/);assert.equal(x.button().disabled,true);assert.equal(x.counts.review,0);});
 await test('only selected current-scope ranges execute and busy controls remain disabled',async()=>{
  const x=setup();x.setStatus({scopeKey:'A',topology:'topology-A',ranges:[{key:'1',label:'T1'},{key:'2',label:'T2'}]});x.c.viewerRenderSourceEditConsent();await settle();
  const card=x.nodes.get('#hayakuSourceEditConsent'),inputs=card.querySelectorAll('input');assert.equal(inputs.length,2);assert.equal(x.button().disabled,true);
  inputs[1].checked=true;inputs[1].onchange();assert.equal(x.button().disabled,false);
  let release,submitted;x.setReview(selection=>{submitted=selection;return new Promise(resolve=>release=resolve)});const operation=x.button().onclick();
  assert.equal(x.button().disabled,true);assert.equal(card.querySelector('[data-reanalysis-refresh]').disabled,true);assert([...inputs].every(n=>n.disabled));
  assert.equal(submitted.scopeKey,'A');assert.equal(submitted.topology,'topology-A');assert.deepEqual(Array.from(submitted.ranges,row=>row.key),['2']);
  release({ok:true});await operation;assert.match(card.textContent,/기억을 갱신했습니다/);assert.equal(x.counts.review,1);assert.equal(x.button().disabled,false);
 });
 await test('scope rerender prevents a late previous inventory from leaking into current card',async()=>{
  const x=setup();let release;x.setRead(()=>new Promise(resolve=>release=resolve));x.c.viewerRenderSourceEditConsent();
  x.viewer.scope={key:'B',chatId:'chat-B',confident:true};x.setRead(()=>({scopeKey:'B',topology:'B',ranges:[{key:'2',label:'B-current'}]}));x.c.viewerRenderSourceEditConsent();await settle();
  release({scopeKey:'A',topology:'A',ranges:[{key:'1',label:'PRIVATE_A'}]});await settle();const h=x.nodes.get('#hayakuSourceEditConsent').innerHTML;assert(!h.includes('PRIVATE_A'));assert(h.includes('B-current'));assert.equal(x.counts.review,0);
 });
 await test('inventory failure reports its cause and never enables execution',async()=>{
  const x=setup();x.setRead(()=>{throw Error('CONTROLLED_LIST_FAILURE')});x.c.viewerRenderSourceEditConsent();await settle();assert.match(x.nodes.get('#hayakuSourceEditConsent').textContent,/목록 조회 실패.*CONTROLLED_LIST_FAILURE/);assert.equal(x.button().disabled,true);assert.equal(x.counts.review,0);
 });
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
