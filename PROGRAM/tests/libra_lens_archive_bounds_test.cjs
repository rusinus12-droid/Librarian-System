'use strict';
// Reduced storage capacity exercises the real UTF-8 guard and newest-record
// truncation through public writes/prepare, without megabytes of fake records.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {lensFixture}=require('./fixtures/libra_lens_handoff_fixture.cjs');
test('archive truncation preserves newest complete records and reports the bounded snapshot',async()=>{
 const f=await lensFixture({transformSource:source=>{const from='const LENS_HANDOFF_MAX_BYTES = 1024 * 1024;';assert.ok(source.includes(from));return source.replace(from,'const LENS_HANDOFF_MAX_BYTES = 8192;');}});
 try{
  const lens=await f.add();for(const [startTurn,endTurn]of [[1,2],[1,3],[1,4],[2,3],[2,4],[2,5]])await f.api.runLensForRange(lens.lensId,{startTurn,endTurn});
  const prepared=await f.api.prepareSessionHandoff({transferId:'bounded'}),ref=prepared.lensArchiveRefs[0],raw=f.r.values.get(ref.archiveKey),archive=JSON.parse(raw);
  assert.equal(prepared.lensTruncated,true);assert.equal(ref.truncated,true);assert.ok(Buffer.byteLength(raw,'utf8')<=8192);
  assert.ok(archive.records.length>0&&archive.records.length<7);assert.equal(archive.records[0].turnRange.end,5);assert.equal(archive.records[0].turnRange.start,2);
  assert.ok(archive.records.every(record=>record.items.length===1),'no record is clipped into a partial note');
 }finally{await f.close();}
});
