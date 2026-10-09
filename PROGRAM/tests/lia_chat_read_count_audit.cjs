'use strict';
const assert = require('node:assert/strict');
const {createFixture} = require('./fixtures/lia_native_runtime_fixture.cjs');
(async()=>{
 Error.stackTraceLimit=30; const rows=[];
 for(const scenario of ['attachment_off','empty_catalog','nonempty_catalog']){
  const calls={},stacks={};let counting=false;
  const f=await createFixture('official',{
   configureApi(api,{values}){
    values.set('liaPersonaIllustrationConfigV1',JSON.stringify({runtimeAttachEnabled:scenario!=='attachment_off'}));
    if(scenario==='nonempty_catalog')values.set('liaPersonaVisualAssetStoreV1',JSON.stringify({version:1,sets:{fixture:{personaKey:'fixture',personaId:'source-persona',personaName:'Source Persona',images:{}}}}));
    for(const name of ['getDatabase','getCurrentCharacterIndex','getCurrentChatIndex','getCharacter','getCharacterFromIndex','getChatFromIndex']){
     const old=api[name];api[name]=async(...args)=>{if(counting){calls[name]=(calls[name]||0)+1;(stacks[name]||=[]).push(new Error().stack.split('\n').slice(2,15).map(s=>s.trim()));}return old?.(...args);};
    }
   },
   transformSource(source){const i=source.lastIndexOf('\n})();');return source.slice(0,i)+'\nglobalThis.__audit={handlePersonaEmotionAssetAfterRequest,getContext,getActiveModulesForPicker};'+source.slice(i);}
  });
  try{
   const record=async(label,fn)=>{Object.keys(calls).forEach(k=>delete calls[k]);Object.keys(stacks).forEach(k=>delete stacks[k]);counting=true;await fn();counting=false;rows.push({scenario,label,calls:{...calls},stacks:JSON.parse(JSON.stringify(stacks))});};
   await f.context.__audit.handlePersonaEmotionAssetAfterRequest('warm config','model');
   await record('one eligible afterRequest',()=>f.context.__audit.handlePersonaEmotionAssetAfterRequest('one response','model'));
   if(scenario==='nonempty_catalog'){
    assert.deepEqual(calls,{getCurrentCharacterIndex:1,getCurrentChatIndex:1,getDatabase:1,getChatFromIndex:1});
    await record('getContext with managed binding',()=>f.context.__audit.getContext({moduleLore:false,selectedModuleIds:[]}));
    await record('module picker context, standalone path',()=>f.context.__audit.getActiveModulesForPicker());
   }else assert.deepEqual(calls,{});
  }finally{await f.dispose();}
 }
 console.log(JSON.stringify({sourceVersion:'0.26.83',kind:'offline fake-host call counts, not latency',rows},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
