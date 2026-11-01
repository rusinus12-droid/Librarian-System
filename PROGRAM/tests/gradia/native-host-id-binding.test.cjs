'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./host.cjs');
const scope={characterId:'native-c',chatId:'native-h'};
const messages=()=>[{role:'user',content:'Open the cabinet.'},{role:'assistant',content:'The blue ledger rests on the upper shelf.'},{role:'user',content:'Where is the blue ledger?'}];
async function fixture(mutate,apiOverrides={},testGlobals={}){
  const chat={id:scope.chatId,message:messages().map((row,i)=>({role:row.role,chatId:'native-'+i,data:row.content}))};
  const character={chaId:scope.characterId,chats:[chat]};let selected=0;
  const host=await load({captureInternals:true,testGlobals,api:{getCurrentCharacterIndex:async()=>selected,getCurrentChatIndex:async()=>0,getCharacterFromIndex:async()=>character,getChatFromIndex:async()=>chat,...apiOverrides},
    transformSource:source=>source.replace(
      'clearStructuredSettings, fullDraftStagePrompt, Runtime };',
      'clearStructuredSettings, fullDraftStagePrompt, Runtime, captureLibNativeReadSetFromHost, buildRecentChat, resolveSgaCurrentTurn, loadActualChatContextForRag, applyActualChatContextToRecent, attachInputAssistContinuityState, libNativePromptView, scopedSettingsForStage };'
    )});
  const api=host.internals,settings={...api.Runtime.settings},input=messages();
  mutate?.(chat,character,input);
  return {chat,character,input,settings,api,runtime:api.Runtime,changeScope:()=>selected=1,bind:()=>api.captureLibNativeReadSetFromHost(input,settings,api.buildRecentChat(input,settings),scope)};
}
test('missing provider IDs bind to exact unique host messages without changing stage text',async()=>{
  const f=await fixture(),original=JSON.stringify(f.input),b=await f.bind();
  assert.equal(b.snapshot.currentInputRef.messageId,'native-2');
  assert.ok(b.snapshot.turns.some(row=>row.ref.messageId==='native-1'));
  assert.equal(JSON.stringify(f.input),original);
  await b.assertCurrent();
  f.chat.message[1].data='The ledger has moved to the lower shelf.';
  await assert.rejects(()=>b.assertCurrent(),error=>error.code==='LIB_READ_NATIVE_CHANGED');
});

test('Current Input wrapper binds to the exact live user while preserving the prompt',async()=>{
  const f=await fixture((_chat,_character,input)=>{
    input[2]={role:'user',content:'<Current Input>\nWhere is the blue ledger?\n</Current Input>'};
  });
  const original=JSON.stringify(f.input),b=await f.bind();
  assert.equal(b.snapshot.currentInputRef.messageId,'native-2');
  assert.equal(b.snapshot.currentInput,'Where is the blue ledger?');
  assert.ok(b.snapshot.turns.some(row=>row.ref.messageId==='native-0'));
  assert.ok(b.snapshot.turns.some(row=>row.ref.messageId==='native-1'));
  assert.equal(JSON.stringify(f.input),original);
  await b.assertCurrent();
  f.chat.message[2].data='A different current input.';
  await assert.rejects(()=>b.assertCurrent(),error=>error.code==='LIB_READ_NATIVE_CHANGED');
});

test('fenced Current Input transport keeps the live raw identity',async()=>{
  const f=await fixture((_chat,_character,input)=>{
    input[2]={role:'user',content:'<Current Input>\n```\nWhere is the blue ledger?\n```\n</Current Input>'};
  });
  const b=await f.bind();
  assert.equal(b.snapshot.currentInputRef.messageId,'native-2');
  assert.equal(b.snapshot.currentInput,'Where is the blue ledger?');
  assert.ok(b.snapshot.turns.some(row=>row.ref.messageId==='native-1'));
  await b.assertCurrent();
});

// Short inputs ("계속", "…") recur across a chat. An earlier, answered turn with
// the same text must not make the current wrapped input unbindable.
test('wrapped input binds the latest live user when an answered turn repeats its text',async()=>{
  const f=await fixture((chat,_character,input)=>{
    chat.message[0].data='계속';
    chat.message[2].data='계속';
    input[0]={role:'user',content:'계속'};
    input[2]={role:'user',content:'<Current Input>\n계속\n</Current Input>'};
  });
  const b=await f.bind();
  assert.equal(b.snapshot.currentInputRef.messageId,'native-2');
  assert.equal(b.snapshot.currentInput,'계속');
  assert.ok(b.snapshot.turns.some(row=>row.ref.messageId==='native-0'&&row.content==='계속'));
  assert.ok(b.snapshot.turns.some(row=>row.ref.messageId==='native-1'));
  await b.assertCurrent();
});

// Host input scripts can reformat the prompt copy (line breaks, a decorating
// prefix) of the latest pending message; the row is still the same input.
test('wrapped input binds a reformatted prompt copy that contains the whole live row',async()=>{
  const f=await fixture((_chat,_character,input)=>{
    input[2]={role:'user',content:'<Current Input>\n[장면 지시]\n**Where** is   the\nblue ledger?\n</Current Input>'};
  });
  const b=await f.bind();
  assert.equal(b.snapshot.currentInputRef.messageId,'native-2');
  assert.equal(b.snapshot.currentInput,'Where is the blue ledger?');
  assert.ok(b.snapshot.turns.some(row=>row.ref.messageId==='native-1'));
});

test('wrapped and reformatted Current Input keeps stage view identical to actual RAG chat reconstruction',async()=>{
  const f=await fixture((_chat,_character,input)=>{
    input[2]={role:'user',content:'<Current Input>\n[장면 지시]\nWhere is   the\nblue ledger?\n</Current Input>'};
  });
  const b=await f.bind();
  const shadowSelection=b.selections.find(item=>item.stage==='shadow_act');
  assert.ok(shadowSelection);
  const stageSettings=f.api.scopedSettingsForStage(f.settings,'shadow_act');
  const stageRecent=f.api.buildRecentChat(b.messages,stageSettings);
  const currentTurn=f.api.resolveSgaCurrentTurn(b.messages);
  const actualChat=await f.api.loadActualChatContextForRag(f.character,{chat:f.chat,source:'getChatFromIndex'},b.messages,currentTurn,null,false);
  const effectiveRecent=f.api.attachInputAssistContinuityState(
    f.api.applyActualChatContextToRecent(stageRecent,actualChat,stageSettings.turnWindow),
    f.settings
  );
  assert.deepEqual(f.api.libNativePromptView(effectiveRecent),shadowSelection.view);
});

test('wrapped input binds when RisuAI replaces {{user}} and {{char}} placeholders in sentence prefix and body',async()=>{
  const persona={name:'철수',personaPrompt:'신중한 조사관'};
  const f=await fixture((chat,character,input)=>{
    character.name='아키비스트';
    chat.message[0].data='{{user}}가 캐비닛을 연다.';
    chat.message[2].data='{{user}}는 문을 열고 {{char}}에게 들어간다.';
    input[0]={role:'user',content:'철수가 캐비닛을 연다.'};
    input[2]={role:'user',content:'<Current Input>\n철수는 문을 열고 아키비스트에게 들어간다.\n</Current Input>'};
  },{
    getDatabase:async()=>({personas:[persona],selectedPersona:0})
  });
  const b=await f.bind();
  assert.equal(b.snapshot.currentInputRef.messageId,'native-2');
  assert.equal(b.snapshot.currentInput,'{{user}}는 문을 열고 {{char}}에게 들어간다.');
  assert.ok(b.snapshot.turns.some(row=>row.ref.messageId==='native-0'&&row.content==='{{user}}가 캐비닛을 연다.'));
  assert.ok(b.snapshot.turns.some(row=>row.ref.messageId==='native-1'));
  assert.equal(f.runtime.lastNativeBindDiagnostic?.mode,'text_verified_bind');
  assert.equal(f.runtime.lastNativeBindDiagnostic?.textMatched,true);
  const shadowSelection=b.selections.find(item=>item.stage==='shadow_act');
  const stageSettings=f.api.scopedSettingsForStage(f.settings,'shadow_act');
  const stageRecent=f.api.buildRecentChat(b.messages,stageSettings);
  const currentTurn=f.api.resolveSgaCurrentTurn(b.messages);
  const actualChat=await f.api.loadActualChatContextForRag(f.character,{chat:f.chat,source:'getChatFromIndex'},b.messages,currentTurn,persona,false);
  const effectiveRecent=f.api.attachInputAssistContinuityState(
    f.api.applyActualChatContextToRecent(stageRecent,actualChat,stageSettings.turnWindow),
    f.settings
  );
  assert.deepEqual(f.api.libNativePromptView(effectiveRecent),shadowSelection.view);
});

for(const provenanceKind of ['explicit_wrapper','request_provenance','registered_input'])test(`strong provenance (${provenanceKind}) binds structurally to single pending native row on non-substring body replacement and records diagnostic`,async()=>{
  const f=await fixture((chat,_character,input)=>{
    chat.message[2].data='{{random::문을 두드린다::조용히 들어간다}} 그리고 주변을 살핀다.';
    const transformed='노크 후 방문을 밀고 들어가 방 안을 둘러본다.';
    if(provenanceKind==='explicit_wrapper'){
      input[2]={role:'user',content:`<Current Input>\n${transformed}\n</Current Input>`};
    }else if(provenanceKind==='request_provenance'){
      input[2]={role:'user',saying:'user',generationInfo:{generationId:'gen-u2'},content:transformed};
    }else{
      input[2]={role:'user',turnMeta:{registeredInput:true},content:transformed};
    }
  });
  const b=await f.bind();
  assert.equal(b.snapshot.currentInputRef.messageId,'native-2');
  assert.equal(b.snapshot.currentInput,'{{random::문을 두드린다::조용히 들어간다}} 그리고 주변을 살핀다.');
  assert.ok(b.snapshot.turns.some(row=>row.ref.messageId==='native-1'));
  const diag=f.runtime.lastNativeBindDiagnostic;
  assert.equal(diag?.mode,'structural_provenance_bind');
  assert.equal(diag?.provenance,provenanceKind);
  assert.equal(diag?.textMatched,false);
  assert.ok(diag?.wrapperChars>0&&diag?.rowChars>0);
  assert.ok(!JSON.stringify(diag).includes('노크 후 방문을'));
});

test('a refused legacy binding names the failing step without its text',async()=>{
  const f=await fixture((_chat,_character,input)=>{
    input[2]={role:'user',content:'An entirely different request.'};
  });
  await assert.rejects(()=>f.bind(),error=>error.code==='LIB_READ_NATIVE_ID_UNAVAILABLE');
  const failure=f.runtime.lastNativeBindFailure;
  assert.equal(failure.step,'input_text_mismatch');
  assert.equal(failure.provenance,'legacy_ambiguous');
  assert.ok(failure.wrapperChars>0&&failure.rowChars>0);
  assert.ok(!JSON.stringify(failure).includes('different request'));
});

test('historical fuzzy match never selects an earlier answered user ID when current pending row differs',async()=>{
  const f=await fixture((chat,_character,input)=>{
    chat.message[0].data='Where is the blue ledger? Check the upper cabinet carefully.';
    chat.message[2].data='Leave the room immediately.';
    input[0]={role:'user',content:'Where is the blue ledger? Check the upper cabinet carefully.'};
    input[2]={role:'user',content:'<Current Input>\nWhere is the blue ledger? Check the upper cabinet carefully.\n</Current Input>'};
  });
  await assert.rejects(()=>f.bind(),error=>error.code==='LIB_READ_NATIVE_ID_UNAVAILABLE');
  assert.equal(f.runtime.lastNativeBindFailure?.step,'input_text_mismatch');
});

test('multiple pending user rows after the last assistant fail closed as input_pending_ambiguous',async()=>{
  const f=await fixture((chat,_character,input)=>{
    chat.message[2].data='First unresponded user message.';
    chat.message.push({role:'user',chatId:'native-3',data:'Where is the blue ledger?'});
    input[2]={role:'user',content:'<Current Input>\nWhere is the blue ledger?\n</Current Input>'};
  });
  await assert.rejects(()=>f.bind(),error=>error.code==='LIB_READ_NATIVE_ID_UNAVAILABLE');
  assert.equal(f.runtime.lastNativeBindFailure?.step,'input_pending_ambiguous');
  assert.equal(f.runtime.lastNativeBindFailure?.candidates,2);
});

for(const kind of ['duplicate','partial','streaming','historical'])test(`wrapped input refuses ${kind} live identity`,async()=>{
  const f=await fixture((chat,_character,input)=>{
    input[2]={role:'user',content:'<Current Input>\nWhere is the blue ledger?\n</Current Input>'};
    if(kind==='duplicate')chat.message.push({...chat.message[2],chatId:'another-user'});
    if(kind==='partial')chat.message[2].data='Where is the blue ledger? Add unrelated instructions.';
    if(kind==='streaming')chat.message[2].isStreaming=true;
    if(kind==='historical')chat.message.push({role:'user',chatId:'newer-user',data:'A different pending request.'});
  });
  await assert.rejects(()=>f.bind(),error=>error.code==='LIB_READ_NATIVE_ID_UNAVAILABLE');
});
for(const kind of ['ambiguous','streaming','order','scope'])test(`host identity binding refuses ${kind}`,async()=>{
  const f=await fixture((chat,character)=>{
    if(kind==='ambiguous')chat.message.push({...chat.message[1],chatId:'different-a'});
    if(kind==='streaming')chat.message[1].isStreaming=true;
    if(kind==='order')chat.message=[chat.message[1],chat.message[0],chat.message[2]];
    if(kind==='scope')character.chaId='foreign-character';
  });
  await assert.rejects(()=>f.bind(),error=>/^LIB_READ_NATIVE_/.test(error.code));
});
test('host selection change revokes the mapping',async()=>{
  const f=await fixture(),b=await f.bind();f.changeScope();
  await assert.rejects(()=>b.assertCurrent(),error=>error.code==='LIB_READ_NATIVE_CHANGED');
});
test('unavailable selection cannot be coerced into character zero',async()=>{
  const f=await fixture(null,{getCurrentCharacterIndex:async()=>null});
  await assert.rejects(()=>f.bind(),error=>error.code==='LIB_READ_NATIVE_SCOPE_CHANGED');
});
test('stuck native host lookup is bounded and cannot dispatch a model',async()=>{
  const f=await fixture(null,{getCurrentCharacterIndex:()=>new Promise(()=>{})},{setTimeout:(fn,ms)=>setTimeout(fn,(ms===20000||ms===30000)?5:ms)});
  await assert.rejects(()=>f.bind(),error=>error.code==='LIB_READ_TIMEOUT');
});

async function inputWriterRevalidationFixture(options={}){
  const crypto=require('node:crypto');
  const chat={id:scope.chatId,message:[{role:'user',chatId:'u1',data:'Open the cabinet.'},{role:'assistant',chatId:'a1',data:'The blue ledger rests on the upper shelf.'}]};
  const character={chaId:scope.characterId,name:'Archivist',chats:[chat],chatPage:0,lorebook:[]};
  const prompts=[];
  let charIndex=0,chatLookupImpl=async()=>chat,charLookupImpl=async()=>character;
  const host=await load({
    captureInternals:true,
    testGlobals:{
      crypto:crypto.webcrypto,
      setTimeout:(fn,ms)=>setTimeout(fn,(ms===20000||ms===30000)?5:ms)
    },
    api:{
      getLocalPluginStorage:async()=>({getItem:async()=>null,setItem:async()=>true,removeItem:async()=>true}),
      getCharacter:async()=>await charLookupImpl(),
      getCharacterFromIndex:async()=>await charLookupImpl(),
      getCurrentCharacterIndex:async()=>typeof charIndex==='function'?await charIndex():charIndex,
      getCurrentChatIndex:async()=>0,
      getChatFromIndex:async()=>await chatLookupImpl(),
      getDatabase:async()=>({personas:[],selectedPersona:'',modules:[]}),
      nativeFetch:async(url,init={})=>{
        if(init.method==='GET')return {ok:true,status:200,text:async()=>JSON.stringify({data:[]})};
        const body=JSON.parse(init.body||'{}');
        prompts.push(body);
        const content='Reconstructed native-only input about the blue ledger on the upper shelf.';
        return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]})};
      }
    }
  });
  await host.plugin.saveProviderPreset('writer',{
    provider:'openai',
    url:'https://api.openai.com/v1/chat/completions',
    key:'synthetic-only',
    model:'gpt-4o-mini-2024-07-18',
    request_format:'chat_completions',
    context_window:128000,
    max_tokens:4096,
    reasoning_preset:'off',
    reasoning_effort:'none',
    timeout_ms:5000,
    stream:false
  });
  await host.plugin.saveRuntimeSettings({
    mode:'off',
    default_preset:'writer',
    input_assist_mode:'user_focus',
    writing_mode:'novel',
    input_assist_target_chars:300,
    lore_activation_mode:'off',
    input_assist_lore_activation_mode:'off'
  });
  host.plugin.bindLibReadOnlyClient({
    schema:'memory-suite.memory-read-client.v1',
    pluginId:'serial_gradation_agents_for_rp',
    openReadSession:async()=>{
      await options.onMemoryFailure?.({
        chat,
        character,
        setCharIndex:next=>{charIndex=next;},
        setChatLookup:next=>{chatLookupImpl=next;},
        setCharLookup:next=>{charLookupImpl=next;}
      });
      const err=new Error(options.errorCode||'LIB_READ_SUPERSEDED');
      err.code=options.errorCode||'LIB_READ_SUPERSEDED';
      throw err;
    }
  },{scope:{scopeKey:'scope-1',...scope}});
  return {
    host,
    prompts,
    run:()=>host.plugin.rewriteInput('Inspect the blue ledger closely.')
  };
}

test('Input Writer optional memory fallback proceeds when native context is re-verified unchanged (no false LIB_READ_SUPERSEDED)',async()=>{
  const f=await inputWriterRevalidationFixture({errorCode:'LIB_READ_SUPERSEDED'});
  const out=await f.run();
  assert.equal(f.prompts.length,1);
  assert.match(out,/blue ledger/);
  const diag=f.host.plugin.getRuntime().lastInputWriterReadDiagnostic;
  assert.equal(diag.status,'unavailable');
  assert.equal(diag.code,'LIB_READ_SUPERSEDED');
});

test('Input Writer optional memory fallback fails closed when native context changed during memory read',async()=>{
  const f=await inputWriterRevalidationFixture({
    errorCode:'LIB_READ_UNAVAILABLE',
    onMemoryFailure:({chat})=>{
      chat.message.push({role:'user',chatId:'u2',data:'Concurrent native mutation.'});
    }
  });
  await assert.rejects(()=>f.run(),err=>err.code==='LIB_READ_NATIVE_CHANGED');
  assert.equal(f.prompts.length,0);
  const diag=f.host.plugin.getRuntime().lastInputWriterReadDiagnostic;
  assert.equal(diag.status,'failed');
  assert.equal(diag.stage,'native_revalidation');
  assert.equal(diag.code,'LIB_READ_NATIVE_CHANGED');
});

test('Input Writer optional memory fallback fails closed on host API error during native revalidation',async()=>{
  const f=await inputWriterRevalidationFixture({
    errorCode:'LIB_READ_UNAVAILABLE',
    onMemoryFailure:({setCharLookup})=>{
      setCharLookup(async()=>{throw new Error('host_api_failure');});
    }
  });
  await assert.rejects(()=>f.run(),err=>err.code==='LIB_READ_NATIVE_UNAVAILABLE');
  assert.equal(f.prompts.length,0);
  const diag=f.host.plugin.getRuntime().lastInputWriterReadDiagnostic;
  assert.equal(diag.status,'failed');
  assert.equal(diag.stage,'native_revalidation');
  assert.equal(diag.code,'LIB_READ_NATIVE_UNAVAILABLE');
});

test('Input Writer optional memory fallback fails closed on scope lookup failure during native revalidation',async()=>{
  const f=await inputWriterRevalidationFixture({
    errorCode:'LIB_READ_UNAVAILABLE',
    onMemoryFailure:({setChatLookup})=>{
      setChatLookup(async()=>null);
    }
  });
  await assert.rejects(()=>f.run(),err=>err.code==='LIB_READ_NATIVE_SCOPE_CHANGED');
  assert.equal(f.prompts.length,0);
  const diag=f.host.plugin.getRuntime().lastInputWriterReadDiagnostic;
  assert.equal(diag.status,'failed');
  assert.equal(diag.stage,'native_revalidation');
  assert.equal(diag.code,'LIB_READ_NATIVE_SCOPE_CHANGED');
});

test('Input Writer optional memory fallback fails closed on timeout during native revalidation',async()=>{
  const f=await inputWriterRevalidationFixture({
    errorCode:'LIB_READ_UNAVAILABLE',
    onMemoryFailure:({setCharIndex})=>{
      setCharIndex(()=>new Promise(()=>{}));
    }
  });
  await assert.rejects(()=>f.run(),err=>err.code==='LIB_READ_TIMEOUT');
  assert.equal(f.prompts.length,0);
  const diag=f.host.plugin.getRuntime().lastInputWriterReadDiagnostic;
  assert.equal(diag.status,'failed');
  assert.equal(diag.stage,'native_revalidation');
  assert.equal(diag.code,'LIB_READ_TIMEOUT');
});

test('end-to-end beforeRequest pipeline with formatted Current Input wrapper binds native ID and injects memory evidence across all stages without LIB_READ_NATIVE_VIEW_CHANGED',async()=>{
  const crypto=require('node:crypto');
  const chat={id:scope.chatId,message:messages().map((row,i)=>({role:row.role,chatId:'native-'+i,data:row.content}))};
  const character={chaId:scope.characterId,name:'Archivist',chats:[chat],chatPage:0,lorebook:[]};
  const prompts=[];
  const host=await load({
    testGlobals:{crypto:crypto.webcrypto},
    api:{
      getLocalPluginStorage:async()=>({getItem:async()=>null,setItem:async()=>true,removeItem:async()=>true}),
      getCharacter:async()=>character,
      getCharacterFromIndex:async()=>character,
      getCurrentCharacterIndex:async()=>0,
      getCurrentChatIndex:async()=>0,
      getChatFromIndex:async()=>chat,
      getDatabase:async()=>({personas:[],selectedPersona:'',modules:[]}),
      nativeFetch:async(_url,init={})=>{
        if(init.method==='GET')return {ok:true,status:200,text:async()=>JSON.stringify({data:[]})};
        const body=JSON.parse(init.body||'{}');
        prompts.push(body);
        const system=body.messages?.filter(m=>m.role==='system').map(m=>m.content).join('\n')||'';
        const content=system.includes('patch JSON')||system.includes('serial RP draft analysis-and-patch agent')
          ?JSON.stringify({schema:'serial_gradation_agents_for_rp_draft_patch_v1',stage:(system.match(/Return the compact (aide_\w+) patch JSON/)||[])[1],ok:true,domain:{},analysis:{summary:'No changes necessary',constraints:[],risks:[]},edits:[]})
          :'DERIVED_DRAFT_SENTINEL The archivist pointed toward the upper shelf where the blue ledger rested.';
        return {ok:true,status:200,json:async()=>({choices:[{message:{content},finish_reason:'stop'}]}),text:async()=>JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]})};
      }
    }
  });
  await host.plugin.saveProviderPreset('offline',{
    provider:'openai',
    url:'https://api.openai.com/v1/chat/completions',
    key:'synthetic-only',
    model:'gpt-4o-mini-2024-07-18',
    request_format:'chat_completions',
    context_window:128000,
    max_tokens:4096,
    reasoning_preset:'off',
    reasoning_effort:'none',
    timeout_ms:5000,
    stream:false
  });
  await host.plugin.saveRuntimeSettings({
    mode:'normal',
    default_preset:'offline',
    input_assist_mode:'off',
    multi_pipeline_mode:'lightweight',
    enable_shadow_act:true,
    enable_character_aide:true,
    enable_world_aide:true,
    enable_plot_aide:true,
    failure_mode:'hard',
    lore_activation_mode:'off'
  });
  const owners=['libra','hayaku','flashback'];
  const items=owners.map(owner=>({owner,id:owner+'-record',key:owner+'-key',content:owner.toUpperCase()+'_MEMORY_EVIDENCE',source:{namespace:owner,revision:1,turnRange:{start:1,end:1}}}));
  host.plugin.bindLibReadOnlyClient({
    schema:'memory-suite.memory-read-client.v1',
    pluginId:'serial_gradation_agents_for_rp',
    openReadSession:async()=>({
      source:'unified_engine',
      snapshot:{
        schema:'memory-suite.memory-read-session.v1',
        scope:{scopeKey:'bound-scope',...scope},
        owners,
        readOnly:true,
        complete:true,
        items,
        evidenceRevision:'c'.repeat(64),
        corpusBytes:items.reduce((sum,row)=>sum+Buffer.byteLength(row.content),0),
        maxCorpusBytes:4194304
      },
      assertCurrent:async()=>true,
      assertCurrentSync:()=>true
    })
  },{scope:{scopeKey:'bound-scope',...scope}});
  const reqMessages=messages();
  reqMessages[2]={role:'user',content:'<Current Input>\n[장면 지시]\nWhere is   the\nblue ledger?\n</Current Input>'};
  const out=await host.hooks.beforeRequest(reqMessages,'model');
  assert.equal(prompts.length,4);
  for(const prompt of prompts){
    const serialized=JSON.stringify(prompt);
    for(const owner of owners)assert.ok(serialized.includes(owner.toUpperCase()+'_MEMORY_EVIDENCE'));
    assert.ok(serialized.includes('The blue ledger rests on the upper shelf.'));
  }
  assert.ok(out.some(m=>typeof m.content==='string'&&m.content.includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1')));
});

test('end-to-end beforeRequest pipeline with {{user}}/{{char}} placeholders and non-substring Current Input transform binds structurally and injects memory evidence',async()=>{
  const crypto=require('node:crypto');
  const persona={name:'철수',personaPrompt:'신중한 조사관'};
  const chat={
    id:scope.chatId,
    message:[
      {role:'user',chatId:'native-0',data:'{{user}}가 캐비닛을 연다.'},
      {role:'assistant',chatId:'native-1',data:'{{char}}가 위쪽 선반의 푸른 장부를 가리켰다.'},
      {role:'user',chatId:'native-2',data:'{{user}}는 조용히 문을 열고 {{char}}에게 들어간다.'}
    ]
  };
  const character={chaId:scope.characterId,name:'아키비스트',chats:[chat],chatPage:0,lorebook:[]};
  const prompts=[];
  const host=await load({
    testGlobals:{crypto:crypto.webcrypto},
    api:{
      getLocalPluginStorage:async()=>({getItem:async()=>null,setItem:async()=>true,removeItem:async()=>true}),
      getCharacter:async()=>character,
      getCharacterFromIndex:async()=>character,
      getCurrentCharacterIndex:async()=>0,
      getCurrentChatIndex:async()=>0,
      getChatFromIndex:async()=>chat,
      getDatabase:async()=>({personas:[persona],selectedPersona:0,modules:[]}),
      nativeFetch:async(_url,init={})=>{
        if(init.method==='GET')return {ok:true,status:200,text:async()=>JSON.stringify({data:[]})};
        const body=JSON.parse(init.body||'{}');
        prompts.push(body);
        const system=body.messages?.filter(m=>m.role==='system').map(m=>m.content).join('\n')||'';
        const content=system.includes('patch JSON')||system.includes('serial RP draft analysis-and-patch agent')
          ?JSON.stringify({schema:'serial_gradation_agents_for_rp_draft_patch_v1',stage:(system.match(/Return the compact (aide_\w+) patch JSON/)||[])[1],ok:true,domain:{},analysis:{summary:'No changes necessary',constraints:[],risks:[]},edits:[]})
          :'DERIVED_DRAFT_SENTINEL 아키비스트가 선반 위의 푸른 장부를 내려놓았다.';
        return {ok:true,status:200,json:async()=>({choices:[{message:{content},finish_reason:'stop'}]}),text:async()=>JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]})};
      }
    }
  });
  await host.plugin.saveProviderPreset('offline',{
    provider:'openai',
    url:'https://api.openai.com/v1/chat/completions',
    key:'synthetic-only',
    model:'gpt-4o-mini-2024-07-18',
    request_format:'chat_completions',
    context_window:128000,
    max_tokens:4096,
    reasoning_preset:'off',
    reasoning_effort:'none',
    timeout_ms:5000,
    stream:false
  });
  await host.plugin.saveRuntimeSettings({
    mode:'normal',
    default_preset:'offline',
    input_assist_mode:'off',
    multi_pipeline_mode:'lightweight',
    enable_shadow_act:true,
    enable_character_aide:true,
    enable_world_aide:true,
    enable_plot_aide:true,
    failure_mode:'hard',
    lore_activation_mode:'off'
  });
  const owners=['libra','hayaku','flashback'];
  const items=owners.map(owner=>({owner,id:owner+'-record',key:owner+'-key',content:owner.toUpperCase()+'_MEMORY_EVIDENCE',source:{namespace:owner,revision:1,turnRange:{start:1,end:1}}}));
  host.plugin.bindLibReadOnlyClient({
    schema:'memory-suite.memory-read-client.v1',
    pluginId:'serial_gradation_agents_for_rp',
    openReadSession:async()=>({
      source:'unified_engine',
      snapshot:{
        schema:'memory-suite.memory-read-session.v1',
        scope:{scopeKey:'bound-scope',...scope},
        owners,
        readOnly:true,
        complete:true,
        items,
        evidenceRevision:'c'.repeat(64),
        corpusBytes:items.reduce((sum,row)=>sum+Buffer.byteLength(row.content),0),
        maxCorpusBytes:4194304
      },
      assertCurrent:async()=>true,
      assertCurrentSync:()=>true
    })
  },{scope:{scopeKey:'bound-scope',...scope}});
  const reqMessages=[
    {role:'user',content:'철수가 캐비닛을 연다.'},
    {role:'assistant',content:'아키비스트가 위쪽 선반의 푸른 장부를 가리켰다.'},
    {role:'user',content:'<Current Input>\n철수가 방문을 밀고 들어가 아키비스트 앞에서 주변을 살핀다.\n</Current Input>'}
  ];
  const out=await host.hooks.beforeRequest(reqMessages,'model');
  assert.equal(prompts.length,4);
  for(const prompt of prompts){
    const serialized=JSON.stringify(prompt);
    for(const owner of owners)assert.ok(serialized.includes(owner.toUpperCase()+'_MEMORY_EVIDENCE'));
    assert.ok(serialized.includes('아키비스트가 위쪽 선반의 푸른 장부를 가리켰다.'));
  }
  assert.ok(out.some(m=>typeof m.content==='string'&&m.content.includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1')));
  const diag=host.plugin.getRuntime().lastNativeBindDiagnostic;
  assert.equal(diag?.mode,'structural_provenance_bind');
  assert.equal(diag?.provenance,'explicit_wrapper');
  assert.equal(diag?.textMatched,false);
});



