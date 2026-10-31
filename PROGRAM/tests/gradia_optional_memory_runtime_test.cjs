'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
// Real GRADIA and upstream RisuAI channel functions; controlled owner/provider responses.
const root=path.join(__dirname,'..');
const {load}=require(path.join(root,'tests/gradia/host.cjs'));
const createHost=require(path.join(root,'tests/fixtures/risu_plugin_channel_host.cjs'));
const createOwner=require(path.join(root,'tools/gradia_plugin_read.cjs'));
const {JSDOM}=require('../tools/gradia/load-dev-dependency.cjs')('jsdom');
const ids={libra:'libra',hayaku:'hayaku_locator_continuity',flashback:'flashback_memory'};
const files={libra:'LIBRA.js',hayaku:'HAYAKU_Locator_Continuity.js',flashback:'Flashback_Memory.js'};
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const schemaValue=s=>s.const!==undefined?s.const:s.type==='object'?Object.fromEntries((s.required||[]).map(k=>[k,schemaValue(s.properties[k])])):s.type==='array'?Array.from({length:Math.max(s.minItems||0,24)},(_,i)=>{const v=schemaValue(s.items);return typeof v==='string'?v+' '+i:v;}):s.type==='boolean'?true:s.type==='number'||s.type==='integer'?1:'Preserve the current library scene.';
const wait=async(fn,label)=>{const start=Date.now();while(Date.now()-start<15000){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw Error('WAIT_TIMEOUT '+label);};
async function setup(t,present=[],saved,{serverOwners=[],staleLibraRegistry=false}={}){
 const sources={serial_gradation_agents_for_rp:fs.readFileSync(path.join(root,'plugins/GRADIA.js'),'utf8')};
 for(const o of present)sources[ids[o]]=fs.readFileSync(path.join(root,'plugins',files[o]),'utf8');
 const bus=createHost(sources),unloads=[],values=new Map(),local=new Map(),prompts=[],sent=[],copied=[],owners={},state={responseText:null,onModel:null,current:true,captures:0};
 const chat={id:'chat',message:[{role:'user',chatId:'u1',data:'민아가 도서관의 열쇠를 물었다.'},{role:'assistant',chatId:'a1',data:'민아는 도서관 문 앞에서 준호가 보관한 은빛 열쇠를 확인했다.'}]};
 const character={id:'char',chaId:'char',name:'민아',description:'NATIVE_CHARACTER_MARKER: 조용한 도서관 사서.',chats:[chat],chatPage:0,lorebook:[]};
 const store={getItem:async k=>values.get(k)??null,setItem:async(k,v)=>values.set(k,v),removeItem:async k=>values.delete(k)};
 const device={getItem:async k=>local.get(k)??null,setItem:async(k,v)=>local.set(k,v)};
 if(saved)local.set('serial_gradation_agents_for_rp:lib_read_connection:v1',JSON.stringify(saved));
 for(const o of present){owners[o]=createOwner({role:'owner',owner:o,api:bus.api(ids[o]),primitives:{fingerprint:sha,byteLength:v=>Buffer.byteLength(v)},
  boundary:async()=>({scope:{scopeKey:o+'-scope',characterId:'char',chatId:'chat'},mode:'plugin_only'}),
  capture:async()=>{state.captures++;return {items:[{id:o+'-record',key:o+'-key',content:o.toUpperCase()+'_OPTIONAL_MEMORY',source:{namespace:o}}],assertCurrent:async()=>state.current,close(){}};}});await owners[o].start();}
 for(const owner of [...serverOwners,...(staleLibraRegistry?['libra']:[])]){
  const scope={scopeKey:owner+'-scope',characterId:'char',chatId:'chat'};
  values.set('__memory_suite_internal_scope_routes_v1__:'+owner,JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:owner,legacyGlobalModeImported:true,entries:{[scope.scopeKey]:{...scope,scopeId:scope.scopeKey,mode:'server_only',origin:'user_explicit',updatedAt:1}}}));
  if(owner==='libra')values.set('libra:v1:scope-registry:v1',JSON.stringify({'char::chat':scope}));
 }
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{pretendToBeVisual:true,url:'https://offline.invalid/'});
 const nativeFetch=async(url,init)=>{
  if(url.startsWith('http://127.0.0.1:47630/')){
   const pathname=new URL(url).pathname,id='A'.repeat(32),names=['libra','hayaku','flashback'];
   if(pathname==='/bootstrap')return new Response(JSON.stringify({ok:true,schema:'memory-suite.storage.bootstrap.v1',url:'http://127.0.0.1:47630',token:'synthetic-only',dataInstanceId:id,dataIdentityContract:'memory-suite.physical-data-identity.v1',resetEpochs:{},protocol:{major:1,minor:0},namespaces:names,authorization:{schema:'memory-suite.bootstrap-authorization.v1',pluginId:'serial_gradation_agents_for_rp',namespace:'libra',roles:['readonly'],readNamespaces:JSON.parse(init.headers['X-Memory-Suite-Read-Owners']),writeNamespaces:[]},capabilities:Object.fromEntries(['kv.v1','keys.v1','revision.v1','digest.v1','idempotency.v1','tombstone.v1','readback.v1','namespace-integrity.v1','data-instance-binding.v1','libra-read-session.v1','gradia-memory-read-session.v1'].map(k=>[k,true]))}));
   const match=/^\/v1\/(libra|hayaku|flashback)\/read-session\/(capture|current)$/.exec(pathname);assert.ok(match,pathname);
   const [,owner,action]=match;assert.ok(serverOwners.includes(owner));const body=JSON.parse(init.body),scope={scopeKey:owner+'-scope',characterId:'char',chatId:'chat'},content=owner.toUpperCase()+'_OPTIONAL_MEMORY';
   const base={scope,dataInstanceId:id,resetEpoch:0,evidenceRevision:sha(owner),readIdentity:{scope,dataInstanceId:id,resetEpoch:0}};
   const result=action==='capture'?{schema:'memory-suite.'+owner+'-read-session.v1',...base,readOnly:true,complete:true,items:[{id:owner+'-record',key:owner+'-key',content,source:{namespace:owner,scopeKey:scope.scopeKey}}],dependencies:[],corpusBytes:Buffer.byteLength(content),metadataBytes:100,rawBytes:1000,maxCorpusBytes:body.maxCorpusBytes,maxRawBytes:body.maxRawBytes}:{schema:'memory-suite.'+owner+'-read-session-current.v1',...base,current:state.current};
   return new Response(JSON.stringify({ok:true,dataInstanceId:id,result}));
  }
  assert.equal(url,'https://api.openai.com/v1/chat/completions','no memory server/network request without connection');
  const body=JSON.parse(init.body);prompts.push(body);await state.onModel?.(prompts.length);
  const system=body.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');let content;
  if(body.response_format?.json_schema?.schema?.properties?.schema?.const==='serial_gradation_agents_for_rp_analysis_v4')content=JSON.stringify(schemaValue(body.response_format.json_schema.schema));
  else if(system.includes('faithful RP input translator'))content='열쇠의 위치를 묻는다.';
  else if(system.includes('PLAYER-CONTROLLED RP ACTION CHOICE ADVISER'))content=JSON.stringify({schema:'gradia_author_directed_input_choices_v1',choices:['A','B','C'].map(id=>({id,title:'행동 '+id,summary:'현재 장면',input:'문 앞에서 열쇠에 관해 묻는다. '+id}))});
  else if(system.includes('gradia_novel_input_choices_v1'))content=JSON.stringify({schema:'gradia_novel_input_choices_v1',choices:['user_focus','npc_focus','offscreen_focus'].map(perspective=>({perspective,title:perspective,summary:'현재 장면',input:'문 앞의 대화를 이어간다. '+perspective}))});
  else if(system.includes('patch JSON')||system.includes('serial RP draft analysis-and-patch agent'))content=JSON.stringify({schema:'serial_gradation_agents_for_rp_draft_patch_v1',stage:(system.match(/Return the compact (aide_\w+) patch JSON/)||[])[1],ok:true,domain:{},analysis:{summary:'Keep current scene',constraints:[],risks:[]},edits:[]});
  else if(system.includes('Run shadow_act analysis now')||system.includes('Run aide_'))content=JSON.stringify({schema:'serial_gradation_agents_for_rp_analysis_v4',stage:(system.match(/Run (\w+) analysis now/)||[])[1],ok:true,analysis:{summary:'Keep current scene',constraints:[],risks:[]},domain:{continuity:'민아는 도서관 문 앞에 있다.'},rewrite_directives:['Keep current scene.']});
  else content='STANDALONE_DRAFT: 민아는 도서관 문 앞에서 은빛 열쇠를 바라봤다. The warm lamplight spread across the shelves while she waited quietly for an answer.';
  if(state.responseText!==null)content=state.responseText;
  return new Response(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]}));};
 const readerApi=bus.api('serial_gradation_agents_for_rp');
 const host=await load({api:{...readerApi,postPluginChannelMessage:async(...args)=>{await state.onSend?.(...args);return readerApi.postPluginChannelMessage(...args);},pluginStorage:store,getLocalPluginStorage:async()=>device,
  getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacter:async()=>character,getChar:async()=>character,getCharacterFromIndex:async()=>character,
  getChatFromIndex:async()=>chat,getChat:async()=>chat,getCurrentChat:async()=>chat,getDatabase:async()=>({characters:[character],personas:[],selectedPersona:'',modules:[]}),
  nativeFetch,fetch:nativeFetch,showContainer:async()=>{},hideContainer:async()=>{},sendChat:async v=>{sent.push(v);return true;},onUnload:async fn=>unloads.push(fn)},
  testGlobals:{crypto:crypto.webcrypto,Response,window:dom.window,Element:dom.window.Element,document:dom.window.document,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),MutationObserver:dom.window.MutationObserver,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),navigator:{clipboard:{writeText:async v=>copied.push(v)},userActivation:{isActive:true}}}});
 t.after(async()=>{await host.plugin.closeSettingsGui();for(const fn of unloads.reverse())await fn();for(const o of Object.values(owners))await o.dispose();dom.window.close();bus.dispose();});
 await host.plugin.saveProviderPreset('audit',{provider:'openai',url:'https://api.openai.com/v1/chat/completions',key:'synthetic-only',model:'gpt-4o-mini-2024-07-18',request_format:'chat_completions',context_window:128000,max_tokens:4096,reasoning_preset:'off',reasoning_effort:'none',timeout_ms:5000,stream:false});
 const configure=(mode='normal',multi='lightweight')=>host.plugin.saveRuntimeSettings({mode,default_preset:'audit',input_assist_mode:'off',multi_pipeline_mode:multi,enable_shadow_act:true,enable_character_aide:true,enable_world_aide:true,enable_plot_aide:true,failure_mode:'hard',lore_activation_mode:'off'});
 const run=async()=>{chat.message.push({role:'user',data:'도서관 문 앞에서 다음 상황을 이어가라. '+(prompts.length+1),chatId:'current-'+prompts.length});chat.messages=chat.message;const messages=chat.message.map(m=>({role:m.role,content:m.data,messageId:m.chatId,chatId:m.chatId}));return host.hooks.beforeRequest(messages,'model');};
 const writer=async(mode='novel')=>{await host.plugin.saveRuntimeSettings({mode:'off',default_preset:'audit',input_assist_mode:'user_focus',writing_mode:mode,input_assist_target_chars:500,lore_activation_mode:'off',input_assist_lore_activation_mode:'off'});
  const doc=dom.window.document,button=label=>[...doc.querySelectorAll('button')].find(b=>b.textContent.trim()===label);
  const pending=host.plugin.continueSceneWithInputAssist();await wait(()=>doc.querySelector('textarea[placeholder^="비워 두면 직전 상황 이어가기"]'),'composer');doc.querySelector('textarea').value='문 앞에서 열쇠를 확인하는 다음 입력';button('진행').click();
  await wait(()=>{const s=host.plugin.getInputAssistSendStatus();if(s?.phase==='error')throw Error(JSON.stringify(s));return doc.querySelector('[data-input-choice-card]');},'choices');doc.querySelector('[data-input-choice-card] .btn--primary').click();await wait(()=>button('바로 전송'),'delivery');button('복사 후 직접 전송').click();return pending;};
 return {host,bus,owners,state,prompts,configure,run,writer,copied};
}
for(const [mode,multi,expected]of [['normal','lightweight',4],['normal','heavyweight',8],['lite','lightweight',2],['off','lightweight',0]])test(`no owners: ${mode}/${multi} preserves native pipeline (${expected} calls)`,async t=>{
 const f=await setup(t);await f.configure(mode,multi);const out=await f.run();assert.equal(f.prompts.length,expected);assert.ok(!JSON.stringify(out).includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1'));assert.ok(!f.bus.messages.some(m=>m.body.action==='capture'||m.body.action==='describe'));
 if(expected){assert.ok(JSON.stringify(out).includes('STANDALONE_DRAFT'));assert.ok(f.prompts.every(p=>JSON.stringify(p).includes('도서관 문 앞')));}
 const before=f.prompts.length;assert.equal(await f.host.hooks.afterRequest('민아는 다음 대답을 기다렸다.','model'),'민아는 다음 대답을 기다렸다.');assert.equal(f.prompts.length,before);
});
for(const mode of ['novel','rp'])test(`no owners: ${mode} Input Writer copies a choice without memory reads`,async t=>{const f=await setup(t);assert.equal(await f.writer(mode),true);assert.equal(f.copied.length,1);assert.ok(f.prompts.length>=1);assert.ok(!f.bus.messages.length);assert.equal(f.host.plugin.getLibReadOnlyStatus().connection.state,'disconnected');});
test('no owners: failed IPC/server connection still permits native pipeline and Input Writer',async t=>{
 const f=await setup(t);let s=await f.host.plugin.connectLibReadOnly('','plugin_ipc');assert.equal(s.state,'error');assert.equal(s.reason,'LIB_READ_PLUGIN_OWNERS_UNAVAILABLE');await f.configure();await f.run();assert.equal(f.prompts.length,4);assert.equal(await f.writer(),true);
 s=await f.host.plugin.connectLibReadOnly('','unified_engine');assert.equal(s.state,'error');assert.equal(s.reason,'LIB_READ_SCOPE_REGISTRY_UNAVAILABLE');assert.equal(f.state.captures,0);t.diagnostic(JSON.stringify({ipc:'LIB_READ_PLUGIN_OWNERS_UNAVAILABLE',server:s.reason}));
});

test('a request waits for the ongoing explicit connection and consumes its evidence',async t=>{
 const f=await setup(t,['libra']);await f.configure();
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 f.state.onSend=async(_target,_channel,message)=>{if(message.action==='describe'){entered();await gate;}};
 const connecting=f.host.plugin.connectLibReadOnly('','plugin_ipc');await started;
 const running=f.run();
 try{await new Promise(r=>setTimeout(r,150));assert.equal(f.prompts.length,0,'no native-only draft while the explicit connection is still in flight');}
 finally{release();}
 assert.equal((await connecting).state,'connected');const out=await running;
 assert.equal(f.prompts.length,4);assert.ok(f.prompts.every(p=>JSON.stringify(p).includes('LIBRA_OPTIONAL_MEMORY')));
 assert.ok(JSON.stringify(out).includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1'));
});

test('failed connection keeps its specific refusal and owner diagnostics in the run',async t=>{
 const f=await setup(t);const status=await f.host.plugin.connectLibReadOnly('','plugin_ipc');
 assert.equal(status.reason,'LIB_READ_PLUGIN_OWNERS_UNAVAILABLE');
 assert.equal(status.unavailable.libra,'LIB_READ_TIMEOUT');
 await f.configure();await f.run();const runtime=f.host.plugin.getRuntime();
 assert.equal(runtime.finalDraftMeta.libReadReason,status.reason);
 assert.equal(runtime.lastLibReadDiagnostic.connection.state,'error');
 assert.equal(runtime.lastLibReadDiagnostic.connection.readSource,'plugin_ipc');
 assert.equal(runtime.lastLibReadDiagnostic.connection.unavailable.libra,'LIB_READ_TIMEOUT');
 assert.equal(f.state.captures,0);
});

test('unreadable saved connection is reported instead of appearing as a fresh install',async t=>{
 const unloads=[];const h=await load({api:{getLocalPluginStorage:async()=>{throw Error('device storage unavailable');},onUnload:async fn=>unloads.push(fn)}});
 t.after(async()=>{for(const fn of unloads.reverse())await fn();});
 assert.equal(h.plugin.getLibReadOnlyStatus().connection.reason,'LIB_READ_PREFERENCE_UNAVAILABLE');
 assert.equal(h.plugin.getLibReadOnlyStatus().connection.state,'error');
 assert.equal(h.getCalls(),0);
});
for(const present of [['libra'],['hayaku'],['flashback'],['libra','hayaku'],['libra','flashback'],['hayaku','flashback']])test('plugin IPC subset: '+present.join('+'),async t=>{
 const f=await setup(t,present),s=await f.host.plugin.connectLibReadOnly('','plugin_ipc');assert.equal(s.state,'connected',JSON.stringify(s));assert.deepEqual(Array.from(s.activeOwners),present);await f.configure();const out=await f.run();assert.equal(f.prompts.length,4);assert.ok(JSON.stringify(out).includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1'));for(const o of present)assert.ok(f.prompts.every(p=>JSON.stringify(p).includes(o.toUpperCase()+'_OPTIONAL_MEMORY')));assert.equal(f.state.captures,present.length);assert.equal(await f.writer(),true);
});
test('owner loss before read allows both the native pipeline and a fresh native writer',async t=>{
 const f=await setup(t,['hayaku']);assert.equal((await f.host.plugin.connectLibReadOnly('','plugin_ipc')).state,'connected');await f.owners.hayaku.dispose();await f.configure();let at=Date.now();await f.run();assert.equal(f.prompts.length,4);assert.ok(!f.prompts.some(p=>JSON.stringify(p).includes('HAYAKU_OPTIONAL_MEMORY')));assert.ok(Date.now()-at<5000,'missing owner does not consume the capture timeout');t.diagnostic('pipeline fallback ms: '+(Date.now()-at));
 const before=f.prompts.length;at=Date.now();assert.equal(await f.writer(),true);assert.equal(f.prompts.length,before+1);assert.ok(Date.now()-at<5000,'availability probe replaces the long capture wait');t.diagnostic('writer fallback ms: '+(Date.now()-at));
});
test('owner loss after memory consumption rejects the influenced draft without extra model calls',async t=>{
 const f=await setup(t,['flashback']);assert.equal((await f.host.plugin.connectLibReadOnly('','plugin_ipc')).state,'connected');await f.configure();f.state.onModel=async()=>{f.state.current=false;};await assert.rejects(()=>f.run(),/LIB_READ_/);assert.equal(f.prompts.length,1);
});

for(const readSource of ['plugin_ipc','unified_engine'])test('saved consent with no owners: '+readSource,async t=>{
 const f=await setup(t,[],{schema:'gradia.lib-read-connection.v2',url:'http://127.0.0.1:47630',explicit:true,readOwners:['libra','hayaku','flashback'],readSource});
 await wait(()=>f.host.plugin.getLibReadOnlyStatus().connection.state==='error','saved connection rejected');assert.equal(f.prompts.length,0);
 await f.configure();await f.run();assert.equal(f.prompts.length,4);assert.equal(await f.writer(),true);assert.ok(!f.bus.messages.some(m=>m.body.action==='capture'));
});

for(const serverOwners of [['hayaku'],['flashback'],['hayaku','flashback']])test('server-only peers feed both GRADIA pipeline and writer without LIBRA: '+serverOwners.join('+'),async t=>{
 const f=await setup(t,[],undefined,{serverOwners}),status=await f.host.plugin.connectLibReadOnly('','unified_engine');assert.equal(status.state,'connected',JSON.stringify(status));assert.deepEqual(Array.from(status.activeOwners),serverOwners);
 await f.configure();const output=await f.run();assert.equal(f.prompts.length,4);assert.ok(JSON.stringify(output).includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1'));
 assert.equal(await f.writer(),true);for(const owner of serverOwners)assert.ok(f.prompts.every(body=>JSON.stringify(body).includes(owner.toUpperCase()+'_OPTIONAL_MEMORY')));
 assert.equal(f.copied.length,1);assert.ok(!f.bus.messages.some(message=>message.body.action==='capture'));
});
test('stale LIBRA registration does not prevent server peers from connecting',async t=>{
 const f=await setup(t,[],undefined,{serverOwners:['hayaku','flashback'],staleLibraRegistry:true}),started=Date.now();
 const status=await f.host.plugin.connectLibReadOnly('','unified_engine');assert.equal(status.state,'connected',JSON.stringify(status));assert.deepEqual(Array.from(status.activeOwners),['hayaku','flashback']);assert.equal(status.unavailable.libra,'LIB_READ_TIMEOUT');assert.ok(Date.now()-started<5000);
 await f.configure();await f.run();assert.equal(f.prompts.length,4);assert.equal(await f.writer(),true);
});
