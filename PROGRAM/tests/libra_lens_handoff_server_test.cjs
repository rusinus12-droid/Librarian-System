'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {branch}=require('./fixtures/native_branch_fixture.cjs');
for(const mode of ['server_only','mirror'])test(mode+': native copy lens archives verify on the real server and purge removes them',async()=>{
 const s=await serverFixture({mode});try{
  const f=s.f,api=f.r.api;let index=0;
  f.r.context.risuai.getCurrentChatIndex=async()=>index;
  f.r.context.risuai.getChat=f.r.context.risuai.getCurrentChat=async()=>f.character.chats[index];
  f.r.context.risuai.getChatFromIndex=async(_c,i)=>f.character.chats[i];
  await f.run();f.control.onCall=async args=>JSON.stringify(args).includes('LIBRA LENS ANALYZER')
   ?{type:'success',result:JSON.stringify({items:[{text:'지호의 은빛 열쇠 약속',refs:['t2-a'],quote:'오늘 돌려주겠다고 약속했다'}]})}
   :{type:'success',result:JSON.stringify(f.control.artifact)};
  const lens=await api.createLens({name:'서버 렌즈',instruction:{goal:'은빛 열쇠 기록'},cadence:{mode:'manual'}});
  await api.runLensForRange(lens.lensId,{startTurn:1,endTurn:5});
  const child=branch(f.chat,5,'lens-server-'+mode);f.character.chats.push(child);index=1;f.character.chatPage=1;
  const result=await api.debugNativeChatCopy({force:true});assert.equal(result.result?.ok,true,JSON.stringify(result));assert.equal(result.result.verifiedLensArchives,1);
  assert.equal((await api.inspectScopeLenses()).memories.filter(item=>item.inherited).length,1);
  assert.ok(s.storedRows().some(row=>row.key.includes(':lens-handoff-archive:')),'archive reaches SQLite');
  await api.trashLens(lens.lensId);await api.purgeLens(lens.lensId);
  assert.equal(s.storedRows().some(row=>row.key.includes(':lens-handoff-archive:')&&row.key.endsWith(':'+lens.lensId)),false);
  assert.equal((await api.inspectScopeLenses()).memories.length,0);
 }finally{await s.cleanup();}
});
