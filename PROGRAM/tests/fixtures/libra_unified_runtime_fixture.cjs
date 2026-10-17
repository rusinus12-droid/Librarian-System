'use strict';
const {createLibraVmHarness}=require('./libra_vm_harness.cjs');
const input=require('./unified_vertical_source.json');
const clone=x=>JSON.parse(JSON.stringify(x));
function artifact(){
 const q=n=>[{ref:`t${n}-a`,quote:input.sourceRows.find(r=>r.ref===`t${n}-a`).text}];
 const entities=[['mina','민아','person','person',2],['jiho','지호','person','person',2],['junho','준호','person','person',3],['library','도서관','world','location',1],['study','서재','world','location',1],['hall','공연실','world','location',1],['org','기록회','world','organization',1],['key','은빛 열쇠','world','object',2],['promise','약속','world','thread',2],['question','공연 허가','world','thread',5]].map(([tempId,name,type,kind,n])=>({tempId,name,type,kind,evidenceSpans:q(n)}));
 const facts=[],stateBindings=[];
 const add=(id,domain,subject,kind,values,text,n,field='',extra={})=>{facts.push({tempFactId:id,domain,subjectTempRef:subject,claimKind:kind,values,text,temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:q(n),...extra});if(field)stateBindings.push({factTempId:id,typedValueField:Object.keys(values)[0],stateDomain:domain,stateField:field});};
 add('f1','world','study','containment',{parentRef:'library'},'서재는 도서관 안에 있다.',1,'parentRef');
 add('f2','world','hall','containment',{parentRef:'library'},'공연실은 도서관 안에 있다.',1,'parentRef');
 add('f3','world','library','management',{managerRef:'org'},'기록회가 도서관을 관리한다.',1,'managerRef');
 add('f4','world','library','rule',{rule:{text:'도서관은 정숙 구역',scopeTempRef:'library',exceptions:[{locationTempRef:'hall',condition:'허가된 공연 중',effect:'정숙 규칙 예외'}]}},'도서관의 정숙 규칙은 공연실의 허가된 공연 동안만 예외다.',1,'rule');
 add('f5','character','mina','location',{locationRef:'study'},'민아가 서재에 도착했다.',2,'locationRef');
 add('f6','world','key','ownership',{ownerRef:'mina'},'은빛 열쇠의 소유자는 민아다.',2,'ownerRef');
 add('f7','world','key','possession',{holderRef:'jiho'},'지호가 민아의 은빛 열쇠를 빌렸다.',2,'holderRef');
 add('f8','world','key','possession',{holderRef:'junho'},'준호가 지호에게서 열쇠를 받아 들었다.',3,'holderRef');
 add('f9','character','mina','knowledge',{knowledge:['상자의 암호']},'민아만 상자의 암호를 들었다.',4,'knowledge');
 add('f10','relationship','mina','relationship',{value:'신뢰한다고 명시적으로 말했다'},'민아는 지호를 신뢰한다고 말했다.',4,'value',{targetTempRef:'jiho',dimension:'trust'});
 add('f11','world','key','possession',{holderRef:'mina'},'지호가 열쇠를 민아에게 반환했다.',5,'holderRef');
 add('f12','narrative','promise','thread',{thread:{summary:'오늘 열쇠 반환 약속',status:'resolved'}},'오늘 열쇠를 반환하겠다는 약속이 이행되었다.',5,'threads');
 add('f13','narrative','question','thread',{thread:{summary:'공연 허가자를 아직 알 수 없음',status:'open'}},'공연 허가자가 누구인지 아직 밝혀지지 않았다.',5,'threads');
 return {schema:'libra.canonical_artifact.v4',entities,facts,stateBindings};
}
async function fixture(options={}){
 const chat=options.snapshot?clone(options.snapshot.chat):{id:'unified-chat',chatId:'unified-chat',name:'Unified synthetic 5 U+A',message:input.sourceRows.map(r=>({role:r.role,chatId:r.ref,data:r.text}))};chat.messages=chat.message;
 const character={id:'unified-char',chaId:'unified-char',name:'민아',chatPage:0,chats:[chat]};
 const control={calls:[],artifact:artifact(),onCall:null,modelFails:false,hooks:{}};
 const host={getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacter:async()=>character,getChar:async()=>character,getCharacterFromIndex:async()=>character,getChat:async()=>chat,getCurrentChat:async()=>chat,getChatFromIndex:async()=>chat,
 getDatabase:async fields=>{const db={personas:[],selectedPersona:'',characters:[character],plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db;},
 addRisuReplacer:async(mode,fn)=>{control.hooks[mode]=fn;return true;},
 runLLMModel:async(...args)=>{control.calls.push(clone(args));if(control.onCall)return control.onCall(args);if(control.modelFails)return {type:'error',result:'synthetic_provider_failure'};return {type:'success',result:JSON.stringify(control.artifact)};}};
 Object.assign(host,options.host || {});
 const r=await createLibraVmHarness({enable_character_ito:false,enable_world_ito:false,enable_plot_ito:false,...options.args},host,{initialValues:options.snapshot?.values,transformSource:options.transformSource,contextGlobals:options.contextGlobals});
 const settings=await r.api.getLibraMemorySettings();
 const requestedEngine=options.mode || 'unified';
 // Getter settings are normalized. Skip only the identical supported engine
 // alias already recorded in this snapshot; other requests keep real validation.
 const sameEngine=['librarian','legacy','unified','unified_review','serial_review'].includes(requestedEngine)
  && settings.librarianPolicyVersion===1 && settings.configurationStatus==='ready'
  && (settings.memoryEngine===requestedEngine
   || (settings.memoryEngine==='librarian' && settings.compatibilityMemoryEngine===requestedEngine));
 if(!sameEngine)await r.api.saveLibraMemorySettings({...settings,memoryEngine:requestedEngine});
 const getManifest=()=>{const key=[...r.values.keys()].find(k=>k.startsWith('libra')&&k.endsWith(':manifest'));return key?JSON.parse(r.values.get(key)):null;};
 const getMemory=(start=1)=>{const ref=getManifest()?.memories?.[String(start)];return ref?JSON.parse(r.values.get(ref.key)):null;};
 const getHead=()=>{const key=[...r.values.keys()].find(k=>{try{return JSON.parse(r.values.get(k))?.schema==='libra.continuity_state.v2';}catch{return false;}});return key?JSON.parse(r.values.get(key)):null;};
 const getRecords=schema=>[...r.values.entries()].flatMap(([key,v])=>{try{const value=JSON.parse(v);return value?.schema===schema?[{key,value}]:[];}catch{return [];}});
 return {r,chat,character,control,getManifest,getMemory,getHead,getRecords,run:()=>r.api.runManualColdStart(),clone};
}
module.exports={fixture,artifact};
