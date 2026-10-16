'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto'), zlib = require('node:zlib');
const plugin = fs.readFileSync(path.join(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8');
const block = plugin.split('  /* GRADIA PLUGIN READ START */')[1].split('  /* GRADIA PLUGIN READ END */')[0];
const {primitives, snapshot, adapter, gunzip} = new Function(block.replace('return createReadSession;', 'return {createReadSession,gunzip};')
  + '\nconst p=createGradiaReadPrimitives(),a=createHayakuPluginReadSession(p); return {primitives:p,snapshot:createGradiaPluginSnapshot,adapter:a.createReadSession,gunzip:a.gunzip};')();
const h64 = value => {let h=0xcbf29ce484222325n;for(let i=0;i<value.length;i++)h=BigInt.asUintN(64,(h^BigInt(value.charCodeAt(i)))*0x100000001b3n);return 'h64'+h.toString(36);};
test('browser read fingerprints and UTF8 lengths match persisted Node metadata',()=>{
  for(const text of ['', '한글😀', '\0"\\\n', 'x'.repeat(4097), '\ud800','\udfff']) {
    assert.equal(primitives.fingerprint(text),crypto.createHash('sha256').update(text).digest('hex'));
    assert.equal(primitives.byteLength(text),Buffer.byteLength(text));
  }
});
test('portable gzip decoding preserves Unicode and bounds actual output, including false advertised lengths',async()=>{
  const text='압축 기억 😀'.repeat(1000), compressed=zlib.gzipSync(text);
  assert.equal((await gunzip(compressed,{maxOutputLength:Buffer.byteLength(text)})).toString('utf8'),text);
  await assert.rejects(()=>gunzip(compressed,{maxOutputLength:10}),error=>error.code==='ERR_BUFFER_TOO_LARGE');
});
test('plugin snapshot follows only selected receipt refs, re-reads dependencies and keeps original source immutable',async()=>{
  const {createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');
  const scope={scopeKey:'chat_'+h64('c\nh'),characterId:'c',chatId:'h'}, key='hayaku.v2.ledger.'+scope.scopeKey;
  const raw=JSON.stringify(createValidPacket()), body={schema:'hayaku.capture_raw_delta.v1',scopeKey:scope.scopeKey,binding:'b',packets:[{raw}],sourcePayload:{user:'PRIVATE_RAW_TRANSCRIPT'}};
  const serialized=JSON.stringify(body), digest=h64(serialized), delta='hayaku.v2.storage_reconciliation_journal.capture_delta::'+scope.scopeKey+'::b::'+digest;
  const ledger={version:'hayaku_storage_ledger_v2',scopeKey:scope.scopeKey,identity:{schema:'hayaku.scope_identity.v1',...scope},
    records:[{recordId:'selected',hash:h64(raw),recordState:'active',targetPairIndex:1,packetType:'current_snapshot',
      captureRawRef:{schema:body.schema,scopeKey:scope.scopeKey,binding:'b',digest,rawDigest:h64(raw),packetIndex:0,storageKey:delta}},
      {recordId:'superseded',hash:h64('bad'),recordState:'superseded',raw:'BAD_OLD_VARIANT'}],slotHeads:[],tombstones:[]};
  const values=new Map([[key,JSON.stringify(ledger)],[delta,serialized],['orphan','PRIVATE_ORPHAN']]), reads=[];
  const original=JSON.stringify([...values]), capture=snapshot({primitives,createReadSession:adapter,read:async key=>{reads.push(key);return values.get(key)??null;}});
  const read=await capture({scope,maxCorpusBytes:4096});
  assert.deepEqual(read.items.map(i=>i.content),[raw]);assert.ok(!JSON.stringify(read.items).includes('PRIVATE_'));
  assert.deepEqual(reads,[key,delta]);
  assert.deepEqual(await Promise.all([read.assertCurrent(),read.assertCurrent()]),[true,true]);
  assert.equal(JSON.stringify([...values]),original);
  values.set(delta,serialized+' ');assert.equal(await read.assertCurrent(),false);
  read.close();await assert.rejects(read.assertCurrent,/STALE/);
});
test('owner cancellation stops a local source read before following another reference',async()=>{
  let canceled=false,reads=0;
  const capture=snapshot({primitives,createReadSession:adapter,read:async()=>{reads++;canceled=true;return '{}';}});
  await assert.rejects(()=>capture({scope:{scopeKey:'chat_'+h64('c\nh'),characterId:'c',chatId:'h'},maxCorpusBytes:4096},
    {check(){if(canceled)throw Error('LIB_READ_CANCELED');}}),/CANCELED/);
  assert.equal(reads,1);
});
