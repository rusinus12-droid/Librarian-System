'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,QUOTE}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');

test('N01-A runtime: incremental owner proofs skip unconsumed historical body reads, verify consumed records physically, and reject mutations in any family or window',async t=>{
  const x=await fixture({mode:'plugin_only'});t.after(()=>x.cleanup());
  const api=x.f.r.api;
  const built=await api.buildMemoryGraphCorpus({limit:1});
  assert.equal(built.status,'published');
  assert.ok(built.windowCount>=6);
  assert.equal(built.sourceProofs.ownerProofAvailable,true);
  assert.deepEqual([...built.sourceProofs.guaranteedFamiliesWithoutBodyReRead],['canonical','micro','state']);
  assert.deepEqual([...built.sourceProofs.reReadRequiredEveryRequestFamilies],['state','lore']);
  assert.deepEqual([...built.sourceProofs.bodyReReadRequiredFamilies],['lore']);

  const allKeys=[...x.f.r.values.keys()];
  const canonicalBodyKeys=allKeys.filter(k=>/:memory:(?!-graph:)/.test(k)&&!k.includes(':manifest'));
  assert.ok(canonicalBodyKeys.length>=1,'fixture must have canonical memory body records');

  const rawGet=x.f.r.values.get.bind(x.f.r.values);
  const readLog=[];
  x.f.r.values.get=key=>{readLog.push(key);return rawGet(key);};

  // Query that selects the 2 mandatory lore entries + the turn-6 Micro quote (bounded maxUnits=3 so canonical is not admitted)
  const options={corpusMode:'required',queryInput:{queryText:'잠시 건넸다'},consumerPolicy:{maxUnits:3},semanticPolicy:{mode:'disabled'},laneBudget:{maxPages:128,maxBytes:262144}};
  const res=await api.executeMemoryGraphUnifiedQuery(options);
  assert.equal(res.modelDispatchEligible,true);
  assert.equal(res.corpusRead.mode,'durable_common_index');
  assert.equal(res.corpusRead.nativeReprojectionRequired,false);
  assert.equal(res.corpusRead.currentnessVerification.mode,'incremental_owner_proof');
  assert.equal(res.corpusRead.currentnessVerification.status,'verified');
  assert.deepEqual([...res.corpusRead.currentnessVerification.changedFamilies],[]);
  assert.deepEqual([...res.corpusRead.currentnessVerification.changedWindows],[]);
  assert.ok(res.bundle.items.some(i=>i.family==='micro'&&i.text===QUOTE));
  assert.equal(res.bundle.items.some(i=>i.family==='canonical'),false);

  // Unconsumed canonical record bodies must NOT be read during incremental query open or commit
  for(const cKey of canonicalBodyKeys){
    assert.equal(readLog.includes(cKey),false,`unconsumed canonical record body ${cKey} must not be read during incremental query`);
  }
  // Consumed micro record body MUST be physically read during assertPhysicalCurrentness
  assert.equal(readLog.includes(x.active.recordKey),true,'consumed micro record body must be physically verified before dispatch');

  // Negative control 1 (Lore): mutating a host lore entry invalidates the corpus via lore proof reread
  const savedLorebook=x.f.character.lorebook;
  x.f.character.lorebook=[{...savedLorebook[0],content:savedLorebook[0].content+' 추가된 로어 문장.'},...savedLorebook.slice(1)];
  await assert.rejects(()=>api.executeMemoryGraphUnifiedQuery(options),err=>{
    assert.equal(err.reason,'stale_generation');
    assert.deepEqual([...(err.currentnessVerification?.changedFamilies||[])],['lore']);
    return true;
  });
  x.f.character.lorebook=savedLorebook;
  assert.equal((await api.executeMemoryGraphUnifiedQuery(options)).modelDispatchEligible,true);

  // Negative control 2 (State): applying a state correction invalidates the corpus via state head proof
  const target=(await x.f.getHead()).world.find(row=>row.name==='은빛 열쇠');
  assert.ok(target);
  const correction=await api.addWorldManagerCorrection({anchorTurn:5,target:{domain:'world'},patch:{world:[{id:target.id,set:{condition:'잠김'}}]}});
  assert.equal(correction.ok,true);
  await assert.rejects(()=>api.executeMemoryGraphUnifiedQuery(options),err=>{
    assert.equal(err.reason,'stale_generation');
    assert.deepEqual([...(err.currentnessVerification?.changedFamilies||[])],['state']);
    return true;
  });
  await api.buildMemoryGraphCorpus({limit:1});
  assert.equal((await api.executeMemoryGraphUnifiedQuery(options)).modelDispatchEligible,true);

  // Negative control 3 (Consumed Readset Physical Body): raw tampering of consumed micro record body without changing microHead
  const savedMicroBody=rawGet(x.active.recordKey);
  const mutatedMicro=JSON.parse(savedMicroBody);
  mutatedMicro.claims[0].text+=' tampered body without head update';
  x.f.r.values.set(x.active.recordKey,JSON.stringify(mutatedMicro));
  const tamperedResult=await api.executeMemoryGraphUnifiedQuery({...options,consumerPolicy:{maxUnits:10}});
  assert.ok(tamperedResult.bundle.items.some(i=>i.family==='micro'),'micro unit must be selected in bundle');
  assert.equal(tamperedResult.modelDispatchEligible,false,'raw tampering of consumed record body must reject model dispatch');
  assert.equal(tamperedResult.deliveryOutcome,'base_request_only');
  assert.equal(tamperedResult.dispatchVerification.status,'rejected');
  x.f.r.values.set(x.active.recordKey,savedMicroBody);

  // Full audit via verifyMemoryGraphCorpus performs eager full window re-enumeration
  const audit=await api.verifyMemoryGraphCorpus();
  assert.equal(audit.status,'verified');
  assert.equal(audit.currentnessVerification.mode,'eager_full_reprojection_audit');
  assert.equal(audit.currentnessVerification.nativeReprojectionPerformed,true);
  assert.ok(audit.familyContracts.canonical.skipUnchangedWindowBodyRead===true);
  assert.ok(audit.familyContracts.lore.reReadRequiredEveryRequest===true);

  // N01-B runtime: multi-step checkpoint resume + incremental window reuse on appended turn + pageBytes=512 split row reassembly
  const cp1=await api.buildMemoryGraphCorpus({limit:2,maxWindowsPerStep:1});
  assert.equal(cp1.status,'checkpointed');
  assert.equal(cp1.completedWindows,1);

  const cp2=await api.buildMemoryGraphCorpus({limit:2,maxWindowsPerStep:2});
  assert.equal(cp2.status,'published');
  assert.equal(cp2.buildMode,'checkpoint_resume');
  assert.equal(cp2.windowCount,3);
  assert.equal(cp2.reusedWindowCount,1);
  assert.equal(cp2.enumeratedWindowCount,2);

  // Append 1 new turn (6 -> 7 turns, so windowCount grows from 3 -> 4 at limit=2): windows 0..2 reused, window 3 enumerated
  x.f.chat.message.push(
    { role: 'user', chatId: 't7-u', data: '추가 질문 7' },
    { role: 'assistant', chatId: 't7-a', data: '추가 원문 7' }
  );
  x.f.chat.messages = x.f.chat.message;
  const incBuilt=await api.buildMemoryGraphCorpus({limit:2});
  assert.equal(incBuilt.status,'published');
  assert.equal(incBuilt.buildMode,'incremental_reuse');
  assert.equal(incBuilt.windowCount,4);
  assert.equal(incBuilt.reusedWindowCount,3);
  assert.equal(incBuilt.enumeratedWindowCount,1);
  const incAudit=await api.verifyMemoryGraphCorpus();
  assert.equal(incAudit.status,'verified');

  // Build with pageBytes=2048 so oversized single index rows split deterministically across pages and query/verify cleanly
  const splitBuilt=await api.buildMemoryGraphCorpus({limit:2,pageBytes:2048});
  assert.equal(splitBuilt.status,'published');
  assert.ok(splitBuilt.storage.splitRowCount>0,'runtime corpus with pageBytes=2048 must split oversized index rows');
  const splitQuery=await api.executeMemoryGraphUnifiedQuery(options);
  assert.equal(splitQuery.modelDispatchEligible,true);
  const splitAudit=await api.verifyMemoryGraphCorpus();
  assert.equal(splitAudit.status,'verified');
});
