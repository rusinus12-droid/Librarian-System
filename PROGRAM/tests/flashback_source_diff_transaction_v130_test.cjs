'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
// Exercise the real tracking controller boundary; this is not a provider request.
const source=fs.readFileSync(path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8');
const marker='const getFlashbackSourceEdits =';
assert.equal(source.split(marker).length,2);
const fixtureSource=source.replace(marker,marker+' globalThis.__testSourceEdits =');
async function sourceEditBoundary(f){await f.context.__testSourceEdits().beforeRequest();f.context.__testSourceEdits().afterRequest();}
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
let passed=0;const check=(v,m)=>{assert.ok(v,m);passed++;};
const wait=async test=>{for(let i=0;i<1500;i++){if(await test())return;await new Promise(r=>setTimeout(r,8));}throw Error('wait timeout');};
(async()=>{const f=await createFixture({source:fixtureSource});try{
 const a=f.api,t=a._test;
 f.currentChat.message=[{role:'user',chatId:'u1',data:'Enter the archive.'},{role:'assistant',chatId:'a1',data:'Alice signed the agreement.'},{role:'user',chatId:'u2',data:'Look for a ribbon.'},{role:'assistant',chatId:'a2',data:'Alice found a blue ribbon.'}];f.currentChat.messages=f.currentChat.message;
 const cfg={...await a.loadSettings(),embeddingProvider:'hash',embeddingModel:'hash-v1',embeddingEnabled:true,autoEpisodeIndex:false};await a.saveSettings(cfg);await a.ingestLiveChatColdStart({scope:'current',canonical:true});
 const scope=await a.resolveCurrentScope();const sync=async()=>t.synchronizeFlashbackTurnWorldline(scope,t.liveChatStateFromNormalized(t.normalizeStoredChatMessages(f.currentChat,scope.scopeKey)),cfg,{forceReconcile:true});
 const original=await t.loadScopeRecords(scope.scopeKey);check(original.records.length>=2,'real canonical initial ingestion');
 f.currentChat.message[1].data='Alice did not sign the agreement. <img src=x onerror="attack()">';
 await sourceEditBoundary(f);await wait(async()=>a.getSourceEditSyncStatus().tasks.some(task=>task.key==='1'&&task.state==='applied'));
 let stored=await t.loadScopeRecords(scope.scopeKey),gates=t.applyRecallHardGates(stored.records,{scopeKey:scope.scopeKey});
 check(gates.some(r=>(r.record||r).text.includes('did not sign')),'automatic before-request replacement is the source returned to recall');
 check(!gates.some(r=>(r.record||r).text.includes('Alice signed')),'replaced old canonical is excluded after durable commit');
 check(gates.some(r=>(r.record||r).text.includes('blue ribbon')),'unchanged later turn remains recallable');
 const status=a.getSourceEditSyncStatus(),view=await t.loadFlashbackSourceEditDiff(status.tasks);
 check(view.rows.length===1&&view.rows[0].valid,'diff binds the exact stored and currently observed source');
 check(view.rows[0].before.includes('Alice ')&&view.rows[0].after.includes('not sign'),'old/new text available in diff');
 check(view.rows[0].after.includes('<mark'),'actual changed range highlighted');
 check(!view.rows[0].after.includes('<img'),'source HTML never becomes executable markup');
 stored=await t.loadScopeRecords(scope.scopeKey);gates=t.applyRecallHardGates(stored.records,{scopeKey:scope.scopeKey});check(gates.some(r=>(r.record||r).text.includes('did not sign')),'automatically replaced source is active');check(!gates.some(r=>(r.record||r).text.includes('Alice signed')),'previous revision removed only after durable replacement');
 check(gates.some(r=>(r.record||r).text.includes('blue ribbon')),'automatic replacement preserves unaffected suffix');
 check((await t.loadTurnWorldline(scope.scopeKey)).retiredRecords.some(r=>r.text.includes('Alice signed')),'old canonical preserved as inactive history');
 const tag='<lb-xnai id="scene" operation="abc">{{inlay::img-1}}</lb-xnai>';f.currentChat.message[3].data+=tag;await sync();check(!a.getSourceEditSyncStatus().tasks.some(v=>v.start===2&&['awaiting_consent','failed'].includes(v.state)),'illustration change does not require user approval');
 // A first capture becomes canonical only after exact current U+A and both stable IDs match.
 const current=await t.loadScopeRecords(scope.scopeKey);const provisional=current.records.map(r=>Number(r.turnIndex||r.pairIndex)===2?{...r,metadata:{...r.metadata,captureAuthority:{provisional:true,liveConfirmed:false}}}:r);
 await t.saveAllRecords(provisional,cfg,scope);await sync();
 const confirmed=await t.loadScopeRecords(scope.scopeKey);check(confirmed.records.filter(r=>Number(r.turnIndex||r.pairIndex)===2).every(r=>r.metadata?.captureAuthority?.liveConfirmed===true),'exact finalized first-capture promotion');
 // A legacy first-capture body that differs cannot auto-promote, but must be reviewable.
 const legacy=(await t.loadScopeRecords(scope.scopeKey)).records.map(r=>Number(r.turnIndex||r.pairIndex)===2?{...r,metadata:{...r.metadata,captureAuthority:{provisional:true,liveConfirmed:false}}}:r);
 await t.saveAllRecords(legacy,cfg,scope);f.currentChat.message[3].data='Alice found a green ribbon.';await sync();await sourceEditBoundary(f);
 const legacyView=await t.loadFlashbackSourceEditDiff(a.getSourceEditSyncStatus().tasks);
 check(legacyView.rows.some(r=>r.valid&&r.previousUnconfirmed&&r.before.includes('blue')&&r.after.includes('green')),'changed legacy first-capture is explicitly reviewable, not silently promoted');
 check(a.getSourceEditSyncStatus().tasks.some(task=>task.key==='2'&&task.state==='applied'),'legacy source is automatically replaced only after exact source validation');
 check((await t.loadScopeRecords(scope.scopeKey)).records.some(r=>r.text.includes('green ribbon')&&r.metadata?.captureAuthority?.liveConfirmed===true),'approved legacy replacement becomes confirmed canonical');
 // A storage acknowledgement failure never leaves the replacement silently successful.
 f.currentChat.message[1].data='Alice postponed the agreement.';await sync();
 const beforeFault=await t.loadScopeRecords(scope.scopeKey),set=f.pluginStorage.setItem.bind(f.pluginStorage);let fail=true;
 f.pluginStorage.setItem=async(k,v)=>{if(fail&&String(k).endsWith(':turn_worldline:v1')){fail=false;throw Error('fixture failed worldline commit');}return set(k,v);};
 await sourceEditBoundary(f);await wait(async()=>a.getSourceEditSyncStatus().tasks.some(task=>task.key==='1'&&task.state==='failed'));
 const failed=a.getSourceEditSyncStatus().tasks.find(task=>task.key==='1');
 check(!!failed?.error&&!fail,'injected owner worldline write failure surfaced through the automatic path');
 const afterFault=await t.loadScopeRecords(scope.scopeKey);check(afterFault.records.some(r=>r.text.includes('did not sign')),'old canonical restored on commit failure');check(!afterFault.records.some(r=>r.text.includes('postponed')),'failed replacement not active');
 check(f.currentChat.message[1].data==='Alice postponed the agreement.','host source not reverted by rollback');
 console.log(JSON.stringify({test:'flashback_source_diff_transaction_v130',passed}));
}finally{await f.dispose();}})().catch(e=>{console.error(e);process.exitCode=1});
