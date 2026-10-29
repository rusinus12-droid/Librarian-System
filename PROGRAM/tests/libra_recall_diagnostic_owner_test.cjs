'use strict';
// Execute the exact current beforeRequest body. Only its asynchronous settings /
// context / branch-read dependencies are controlled here; the whole three-mode
// worldline regression separately exercises the real canonical GET barrier.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const sourcePath=process.env.LIBRA_DIAGNOSTIC_SOURCE||path.join(__dirname,'../plugins/LIBRA.js');
const source=fs.readFileSync(sourcePath,'utf8'),start=source.indexOf('    const beforeRequest = async (messages, type) => {'),end=source.indexOf('\n    const afterRequest = async ',start);
assert(start>0&&end>start,'unique real core hook body');
const ownerLine='    let latestRecallPublicationOwner = null;';
const prefix=source.slice(Math.max(0,start-100),start).includes(ownerLine)?ownerLine+'\n':'';
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture({oldPhase='before_branch_reconcile',sameScope=false,currentEarly=false,oldContextResolves=false}={}){
 let seq=0,enter,release;const entered=new Promise(r=>enter=r),blocked=new Promise(r=>release=r),Runtime={lastInjection:'prior'},state={captureBackend:'none',bootstrapReferenceCache:new Map(),pendingBoundaryRecoveryCheckedScopes:new Set(),lastRequestScope:{scope:{scopeKey:'unrelated-prior'}}};
 const scope=id=>({scopeKey:sameScope?'same-scope':'scope-'+id,chatId:'chat-'+id});
 const fail=message=>Object.assign(new Error(message),{code:'SYNTHETIC_DEPENDENCY_FAILURE'});
 const context={Runtime,state,DEFAULT_RESPONSE_INJECTION_MODE:'fixture-default',LIBRA_CAPTURE_BACKENDS:{CHAT_OUTPUT_V3:'capture'},RECALL_REQUEST_BUDGET_MS:1000,RECALL_TIMEOUT_EXTENSION_MS:10000,
  MEMORY_INJECTION_MARKER:'marker1',LEGACY_PLANNING_INJECTION_MARKER:'marker2',CLASSIC_INJECTION_MARKER:'marker3',LEGACY_RESPONSE_INJECTION_MARKER:'marker4',
  isMainNarrativeRequest:type=>type==='model',contentToText:String,createRecallGuard:()=>({id:++seq}),recallGuardSnapshot:g=>({id:g?.id||0}),
  async runRecallStep(g,phase){
   if(currentEarly&&phase==='before_settings')throw fail('current_early_failure');
   if(g.id===1&&phase===oldPhase){enter();await blocked;if(oldContextResolves&&phase==='before_context')return{scope:scope(g.id),chat:{}};throw fail('older_failure');}
   if(phase==='before_settings')return{enabled:true,autoAnalyze:false};
   if(phase==='before_context')return{scope:scope(g.id),chat:{}};
   if(phase==='before_branch_reconcile')throw fail('newer_failure');
   throw Error('unexpected test phase:'+phase);
  },loadMemorySettings(){},resolveContext(){},buildPairs:()=>[],clearStaleMemoryInjectionDebug(){},
  rawChatMessages:()=>[],messageRole:()=>'',cleanMessageText:()=>'',digest:()=>'',sourceDigest:()=>'',
  normalizeRequestType:String,clone:plain,string:v=>String(v??''),compact:(v,n)=>String(v??'').slice(0,n),asObject:v=>v&&typeof v==='object'?v:{},
  liveTailDiagnosticSnapshot:v=>v??null,warn(){},scheduleGuiTraceRefresh(){}};
 const helpersStart=source.indexOf('    const memoryInjectionScopeMatches = (left, right) => {'),helpersEnd=source.indexOf('    const scheduleBeforeRequestRecovery = async ',helpersStart);
 assert(helpersStart>0&&helpersEnd>helpersStart,'exact real diagnostic clear helper region');
 vm.createContext(context);vm.runInContext(source.slice(helpersStart,helpersEnd)+prefix+source.slice(start,end)+'\nglobalThis.hook=beforeRequest;',context,{filename:sourcePath});
 return{context,Runtime,state,entered,release,scope};
}
test('current failing recall still publishes fail-open diagnostics for its own scope',async()=>{
 const f=fixture({oldPhase:'never'}),messages=[{role:'user',content:'current request'}];
 assert.equal(await f.context.hook(messages,'model'),messages);
 assert.equal(f.Runtime.lastMemoryRecallViewer.error,'newer_failure');assert.equal(f.Runtime.lastMemoryRecallViewer.scopeKey,'scope-1');assert.equal(f.Runtime.lastMemoryRecallViewer.failOpen,true);assert.equal(f.Runtime.lastInjection,'');
});
for(const sameScope of [false,true])test((sameScope?'same':'different')+'-scope older failed read cannot replace newer request diagnostics',async()=>{
 const f=fixture({sameScope}),oldMessages=[{role:'user',content:'older request'}],newMessages=[{role:'user',content:'newer request'}];
 const old=f.context.hook(oldMessages,'model');await f.entered;
 assert.equal(await f.context.hook(newMessages,'model'),newMessages);const before=plain(f.Runtime),runtime=plain(f.state.lastRecallRuntime);
 f.release();assert.equal(await old,oldMessages);assert.deepEqual(plain(f.Runtime),before);assert.deepEqual(plain(f.state.lastRecallRuntime),runtime);assert.equal(f.Runtime.lastMemoryRecallViewer.error,'newer_failure');
});
test('older settings-phase failure cannot borrow a newer request scope or overwrite it',async()=>{
 const f=fixture({oldPhase:'before_settings'}),messages=[{role:'user',content:'older settings'}],old=f.context.hook(messages,'model');await f.entered;
 await f.context.hook([{role:'user',content:'newer context'}],'model');const before=plain(f.Runtime);f.release();assert.equal(await old,messages);assert.deepEqual(plain(f.Runtime),before);
});
test('current failure before context does not claim an unrelated prior request scope',async()=>{
 const f=fixture({currentEarly:true}),messages=[{role:'user',content:'early failure'}];assert.equal(await f.context.hook(messages,'model'),messages);
 assert.equal(f.Runtime.lastMemoryRecallViewer.error,'current_early_failure');assert.equal(f.Runtime.lastMemoryRecallViewer.scopeKey,'');assert.deepEqual(plain(f.Runtime.lastMemoryRecallViewer.scope),{});
});

test('older context fulfillment cannot clear or republish a newer request diagnostic before its later failure',async()=>{
 const f=fixture({oldPhase:'before_context',oldContextResolves:true}),messages=[{role:'user',content:'older delayed context'}],old=f.context.hook(messages,'model');await f.entered;
 await f.context.hook([{role:'user',content:'newer resolved context'}],'model');const before=plain(f.Runtime),scopeBefore=plain(f.state.lastRequestScope),runtimeBefore=plain(f.state.lastRecallRuntime);
 f.release();assert.equal(await old,messages);assert.deepEqual(plain(f.Runtime),before);assert.deepEqual(plain(f.state.lastRequestScope),scopeBefore);assert.deepEqual(plain(f.state.lastRecallRuntime),runtimeBefore);
});
