'use strict';
const assert=require('node:assert/strict');
// Read the physical raw bytes and the separately bound v2 lifecycle metadata.
// Retain this independent storage observation in host integration fixtures.
function readLedgerReceipts(store){
 const records=[];
 for(const[key,value]of store){
  if(!key.includes('::record::')||key.includes('::chunk:v1:')||key.endsWith('::publication')||key.endsWith('::status'))continue;
  let raw=JSON.parse(value);
  if(raw.__libraChunkedStorageV1===true){assert.equal(raw.key,key);const text=raw.chunks.map(k=>{assert.ok(k.startsWith(key+'::chunk:v1:'));const part=store.get(k);assert.equal(typeof part,'string');return part;}).join('');assert.equal(text.length,raw.length);raw=JSON.parse(text);}
  if(raw.kind!=='libra_raw_turn')continue;
  const metadataValue=store.get(key+'::status');
  if(raw.version===2&&metadataValue!=null){const meta=JSON.parse(metadataValue);assert.equal(meta.version,1);assert.equal(meta.recordKey,key);assert.equal(meta.scopeKey,raw.scopeKey);assert.equal(meta.rawHash,raw.rawHash);assert.equal(typeof meta.patch,'object');assert.ok(meta.patch&&!Array.isArray(meta.patch));for(const field of ['version','kind','recordId','recordKey','requestId','scopeKey','runtimeScopeKey','canonicalScope','characterId','characterIndex','chatId','chatIndex','requestSequence','requestType','resetGeneration','userText','assistantText','responseHash','rawHash','userBytes','assistantBytes','journalSequence','journalPageNumber','captureSource','observedAt'])assert.equal(Object.hasOwn(meta.patch,field),false,'lifecycle may not override raw '+field);raw={...raw,...meta.patch};}
  records.push(raw);
 }
 return records;
}
// Canonical roots share RisuCompat's physical chunk format. Chunk values are
// fragments, not independent JSON documents; corrupt roots must still throw.
function readCanonicalRecords(store){
 const records=[];
 for(const[key,value]of store){
  if(!String(key).startsWith('LIBRA_DATA::')||String(key).includes('::chunk:v1:'))continue;
  let record=JSON.parse(value);
  if(record.__libraChunkedStorageV1===true){
   assert.equal(record.key,key,'canonical manifest key');
   assert.ok(Array.isArray(record.chunks)&&record.chunks.length>0,'canonical manifest chunks');
   assert.equal(new Set(record.chunks).size,record.chunks.length,'canonical duplicate chunk');
   assert.ok(Number.isInteger(record.length)&&record.length>=0,'canonical chunk length');
   const text=record.chunks.map(chunkKey=>{
    assert.equal(typeof chunkKey,'string','canonical chunk key');
    assert.ok(chunkKey.startsWith(key+'::chunk:v1:'),'canonical chunk ownership');
    const part=store.get(chunkKey);
    assert.equal(typeof part,'string','canonical missing chunk');
    return part;
   }).join('');
   assert.equal(text.length,record.length,'canonical chunk length');
   record=JSON.parse(text);
  }
  records.push({key,record});
 }
 return records;
}
module.exports={readLedgerReceipts,readCanonicalRecords};
