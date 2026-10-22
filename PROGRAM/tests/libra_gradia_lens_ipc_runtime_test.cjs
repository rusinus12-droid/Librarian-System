'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {fixture,QUOTE}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const {load}=require('./gradia/host.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
// Publication precedes the scheduled state snapshot. Wait for real owner work
// to finish; a changing producer is correctly rejected by the shipped reader.
const observeOwnerReadiness=source=>{
 const seam='    getCaptureBackendState() { return safeClone(LibraMemoryCore.getCaptureBackendState()); },';
 assert.ok(source.includes(seam));
 return source.replace(seam,`    ownerReadFixtureReady() {
      const s=LibraMemoryCore.state;
      return !s.microJobs.size && !s.receiptCaptureJobs.size && !s.storageWriteFence.size
        && !s.branchAuditInFlight.size && !s.timers.has('current_state_snapshot')
        && Number(s.snapshot?.refreshedAt||0)>=Number(s.lastMicroPublication?.at||0);
    },
`+seam);
};
const createHost=require('./fixtures/risu_plugin_channel_host.cjs');
const sources={libra:fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8'),serial_gradation_agents_for_rp:fs.readFileSync(path.join(__dirname,'../plugins/GRADIA.js'),'utf8')};
for(const mode of ['plugin_only','server_only'])test(`${mode}: actual RisuAI channel functions carry unified and noncanonical lens evidence into every GRADIA stage`,{timeout:180000},async t=>{
 const bus=createHost(sources),x=await fixture({mode,hostOverrides:bus.api('libra'),transformSource:observeOwnerReadiness});
 const unload=[],prompts=[];let onModel=null;
 t.after(async()=>{for(const fn of unload.reverse())await fn();await x.cleanup();bus.dispose();});
 const f=x.f,chat=f.chat,character=f.character;
 await waitFor(()=>f.r.api.ownerReadFixtureReady(),15000);
 const lens=await f.r.api.createLens({name:'IPC 렌즈',instruction:{goal:'도서관의 분위기 기록'},evidenceMode:'strict',recall:{enabled:true,mode:'recent',maxItems:2,share:100}});
 const quote=chat.message.find(row=>row.chatId==='t1-a').data.slice(0,60);
 f.control.onCall=async()=>({type:'success',result:JSON.stringify({items:[{label:'단서',text:'LENS_IPC_ONLY: 도서관의 정숙 규칙은 인물의 선택에 긴장을 준다.',quote,refs:['t1-a'],extra:{focus:'비정본 관점'}}]})});
 assert.equal((await f.r.api.runLensForRange(lens.lensId,{startTurn:1,endTurn:5})).acceptedCount,1);
 const registry=await f.r.api.getLensRegistry();await f.r.api.saveLensRegistry({...registry,recallSemantic:false});
 f.control.onCall=async()=>{throw Error('read must not analyze memory');};
 chat.message.push({role:'user',chatId:'t7-u',data:'민아 은빛 열쇠의 현재 보관자는?'});chat.messages=chat.message;
 await f.r.api.buildMemoryGraphCorpus({limit:2});
 const lensProbe=await f.r.api.recallLensMemories({queryText:'은빛 열쇠와 도서관의 규칙',maxChars:12000,semantic:false,refreshVectors:false,readOnly:true});
 assert.ok(lensProbe.renderedBlock.includes('LENS_IPC_ONLY'),JSON.stringify(lensProbe));
 const sdkFetch=async(url,init)=>{
  if(x.server&&url.startsWith(x.server.url+'/'))return fetch(url,init);
  const body=JSON.parse(init.body);prompts.push(body);await onModel?.(prompts.length);
  const system=body.messages?.filter(m=>m.role==='system').map(m=>m.content).join('\n')||'';
  const stage=(system.match(/(aide_\w+) patch JSON/)||[])[1];
  const content=stage?JSON.stringify({schema:'serial_gradation_agents_for_rp_draft_patch_v1',stage,ok:true,domain:{},analysis:{summary:'근거 유지',constraints:[],risks:[]},edits:[]})
   :'민아는 도서관의 은빛 열쇠를 확인하고 문 앞에서 조용히 기다렸다. The grounded scene continues without changing the remembered facts.';
  return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]})};
 };
 const localValues=new Map(),localStore={getItem:async k=>localValues.get(k)??null,setItem:async(k,v)=>{localValues.set(k,v);return true;},removeItem:async k=>{localValues.delete(k);return true;}};
 const g=await load({testGlobals:{crypto:crypto.webcrypto},api:{...bus.api('serial_gradation_agents_for_rp'),
  pluginStorage:x.server?.backend||localStore,getLocalPluginStorage:async()=>x.server?.backend||localStore,
  getArgument:async name=>name==='mode'?'off':name.includes('url')&&x.server?x.server.url:undefined,
  getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacterFromIndex:async()=>character,getCharacter:async()=>character,getChar:async()=>character,
  getChat:async()=>chat,getCurrentChat:async()=>chat,getChatFromIndex:async()=>chat,
  getDatabase:async()=>({characters:[character],personas:[],selectedPersona:'',modules:[]}),nativeFetch:sdkFetch,onUnload:async fn=>{unload.push(fn);return true;}}});
 const status=await g.plugin.connectLibReadOnly(x.server?.url||'',mode==='plugin_only'?'plugin_ipc':'unified_engine');
 assert.equal(status.state,'connected',JSON.stringify(status));
 assert.ok(status.activeOwners.includes('libra'));
 await g.plugin.saveProviderPreset('offline',{provider:'openai',url:'https://api.openai.com/v1/chat/completions',key:'synthetic-only',model:'gpt-4o-mini-2024-07-18',request_format:'chat_completions',context_window:128000,max_tokens:2048,reasoning_preset:'off',reasoning_effort:'none',timeout_ms:5000,stream:false});
 await g.plugin.saveRuntimeSettings({mode:'normal',default_preset:'offline',input_assist_mode:'off',multi_pipeline_mode:'lightweight',enable_shadow_act:true,enable_character_aide:true,enable_world_aide:true,enable_plot_aide:true,failure_mode:'hard',lore_activation_mode:'off'});
 const messages=chat.message.map(row=>({role:row.role,content:row.data,messageId:row.chatId,chatId:row.chatId}));
 const lensBytes=()=>JSON.stringify(x.server?x.server.storedRows().filter(row=>row.key.includes(':lens:')):[...f.r.values].filter(([key])=>key.includes(':lens:')));
 const before=lensBytes(),calls=f.control.calls.length;
 const output=await g.hooks.beforeRequest(messages,'model');
 assert.equal(prompts.length,4,JSON.stringify(g.plugin.getRuntime().last));
 assert.ok(prompts.every(body=>JSON.stringify(body).includes(QUOTE)),'unified Micro in each actual model request');
 assert.ok(prompts.every(body=>JSON.stringify(body).includes('LENS_IPC_ONLY')),'lens notes in each actual model request');
 assert.ok(prompts.every(body=>JSON.stringify(body).includes('정본 기억이 우선')),'noncanonical precedence travels with the lens notes');
 assert.ok(output.some(row=>row.content?.includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1')));
 assert.equal(lensBytes(),before,'reading creates no lens storage mutations');assert.equal(f.control.calls.length,calls);
 const replies=bus.messages.filter(m=>m.body.action==='capture'&&m.body.result?.items?.some(item=>item.content.includes('LENS_IPC_ONLY'))||m.body.result?.engine?.lensEvidence?.itemCount);
 assert.ok(replies.length,'real host-routed reply contains lens bytes');
 // A registry-only change must revoke the issued lens evidence even when the graph body is unchanged.
 prompts.length=0;onModel=async()=>{await f.r.api.updateLens(lens.lensId,{recall:{enabled:false,mode:'recent',share:100,maxItems:2}});};
 await assert.rejects(()=>g.hooks.beforeRequest(messages,'model'),e=>/^LIB_READ_/.test(e.code));
 assert.equal(prompts.length,1,'changed lens evidence cannot feed AIDE or host handoff');
 assert.ok(!JSON.stringify(g.plugin.getRuntime()).includes('LENS_IPC_ONLY'),'no generic runtime evidence copy');
});
test('upstream host enforces mutual allowed-ipc and supplies the actual sender',async()=>{
 const host=createHost(sources),a=host.api('libra'),b=host.api('serial_gradation_agents_for_rp');let received;
 b.addPluginChannelListener('test',(value,metadata)=>{received={value,metadata};});
 a.postPluginChannelMessage('serial_gradation_agents_for_rp','test',{sender:'forged',content:'wire'});
 assert.equal(received.metadata.sender,'libra');assert.equal(received.value.content,'wire');
 host.plugins.find(p=>p.name==='libra').allowedIPC=[];received=null;
 a.postPluginChannelMessage('serial_gradation_agents_for_rp','test',{content:'denied'});
 assert.equal(received,null);assert.equal(host.warnings.length,1);host.dispose();
});
