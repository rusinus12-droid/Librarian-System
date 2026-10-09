'use strict';
const {fixture,artifact}=require('./libra_unified_runtime_fixture.cjs');
const {branch}=require('./native_branch_fixture.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
async function lineageFixture(options={}){
 let current=null,char=null;
 const f=await fixture({...options,host:{getCurrentChatIndex:async()=>Math.max(0,char?.chats.indexOf(current)||0),
 getCharacter:async()=>char,getChar:async()=>char,getCharacterFromIndex:async()=>char,
 getChat:async()=>current,getCurrentChat:async()=>current,getChatFromIndex:async(_c,i)=>char.chats[i],
 getDatabase:async fields=>{const db={personas:[],selectedPersona:'',characters:char?[char]:[],plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db;}}});
 char=f.character;current=f.chat;
 const select=chat=>{if(!char.chats.includes(chat))char.chats.push(chat);current=chat;char.chatPage=char.chats.indexOf(current);return chat;};
 const manifest=chat=>f.getRecords('libra.manifest.v1').find(x=>x.value.chatId===(chat||current).id)?.value || [...f.r.values].map(([k,v])=>{try{return k.endsWith(':manifest')?JSON.parse(v):null;}catch{return null;}}).find(x=>x?.chatId===(chat||current).id);
 const head=chat=>f.getRecords('libra.continuity_state.v2').find(x=>x.value.scopeKey===manifest(chat)?.scopeKey)?.value;
 const appendFive=()=>{const n=current.message.filter(m=>m.role==='user'&&!m.isComment&&!m.disabled).length;const extra=f.chat.message.slice(0,10).map((m,i)=>({...m,chatId:`${current.id}-t${n+1+Math.floor(i/2)}-${i%2?'a':'u'}`}));current.message.push(...extra);current.messages=current.message;f.control.artifact=artifact();for(const x of [...f.control.artifact.entities,...f.control.artifact.facts])for(const e of x.evidenceSpans)e.ref=e.ref.replace(/^t(\d+)/,(_,v)=>`t${Number(v)+n}`);};
 return {...f,select,manifest,head,appendFive,branch:(n,id)=>{const child=branch(current,n,id);child.messages=child.message;return select(child);},empty:id=>select({id,chatId:id,name:id,message:[]}),current:()=>current};
}
module.exports={lineageFixture,clone};
