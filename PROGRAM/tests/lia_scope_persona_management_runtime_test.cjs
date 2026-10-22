'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');
async function setup(t){
 let calls=0;
 const f=await createFixture('official',{configureApi(api,{db}){
   db.personas.push({id:'second-source',name:'두 번째 Persona',personaPrompt:'신중한 탐험가. 은빛 나침반을 지닌다.'});
   db.characters[0].chats.push({id:'other-chat',name:'다른 채팅',bindedPersona:'second-source',message:[],custom:{keep:true}});
   api.getCharacterFromIndex=async i=>db.characters[i]||null;
   api.getChatFromIndex=async(i,j)=>db.characters[i]?.chats[j]||null;
   api.setChatToIndex=async(i,j,next)=>{const chat=db.characters[i]?.chats[j];if(!chat)return false;for(const key of Object.keys(chat))delete chat[key];Object.assign(chat,structuredClone(next));return true;};
   api.otherAx=async()=>{calls++;throw Error('scope management must not call an LLM');};
 }});
 t.after(()=>f.dispose());f.calls=()=>calls;return f;
}
const request=(catalog,row,id)=>({scopeKey:row.scopeKey,expectedRevision:row.revision,personaId:id,expectedPersonaRevision:catalog.personas.find(p=>p.id===id)?.revision});
test('catalog lists managed and ordinary native chats without changing storage or personas',async t=>{
 const f=await setup(t),before=JSON.stringify(f.db),stored=JSON.stringify([...f.values].filter(([k])=>k.startsWith('liaPersonaLinkerLivePersona')));
 const catalog=await f.runtime.getScopePersonaCatalog();
 assert.equal(catalog.rows.length,2);
 assert.equal(catalog.rows.find(r=>r.chatId==='lia-chat').status,'LIA 연결됨');
 assert.equal(catalog.rows.find(r=>r.chatId==='other-chat').personaName,'두 번째 Persona');
 assert.match(catalog.rows.find(r=>r.chatId==='other-chat').preview,/탐험가/);
 assert.equal(JSON.stringify(f.db),before);assert.equal(JSON.stringify([...f.values].filter(([k])=>k.startsWith('liaPersonaLinkerLivePersona'))),stored);assert.equal(f.calls(),0);
});
test('a non-current chat changes and unbinds without switching the selected chat or default persona',async t=>{
 const f=await setup(t),original=JSON.stringify(f.liveChat),personas=JSON.stringify(f.db.personas),catalog=await f.runtime.getScopePersonaCatalog(),row=catalog.rows.find(r=>r.chatId==='other-chat');
 const saved=await f.runtime.changeScopePersona(request(catalog,row,'source-persona'));
 assert.equal(saved.personaId,'source-persona');assert.equal(f.character.chats[1].bindedPersona,'source-persona');assert.deepEqual(f.character.chats[1].custom,{keep:true});
 assert.equal(JSON.stringify(f.liveChat),original);assert.equal(f.db.selectedPersona,0);assert.equal(JSON.stringify(f.db.personas),personas);
 const next=await f.runtime.getScopePersonaCatalog(),current=next.rows.find(r=>r.chatId==='other-chat');
 await f.runtime.changeScopePersona(request(next,current,''));
 assert.equal(f.character.chats[1].bindedPersona,undefined);assert.equal(f.db.selectedPersona,0);assert.equal(f.calls(),0);
});
test('managed scopes reuse the existing per-chat Live transaction and preserve the old persona',async t=>{
 const f=await setup(t),catalog=await f.runtime.getScopePersonaCatalog(),row=catalog.rows.find(r=>r.chatId==='lia-chat'),other=JSON.stringify(f.character.chats[1]);
 const saved=await f.runtime.changeScopePersona(request(catalog,row,'second-source'));
 assert.match(saved.personaId,/^lia-live-persona::/);assert.equal(saved.sourcePersonaName,'두 번째 Persona');
 assert.equal(f.db.personas.find(p=>p.id==='lia-live-persona::fixture').personaPrompt,'Base persona prompt');
 assert.equal(f.db.personas.find(p=>p.id==='second-source').personaPrompt,'신중한 탐험가. 은빛 나침반을 지닌다.');
 assert.equal(JSON.stringify(f.character.chats[1]),other);assert.equal(f.db.selectedPersona,0);assert.equal(f.calls(),0);
});
test('stale views, deleted targets, duplicate IDs and other scopes Live personas cannot authorize changes',async t=>{
 const f=await setup(t),catalog=await f.runtime.getScopePersonaCatalog(),row=catalog.rows.find(r=>r.chatId==='other-chat');
 f.character.chats[1].bindedPersona='source-persona';
 await assert.rejects(()=>f.runtime.changeScopePersona(request(catalog,row,'second-source')),/情報|정보가 바뀌/);
 let fresh=await f.runtime.getScopePersonaCatalog(),target=fresh.rows.find(r=>r.chatId==='other-chat');
 await assert.rejects(()=>f.runtime.changeScopePersona(request(fresh,target,'lia-live-persona::fixture')),/다른 채팅의 Live/);
 f.db.personas.find(p=>p.id==='second-source').personaPrompt+=' changed';
 await assert.rejects(()=>f.runtime.changeScopePersona(request(fresh,target,'second-source')),/Persona가 변경/);
 f.character.chats.push({...f.character.chats[1],message:[]});fresh=await f.runtime.getScopePersonaCatalog();
 assert.equal(fresh.rows.filter(r=>r.chatId==='other-chat').every(r=>!r.available),true);
 await assert.rejects(()=>f.runtime.changeScopePersona(request(fresh,fresh.rows.find(r=>r.chatId==='other-chat'),'source-persona')),/중복/);
 assert.equal(f.character.chats[1].bindedPersona,'source-persona');assert.equal(f.calls(),0);
});
test('stored bindings whose chat is gone remain visible and cannot be edited',async t=>{
 const f=await setup(t);f.character.chats.shift();
 const rows=(await f.runtime.getScopePersonaCatalog()).rows,orphan=rows.find(r=>r.orphan);
 assert.equal(orphan.scopeKey,f.scopeKey);assert.equal(orphan.available,false);
 await assert.rejects(()=>f.runtime.changeScopePersona({scopeKey:f.scopeKey,expectedRevision:'old',personaId:'source-persona'}),/원본 채팅/);
 assert.ok(f.values.has('liaPersonaLinkerLivePersonaIndexV2'));
});
test('reordered host indexes are resolved from fresh IDs and rejected if the host returns another chat',async t=>{
 const f=await setup(t),catalog=await f.runtime.getScopePersonaCatalog(),row=catalog.rows.find(r=>r.chatId==='other-chat');
 f.character.chats.reverse();
 await f.runtime.changeScopePersona(request(catalog,row,'source-persona'));
 assert.equal(f.character.chats[0].id,'other-chat');assert.equal(f.character.chats[0].bindedPersona,'source-persona');
 const fresh=await f.runtime.getScopePersonaCatalog(),target=fresh.rows.find(r=>r.chatId==='other-chat');
 f.api.getChatFromIndex=async()=>f.character.chats[1];
 await assert.rejects(()=>f.runtime.changeScopePersona(request(fresh,target,'second-source')),/채팅 위치/);
 assert.equal(f.character.chats[1].bindedPersona,'lia-live-persona::fixture');
});

test('a chat reorder during the final character read cannot overwrite the other chat',async t=>{
 const f=await setup(t),catalog=await f.runtime.getScopePersonaCatalog(),row=catalog.rows.find(r=>r.chatId==='other-chat');
 const before=new Map(f.character.chats.map(chat=>[chat.id,JSON.stringify(chat)]));let reads=0;
 f.api.getCharacterFromIndex=async i=>{if(++reads===2)f.character.chats.reverse();return f.db.characters[i];};
 await assert.rejects(()=>f.runtime.changeScopePersona(request(catalog,row,'source-persona')),/LIA_BINDING_CHANGE_SCOPE_CHANGED/);
 for(const chat of f.character.chats)assert.equal(JSON.stringify(chat),before.get(chat.id),'each chat retains its content and binding');
});

test('the final character read preserves newer chat fields and refuses a changed binding',async t=>{
 for(const changeBinding of [false,true]){
  const f=await setup(t),catalog=await f.runtime.getScopePersonaCatalog(),row=catalog.rows.find(r=>r.chatId==='other-chat');let reads=0;
  f.api.getChatFromIndex=async(i,j)=>structuredClone(f.db.characters[i]?.chats[j]);
  f.api.getCharacterFromIndex=async i=>{
   if(++reads===2){f.character.chats[1].custom.newValue='written concurrently';if(changeBinding)f.character.chats[1].bindedPersona='';}
   return structuredClone(f.db.characters[i]);
  };
  const operation=()=>f.runtime.changeScopePersona(request(catalog,row,'source-persona'));
  if(changeBinding)await assert.rejects(operation,/LIA_BINDING_CHANGE_CONFLICT/);else await operation();
  assert.equal(f.character.chats[1].custom.newValue,'written concurrently');
  assert.equal(f.character.chats[1].bindedPersona,changeBinding?'':'source-persona');
 }
});

test('partial database reads and damaged binding shards never look like an empty editable catalog',async t=>{
 const f=await setup(t),original=f.api.getDatabase;
 f.api.getDatabase=async()=>({characters:f.db.characters,personas:f.db.personas});
 await assert.rejects(()=>f.runtime.getScopePersonaCatalog(),/기본 Persona 선택 상태/);
 f.api.getDatabase=async()=>null;await assert.rejects(()=>f.runtime.getScopePersonaCatalog(),/데이터 접근 권한/);
 f.api.getDatabase=original;
 const index=JSON.parse(f.values.get('liaPersonaLinkerLivePersonaIndexV2'));
 f.values.set(index.entries[f.scopeKey].storageKey,'{"corrupt":true}');
 const catalog=await f.runtime.getScopePersonaCatalog(),row=catalog.rows.find(r=>r.scopeKey===f.scopeKey);
 assert.equal(row.available,false);assert.equal(row.reason,'LIA 연결 기록 확인 필요');
 await assert.rejects(()=>f.runtime.changeScopePersona(request(catalog,row,'second-source')),/LIA 연결 기록/);
 assert.equal(f.liveChat.bindedPersona,'lia-live-persona::fixture');
});

test('a rejected host write preserves native binding and does not report successful application',async t=>{
 const f=await setup(t),catalog=await f.runtime.getScopePersonaCatalog(),row=catalog.rows.find(r=>r.chatId==='other-chat');
 f.api.setChatToIndex=async()=>false;
 await assert.rejects(()=>f.runtime.changeScopePersona(request(catalog,row,'source-persona')),/LIA_CHAT_BINDING_WRITE_REJECTED/);
 assert.equal(f.character.chats[1].bindedPersona,'second-source');assert.equal(f.db.selectedPersona,0);assert.equal(f.calls(),0);
});

test('an in-flight scope change blocks a second scope operation and releases the lock afterwards',async t=>{
 const f=await setup(t),catalog=await f.runtime.getScopePersonaCatalog(),row=catalog.rows.find(r=>r.chatId==='other-chat');
 let enter,release;const entered=new Promise(r=>{enter=r;}),gate=new Promise(r=>{release=r;}),original=f.api.setChatToIndex;
 f.api.setChatToIndex=async(...args)=>{enter();await gate;return original(...args);};
 const pending=f.runtime.changeScopePersona(request(catalog,row,'source-persona'));await entered;
 try{await assert.rejects(()=>f.runtime.changeScopePersona(request(catalog,catalog.rows.find(r=>r.chatId==='lia-chat'),'second-source')),/진행 중인 Persona 작업/);}
 finally{release();}
 await pending;f.api.setChatToIndex=original;
 const fresh=await f.runtime.getScopePersonaCatalog();await f.runtime.changeScopePersona(request(fresh,fresh.rows.find(r=>r.chatId==='other-chat'),''));
 assert.equal(f.character.chats[1].bindedPersona,undefined);
});
