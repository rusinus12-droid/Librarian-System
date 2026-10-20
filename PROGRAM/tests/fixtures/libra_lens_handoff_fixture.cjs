'use strict';
const {fixture}=require('./libra_unified_runtime_fixture.cjs');
const {clone,branch}=require('./native_branch_fixture.cjs');
async function lensFixture(options={}){
 const f=await fixture(options);let index=0,reply=null;
 const host=f.r.context.risuai;
 host.getCurrentChatIndex=async()=>index;
 host.getChat=host.getCurrentChat=async()=>f.character.chats[index];
 host.getChatFromIndex=async(_c,i)=>f.character.chats[i];
 // Optional source edits before the canonical run (e.g. a long turn for excerpt tests).
 if(typeof options.beforeRun==='function')await options.beforeRun(f);
 await f.run();
 f.control.onCall=async args=>JSON.stringify(args).includes('LIBRA LENS ANALYZER')
  ?{type:'success',result:typeof reply==='function'?await reply(args):JSON.stringify(reply||{items:[{label:'약속',text:'지호의 은빛 열쇠 반환 약속',refs:['t2-a'],quote:'오늘 돌려주겠다고 약속했다',target:'지호'}]})}
  :{type:'success',result:JSON.stringify(f.control.artifact)};
 const api=f.r.api;
 const add=async(name='약속 렌즈',status='active',extra={})=>{
  const lens=await api.createLens({name,status,evidenceMode:'interpretive',instruction:{goal:'은빛 열쇠와 약속을 기록한다.'},cadence:{mode:'manual'},...extra});
  await api.runLensForRange(lens.lensId,{startTurn:1,endTurn:5});return lens;
 };
 const select=i=>{index=i;f.character.chatPage=i;};
 const target=(name='다음 대화',native=false)=>{
  const id='lens-chat-'+f.character.chats.length;
  const chat=native?branch(f.chat,5,id):{id,chatId:id,name,message:[],messages:[]};
  f.character.chats.push(chat);select(f.character.chats.length-1);return chat;
 };
 const manifest=chatId=>[...f.r.values.entries()].flatMap(([key,raw])=>{try{const value=JSON.parse(raw);return value?.schema==='libra.manifest.v1'&&value.chatId===chatId?[{key,value}]:[];}catch{return[];}})[0];
 return {...f,api,add,target,select,manifest,setReply:value=>reply=value,clone,close:()=>f.r.cleanup()};
}
module.exports={lensFixture};
