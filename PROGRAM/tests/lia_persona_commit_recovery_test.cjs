'use strict';
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');
const expose=source=>source.replace('      getLiveSyncCaptureState:', `      debugAuditConfigure: async choice => configureLivePersonaSync(await getLiveRuntimeContext(), choice),
      debugAuditCheck: () => runManualLivePersonaAnalysis(),
      debugAuditUnauthorized: () => checkLivePersonaSync({force:true}),
      debugAuditResume: async () => {const ctx=await getLiveRuntimeContext();return resumeLivePersonaBindingChange(ctx,await readLivePersonaBindingByScopeKey(livePersonaScopeKey(ctx),true));},
      debugAuditGenerated: (ctx,result) => upsertGeneratedPersona(ctx,result),
      getLiveSyncCaptureState:`);
const make=options=>createFixture('official',{transformSource:expose,...options});
const read=f=>{const index=JSON.parse(f.values.get('liaPersonaLinkerLivePersonaIndexV2'));return JSON.parse(f.values.get(index.entries[f.scopeKey].storageKey));};
const snapshot=f=>structuredClone({values:[...f.values],personas:f.db.personas,selectedPersona:f.db.selectedPersona,chat:f.liveChat});
(async()=>{let passed=0;
 const f=await make();let saved;
 try {
  const ctx={char:f.character,chat:f.liveChat,charIndex:0,chatIndex:0,personaInfo:{persona:f.db.personas[0]},generationMode:'classic'};
  const generate=prompt=>f.runtime.debugAuditGenerated(ctx,{personaPrompt:prompt,generationMode:'classic'});
  const first=await generate('OLD');const write=f.api.setDatabase;
  for(const result of [false,{ok:false},{success:false}]){f.api.setDatabase=async()=>result;await assert.rejects(()=>generate('NEW'),error=>error.code==='LIA_PERSONA_WRITE_REJECTED');passed++;}
  f.api.setDatabase=async()=>undefined;await assert.rejects(()=>generate('NEW'),/LIA_PERSONA_READBACK_MISMATCH/);passed++;
  f.api.setDatabase=async patch=>{await write(patch);f.db.personas.find(p=>p.id===first.persona.id).name='CORRUPT';return true;};
  await assert.rejects(()=>generate('NEW'),/LIA_PERSONA_READBACK_MISMATCH/);passed++;
  f.api.setDatabase=write;assert.equal((await generate('VALID')).persona.personaPrompt,'VALID');passed++;
  f.db.personas.find(p=>p.id==='lia-live-persona::fixture').customMetadata={preserved:true};
  let enter, release;const entered=new Promise(resolve=>enter=resolve),held=new Promise(resolve=>release=resolve);
  f.api.setDatabase=async patch=>{enter();await held;return write(patch);};
  const configuring=f.runtime.debugAuditConfigure('id:source-persona');await entered;
  try {
   await assert.rejects(()=>f.runtime.debugAuditConfigure('id:source-persona'),/LIA_BINDING_CHANGE_BUSY/);
   assert.equal((await f.runtime.debugAuditCheck()).reason,'binding_configuration_in_flight');
  } finally { release(); }
  await configuring;f.api.setDatabase=write;
  assert.equal(f.db.personas.find(p=>p.id==='lia-live-persona::fixture').customMetadata.preserved,true);passed++;
  f.db.personas.push({id:'second-source',name:'Second',personaPrompt:'Second base'});
  const set=f.api.pluginStorage.setItem, before=f.liveChat.bindedPersona;
  f.api.pluginStorage.setItem=async(k,v)=>String(k).startsWith('liaPersonaLinkerLivePersona')?false:set(k,v);
  await assert.rejects(()=>f.runtime.debugAuditConfigure('id:second-source'));
  assert.equal(f.liveChat.bindedPersona,before);assert.equal(read(f).livePersonaId,before);passed++;
  // The prepared journal succeeds; only the final completed binding is rejected.
  f.api.pluginStorage.setItem=async(k,v)=>{
   if(String(k).startsWith('liaPersonaLinkerLivePersonaScope')){const row=JSON.parse(v);if(row.sourcePersonaId==='second-source'&&!row.pendingBindingChange)return false;}
   return set(k,v);
  };
  await assert.rejects(()=>f.runtime.debugAuditConfigure('id:second-source'));
  assert(read(f).pendingBindingChange);assert.equal(read(f).pendingBindingChange.persona.id,f.liveChat.bindedPersona);saved=snapshot(f);passed++;
 }finally{await f.dispose();}
 const restarted=await make({snapshot:saved});
 try{assert(read(restarted).pendingBindingChange,"startup preserves the pending journal");await restarted.runtime.debugAuditResume();const b=read(restarted);assert.equal(b.pendingBindingChange,null);assert.equal(b.livePersonaId,restarted.liveChat.bindedPersona);assert.equal(b.sourcePersonaId,'second-source');assert(b.enabled);passed++;}finally{await restarted.dispose();}
 // A third-party edit after the pending host write must not be overwritten on restart.
 const changed=structuredClone(saved);changed.chat.bindedPersona='user-chosen-persona';
 const conflict=await make({snapshot:changed});
 try{assert(read(conflict).pendingBindingChange);assert.equal((await conflict.runtime.debugAuditCheck()).reason,"binding_change_pending");await assert.rejects(()=>conflict.runtime.debugAuditResume(),/LIA_BINDING_CHANGE_CONFLICT/);assert.equal(conflict.liveChat.bindedPersona,'user-chosen-persona');passed++;}finally{await conflict.dispose();}
 const g=await make();let unchanged;
 try{
  g.db.personas.push({id:'new-native',name:'New Native',personaPrompt:'New native'});g.db.selectedPersona=2;
  const bound=g.liveChat.bindedPersona,before=JSON.stringify(read(g));
  assert.equal((await g.runtime.debugAuditUnauthorized()).reason,'manual_only');
  assert.equal(g.liveChat.bindedPersona,bound);assert.equal(JSON.stringify(read(g)),before);
  unchanged=snapshot(g);passed++;
 }finally{await g.dispose();}
 const recovered=await make({snapshot:unchanged});
 try{assert.equal(recovered.liveChat.bindedPersona,'lia-live-persona::fixture');assert.equal(read(recovered).pendingBindingChange ?? null,null);assert.equal(read(recovered).enabled,true);assert.equal(recovered.db.personas[recovered.db.selectedPersona].id,'new-native');passed++;}finally{await recovered.dispose();}
 console.log(JSON.stringify({test:'lia_persona_commit_recovery',passed,host:'isolated full plugin VM',externalModelCalls:0}));
})().catch(error=>{console.error(error);process.exitCode=1;});
