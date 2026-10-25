'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {lensFixture}=require('./fixtures/libra_lens_handoff_fixture.cjs');
const plain=value=>JSON.parse(JSON.stringify(value));
const inherited=(f,id)=>f.manifest(id).value.inheritedLensArchives;
async function transfer(f,id='lens-transfer'){
 const prepared=await f.api.prepareSessionHandoff({transferId:id});const target=f.target();
 const adopted=await f.api.adoptSessionHandoff({transferId:id,targetChatId:target.id});return{prepared,target,adopted};
}
test('active and paused lenses round-trip by immutable reference, trash is excluded and counts verify',async()=>{
 const f=await lensFixture();try{
  const active=await f.add(),paused=await f.add('일시정지 렌즈','paused'),trashed=await f.add('휴지통 렌즈');await f.api.trashLens(trashed.lensId);
  const canonical=[...f.r.values.entries()].filter(([k])=>/:memory:|:continuity-state$|:entity-registry/.test(k));
  const {prepared,target,adopted}=await transfer(f);assert.equal(prepared.expectedLensArchives,2);assert.equal(prepared.expectedLensRecords,2);
  assert.equal(adopted.verified,true);assert.equal(adopted.verifiedLensArchives,2);assert.equal(adopted.verifiedLensRecords,2);
  for(const [key,raw]of canonical)assert.equal(f.r.values.get(key),raw,'lenses cannot change canonical memory, State or people');
  const refs=inherited(f,target.id);assert.deepEqual(refs.map(ref=>ref.lensId).sort(),[active.lensId,paused.lensId].sort());
  assert.ok(refs.every(ref=>ref.sessionEpoch===-1));
  const view=await f.api.inspectScopeLenses();assert.equal(view.memories.length,2);assert.ok(view.memories.every(item=>item.inherited&&item.readOnly&&item.sourceTurns['t2-a']));
  assert.equal(view.lenses[active.lensId].itemCount,0);assert.equal(view.lenses[active.lensId].inheritedItemCount,1);
  const bytes=f.r.values.get(refs[0].archiveKey);assert.equal((await f.api.deleteLensMemories({memoryId:view.memories[0].id})).ok,false);assert.equal(f.r.values.get(refs[0].archiveKey),bytes);
  const verified=await f.api.verifySessionHandoff({transferId:'lens-transfer',targetChatId:target.id,expectedLensArchives:2,expectedLensRecords:2});assert.equal(verified.verified,true);
  assert.equal((await f.api.verifySessionHandoff({transferId:'lens-transfer',targetChatId:target.id,expectedLensRecords:3})).verified,false);
 }finally{await f.close();}
});
test('a second handoff carries the first chat notes with earlier session epochs',async()=>{
 const f=await lensFixture();try{
  await f.add();await transfer(f,'first');const second=await transfer(f,'second');assert.equal(second.adopted.verified,true);
  assert.equal(inherited(f,second.target.id)[0].sessionEpoch,-2);assert.equal((await f.api.inspectScopeLenses()).memories[0].inherited,true);
 }finally{await f.close();}
});
test('inherited recall is relevant, bounded, sanitized again and skips a corrupt archive visibly',async()=>{
 const f=await lensFixture();try{
  const lens=await f.add();const {target}=await transfer(f);const ref=inherited(f,target.id)[0];
  let recall=await f.api.recallLensMemories({query:'지호 은빛 열쇠 약속',canonicalBudgetChars:12000});
  assert.ok(recall.usedChars<=2600);assert.match(recall.renderedBlock,/\[lens:약속 렌즈 · 이전 대화\]/);assert.equal(recall.injectedItems[0].inherited,true);
  await f.api.updateLens(lens.lensId,{recall:{mode:'recent'}});
  recall=await f.api.recallLensMemories({query:'unrelated helicopter orbit',canonicalBudgetChars:12000});assert.equal(recall.injectedItems.length,0,'recent mode never sweeps previous-chat notes');
  assert.equal((await f.api.recallLensMemories({query:'열쇠',canonicalBudgetChars:0})).usedChars,0);
  const archive=JSON.parse(f.r.values.get(ref.archiveKey));archive.records[0].items[0].text+=' CORRUPT';f.r.values.set(ref.archiveKey,JSON.stringify(archive));
  recall=await f.api.recallLensMemories({query:'열쇠 약속',canonicalBudgetChars:12000});assert.equal(recall.injectedItems.length,0);assert.ok(recall.skippedCandidates.some(row=>row.reasonCode==='inherited_archive_unavailable'));
  assert.equal((await f.api.inspectScopeLenses()).inheritedArchiveUnavailable.length,1);
 }finally{await f.close();}
});
test('archive instruction snapshots survive an instruction revision change',async()=>{
 const f=await lensFixture();try{
  const lens=await f.add();await transfer(f);await f.api.updateLens(lens.lensId,{instruction:{goal:'새 분석 지침'}});
  const item=(await f.api.inspectScopeLenses()).memories[0];assert.equal(item.instructionCurrent,false);assert.equal(item.recordInstructionText,lens.instructionText);assert.match(item.currentInstructionText,/새 분석/);
 }finally{await f.close();}
});
test('purging a lens removes inherited archives and every known successor manifest ref',async()=>{
 const f=await lensFixture();try{
  const lens=await f.add();const first=await transfer(f,'first');const second=await transfer(f,'second');
  await f.api.trashLens(lens.lensId);await f.api.purgeLens(lens.lensId);
  assert.equal([...f.r.values.keys()].some(key=>key.includes(':lens-handoff-archive:')&&key.endsWith(':'+lens.lensId)),false);
  assert.equal(inherited(f,first.target.id).length,0);assert.equal(inherited(f,second.target.id).length,0);
  assert.ok((await f.api.getLensRegistry()).purgedLensIds.includes(lens.lensId));assert.equal((await f.api.inspectScopeLenses()).memories.length,0);
 }finally{await f.close();}
});
test('a native branch inherits only shared-prefix lens notes with verified archive readback',async()=>{
 const f=await lensFixture();try{
  await f.add();f.target('분기',true);const result=await f.api.debugNativeChatCopy({force:true});
  assert.equal(result.result?.ok,true,JSON.stringify(result));assert.equal(result.result.verifiedLensArchives,1);assert.equal(result.result.verifiedLensRecords,1);
  assert.equal((await f.api.inspectScopeLenses()).memories.filter(item=>item.inherited).length,1);
 }finally{await f.close();}
});
test('source changes during the final lens storage publication cannot persist stale notes',async()=>{
 const f=await lensFixture();try{
  const lens=await f.add();const key=[...f.r.values.keys()].find(k=>k.endsWith(`:lens:${lens.lensId}:records`)),before=f.r.values.get(key);
  const store=f.r.context.risuai.pluginStorage,set=store.setItem.bind(store);let hit=false;
  store.setItem=async(k,value)=>{const result=await set(k,value);if(k===key&&!hit){hit=true;f.chat.message[3].data+=' Changed source after write.';}return result;};
  await assert.rejects(f.r.core.runLensForRange(lens.lensId,{startTurn:1,endTurn:5}),/원문 변경/);assert.equal(hit,true);assert.equal(f.r.values.get(key),before);
 }finally{await f.close();}
});
test('an in-flight lens cannot recreate data after permanent delete',async()=>{
 const f=await lensFixture();let release=()=>{};try{
  const lens=await f.add();let started;const entered=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
  f.setReply(async()=>{started();await gate;return JSON.stringify({items:[{text:'late lens',refs:['t2-a'],basis:'a late response'}]});});
  const run=f.r.core.runLensForRange(lens.lensId,{startTurn:1,endTurn:5});await entered;await f.api.trashLens(lens.lensId);await f.api.purgeLens(lens.lensId);release();
  await assert.rejects(run,/렌즈가 변경되거나 삭제/);assert.equal([...f.r.values.keys()].some(key=>key.includes(`:lens:${lens.lensId}:`)),false);
 }finally{release();await f.close();}
});
test('permanent deletion waits for a suspended storage write and its rollback',async()=>{
 const f=await lensFixture();let release=()=>{},purging;
 try{
  const lens=await f.add(),key=[...f.r.values.keys()].find(k=>k.endsWith(`:lens:${lens.lensId}:records`));
  const store=f.r.context.risuai.pluginStorage,set=store.setItem.bind(store);let hit=false,entered;
  const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  store.setItem=async(k,value)=>{if(k===key&&!hit){hit=true;entered();await gate;}return await set(k,value);};
  const running=f.r.core.runLensForRange(lens.lensId,{startTurn:1,endTurn:5}).then(value=>({value}),error=>({error}));
  await started;await f.api.trashLens(lens.lensId);let deleted=false;
  purging=f.api.purgeLens(lens.lensId).then(value=>{deleted=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(deleted,false,'delete cannot finish while the write can still restore old records');
  release();assert.ok((await running).error);await purging;
  assert.equal([...f.r.values.keys()].some(k=>k.includes(`:lens:${lens.lensId}:`)),false);
 }finally{release();await purging?.catch(()=>{});await f.close();}
});
test('a storage removal that leaves lens data behind fails deletion and remains retryable',async()=>{
 const f=await lensFixture();try{
  const lens=await f.add(),key=[...f.r.values.keys()].find(k=>k.endsWith(`:lens:${lens.lensId}:records`));
  const store=f.r.context.risuai.pluginStorage,remove=store.removeItem.bind(store);
  store.removeItem=async k=>k===key?false:await remove(k);
  await f.api.trashLens(lens.lensId);await assert.rejects(f.api.purgeLens(lens.lensId),/일부 렌즈 기록/);
  assert.ok((await f.api.getLensRegistry()).trash.some(row=>row.lensId===lens.lensId));
  assert.ok(f.r.values.has(key));store.removeItem=remove;
  await f.api.purgeLens(lens.lensId);assert.equal(f.r.values.has(key),false);
 }finally{await f.close();}
});
test('prepare settles a running lens and retains its freeze until adoption finishes',async()=>{
 const f=await lensFixture();let release=()=>{};try{
  const lens=await f.add();let entered;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  f.setReply(async()=>{entered();await gate;return JSON.stringify({items:[{text:'은빛 열쇠 약속의 최신 기록',refs:['t2-a'],basis:'약속의 말'}]});});
  const run=f.r.core.runLensForRange(lens.lensId,{startTurn:1,endTurn:5});await started;let settled=false;
  const preparing=f.api.prepareSessionHandoff({transferId:'freeze'}).then(value=>{settled=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(settled,false);release();await run;
  const prepared=await preparing;assert.equal(prepared.expectedLensRecords,1);
  await assert.rejects(f.r.core.runLensForRange(lens.lensId,{startTurn:1,endTurn:5}),/승계 준비 중/);
  const target=f.target();const result=await f.api.adoptSessionHandoff({transferId:'freeze',targetChatId:target.id});assert.equal(result.verified,true);
  assert.match((await f.api.inspectScopeLenses()).memories[0].text,/최신/);
 }finally{release();await f.close();}
});
test('cancel before adoption releases the freeze and deletes owned lens archives',async()=>{
 const f=await lensFixture();try{
  const lens=await f.add();const prepared=await f.api.prepareSessionHandoff({transferId:'cancel'});
  assert.equal((await f.api.rollbackLensSessionHandoff({transferId:'cancel'})).deletedArchives,1);
  assert.equal(f.r.values.has(prepared.lensArchiveRefs[0].archiveKey),false);
  assert.equal((await f.r.core.runLensForRange(lens.lensId,{startTurn:1,endTurn:5})).ok,true);
 }finally{await f.close();}
});
test('lens rollback removes successor refs and owned archives without touching canonical data',async()=>{
 const f=await lensFixture();try{
  await f.add();const {prepared,target}=await transfer(f,'rollback');
  const memoryKeys=[...f.r.values.keys()].filter(k=>/:memory:|:continuity-state$/.test(k)),before=memoryKeys.map(k=>[k,f.r.values.get(k)]);
  const result=await f.api.rollbackLensSessionHandoff({transferId:'rollback',targetChatId:target.id});assert.equal(result.verified,true);assert.equal(result.deletedArchives,1);
  assert.equal(inherited(f,target.id).length,0);assert.equal(f.r.values.has(prepared.lensArchiveRefs[0].archiveKey),false);
  for(const [key,value]of before)assert.equal(f.r.values.get(key),value);
  assert.equal((await f.api.rollbackLensSessionHandoff({transferId:'rollback',targetChatId:target.id})).removedRefs,0,'rollback is idempotent');
 }finally{await f.close();}
});
test('a write to source lens records while the archive is stored fails prepare and cleans owned artifacts',async()=>{
 const f=await lensFixture();try{
  const lens=await f.add(),key=[...f.r.values.keys()].find(k=>k.endsWith(`:lens:${lens.lensId}:records`));
  const store=f.r.context.risuai.pluginStorage,set=store.setItem.bind(store);let hit=false;
  store.setItem=async(k,value)=>{const result=await set(k,value);if(!hit&&k.includes(':lens-handoff-archive:')){hit=true;const records=JSON.parse(f.r.values.get(key));records.updatedAt='foreign mutation';f.r.values.set(key,JSON.stringify(records));}return result;};
  await assert.rejects(f.api.prepareSessionHandoff({transferId:'mutated'}),/원본이 변경/);assert.equal(hit,true);
  assert.equal([...f.r.values.keys()].some(k=>k.startsWith('libra:v1:lens-handoff-archive:mutated:')),false);
 }finally{await f.close();}
});
test('late copies of a purged archive stay hidden and are cleaned when the successor is opened',async()=>{
 const f=await lensFixture();try{
  const lens=await f.add();const {target}=await transfer(f),row=f.manifest(target.id),ref=inherited(f,target.id)[0],archive=f.r.values.get(ref.archiveKey),stale=JSON.stringify(row.value);
  await f.api.trashLens(lens.lensId);await f.api.purgeLens(lens.lensId);
  f.r.values.set(row.key,stale);f.r.values.set(ref.archiveKey,archive);
  assert.equal((await f.api.inspectScopeLenses()).memories.length,0);
  for(let i=0;i<100&&f.manifest(target.id).value.inheritedLensArchives.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.manifest(target.id).value.inheritedLensArchives.length,0);assert.equal(f.r.values.has(ref.archiveKey),false);
 }finally{await f.close();}
});
test('portable export follows inherited lens archive dependencies',async()=>{
 const f=await lensFixture();try{
  await f.add();const {target}=await transfer(f),ref=inherited(f,target.id)[0];
  let envelope;
  for(let i=0;i<100;i++){
    try{envelope=await f.r.context.__LIBRAPortableMemoryBackup.exportCurrentScope();break;}
    catch(error){if(!/busy|진행|처리/.test(String(error?.message)))throw error;await new Promise(resolve=>setTimeout(resolve,20));}
  }
  assert.ok(envelope?.records.some(row=>row.key===ref.archiveKey),'portable backup contains the immutable inherited archive');
 }finally{await f.close();}
});
test('own current notes precede equal previous-chat text and never expand the lens budget',async()=>{
 const f=await lensFixture();try{
  const lens=await f.add();const {target}=await transfer(f);target.message=f.clone(f.chat.message);target.messages=target.message;
  await f.r.core.runLensForRange(lens.lensId,{startTurn:1,endTurn:5});
  const result=await f.api.recallLensMemories({query:'지호 은빛 열쇠 약속',canonicalBudgetChars:12000});
  assert.equal(result.injectedItems[0].inherited,false);assert.ok(result.usedChars<=2600);
 }finally{await f.close();}
});
test('an invalid ref after the first eight references cannot be hidden by the admission cap',async()=>{
 const f=await lensFixture();try{
  const rows=require('./fixtures/unified_vertical_source.json').sourceRows;
  const batch=Array.from({length:5},(_,i)=>({turn:i+1,user:{text:rows[i*2].text},assistant:{text:rows[i*2+1].text}}));
  const result=f.api.evaluateLensCandidateItems({items:[{text:'범위 밖의 인용도 검증해야 한다.',refs:['t1-u','t1-a','t2-u','t2-a','t3-u','t3-a','t4-u','t4-a','t999-a'],basis:'test'}]}, {evidenceMode:'interpretive'},batch);
  assert.equal(result.acceptedItems.length,0);assert.equal(result.rejectedItems[0].reasonCode,'out_of_range_ref');
 }finally{await f.close();}
});
test('a provider that ignores cancellation cannot publish after prepare discards its running job',async()=>{
 const f=await lensFixture();let release=()=>{};try{
  const lens=await f.add();let entered;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  f.setReply(async()=>{entered();await gate;return JSON.stringify({items:[{text:'late discarded note',refs:['t2-a'],basis:'late'}]});});
  const run=f.r.core.runLensForRange(lens.lensId,{startTurn:1,endTurn:5});const outcome=run.then(value=>({value}),error=>({error}));await started;
  const prepared=await f.api.prepareSessionHandoff({transferId:'ignored-abort'});assert.equal(prepared.expectedLensRecords,1);
  release();const result=await outcome;assert.ok(result.error||result.value?.status==='stale_source_revision');
  const target=f.target();assert.equal((await f.api.adoptSessionHandoff({transferId:'ignored-abort',targetChatId:target.id})).verified,true);
  assert.equal((await f.api.inspectScopeLenses()).memories.some(item=>item.text==='late discarded note'),false);
 }finally{release();await f.close();}
});
