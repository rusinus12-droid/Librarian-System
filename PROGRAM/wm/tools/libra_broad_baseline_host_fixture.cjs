'use strict';
const assert=require('node:assert/strict');
const clone=x=>JSON.parse(JSON.stringify(x));
function installHostProjection(host,character,chat,messages){
 character.chatPage=0;
 const saveChat=async(ci,ti,value)=>{assert.equal(Number(ci),0);assert.equal(Number(ti),0);assert.equal(value.id,chat.id);Object.assign(chat,clone(value));chat.message=chat.msgs=messages;character.chats[0]=chat;return true;};
 host.setChatToIndex=saveChat;
 host.setCharacter=async value=>{assert.equal(value.id,character.id);const selected=value.chats?.[0];Object.assign(character,clone(value));if(selected)await saveChat(0,0,selected);character.chats[0]=chat;return true;};
 host.setCharacterToIndex=async(ci,value)=>{assert.equal(Number(ci),0);return host.setCharacter(value);};
}
async function admit(api,character,chat,store){
 const scope=api.LibraDataStorage.scopeKeyFor(character,chat,chat.bindedPersona),key=api.LibraDataStorage.storageKeyFor(scope);
 assert.equal(store.has(key),false,'empty fresh physical canonical fixture');
 const nativeEntries=chat.localLore,beforeMissing=JSON.stringify([...store]);
 chat.localLore=[...nativeEntries,{key:'unverified-host-only',comment:'lmai_memory',content:'[META:{"turn":1}]\nUnverified host-only memory.'}];
 let missing;try{missing=await api.LibraDataStorage.preparePersonaContext(character,chat)}finally{chat.localLore=nativeEntries}
 assert.equal(missing.ok,false,'canonical-missing host data must not admit');assert.match(missing.reason,/canonical_missing/);assert.equal(JSON.stringify([...store]),beforeMissing,'missing canonical rejection cannot write physical storage');
 store.set(key,JSON.stringify({scopeKey:scope,entries:[]}));
 const admitted=await api.PersonaRuntimeCoordinator.activate({char:character,chat});assert.equal(admitted.ok,true,admitted.reason);
 const verified=await api.LibraDataStorage.readVerified(scope);assert.equal(verified.ok,true);assert.equal(verified.missing,false);assert.equal(verified.raw,store.get(key));
 return {scope,key};
}
async function waitForTurn(store,userText,assistantText,budgetMs=12000){
 const deadline=Date.now()+budgetMs;
 while(Date.now()<deadline){const receipts=[...store.values()].map(v=>{try{return JSON.parse(v)}catch{return null}}).filter(v=>v?.kind==='libra_raw_turn'&&v.userText===userText&&v.assistantText===assistantText).map(raw=>{const text=raw.version===2?store.get(raw.recordKey+'::status'):null;if(text==null)return raw;const meta=JSON.parse(text);assert.equal(meta.version,1);assert.equal(meta.recordKey,raw.recordKey);assert.equal(meta.scopeKey,raw.scopeKey);assert.equal(meta.rawHash,raw.rawHash);assert.ok(meta.patch&&typeof meta.patch==='object'&&!Array.isArray(meta.patch));for(const field of ['version','kind','recordId','recordKey','requestId','scopeKey','runtimeScopeKey','canonicalScope','characterId','characterIndex','chatId','chatIndex','requestSequence','requestType','resetGeneration','userText','assistantText','responseHash','rawHash','userBytes','assistantBytes','journalSequence','journalPageNumber','captureSource','observedAt'])assert.equal(Object.hasOwn(meta.patch,field),false);return {...raw,...meta.patch};});for(const r of receipts)assert.notEqual(r.analysisStatus,'failed','actual worker failure '+(r.lastError||r.analysisError||''));if(receipts.some(r=>r.status==='committed'&&r.analysisStatus==='done'))return receipts.find(r=>r.status==='committed'&&r.analysisStatus==='done');await new Promise(resolve=>setTimeout(resolve,20));}
 throw new Error('actual raw committed/done frontier not reached for exact pair within '+budgetMs+'ms');
}
module.exports={installHostProjection,admit,waitForTurn};
