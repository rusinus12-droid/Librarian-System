'use strict';
// Tests original production functions with read/storage and DOM boundaries
// injected. No RisuAI simulator and no external LLM/provider calls.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const P=path.resolve(__dirname,'..'), source=fs.readFileSync(path.join(P,'plugins/LIBRA.js'),'utf8');
const part=(s,a,b)=>{const i=s.indexOf(a),j=s.indexOf(b,i+a.length);assert(i>=0&&j>i,a);return s.slice(i,j);};
const obj=x=>x&&typeof x==='object'&&!Array.isArray(x)?x:{},arr=x=>Array.isArray(x)?x:[],text=x=>String(x??'');
const el=(tag,attrs={},children=[])=>({tag,...attrs,children:children.filter(x=>x!=null)});
const walk=node=>!node||typeof node!=='object'?[]:[node,...(node.children||[]).flatMap(walk)];
const boot=(code,env,expr)=>vm.runInNewContext(code+'\n;('+expr+');',{console,Promise,Map,Set,Date,Number,Object,queueMicrotask,structuredClone,...env});
const diagnostics=part(source,'  const operationalScopeKey =','  const operationalHealthCard =');
const jobs=part(source,'  const loadCanonicalJobsPage =','  const executionReceiptStatusCopy');
const replay=part(source,'  const runStateReplayMaintenance =','  const buildStateTrackingAvailabilityPanel =');
const receipts=part(source,'  const executionReceiptCacheKey =','  const deleteFailedExecutionRun =');
const dom={guiAsObject:obj,guiAsArray:arr,text,guiEl:el,libraStatusBadge:(value,tone)=>el('badge',{text:value,tone}),guiLazyDetails:(attrs,summary,body)=>el('details',attrs,[summary,...body()]),fieldNode:(label,field)=>el('field',{text:label},[field]),selectNode:(value,options,onChange)=>el('select',{value,options,onChange}),guiSetStatus:()=>{},queueGuiNavigationRender:()=>{},libraFormatTime:x=>String(x)};
// The State panel now renders its selects with the production optionNodes helper; load it verbatim.
dom.optionNodes=vm.runInNewContext(part(source,'  const optionNodes = (items, selected) => items.map(item => {','\n  const inputNode =')+';optionNodes',{guiEl:el,String,Array});
const results=[];
async function check(name,fn){await fn();results.push(name);}
const drain=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function fixture({failure='',unbound=false}={}){
 const Gui={visible:true,openSerial:1};let time=10000,contextScope='s',calls=0,renders=0,healthy=!failure;const queued=[];
 const context=()=>({scope:{scopeKey:contextScope},chat:{}});
 const core={BATCH_SIZE:5,state:{snapshot:{scope:{scopeKey:unbound?'':contextScope}}},
 resolveContext:async()=>{calls++;if(!healthy&&failure==='context')throw Error('context unavailable');return context();},
 loadPendingBoundaryStore:async scope=>{assert.equal(scope.scopeKey,contextScope);if(!healthy&&failure==='pending')throw Error('pending unavailable');return {entries:[]};},
 getWorldManagerRuntimeMeta:async ({context:c})=>{assert.equal(c.scope.scopeKey,contextScope);return {worldline:{activeWorldlineId:'main'}};},
 loadStateWorldlineMeta:async()=>({activeWorldlineId:'main',worldlines:{main:{},alternate:{}}}),
 listCanonicalJobs:async({page,context:c})=>{assert.equal(c.scope.scopeKey,contextScope);if(!healthy&&failure==='jobs')throw Error('job unavailable');return {scopeKey:c.scope.scopeKey,page,pageSize:24,total:80,jobs:[]};}
 };
 const env={...dom,Gui,Runtime:{},LibraMemoryCore:core,Date:class extends Date{static now(){return time;}},queueMicrotask:f=>queued.push(f),queueGuiNavigationRender:()=>{renders++;}};
 const api=boot(diagnostics+jobs,env,'({refresh:refreshOperationalDiagnostics,ensure:ensureOperationalDiagnostics,jobs:loadCanonicalJobsPage,buildJobs:buildCanonicalJobsPanel})');
 return {Gui,core,api,stats:()=>({calls,renders,queued:queued.length}),advance:n=>{time+=n;},heal:()=>{healthy=true;},switchScope:s=>{contextScope=s;core.state.snapshot.scope.scopeKey=s;},flush:async()=>{for(let i=0;i<30&&queued.length;i++){queued.shift()();await drain();}}};
}
(async()=>{
 await check('failed diagnostic reads cannot spin on render',async()=>{
  const f=fixture({failure:'context'});await f.api.refresh();for(let i=0;i<20;i++)f.api.ensure();await f.flush();
  assert.equal(f.stats().calls,1);assert.equal(f.stats().renders,1);assert.equal(f.Gui.operationalDiagnosticsFailures,1);assert.equal(f.Gui.operationalDiagnosticsRetryAt,11000);
  f.advance(1001);f.api.ensure();await f.flush();assert.equal(f.stats().calls,2);assert.equal(f.Gui.operationalDiagnosticsRetryAt,13001);
  f.heal();await f.api.refresh({force:true});assert.equal(f.Gui.operationalDiagnostics.status,'ready');assert.equal(f.Gui.operationalDiagnosticsRetryAt,0);
 });
 await check('diagnostic partial failure preserves independent successes, not empty success',async()=>{
  const f=fixture({failure:'pending'});await f.api.refresh();assert.equal(f.Gui.operationalDiagnostics.status,'partial');assert.equal(f.Gui.operationalDiagnostics.fieldStatus.pendingBoundary,'error');assert.equal(f.Gui.operationalDiagnostics.pendingBoundary,null);assert.equal(f.Gui.operationalDiagnostics.fieldStatus.worldManager,'ready');
  for(let i=0;i<10;i++)f.api.ensure();await f.flush();assert.equal(f.stats().calls,2);
 });
 await check('diagnostic same-scope stale field retained and labelled stale',async()=>{
  const f=fixture({failure:'pending'});f.Gui.operationalDiagnostics={scopeKey:'s',pendingBoundary:{entries:[{startTurn:1,expectedEndTurn:5}]}};await f.api.refresh();assert.equal(f.Gui.operationalDiagnostics.fieldStatus.pendingBoundary,'stale');assert.equal(f.Gui.operationalDiagnostics.pendingBoundary.entries.length,1);
 });
 for(const action of ['switch','hide'])await check(`diagnostics discard ${action} in-flight response`,async()=>{
  const f=fixture();let release;f.core.listCanonicalJobs=async()=>new Promise(r=>release=r);const work=f.api.refresh();await drain();assert(release);
  if(action==='switch')f.switchScope('other');else f.Gui.visible=false;release({jobs:[]});await work;assert.equal(f.Gui.operationalDiagnostics,undefined);assert.equal(f.stats().renders,0);
 });
 await check('unbound scope does not issue render-owned diagnostic reads',async()=>{
  const f=fixture({unbound:true});for(let i=0;i<10;i++)f.api.ensure();await f.flush();assert.equal(f.stats().calls,0);
 });
 await check('Canonical job read failure has bounded retry and manual recovery',async()=>{
  const f=fixture({failure:'jobs'});f.api.buildJobs();await f.flush();for(let i=0;i<20;i++)f.api.buildJobs();await f.flush();assert.equal(f.stats().calls,1);assert(f.Gui.canonicalJobsError);assert.equal(f.stats().renders,1);
  f.heal();await f.api.jobs({force:true,page:2});assert.equal(f.Gui.canonicalJobsPage.page,2);assert.equal(f.Gui.canonicalJobsPage.scopeKey,'s');assert.equal(f.Gui.canonicalJobsError,'');
 });
 await check('Canonical job cache is cleared on scope switch',async()=>{
  const f=fixture();await f.api.jobs();f.switchScope('other');f.api.buildJobs();assert.equal(f.Gui.canonicalJobsPage,null);await f.flush();assert.equal(f.Gui.canonicalJobsPage.scopeKey,'other');
 });
 await check('Canonical job in-flight scope change cannot publish stale jobs',async()=>{
  const f=fixture();let release;f.core.listCanonicalJobs=async()=>new Promise(r=>release=r);const work=f.api.jobs();await drain();f.switchScope('other');release({jobs:[{jobId:'wrong'}]});await work;assert.equal(f.Gui.canonicalJobsPage,undefined);
 });
 function replayFixture({outcome='ok',readback='good'}={}){
  const Gui={visible:true,worldlineTargetId:'main',worldlineRollbackTurn:''};let scope='s',head={scopeKey:'s',worldlineId:'main',throughTurn:10,basis:{replayFingerprint:'fp'}},calls=0,diag=0;const statuses=[];
  const cached={scopeKey:'s',worldManager:{worldline:{activeWorldlineId:'main'}},worldlineMeta:{activeWorldlineId:'main',worldlines:{main:{},alternate:{}}},fieldStatus:{worldlineMeta:'ready'}};
  const operation=async options=>{calls++;assert.equal(options.expectedScopeKey,'s');if(outcome!=='ok')return {ok:false,code:'STATE_REPLAY_FAILED',error:'injected failure',restoredPrevious:outcome==='restored',rollbackIncomplete:outcome==='incomplete'};head={...head,worldlineId:options.worldlineId,throughTurn:options.throughTurn??10};return {ok:true,head:structuredClone(head)};};
  const core={BATCH_SIZE:5,resolveContext:async()=>({scope:{scopeKey:scope}}),rebuildCurrentStateForWorldline:operation,setStateWorldline:operation,rollbackStateWorldline:operation,refreshSnapshot:async()=>({scope:{scopeKey:readback==='scope'?'other':scope},continuityState:{...head,...(readback==='worldline'?{worldlineId:'wrong'}:{}),...(readback==='basis'?{basis:{replayFingerprint:'stale'}}:{})}})};
  // Panel actions now confirm through the approved in-app dialog and re-render via the navigation queue.
  const confirms=[];
  const api=boot(replay,{...dom,Gui,LibraMemoryCore:core,operationalScopeKey:()=>scope,ensureOperationalDiagnostics:()=>cached,operationalReadError:e=>e.message,confirm:()=>true,confirmApprovedOperation:async(message,options)=>{confirms.push({message,options});return true;},queueGuiNavigationRender:()=>{},refreshOperationalDiagnostics:async()=>{diag++;},guiSetStatus:(...v)=>statuses.push(v)},'({run:runStateReplayMaintenance,build:buildStateReplayMaintenancePanel})');
  // Actions are fire-and-forget (onClick:()=>void execute(...)); settle the real operation before asserting.
  const press=async button=>{button.onClick();await drain();for(let i=0;i<50&&Gui.worldManagerRuntimeMetaRebuilding;i++)await drain();assert(!Gui.worldManagerRuntimeMetaRebuilding,'operation settled');};
  return {api,Gui,statuses,confirms,press,scope:s=>{scope=s;},stats:()=>({calls,diag})};
 }
 for(const outcome of ['restored','incomplete'])await check(`State ${outcome} failure is not a success notice`,async()=>{
  // The panel's direct rebuild button moved to the recovery dialog; the worldline switch action runs the same guarded replay.
  const f=replayFixture({outcome}),nodes=walk(f.api.build());nodes.find(x=>x.tag==='select').onChange({target:{value:'alternate'}});const button=walk(f.api.build()).find(x=>x.text==='선택한 분기로 전환');assert(!button.disabled);await f.press(button);assert.equal(f.confirms.length,1);assert.equal(f.stats().calls,1);assert(f.statuses.at(-1)[1]);assert(!f.statuses.some(x=>x[0]==='현재 상태 재생과 readback을 확인했습니다.'));assert.equal(f.stats().diag,0);
 });
 for(const readback of ['scope','worldline','basis'])await check(`State successful API with ${readback} mismatch fails readback`,async()=>{
  const f=replayFixture({readback});await assert.rejects(f.api.run({kind:'rebuild',scopeKey:'s',worldlineId:'main'}),/STATE_MAINTENANCE_/);assert.equal(f.stats().diag,0);
 });
 await check('State successful durable readback produces completion',async()=>{
  const f=replayFixture(),nodes=walk(f.api.build());nodes.find(x=>x.tag==='select').onChange({target:{value:'alternate'}});const button=walk(f.api.build()).find(x=>x.text==='선택한 분기로 전환');await f.press(button);assert.equal(f.stats().calls,1);assert.equal(f.stats().diag,1);assert(f.statuses.some(x=>x[0]==='현재 상태 재생과 readback을 확인했습니다.'));assert(!f.statuses.at(-1)[1]);
 });
 await check('Worldline rollback button changes locally without a page remount',async()=>{
  // The approved panel validates the boundary when the action runs (not by toggling disabled) and confirms the target turn.
  const f=replayFixture(),nodes=walk(f.api.build()),input=nodes.find(x=>x.type==='number'),button=nodes.find(x=>x.text==='변경 내용 확인');assert(!button.disabled);
  for(const value of ['','0','7','NaN','-5','10.5','9007199254740995']){input.onInput({target:{value}});await f.press(button);assert.equal(f.stats().calls,0,value);assert.equal(f.confirms.length,0,value);assert.deepEqual(f.statuses.at(-1),['저장이 완료된 T5 · T10 · T15 경계를 선택하세요.',true,true],value);}
  input.onInput({target:{value:'10'}});await f.press(button);assert.equal(f.stats().calls,1);assert.equal(f.confirms.length,1);assert(f.confirms[0].message.includes('T10'));assert.equal(f.statuses.at(-1)[0],'현재 상태 재생과 readback을 확인했습니다.');
 });
 await check('Worldline selection enables switch immediately',async()=>{
  // Selection is committed to Gui state and the panel re-renders through the navigation queue.
  const f=replayFixture(),nodes=walk(f.api.build()),select=nodes.find(x=>x.tag==='select');assert(nodes.find(x=>x.text==='선택한 분기로 전환').disabled);select.onChange({target:{value:'alternate'}});assert.equal(f.Gui.worldlineTargetId,'alternate');const button=walk(f.api.build()).find(x=>x.text==='선택한 분기로 전환');assert(!button.disabled);await f.press(button);assert.equal(f.stats().calls,1);assert.equal(f.confirms[0].options.target,'s · alternate');
 });
 await check('State command refuses a changed scope before writes',async()=>{
  const f=replayFixture();f.scope('changed');await assert.rejects(f.api.run({kind:'rebuild',scopeKey:'s',worldlineId:'main'}),/SCOPE_CHANGED/);assert.equal(f.stats().calls,0);
 });
 await check('Compute card consumes real SDK status, not nonexistent flags',async()=>{
  const sdk=fs.readFileSync(path.join(P,'sdk/MemorySuiteComputeClient.source.js'),'utf8');
  const status=boot(part(sdk,'  const status =','  const emitStatus ='),{namespace:'libra',pluginId:'libra',defaultMode:'local',lifecycle:{disposed:false},state:{mode:{value:'prefer_server'},status:{state:'ready',reason:'tested'},connection:{value:{version:'test',operations:new Map([['op',true]])}},circuit:{},counters:{},jobRuns:new Map(),derivedCache:new Map(),inFlight:2}},'status')();
  const code=part(source,'  const captureBackendLabel =','  const runStateReplayMaintenance =');const cards=[];
  const panel=boot(code,{...dom,Gui:{},Runtime:{},operationalScopeKey:()=>'',ensureOperationalDiagnostics:()=>({}),LibraMemoryCore:{state:{},getCaptureBackendState:()=>({}),getLastRecall:()=>({}),getMemorySuiteComputeStatus:()=>status},operationalHealthCard:c=>{cards.push(c);return el('card',c);}},'buildOperationalHealthPanel');panel();const card=cards.find(c=>c.title==='Compute Plane');assert.equal(card.status,'Ready');assert.equal(card.tone,'good');assert(card.rows.some(x=>x[1]==='prefer_server'));assert(card.rows.some(x=>x[0]==='workers / queue'&&x[1]==='미조회'));
 });
 await check('failed Canonical provider budget survives receipt projection',async()=>{
  const usage=part(source,'    const executionUsageSummary =','    const executionReceiptRows =');
  const match=source.match(/usage:executionUsageSummary\(run\.commit\?\.providerBudget[^\n]*?\),providerBudget:clone\((.*?)\),retry:/);assert(match);
  const run={providerBudget:{usage:{inputTokens:123,outputTokens:45,totalTokens:168},limits:{maxCalls:8},calls:2}};
  const result=boot(usage,{asObject:obj,run,clone:structuredClone},`({usage:executionUsageSummary(${match[1]}),budget:${match[1]}})`);assert.equal(result.usage.totalTokens,168);assert.equal(result.budget.calls,2);assert.equal(result.usage.available,true);
 });
 await check('receipt tokens distinguish absent, zero measured and estimated',async()=>{
  const fn=boot(part(source,'    const executionUsageSummary =','    const executionReceiptRows ='),{asObject:obj},'executionUsageSummary');assert.equal(fn({}).measurement,'unavailable');assert.equal(fn({totalTokens:0}).measurement,'measured');assert.equal(fn({usage:{totalTokens:12,estimated:true}}).measurement,'estimated');
 });
 function receiptFixture(){
  const Gui={visible:true,openSerial:1};let scope='s',resolve,fail=false;
  const api={listExecutionReceipts:async options=>{assert.equal(options.expectedScopeKey,scope);if(fail)throw Error('receipt failed');return new Promise(r=>resolve=r);},getExecutionReceiptDetail:async()=>({scopeKey:scope,id:'r',kind:'memory'})};
  const funcs=boot(receipts,{...dom,Gui,__LIBRA__:api,operationalScopeKey:()=>scope,operationalReadError:e=>e.message},'({load:loadExecutionReceiptPage,detail:loadExecutionReceiptDetail,ensure:ensureExecutionReceiptScope})');
  return {Gui,funcs,switchScope:s=>{scope=s;},fail:()=>{fail=true;},release:()=>resolve({scopeKey:'s',items:[{id:'r'}]})};
 }
 await check('receipt page discards an in-flight scope change',async()=>{const f=receiptFixture();const p=f.funcs.load('memory');await drain();f.switchScope('other');f.funcs.ensure();f.release();await p;assert.equal(f.Gui.executionReceiptPages.memory,undefined);});
 await check('receipt error is stored for explicit retry, cleared on new scope',async()=>{const f=receiptFixture();f.fail();await f.funcs.load('memory');assert.equal(f.Gui.executionReceiptErrors.memory,'receipt failed');f.switchScope('other');f.funcs.ensure();assert.equal(f.Gui.executionReceiptErrors.memory,undefined);});
 console.log(JSON.stringify({test:'suite_libra_operational_fault_test',passed:results.length,cases:results}));
})().catch(e=>{console.error(e);process.exitCode=1;});
