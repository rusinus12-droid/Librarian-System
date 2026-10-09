'use strict';
const fs=require('node:fs');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./hayaku_runtime_harness.cjs');
const {createFixture}=require('./flashback_native_runtime_fixture.cjs');
const OLD='Alice signed the agreement.',NEW='Alice did not sign the agreement.';
function envelope(quote){const p=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:quote});p.entity.characters=[{name:'Alice'}];p.planner.continuity_locks=[quote];const grounding=[];const walk=(v,path)=>{if(Array.isArray(v)){v.forEach((x,i)=>{if(x!=null&&(typeof x!=='string'||x.trim()))grounding.push({path:`${path}[${i}]`,source:'target',evidence:[quote]})});return;}if(v&&typeof v==='object')for(const[k,x]of Object.entries(v))walk(x,path?path+'.'+k:k);};for(const a of ['entity','world','narrative','planner'])walk(p[a],a);grounding.push({path:'meta.summary_memory.summary',source:'target',evidence:[quote]});return{schema:'hayaku.native_repair_output.v1',packet:p,grounding};}
async function ownerFixture(owner,options={}){
 if(owner==='hayaku'){
  const packet=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:OLD});
  const r=await createHayakuRuntime({...options,autoRepair:false,afterRequestAutoRepair:false,pluginSourceFile:process.env.HAYAKU_TEST_PLUGIN,messages:[{role:'user',id:'u1',chatId:'u1',data:'What does Alice do?'},{role:'assistant',id:'a1',chatId:'a1',data:hiddenPacketMessage(OLD,packet)}]});
  if(process.env.HAYAKU_TEST_PLUGIN)console.log('OWNER_ARTIFACT_LOAD '+JSON.stringify({owner,path:process.env.HAYAKU_TEST_PLUGIN,sha256:r.sourceSha256}));
  await options.beforeSeed?.(r);
  await r.callBeforeRequest([{role:'user',content:'Initial recall.'}],'model');await r.callAfterRequest('','model');
  return {api:r.hayaku,chat:r.chat,store:r.host.pluginStorage,r,edit:txt=>r.chat.message[1].data=hiddenPacketMessage(txt,packet),calls:()=>r.llmCalls.length,respond:fn=>r.setLlmResponder(fn),records:async()=> (await r.hayaku.ledger.inspect({includeRecords:true})).records,dispose:r.dispose};
 }
 const source=options.source||(process.env.FLASHBACK_TEST_PLUGIN?fs.readFileSync(process.env.FLASHBACK_TEST_PLUGIN,'utf8'):undefined);
 const r=await createFixture({...options,source,chat:{message:[{role:'user',id:'u1',chatId:'u1',data:'What does Alice do?'},{role:'assistant',id:'a1',chatId:'a1',data:OLD}]}});
 // The public API is exposed before async settings/journal recovery finishes.
 // Wait for the actual startup milestone, as the current embedding fixture does.
 const readyDeadline=Date.now()+15000;
 while(!r.api.uiStatus().registered.after){
  if(Date.now()>=readyDeadline){await r.dispose();throw Error('FLASHBACK_FIXTURE_STARTUP_TIMEOUT');}
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 if(process.env.FLASHBACK_TEST_PLUGIN)console.log('OWNER_ARTIFACT_LOAD '+JSON.stringify({owner,path:process.env.FLASHBACK_TEST_PLUGIN,sha256:require('node:crypto').createHash('sha256').update(source).digest('hex')}));
 await r.api.saveSettings({...await r.api.loadSettings(),embeddingProvider:'hash',embeddingModel:'hash-v1',embeddingEnabled:true,autoEpisodeIndex:false});
 await r.api.ingestLiveChatColdStart({scope:'current',canonical:true});const scope=await r.api.resolveCurrentScope();
 let calls=0;r.host.llm=async()=>{calls++;throw Error('Flashback must not call a summary model');};
 return {api:r.api,chat:r.currentChat,store:r.pluginStorage,r,edit:txt=>r.currentChat.message[1].data=txt,calls:()=>calls,respond:()=>{},records:async()=>(await r.api.inspectMemoryLedger(scope,{includeRecords:true})).records,dispose:r.dispose};
}
module.exports={ownerFixture,envelope,OLD,NEW};
