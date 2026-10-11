'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./libra_unified_runtime_fixture.cjs');
const {actualClassicPacket}=require('./libra_actual_classic_request.cjs');
async function verifyArchiveRecall(){
 const f=await fixture();
 try{
  await f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'});
  assert.equal((await f.run()).completed,1);await f.r.api.retryPendingUnifiedVectors();
  const portable=f.r.context.__LIBRAPortableMemoryBackup;
  const envelope=await portable.exportCurrentScope();
  const target={id:'selected-archive-target',chatId:'selected-archive-target',name:'Archive target',message:[]};target.messages=target.message;
  f.character.chats.push(target);f.character.chatPage=1;const host=f.r.context.risuai;
  host.getCurrentChatIndex=async()=>1;host.getChatFromIndex=async(_char,index)=>f.character.chats[index];host.getChat=async()=>target;host.getCurrentChat=async()=>target;
  assert.equal((await portable.importAsPredecessorArchive(envelope)).ok,true,'real public import creates a predecessor archive');
  const inventory=await f.r.api.listCanonicalBatchRanges(),memories=await f.r.api.getCanonicalMemories();
  assert.ok(memories.some(memory=>memory.archiveShared===true),'public loader decorates an actual shared archive memory');
  const calls=f.control.calls.length;
  const packet=await actualClassicPacket(f,'민아의 은빛 열쇠를 누가 반환했나요?',inventory.scopeKey);
  assert.match(packet.actualClassic.block,/은빛 열쇠|열쇠/);assert.ok(packet.actualClassic.deliveredRows.some(row=>row.inheritedSessionHistory===true),'an inherited canonical is delivered');
  assert.equal(f.control.calls.length,calls,'archive recall performs no analysis');
  const ref=packet.actualClassic.context.canonicalRefs.find(ref=>ref.inherited===true);assert.ok(ref,'sealed response retains inherited canonical identity');
  const physical=JSON.parse(f.r.values.get(ref.key)),decorated=memories.find(memory=>memory.memoryId===physical.memoryId);
  assert.ok(decorated);assert.notDeepEqual(decorated,physical,'physical archive and logical session overlay are distinct');
  assert.equal((await f.r.api.validateResponseContext(packet.actualClassic.context)).ok,true,'physical proof binds the archived body before logical overlay');
  return {archiveShared:true,inheritedDelivered:true,distinctLogicalOverlay:true,providerCallsDuringRecall:0};
 }finally{await f.r.cleanup();}
}
module.exports={verifyArchiveRecall};
if(require.main===module)verifyArchiveRecall().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
