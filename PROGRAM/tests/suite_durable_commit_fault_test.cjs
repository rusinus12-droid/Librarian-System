'use strict';
// Production functions; only host/storage boundaries are fault-injected.
// This does not simulate RisuAI or call an external model/provider.
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm'), assert=require('node:assert/strict'), crypto=require('node:crypto');
const P=path.resolve(__dirname,'..');
const read=name=>fs.readFileSync(path.join(P,'plugins',name),'utf8');
const part=(s,a,b)=>{const i=s.indexOf(a),j=s.indexOf(b,i+a.length);assert(i>=0&&j>i,a);return s.slice(i,j);};
const ev=(code,env,expr)=>vm.runInNewContext(code+'\n;('+expr+');',{console,Date,Map,Set,Promise,setTimeout,clearTimeout,structuredClone,...env});
const clone=x=>structuredClone(x), hash=x=>crypto.createHash('sha256').update(String(x)).digest('hex');
const results=[];
async function check(name,fn){await fn();results.push(name);}
async function captureFixture(failure){
 const source=read('Flashback_Memory.js');let calls=0,decisions=0,stopped=0,body='original assistant';
 const Runtime={captureBackend:'v3',settings:{},pendingTurns:[{pendingId:'p',scope:{scopeKey:'s'},latestUser:'u',pairIndex:1}],chatOutputTurnRevisions:new Map(),chatOutputCaptureCandidates:new Map(),captureBackendDuplicateDrops:0,captureBackendRevisionCount:0,captureBackendStaleDrops:0};
 const pair={userText:'u',get assistantText(){return body;},pairIndex:1};
 const capture=ev(part(source,'  const processRisuChatOutputEvent =','  const processLegacyScriptOutputCapture ='),{
  Runtime,FLASHBACK_CAPTURE_BACKENDS:{CHAT_OUTPUT_V3:'v3',NONE:'none'},text:x=>String(x||''),stableHash:hash,
  flashbackChatOutputSnapshot:x=>x,resolveScopeFromSnapshot:()=>({scopeKey:'s'}),liveChatReadState:()=>({known:true,normalized:[]}),
  liveChatStateFromNormalized:()=>({pairByAssistantPosition:new Map([[2,pair]])}),canonicalChatUserText:x=>x,canonicalChatResponseText:x=>x,
  enqueueChatOutputCaptureWork:async(k,f)=>f(),authoritativeFinalizedCandidate:()=>({position:2,body,authoritativePair:pair}),
  // Journal recovery is an independent startup path; this fixture isolates the
  // post-output durable commit that is under fault injection.
  recoverPendingCapturesFromJournal:async()=>({ok:true,recovered:0}),
  consumeRequestDecisionForPending:()=>{decisions++;},stopFinalizedCaptureMonitor:()=>{stopped++;},opLog:()=>{},
  saveFinalizedChatCapture:async()=>{calls++;if(calls===1){if(failure==='throw')throw Error('storage fault');if(failure==='false')return false;}return true;}
 },'processRisuChatOutputEvent');
 return {capture:()=>capture({chat:{},chatInfo:{messageIndex:1}}),Runtime,stats:()=>({calls,decisions,stopped}),revise:v=>{body=v;}};
}
function personaFixture(mode){
 const source=read('LIA_Persona_Linker.js');let db={personas:[{id:'live',name:'Persona',personaPrompt:'old'},{id:'other',name:'Other',personaPrompt:'preserve'}],selectedPersona:1};const logs=[];let writes=0;
 const api={getDatabase:async()=>clone(db),setDatabase:async payload=>{
  writes++;assert.deepEqual(Object.keys(payload),['personas']);
  if(mode==='false')return false;if(mode==='ok_false')return {ok:false};if(mode==='noop')return;
  db.personas=clone(payload.personas);if(mode==='wrong_name')db.personas[0].name='stale name';if(mode==='wrong_prompt')db.personas[0].personaPrompt='old';return;
 }};
 // Keep the production snapshot, write guard and readback helpers in this fixture.
 // Extracting only the two callers leaves their safety contract undefined.
 const funcs=ev(part(source,'  function personaDatabaseRowKey(','  async function removeLiaLivePersonaIfUnreferenced('),{
  api,withPersonaDatabaseMutationLock:async f=>f(),asArray:x=>Array.isArray(x)?x:[],appendDebugLog:(...x)=>logs.push(x),appendOperationLog:()=>{}
 },'({upsert:upsertPersonaFresh,mutate:mutatePersonaFresh})');
 return {funcs,logs,db:()=>db,writes:()=>writes};
}
function handoffFixture({sourceChanged=false,siblingChanged=false,prewriteChanged=false,noOp=false,readbackChanged=false}={}){
 const source=read('RETRACE.js');
 const old={id:'character',chatPage:0,name:'original name',chats:[{id:'source',message:[{role:'user',data:'original'}],note:'source note'},{id:'sibling',note:'old note',message:[]}]};
 let db=clone(old);if(sourceChanged)db.chats[0].note='source updated';if(siblingChanged){db.chats[1].note='fresh sibling';db.name='fresh character';db.chats.push({id:'new sibling',note:'created during preparation'});}
 let reads=0,writes=0;
 const getCurrentContext=async()=>{reads++;if(prewriteChanged&&reads===2)db.chats[1].note='raced again';return {character:clone(db),chat:clone(db.chats[db.chatPage]),characterIndex:0};};
 const indexed={setCharacterToIndex:async(index,payload)=>{writes++;if(!noOp)db=clone(payload);return undefined;},getCharacterFromIndex:async()=>{const v=clone(db);if(readbackChanged)v.chats[1].note='external postcommit change';return v;}};
 const code=part(source,'  // Stable semantic identity for explicit handoff writes,','  const sealNextSessionHandoffJournal =');
 const commit=ev(code,{clone,stableHash64:hash,contextIdentity:x=>({characterId:x?.character?.id||'',chatId:x?.chat?.id||''}),liveApi:()=>indexed,getCurrentContext},'commitFreshNextSessionChat');
 return {run:()=>commit({context:{character:clone(old),chat:clone(old.chats[0]),characterIndex:0},identity:{characterId:'character',chatId:'source'},newChat:{id:'target',message:[]},targetChatId:'target'}),db:()=>db,writes:()=>writes};
}
(async()=>{
 await check('Flashback throw -> identical output retried -> durable duplicate only',async()=>{
  const f=await captureFixture('throw');await assert.rejects(f.capture(),/storage fault/);assert.equal(f.stats().decisions,0);assert.equal(f.stats().stopped,0);
  assert.equal([...f.Runtime.chatOutputTurnRevisions.values()][0].persisted,false);
  assert.equal((await f.capture()).captured,1);assert.equal(f.stats().calls,2);assert.equal(f.Runtime.captureBackendRevisionCount,1);
  assert.equal((await f.capture()).duplicates,1);assert.equal(f.stats().calls,2);
 });
 await check('Flashback false/in-flight save remains retryable; changed body gets new revision',async()=>{
  const f=await captureFixture('false');assert.equal((await f.capture()).captured,0);assert.equal(f.stats().decisions,0);
  assert.equal((await f.capture()).captured,1);f.revise('new assistant revision');assert.equal((await f.capture()).captured,1);
  assert.equal(f.Runtime.captureBackendRevisionCount,2);assert.equal(f.stats().calls,3);
 });
 for(const method of ['mutate','upsert'])for(const mode of ['false','ok_false','noop','wrong_name','wrong_prompt','applied']){
  await check(`LIA ${method} ${mode}`,async()=>{
   const f=personaFixture(mode);const action=()=>method==='mutate'?f.funcs.mutate('live',p=>({...p,name:'Persona new',personaPrompt:'new'})):f.funcs.upsert({id:'live',name:'Persona new',personaPrompt:'new'});
   if(mode==='applied'){await action();assert.equal(f.db().personas[0].personaPrompt,'new');assert(f.logs.some(x=>x[1]===`${method}_success`));}
   else{await assert.rejects(action(),e=>['LIA_PERSONA_WRITE_REJECTED','LIA_PERSONA_READBACK_MISMATCH'].includes(e.code));assert(!f.logs.some(x=>x[1]===`${method}_success`));}
   assert.equal(f.db().selectedPersona,1);assert.equal(f.db().personas[1].personaPrompt,'preserve');
  });
 }
 await check('RETRACE rebase preserves sibling edits, new sibling and character fields',async()=>{
  const f=handoffFixture({siblingChanged:true});const r=await f.run();assert.equal(r.hostReadbackVerified,true);assert.equal(f.writes(),1);
  assert.equal(f.db().name,'fresh character');assert.equal(f.db().chats.find(c=>c.id==='sibling').note,'fresh sibling');assert(f.db().chats.some(c=>c.id==='new sibling'));assert.equal(f.db().chats.find(c=>c.id==='source').note,'source note');
 });
 for(const fault of ['sourceChanged','prewriteChanged','noOp','readbackChanged'])await check(`RETRACE ${fault} fails closed without stale rollback`,async()=>{
  const f=handoffFixture({[fault]:true});await assert.rejects(f.run(),e=>e.code==='RETRACE_HOST_WRITE_CONFLICT');
  assert.equal(f.writes(),['sourceChanged','prewriteChanged'].includes(fault)?0:1);
 });
 console.log(JSON.stringify({test:'suite_durable_commit_fault_test',passed:results.length,cases:results}));
})().catch(e=>{console.error(e);process.exitCode=1;});
