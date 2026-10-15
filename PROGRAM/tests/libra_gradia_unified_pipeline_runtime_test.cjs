'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture,QUOTE}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const {load}=require('./gradia/host.cjs');
const createBus=require('./fixtures/libra_gradia_read_bus.cjs');
test('native LIBRA kernel -> authenticated owner receipt -> real GRADIA SHADOW/AIDE handoff',async t=>{
 const bus=createBus();const x=await fixture({mode:'server_only',hostOverrides:bus.api('libra')});
 const unload=[],prompts=[];let onModel=null;
 t.after(async()=>{for(const fn of unload.reverse())await fn();await x.cleanup();});
 const f=x.f,chat=f.chat,character=f.character;
 chat.message.push({role:'user',chatId:'t7-u',data:'민아 은빛 열쇠의 현재 보관자는?'});chat.messages=chat.message;
 await f.r.api.buildMemoryGraphCorpus({limit:2});
 const sdkFetch=async(url,init)=>{
   if(url.startsWith(x.server.url+'/'))return await fetch(url,init);
   const body=JSON.parse(init.body);prompts.push(body);await onModel?.(prompts.length);
   const system=body.messages?.filter(m=>m.role==='system').map(m=>m.content).join('\n')||'';
   const stage=(system.match(/(aide_\w+) patch JSON/)||[])[1];
   const content=stage?JSON.stringify({schema:'serial_gradation_agents_for_rp_draft_patch_v1',stage,ok:true,domain:{},analysis:{summary:'Keep the grounded draft',constraints:[],risks:[]},edits:[]})
     :'민아는 은빛 열쇠를 확인하고 문 앞에서 기다렸다. The grounded scene continued in the quiet room.';
   return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]})};
 };
 const g=await load({testGlobals:{crypto:crypto.webcrypto},api:{...bus.api('serial_gradation_agents_for_rp'),
   pluginStorage:x.server.backend,getLocalPluginStorage:async()=>x.server.backend,
   getArgument:async name=>name.includes('url')?x.server.url:name==='mode'?'off':undefined,
   getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacterFromIndex:async()=>character,getCharacter:async()=>character,getChar:async()=>character,
   getChat:async()=>chat,getCurrentChat:async()=>chat,getChatFromIndex:async()=>chat,
   getDatabase:async()=>({characters:[character],personas:[],selectedPersona:'',modules:[]}),
   nativeFetch:sdkFetch,onUnload:async fn=>{unload.push(fn);return true;}}});
 const status=await g.plugin.connectLibReadOnly(x.server.url);
 assert.equal(status.state,'connected',JSON.stringify(status));assert.equal(status.readSource,'unified_engine');
 await g.plugin.saveProviderPreset('offline',{provider:'openai',url:'https://api.openai.com/v1/chat/completions',key:'synthetic-only',model:'gpt-4o-mini-2024-07-18',request_format:'chat_completions',context_window:128000,max_tokens:2048,reasoning_preset:'off',reasoning_effort:'none',timeout_ms:5000,stream:false});
 await g.plugin.saveRuntimeSettings({mode:'normal',default_preset:'offline',input_assist_mode:'off',multi_pipeline_mode:'lightweight',
   enable_shadow_act:true,enable_character_aide:true,enable_world_aide:true,enable_plot_aide:true,failure_mode:'hard',lore_activation_mode:'off'});
 const messages=chat.message.map(row=>({role:row.role,content:row.data,messageId:row.chatId,chatId:row.chatId}));
 const before=x.server.storedRows().filter(row=>!row.key.includes(':memory-graph-control:v1:')),calls=f.control.calls.length;
 const output=await g.hooks.beforeRequest(messages,'model');
 assert.equal(prompts.length,4,JSON.stringify(g.plugin.getRuntime().last));
 assert.ok(prompts.every(body=>JSON.stringify(body).includes('owner_issued_evidence_bundle')));
 assert.ok(prompts.every(body=>JSON.stringify(body).includes(QUOTE)), 'real owner Micro evidence must reach each stage');
 assert.ok(output.some(row=>row.content?.includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1')));
 assert.equal(bus.messages.filter(row=>row.body.action==='capture').length,1);
 assert.equal(bus.messages.find(row=>row.body.result?.engine?.corpusRead)?.body.result.engine.corpusRead.mode,'durable_common_index');
 assert.equal(bus.messages.find(row=>row.body.result?.engine?.corpusRead)?.body.result.engine.corpusRead.storage.storageAccess,'selective_durable_pages');
 assert.ok(bus.messages.some(row=>row.body.action==='current'));
 assert.equal(f.control.calls.length,calls);assert.deepEqual(x.server.storedRows().filter(row=>!row.key.includes(':memory-graph-control:v1:')),before,'reading must not write owner memory');
 assert.ok(!JSON.stringify([...g.store]).includes('owner_issued_evidence_bundle'));
 // A second request gets a fresh selection, but an owner source edit during
 // SHADOW must stop the pending draft before AIDE or the host can receive it.
 prompts.length=0;onModel=async()=>{chat.message.find(row=>row.chatId==='t6-a').data+=' 원문 수정';};
 await assert.rejects(()=>g.hooks.beforeRequest(messages,'model'),e=>/^LIB_READ_/.test(e.code));
 assert.equal(prompts.length,1);assert.equal(bus.messages.filter(row=>row.body.action==='capture').length,2);
 assert.ok(!JSON.stringify(g.plugin.getRuntime()).includes('owner_issued_evidence_bundle'));
});
