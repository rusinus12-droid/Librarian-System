'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createHayakuRuntime,createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const plain=value=>JSON.parse(JSON.stringify(value));
const os=require('node:os');
const diskRoot=fs.mkdtempSync(path.join(os.tmpdir(),'dual-engine-record-v2-'));
function disk(name){const file=path.join(diskRoot,name+'.json');if(!fs.existsSync(file))fs.writeFileSync(file,'{}');const read=()=>JSON.parse(fs.readFileSync(file,'utf8'));const write=value=>{const fd=fs.openSync(file,'w');try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};return {get values(){return new Map(Object.entries(read()));},async getItem(k){return read()[k]??null;},async setItem(k,v){const all=read();all[k]=v;write(all);return true;},async removeItem(k){const all=read();delete all[k];write(all);return true;},async keys(){return Object.keys(read());}};}
const stats={hayakuCases:0,flashbackCases:0,externalModelCalls:0};
const shape=[['world','world_rules','worldRules','world_rule'],['world','active_events','activeEvents','active_event'],['world','historical_events','historicalEvents','historical_event'],['world','factions','factions','faction'],['world','regions','regions','region'],['world','offscreen_threads','offscreenThreads','offscreen_thread'],['narrative','conflict_traces','conflictTraces','conflict_trace'],['narrative','scene_deltas','sceneDeltas','scene_delta'],['narrative','theme_motifs','themeMotifs','theme_motif'],['narrative','critical_dialogue','criticalDialogue','critical_dialogue'],['planner','continuity_locks','continuityLocks','continuity_lock'],['planner','do_not_resolve_yet','doNotResolveYet','do_not_resolve_yet'],['planner','consequence_ledger','consequenceLedger','consequence'],['planner','payoff_tracker','payoffTracker','payoff'],['planner','open_invitations','openInvitations','open_invitation']];
function blank(){const p=createValidPacket();for(const axis of ['entity','world','narrative','planner'])p[axis]={};return p;}
async function hayaku(){const h=await createHayakuRuntime({autoRepair:false});try{const t=h.hayaku._test,s={...h.hayaku.settings(),hierarchicalEpisodeMemoryEnabled:false,retrievalRecentContext:{topics:[]}};
 for(const [axis,field,alias,category] of shape)for(const form of ['object','string','single']){
  const p=blank(),marker='Record_'+stats.hayakuCases+'_Ω violet object';const value=form==='string'?marker:{summary:marker};p[axis][alias]=form==='single'?value:[value];const raw=JSON.stringify(p),hash='origin-'+stats.hayakuCases;
  const sourceRows=t.localRecallRowsFromPacket({raw,hash,messageIndex:1},hash),target=sourceRows.find(r=>r.category===category);assert(target,category+' source');
  const pointer=target.locator.originalPointer;let actual=p;for(const key of pointer.slice(1).split('/').map(k=>k.replace(/~1/g,'/').replace(/~0/g,'~')))actual=actual[key];assert.deepEqual(actual,form==='string'?marker:value);
  for(const evidence of [undefined,{lines:[marker],roles:['assistant']},{lines:['Unrelated material'],roles:['assistant']}])for(const mode of ['full','compact','light']){
   const store=t.emptyStore(),meta={messageIndex:1,sourceEvidence:evidence,compactFullIngest:mode==='compact'};
   if(mode==='light')t.ingestLightPacketToStore(store,raw,hash,meta);else t.ingestPacket(store,raw,hash,meta);
   t.rebuildIndex(store,{settings:s,deadlineAt:Date.now()+5000});const row=store.index.find(r=>r.category===category&&r.publicText.includes(marker));
   assert(row,category+'/'+form+'/'+mode+' stored');assert.equal(row.publicRef,target.publicRef);assert.equal(row.locator.originalPointer,pointer);assert.equal(JSON.stringify(p),raw);stats.hayakuCases++;
  }
 }
 for(const field of ['thoughts','thinking','mindset','current_thoughts','currentThoughts','profile.thoughts','profile.mindset']){
  const p=blank(),secret='Private_'+field+'_情報',person={id:'owner-1',name:'Nivara',current_state:'Public cobalt coat'};
  if(field.startsWith('profile.'))person.profile={[field.split('.')[1]]:secret};else person[field]=secret;
  p.entity.characters=[person,{id:'other-1',name:'Zorim',current_state:'Public amber bag'}];const raw=JSON.stringify(p),hash='private-'+field;
  for(const mode of ['full','light']){const store=t.emptyStore();(mode==='full'?t.ingestPacket:t.ingestLightPacketToStore)(store,raw,hash,{messageIndex:1});t.rebuildIndex(store,{settings:s,deadlineAt:Date.now()+5000});
   for(const prepared of [false,true]){if(prepared)await t.localRecallPrepareSources([{raw,hash,messageIndex:1}],store,s,'private-'+field+'-'+mode,Date.now()+5000);
    const plan=async query=>t.selectHayakuEvidencePlan(await t.searchIndexCompositeRecall(store,query,s),query,s,14000).text;
    assert(!(await plan('Zorim '+secret)).includes(secret),'private information denied');assert((await plan('Nivara '+secret)).includes(secret),'owner can recall own private record');assert((await plan('Public cobalt coat')).includes('Public cobalt coat'));stats.hayakuCases++;
   }
  }
 }
 assert.equal(h.llmCalls.length,0);
}finally{await h.dispose();}}
async function flashback(){for(const backend of ['chatOutput','afterRequest'])for(const mode of ['mixed','idOnly','repeat','reroll','awaiting']){
 const diskName=backend+'-'+mode,storage=disk(diskName),local=disk(diskName+'-local');
 let f=await createFixture({captureBackend:backend,pluginStorage:storage,safeLocalStorage:local});try{let api=f.api,t=api._test,sel=api._selectionTest;
  await api.saveSettings({...await api.loadSettings(),embeddingProvider:'hash',embeddingModel:'hash-v1',embeddingEnabled:true,autoEpisodeIndex:false,episodeIndexEnabled:false,captureAfterRequest:true});
  const history=[{role:'user',chatId:'u1',data:'Continue the archive.'},{role:'assistant',chatId:'a1',data:'The old archive has a copper shelf.'}];f.currentChat.message=history;f.currentChat.messages=history;
  await api.ingestLiveChatColdStart({scope:'current',canonical:true});const scope=await api.resolveCurrentScope(),old=plain((await t.loadScopeRecords(scope.scopeKey)).records);
  const current=['repeat','reroll','awaiting'].includes(mode)?history[0].data:'Inspect the opal cabinet.',response='The new opal cabinet has a silver panel, a glass lens, and a separate lower drawer.';
  let request=history.map(m=>({role:m.role,chatId:m.chatId,content:m.data}));const user={role:'user',content:current};if(mode==='idOnly')user.id='u2';
  if(mode==='reroll')request=[request[0]];else if(mode==='awaiting')request=[user];else request.push(user);
  await sel.beforeRequest(request,'model');const pending=t.pendingCaptureRuntimeSnapshot().pendingTurns;assert.equal(pending.length,1);assert.equal(pending[0].latestUser,current);
  if(mode==='awaiting')assert.equal(pending[0].pairIndex,0);else assert.equal(pending[0].pairIndex,mode==='reroll'?1:2);
  if(mode==='awaiting'){
   await new Promise(resolve=>setTimeout(resolve,50));
   const journal=await t.loadPendingCaptureJournalEntries();assert(journal.some(row=>row.bindingState==='awaiting_binding'));
   const previousChat=plain(f.currentChat);await f.dispose();f=await createFixture({captureBackend:backend,pluginStorage:disk(diskName),safeLocalStorage:disk(diskName+'-local'),chat:previousChat});api=f.api;t=api._test;sel=api._selectionTest;
   const readyAt=Date.now();while(api.getCaptureBackendState().backend==='none'&&Date.now()-readyAt<10000)await new Promise(resolve=>setTimeout(resolve,20));
   const recovery=await t.recoverPendingCapturesFromJournal(await api.loadSettings());
   assert(t.pendingCaptureRuntimeSnapshot().pendingTurns.some(row=>row.pairIndex===0),JSON.stringify({recovery,snapshot:t.pendingCaptureRuntimeSnapshot(),journal:await t.loadPendingCaptureJournalEntries()}));
   assert((await t.loadPendingCaptureJournalEntries()).some(row=>row.bindingState==='awaiting_binding'));
  }
  const live=mode==='reroll'?[history[0],{role:'assistant',chatId:'a2',data:response}]:[...history,{role:'user',chatId:'u2',data:current},{role:'assistant',chatId:'a2',data:response}];f.currentChat.message=live;f.currentChat.messages=live;
  if(backend==='chatOutput'){const result=await t.processRisuChatOutputEvent({char:f.character,chat:f.currentChat,messageIndex:live.length-1,characterIndex:0,chatIndex:0});assert.equal(result.captured,1,JSON.stringify(result));}
  else {assert.equal(api.getCaptureBackendState().backend,'after_request_reconcile');await sel.afterRequest(response,'model');}
  const records=plain((await t.loadScopeRecords(scope.scopeKey)).records);assert(records.some(r=>r.text.includes(response)),backend+'/'+mode+' persisted');
  const newest=records.find(r=>r.text.includes(response));assert(newest.text.includes(current));assert.equal(Number(newest.turnIndex||newest.pairIndex),mode==='reroll'?1:2);
  if(mode!=='reroll'){const previous=records.find(r=>r.id===old[0].id);assert(previous);assert.equal(previous.text,old[0].text);assert.deepEqual(previous.vector,old[0].vector);}
  const reopened=await createFixture({pluginStorage:disk(diskName),safeLocalStorage:disk(diskName+'-local'),chat:plain(f.currentChat)});try{const read=plain((await reopened.api._test.loadScopeRecords(scope.scopeKey)).records);assert(read.some(r=>r.id===newest.id&&r.text===newest.text&&JSON.stringify(r.vector)===JSON.stringify(newest.vector)));}finally{await reopened.dispose();}
  stats.flashbackCases++;
 }finally{await f.dispose();}}
}
(async()=>{await hayaku();await flashback();console.log(JSON.stringify({...stats,physicalReadback:true}));})().catch(e=>{console.error(e.stack||e);console.error(JSON.stringify(stats));process.exitCode=1;}).finally(()=>{assert(path.resolve(diskRoot).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(diskRoot).startsWith('dual-engine-record-v2-'));fs.rmSync(diskRoot,{recursive:true,force:true});});
