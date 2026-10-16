'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {JSDOM}=require('jsdom');
const {load}=require('../gradia/host.cjs');
const createBus=require('./libra_gradia_read_bus.cjs');
const createOwner=require('../../tools/libra_gradia_unified_read.cjs');
const fingerprint=v=>crypto.createHash('sha256').update(v).digest('hex');
const wait=async(fn,label='condition',ms=120000)=>{const at=Date.now();while(Date.now()-at<ms){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw Error('WAIT_TIMEOUT: '+label);};
async function fixture(t,{native=false,writingMode='novel',unified=true,bus:providedBus,chat:providedChat,character:providedCharacter}={}){
 const bus=providedBus||createBus(),controls={current:true,onQuery:null,onModel:null,onPermission:null,onCurrent:null,denied:false},unloads=[],prompts=[],sent=[],copied=[];
 const nativeHost=native?await require('./libra_memory_graph_reader_fixture.cjs').fixture({mode:'server_only',hostOverrides:bus.api('libra')}):null;
 const chat=providedChat||nativeHost?.f.chat||{id:'h',message:[{role:'user',chatId:'u1',data:'민아는 은빛 열쇠를 확인한다.'},{role:'assistant',chatId:'a1',data:'준호가 은빛 열쇠를 보관한 채 문 앞에서 기다렸다.'}]};
 const character=providedCharacter||nativeHost?.f.character||{chaId:'c',name:'민아',chats:[chat],chatPage:0,lorebook:[]};
 const scope=nativeHost?{scopeKey:nativeHost.scopeKey,characterId:character.chaId||character.id,chatId:chat.id}:{scopeKey:'s',characterId:'c',chatId:'h'};
 const url=nativeHost?.server.url||'http://127.0.0.1:47630',dataId='A'.repeat(32),values=new Map(),local=new Map();
 values.set('libra:v1:scope-registry:v1',JSON.stringify({[scope.characterId+'::'+scope.chatId]:scope}));
 values.set('__memory_suite_internal_scope_routes_v1__:libra',JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:'libra',legacyGlobalModeImported:true,entries:{[scope.scopeKey]:{scopeId:scope.scopeKey,scopeKey:scope.scopeKey,mode:'server_only',origin:'user_explicit',updatedAt:1}}}));
 const store={getItem:async k=>values.get(k)??null,setItem:async(k,v)=>{values.set(k,v);return true;},removeItem:async k=>{values.delete(k);return true;}},device={getItem:async k=>local.get(k)??values.get(k)??null,setItem:async(k,v)=>{local.set(k,v);return true;}};
 let owner,queries=0,ownerSerial=0;
 if(!native){owner=createOwner({role:'owner',api:bus.api('libra'),fingerprint,randomId:()=>String(++ownerSerial),
  boundary:async request=>({scope:request.scope,dataInstanceId:dataId,resetEpoch:0}),
  query:async(request,authority)=>{queries++;authority.bindGraph({readerFrame:{},nodes:[],edges:[],bases:[]});await controls.onQuery?.(request);
   return {modelDispatchEligible:true,queryComplete:false,deliveryOutcome:'partial',windowRead:{limit:20},nextWindow:null,
    bundle:{generation:'g1'},packet:{renderedText:controls.evidenceText||'WRITER_OWNER_EVIDENCE: 준호가 은빛 열쇠를 보관한다.',packetDigest:fingerprint(controls.evidenceText||'packet')}};},verify:async()=>{await controls.onCurrent?.();return controls.current;}});await owner.start();}
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{pretendToBeVisual:true,url:'https://offline.invalid/'});
 const transport=async(target,init={})=>{
  if(target.startsWith(url+'/')){
   if(nativeHost)return await fetch(target,init);
   if(controls.denied)return new Response(JSON.stringify({error:'forbidden'}),{status:403});
   const path=new URL(target).pathname;
   if(path==='/bootstrap')return new Response(JSON.stringify({ok:true,schema:'memory-suite.storage.bootstrap.v1',url,token:'synthetic-only',dataInstanceId:dataId,dataIdentityContract:'memory-suite.physical-data-identity.v1',resetEpochs:{},protocol:{major:1,minor:0},namespaces:['libra','hayaku','flashback'],authorization:{schema:'memory-suite.bootstrap-authorization.v1',pluginId:'serial_gradation_agents_for_rp',namespace:'libra',roles:['readonly'],readNamespaces:JSON.parse(init.headers['X-Memory-Suite-Read-Owners']||'["libra"]'),writeNamespaces:[]},capabilities:Object.fromEntries(['kv.v1','keys.v1','revision.v1','digest.v1','idempotency.v1','tombstone.v1','readback.v1','namespace-integrity.v1','data-instance-binding.v1','libra-read-session.v1','gradia-memory-read-session.v1'].map(k=>[k,true]))}));
   assert.match(path,/^\/v1\/libra\/read-session\/(capture|current)$/);const body=JSON.parse(init.body),base={scope,dataInstanceId:dataId,resetEpoch:0,evidenceRevision:'a'.repeat(64)};
   const result=path.endsWith('/capture')?{schema:'memory-suite.libra-read-session.v1',readOnly:true,complete:true,...base,items:[{id:'old',key:'old',content:'LEGACY_AUTHORIZATION_ONLY',source:{namespace:'libra'}}],dependencies:[],readIdentity:{scope,dataInstanceId:dataId,resetEpoch:0},corpusBytes:25,metadataBytes:10,rawBytes:35,maxCorpusBytes:body.maxCorpusBytes,maxRawBytes:body.maxRawBytes}:{schema:'memory-suite.libra-read-session-current.v1',current:true,...base};
   result.corpusBytes=path.endsWith('/capture')?Buffer.byteLength(result.items[0].content):undefined;
   return new Response(JSON.stringify({ok:true,dataInstanceId:dataId,result}));
  }
  const body=JSON.parse(init.body);prompts.push(body);await controls.onModel?.(prompts.length,body,init);
  const system=body.messages?.filter(m=>m.role==='system').map(m=>m.content).join('\n')||body.instructions||body.system||body.systemInstruction?.parts?.map(p=>p.text).join('\n')||body.input?.filter(m=>m.role==='system').flatMap(m=>m.content.map(p=>p.text)).join('\n')||'';
  let content;
  if(system.includes('faithful RP input translator'))content='TRANSLATED_WRITER_CHOICE 은빛 열쇠의 위치를 묻는다.';
  else if(system.includes('PLAYER-CONTROLLED RP ACTION CHOICE ADVISER'))content=JSON.stringify({schema:'gradia_author_directed_input_choices_v1',choices:['A','B','C'].map((id,i)=>({id,title:'행동 '+id,summary:'선택 '+id,input:'WRITER_CHOICE_'+id+' 은빛 열쇠에 대해 묻는다.'}))});
  else content=JSON.stringify({schema:'gradia_novel_input_choices_v1',choices:['user_focus','npc_focus','offscreen_focus'].map(perspective=>({perspective,title:perspective,summary:'현재 장면을 잇는다.',input:'WRITER_CHOICE_'+perspective+' 은빛 열쇠가 있는 문 앞에서 장면을 잇는다.'}))});
  if(controls.output!==undefined)content=controls.output;
  const result=body.contents?{candidates:[{content:{parts:[{text:content}]},finishReason:'STOP'}]}:body.generationConfig?{}
   :body.system!==undefined?{content:[{type:'text',text:content}],stop_reason:'end_turn'}
   :body.options?{message:{content},done:true,done_reason:'stop'}
   :{choices:[{message:{content},finish_reason:'stop'}]};
  return {ok:true,status:200,text:async()=>JSON.stringify(result)};
 };
 const host=await load({api:{...bus.api('serial_gradation_agents_for_rp'),pluginStorage:nativeHost?.server.backend||store,getLocalPluginStorage:async()=>nativeHost?.server.backend||device,
  getArgument:async name=>name.includes('url')?url:name==='mode'?'off':undefined,
  getCharacter:async()=>{await controls.onNativeRead?.();return character;},getChar:async()=>{await controls.onNativeRead?.();return character;},getCharacterFromIndex:async()=>{await controls.onNativeRead?.();return character;},
  getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getChatFromIndex:async()=>chat,
  getDatabase:async()=>({personas:[],selectedPersona:'',modules:[]}),nativeFetch:transport,fetch:transport,
  requestPluginPermission:async name=>{if(name==='sendChat')await controls.onPermission?.();return true;},
  showContainer:async()=>{},hideContainer:async()=>{},sendChat:async value=>{sent.push(value);return true;},
  onUnload:async fn=>{unloads.push(fn);return true;}},testGlobals:{crypto:crypto.webcrypto,Response,window:dom.window,Element:dom.window.Element,document:dom.window.document,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),MutationObserver:dom.window.MutationObserver,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),navigator:{clipboard:{writeText:async v=>{copied.push(v);}},userActivation:{isActive:true}}}});
 t.after(async()=>{await host.plugin.closeSettingsGui();for(const fn of unloads.reverse())await fn();dom.window.close();await owner?.dispose();await nativeHost?.cleanup();});
 if(unified){const status=await host.plugin.connectLibReadOnly(url);assert.equal(status.state,'connected',JSON.stringify(status));}
 await host.plugin.saveProviderPreset('writer',{provider:'openai',url:'https://api.openai.com/v1/chat/completions',key:'synthetic-only',model:'gpt-4o-mini-2024-07-18',request_format:'chat_completions',context_window:128000,max_tokens:4096,reasoning_preset:'off',reasoning_effort:'none',timeout_ms:5000,stream:false});
 await host.plugin.saveRuntimeSettings({mode:'off',default_preset:'writer',input_assist_mode:'user_focus',writing_mode:writingMode,input_assist_target_chars:500,lore_activation_mode:'off',input_assist_lore_activation_mode:'off'});
 const document=dom.window.document;
 const button=label=>[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===label);
 const start=async(input='은빛 열쇠를 찾는 다음 장면을 제안해 줘.',beforeProceed=null)=>{const pending=host.plugin.continueSceneWithInputAssist();await wait(()=>document.querySelector('textarea[placeholder]'),'composer');const editor=document.querySelector('textarea[placeholder]');editor.value=input;await beforeProceed?.();button('진행').click();return {pending};};
 return {host,bus,controls,dom,document,button,start,wait,prompts,sent,copied,chat,character,scope,values,local,nativeHost,queries:()=>native?bus.messages.filter(m=>m.body.action==='capture').length:queries,
  async choices(){await wait(()=>{const status=host.plugin.getInputAssistSendStatus();if(status?.phase==='error'||status?.phase==='cancelled')throw Error('WRITER_FAILED: '+JSON.stringify(status));return document.querySelector('[data-input-choice-card]');},'choice picker',native?120000:15000);return [...document.querySelectorAll('[data-input-choice-card]')];},
  async select(index=0){const cards=await this.choices();cards[index].querySelector('.btn--primary').click();await wait(()=>button('바로 전송'),'delivery picker');},
  async done(pending,action='바로 전송'){button(action).click();return await pending;}};
}
module.exports={fixture,wait};
