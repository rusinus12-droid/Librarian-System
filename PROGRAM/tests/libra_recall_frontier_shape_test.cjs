'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
const start=source.indexOf('    const microFrontierFromDelivery = '),end=source.indexOf('    const buildRecallEvidencePacket = ',start);
assert.ok(start>0 && end>start);
const frontier=vm.runInNewContext(source.slice(start,end)+'\nmicroFrontierFromDelivery',{
  asArray:x=>Array.isArray(x)?x:[],asObject:x=>x&&typeof x==='object'?x:{},string:x=>String(x??'')
});
test('current family/turn rows and legacy kind/range rows expose selected Micro turns',()=>{
  const result=frontier({rows:[{family:'micro',turn:24},{kind:'micro',turnRange:{start:4,end:4}},
    {family:'state',turn:25},{family:'micro',turn:13,semanticRole:'source_only'}]});
  assert.equal(result.lastKnownTurn,24);
  assert.deepEqual(Array.from(result.verifiedTurns),[4,24]);
  assert.deepEqual(Array.from(result.sourceOnlyTurns),[13]);
  assert.equal(result.pending,true);
  assert.equal(result.analysisStatus,'minimum_source_bound');
});
test('durable index wins over selected rows and reports absent analyses',()=>{
  const result=frontier({rows:[{family:'micro',turn:24}]},null,
    {lastKnownTurn:25,verifiedTurns:[24],sourceOnlyTurns:[],pendingTurns:[25]});
  assert.equal(result.lastKnownTurn,25);
  assert.deepEqual(Array.from(result.pendingTurns),[25]);
  assert.equal(result.pending,true);
});
