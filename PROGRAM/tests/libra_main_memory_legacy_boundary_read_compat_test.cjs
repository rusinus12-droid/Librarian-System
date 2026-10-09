'use strict';
// Stored v5 legacy bracket-string boundary compatibility is a read/replay path,
// separate from the producer contract that requires new structured boundary rows.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const MODES = process.env.LIBRA_LEGACY_BOUNDARY_MODE
  ? [process.env.LIBRA_LEGACY_BOUNDARY_MODE] : ['plugin_only', 'mirror', 'server_only'];
const clone = value => JSON.parse(JSON.stringify(value));
const rows = snapshot => {
  const stored = snapshot.storedRows().map(row => ({ ...row }));
  const seen = new Set(stored.map(row => row.key));
  for (const [key, raw] of snapshot.local.entries()) {
    if (seen.has(key)) continue;
    let value = raw; try { value = JSON.parse(raw); } catch {}
    stored.push({ key, raw, value });
  }
  return stored;
};
const memories = snapshot => rows(snapshot).filter(row => /:memory:\d+:/.test(row.key)
  && row.value?.canonicalArtifact).sort((a,b) => Number(/:memory:(\d+):/.exec(a.key)?.[1]||0)-Number(/:memory:(\d+):/.exec(b.key)?.[1]||0));
const headOf = snapshot => {
  const row = rows(snapshot).find(row => /:continuity-state$/.test(row.key));
  return row?.value || snapshot.getHead();
};
const digest = value => {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  let hash = 2166136261, length = 0;
  for (let index=0; index<serialized.length; index++) { hash ^= serialized.charCodeAt(index); hash = Math.imul(hash,16777619); }
  hash ^= 31; hash = Math.imul(hash,16777619); length += serialized.length + 1;
  return `${(hash>>>0).toString(16).padStart(8,'0')}:${length}`;
};
const cursorForRef = ref => ({
  key:String(ref?.key||''),memoryId:String(ref?.memoryId||''),revision:Number(ref?.revision||0),sourceDigest:String(ref?.sourceDigest||''),
  manualStateDispositionDigest:String(ref?.manualStateDispositionDigest||''),manualAuthorityHash:String(ref?.manualAuthorityHash||''),
  artifactSchema:String(ref?.artifactSchema||''),artifactDigest:String(ref?.artifactDigest||''),worldlineId:String(ref?.worldlineId||'main'),
  logicalWorldlineId:String(ref?.logicalWorldlineId||ref?.worldlineId||'main'),turnRange:clone(ref?.turnRange||{}),sessionEpoch:Number(ref?.sessionEpoch||0),
  inheritedSessionHistory:ref?.inheritedSessionHistory===true||ref?.inherited===true,archiveShared:ref?.archiveShared===true,
  archiveId:String(ref?.archiveId||''),archiveCanonicalId:String(ref?.archiveCanonicalId||''),handoffTransferId:String(ref?.handoffTransferId||''),
  sourceSessionScopeKey:String(ref?.sourceSessionScopeKey||''),nativeCopiedFromScopeKey:String(ref?.nativeCopiedFromScopeKey||'')
});
const rawArtifactBytes = row => {
  const raw = String(row.raw), marker = '"canonicalArtifact"', fieldAt = raw.indexOf(marker);
  assert.ok(fieldAt >= 0, 'stored canonical memory includes canonicalArtifact');
  let start = raw.indexOf(':', fieldAt + marker.length) + 1;
  while (/\s/.test(raw[start] || '')) start++;
  let depth=0, quoted=false, escaped=false;
  for (let index=start; index<raw.length; index++) {
    const char=raw[index];
    if (quoted) { if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue; }
    if(char==='"'){quoted=true;continue;}
    if(char==='{'||char==='[')depth++;
    else if(char==='}'||char===']'){depth--;if(depth===0)return raw.slice(start,index+1);}
  }
  throw new Error('stored canonicalArtifact JSON bytes are unterminated');
};
const writeStored = async (snapshot,key,value) => {
  const raw = JSON.stringify(value);
  if (snapshot.local.has(key)) snapshot.local.set(key,raw);
  if (snapshot.storedRows().some(row=>row.key===key)) await snapshot.mutate(key,value);
  assert.ok(snapshot.local.has(key)||snapshot.storedRows().some(row=>row.key===key),`stored row exists: ${key}`);
};
const entityId = (head,name) => head?.characters?.find(row=>row.name===name)?.id||'';

const runMode = async mode => {
  const snapshot=await serverFixture({mode}),f=snapshot.f;
  const observation={mode};
  try {
    const quote='민아는 지호에게 오늘 편지를 열지 말라고 말했다.';
    const source=f.chat.message.find(row=>row.chatId==='t4-a');
    assert.ok(source,`${mode}: direct source row exists`);
    source.data=`${source.data||''} ${quote}`.trim();
    f.control.artifact=clone(artifact());
    f.control.artifact.schema='libra.canonical_artifact.v5';
    f.control.artifact.facts.push({tempFactId:'c_legacy_probe',domain:'character',subjectTempRef:'mina',claimKind:'character_boundary',
      values:{boundaries:[{content:quote,topic:'편지 열기',kind:'boundary',scope:{subjectRef:'mina',targetRef:'jiho',act:'편지 열기',when:'오늘'}}]},
      text:quote,temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref:'t4-a',quote}]});
    f.control.artifact.stateBindings.push({factTempId:'c_legacy_probe',typedValueField:'boundaries',stateDomain:'character',stateField:'boundaries'});
    const produced=await f.run();
    assert.equal(produced.completed,1,`${mode}: real controlled provider commits a structured v5 boundary first`);
    const memoryRow=memories(snapshot)[0];
    assert.ok(memoryRow,`${mode}: canonical memory was stored`);
    const memory=clone(memoryRow.value),manifestRow=rows(snapshot).find(row=>/:manifest$/.test(row.key));
    assert.ok(manifestRow,`${mode}: active manifest exists`);
    const manifest=clone(manifestRow.value),fact=memory.canonicalArtifact.facts.find(row=>row.tempFactId==='c_legacy_probe');
    assert.ok(fact?.values?.boundaries?.[0]?.scope?.targetRef,`${mode}: producer stored a typed Registry-resolvable scope`);

    const legacyString=`${quote} [주제: 편지 열기]`;
    fact.values.boundaries=[legacyString];
    memory.text=f.r.api.debugRenderUnifiedArtifact(memory.canonicalArtifact);
    memory.artifactDigest=digest(memory.canonicalArtifact);
    const manifestRef=Object.values(manifest.memories||{}).find(ref=>ref.key===memoryRow.key);
    assert.ok(manifestRef,`${mode}: active reference points at the stored memory`);
    manifestRef.artifactDigest=memory.artifactDigest;
    await writeStored(snapshot,memoryRow.key,memory);
    await writeStored(snapshot,manifestRow.key,manifest);
    const activeRow=rows(snapshot).find(row=>/:unified-active:v1$/.test(row.key));
    if(activeRow){
      const active=clone(activeRow.value),refs=[...Object.values(manifest.memories||{}),...(manifest.inheritedMemories||[])]
        .filter(ref=>ref?.status==='committed'&&ref?.key)
        .sort((left,right)=>Number(left.sessionEpoch||0)-Number(right.sessionEpoch||0)||Number(left.turnRange?.start||0)-Number(right.turnRange?.start||0));
      active.manifestIdentity=digest(refs.map(ref=>({cursor:cursorForRef(ref),sourceEvidenceRef:ref.sourceEvidenceRef||null})));
      await writeStored(snapshot,activeRow.key,active);
    }

    const mutatedRow=memories(snapshot).find(row=>row.key===memoryRow.key);
    assert.equal(mutatedRow.value.canonicalArtifact.schema,'libra.canonical_artifact.v5',`${mode}: persisted fixture stays v5`);
    assert.equal(mutatedRow.value.canonicalArtifact.facts.find(row=>row.tempFactId==='c_legacy_probe').values.boundaries[0],legacyString,
      `${mode}: fixture contains a stored pre-structured legacy boundary string`);
    const before=rawArtifactBytes(mutatedRow);
    const beforeProviderCalls=f.control.calls.length;
    const cache=rows(snapshot).find(row=>/:state-replay-cache:v1$/.test(row.key));
    if(cache){
      if(snapshot.local.has(cache.key))snapshot.local.delete(cache.key);
      if(snapshot.storedRows().some(row=>row.key===cache.key))await snapshot.mutate(cache.key,null,'remove');
      assert.equal(rows(snapshot).some(row=>row.key===cache.key),false,`${mode}: derived replay cache is actually deleted`);
    }
    const replay=await f.r.api.rebuildWorldManagerState({reason:'phase_c_stored_legacy_boundary_replay'});
    assert.equal(replay.ok,true,`${mode}: stored v5 legacy string passes canonical replay ${JSON.stringify(replay)}`);
    assert.equal(replay.providerCalls,0,`${mode}: legacy read/replay made no provider calls`);
    const head=headOf(snapshot),mina=head?.characters?.find(row=>row.name==='민아');
    observation.statePreservesLegacyString=mina?.state?.boundaries?.includes(legacyString)===true;
    assert.equal(observation.statePreservesLegacyString,true,`${mode}: State preserves the exact historical string bytes`);
    const afterRow=memories(snapshot).find(row=>row.key===memoryRow.key);
    observation.replayPreservesLegacyArtifactBytes=rawArtifactBytes(afterRow)===before;
    assert.equal(observation.replayPreservesLegacyArtifactBytes,true,`${mode}: cold replay preserves stored v5 canonicalArtifact JSON bytes`);
    observation.noProviderCalls=f.control.calls.length===beforeProviderCalls;
    assert.equal(observation.noProviderCalls,true,`${mode}: replay did not re-enter the controlled provider`);

    const page=await f.r.api.listWorldManagerHistory({domain:'characters',limit:10});
    const ref=page.items.find(item=>item.memoryId===memory.memoryId);
    assert.ok(ref,`${mode}: actual History API lists the legacy-string memory`);
    const detail=await f.r.api.getWorldManagerHistoryDetail({memoryId:ref.memoryId,revision:ref.revision,
      sourceDigest:ref.sourceDigest,worldlineId:page.worldlineId});
    const minaId=entityId(head,'민아'),identity=JSON.stringify(['legacy',minaId,legacyString]);
    const event=detail.semanticTimeline.events.find(row=>row.field==='boundaries'&&row.itemIdentity===identity);
    observation.historyReadsLegacyString=event?.item?.legacy===true&&event.content===quote;
    assert.equal(observation.historyReadsLegacyString,true,`${mode}: History API derives a readable legacy-string item with its exact identity`);
    return observation;
  } finally { await snapshot.cleanup(); }
};

(async()=>{
  const results={};for(const mode of MODES)results[mode]=await runMode(mode);
  if(MODES.length>1){
    const project=({mode,...rest})=>rest;
    assert.deepEqual(project(results.mirror),project(results.plugin_only),'mirror matches plugin_only');
    assert.deepEqual(project(results.server_only),project(results.plugin_only),'server_only matches plugin_only');
  }
  console.log(JSON.stringify({test:'libra_main_memory_legacy_boundary_read_compat',passed:1,
    boundary:'stored legacy v5 consumer compatibility fixture; producer remains structured-only; no live external provider',results}));
})().catch(error=>{console.error(error);process.exitCode=1;});
