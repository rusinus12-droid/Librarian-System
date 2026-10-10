'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const sha=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
test('canonical normalized-source verification preserves transferred original message identities',async()=>{
 const f=await fixture({transformSource:s=>s.replace('const readVerifiedCompletedTurnRawPacket = async','const readVerifiedCompletedTurnRawPacket = globalThis.__rawTransferProbe = async')});
 try{assert.equal((await f.run()).completed,1);const active=await f.r.api.debugReadActiveCompletedTurnReceipt(1),receipt=JSON.parse(f.r.values.get(active.receiptKey));
  // A copied packet retains its original source-row IDs while the bound target
  // receipt uses the target chat's IDs. Existing strict transfer admission
  // explicitly compares raw payloads without treating original IDs as target IDs.
  const packet=receipt.rawSourcePacket;for(const role of ['user','assistant'])for(const row of packet[role].segments)row.messageId='original-parent-'+row.messageId;
  packet.origin.scopeKey='original-parent-scope';const {packetDigest,...body}=packet;packet.packetDigest=sha(body);
  receipt.rawPacketRef={...receipt.rawPacketRef,packetDigest:packet.packetDigest,originRelation:'transferred_original_capture'};
  f.r.values.set(active.receiptKey,JSON.stringify(receipt));
  // The initial receipt may have a matching capture row; remove only the
  // synthetic optional active-pointer record to read this valid inline packet.
  for(const key of [...f.r.values.keys()])if(key.includes(':source-receipt-capture:')&&key.endsWith(':t1:'+receipt.revisionId))f.r.values.delete(key);
  const strict=await f.r.context.__rawTransferProbe(receipt,active.receiptKey);assert.equal(strict.status,'verified',JSON.stringify(strict));
  const equivalent=await f.r.context.__rawTransferProbe(receipt,active.receiptKey,{allowProjectedEquivalent:true});
  assert.equal(equivalent.status,'verified',JSON.stringify(equivalent));
 }finally{await f.r.cleanup();}
});
