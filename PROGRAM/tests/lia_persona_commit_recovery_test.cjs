'use strict';
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');
const expose=source=>source.replace('      getScopePersonaCatalog:', `      debugAuditGenerated: (ctx,result) => upsertGeneratedPersona(ctx,result),
      getScopePersonaCatalog:`);
const make=options=>createFixture('official',{transformSource:expose,...options});
(async()=>{let passed=0;
 const f=await make();
 try {
  const ctx={char:f.character,chat:f.liveChat,charIndex:0,chatIndex:0,personaInfo:{persona:f.db.personas[0]},generationMode:'classic'};
  const generate=prompt=>f.runtime.debugAuditGenerated(ctx,{personaPrompt:prompt,generationMode:'classic'});
  const first=await generate('OLD');const write=f.api.setDatabase;
  for(const result of [false,{ok:false},{success:false}]){f.api.setDatabase=async()=>result;await assert.rejects(()=>generate('NEW'),error=>error.code==='LIA_PERSONA_WRITE_REJECTED');passed++;}
  f.api.setDatabase=async()=>undefined;await assert.rejects(()=>generate('NEW'),/LIA_PERSONA_READBACK_MISMATCH/);passed++;
  f.api.setDatabase=async patch=>{await write(patch);f.db.personas.find(p=>p.id===first.persona.id).name='CORRUPT';return true;};
  await assert.rejects(()=>generate('NEW'),/LIA_PERSONA_READBACK_MISMATCH/);passed++;
  f.api.setDatabase=write;assert.equal((await generate('VALID')).persona.personaPrompt,'VALID');passed++;
 }finally{await f.dispose();}
 console.log(JSON.stringify({test:'lia_persona_commit_recovery',passed,host:'isolated full plugin VM',externalModelCalls:0}));
})().catch(error=>{console.error(error);process.exitCode=1;});
