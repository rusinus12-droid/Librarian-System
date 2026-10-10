'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('../server/authority/contracts.cjs');
const codecFile = path.resolve(__dirname, '../server/authority/receipt-codec.cjs');
const vectors = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures/authority-preserved/receipt-extension-golden-vectors.json'), 'utf8'));
function codec() {
  assert(fs.existsSync(codecFile), 'bounded receipt codec must exist as a separate profile');
  return require(codecFile);
}
const shape = n => ({ ok: true, result: { schema: 'memory-suite.storage.batch-receipt.v1', namespace: 'libra', operationId: 'fixture-codec-operation', atomicScope: 'single_namespace_sqlite', durable: true, verified: true, committedAt: 1, receipts: Array.from({ length: n }, (_, i) => ({ kind: 'set', space: 'plugin', key: 'libra:codec:' + i, revision: 1, digest: 'a'.repeat(64), tombstone: false, committedAt: 1 })), checked: 0 } });

test('generic_control_canonical_bounds_are_not_broadened', () => {
  assert.throws(() => C.canonical('x'.repeat(1048576)), /INVALID_AUTHORITY_JSON/);
  assert.throws(() => C.canonical(Array(65536).fill(0)), /INVALID_AUTHORITY_JSON/);
  const M = codec();
  assert.equal(M.LIMITS.originalResultBytes, 134217728);
  assert.equal(M.LIMITS.compactReceiptBytes, 65536);
  assert.equal(M.LIMITS.touchRowBytes, 32768);
  assert.equal(M.LIMITS.touchedBytes, 268435456);
  assert.equal(M.LIMITS.touchedKeys, 8192);
});

test('result_scanner_matches_key_inclusive_canonical_nodes_and_depth', () => {
  const M = codec();
  assert.equal(M.scanResultJson(JSON.stringify(shape(4096))).nodes, 61463);
  assert.equal(M.scanResultJson(JSON.stringify(Array(65535).fill(0))).nodes, 65536);
  assert.throws(() => M.scanResultJson(JSON.stringify(Array(65536).fill(0))), /RESOURCE_LIMIT/);
  assert.doesNotThrow(() => M.scanResultJson('['.repeat(32) + '0' + ']'.repeat(32)));
  assert.throws(() => M.scanResultJson('['.repeat(33) + '0' + ']'.repeat(33)), /RESOURCE_LIMIT/);
  const oldParse = JSON.parse; let parses = 0;
  JSON.parse = () => { parses++; throw Error('SCANNER_MUST_NOT_PARSE'); };
  try { M.scanResultJson('{"escaped":"\\ud800","pair":"😀"}'); }
  finally { JSON.parse = oldParse; }
  assert.equal(parses, 0);
});

test('result_scanner_accepts_exact_original_JSON_and_rejects_invalid_grammar', () => {
  const M = codec();
  for (const value of ['null', 'true', 'false', '-0', '1.25e-3', '[]', '{}', '{"x":[null,true,1,"한😀\\n\\u0000"]}', '{"x":"\\ud800"}']) assert.doesNotThrow(() => M.scanResultJson(value), value);
  for (const value of ['', '[1,]', '{"x":1,}', '{x:1}', '01', '1e', '1e309', '[', '{"x":"\n"}', '{"x":"\\uGGGG"}', 'true false', '{"x":NaN}']) assert.throws(() => M.scanResultJson(value), /INVALID_JSON|RESOURCE_LIMIT/, value);
});

test('golden_original_bytes_compact_metadata_and_empty_touch_hash_match', () => {
  const M = codec(), original = vectors.ordinaryResult;
  assert.equal(Buffer.byteLength(original.originalJson), original.utf8Bytes);
  assert.equal(M.hashUtf8(original.originalJson), original.sha256);
  assert.equal(C.canonical(vectors.compactReceipt.json), vectors.compactReceipt.canonicalJson);
  assert.equal(M.hashUtf8(C.canonical(vectors.compactReceipt.json)), vectors.compactReceipt.canonicalSha256);
  const compact = vectors.compactReceipt.json;
  assert.doesNotThrow(() => M.validateCompactReceipt(compact, { operationKey: vectors.operationKey, physicalBinding: compact.physicalBinding, ownerBinding: compact.ownerBinding }));
  for (const sample of vectors.sourceSequences) {
    const hash = M.createTouchHasher(vectors.operationKey);
    sample.rows.forEach((row, ordinal) => { assert.equal(Buffer.from(M.encodeTouch(row)).toString('hex'), sample.rowCanonicalUtf8Hex[ordinal]); hash.update(ordinal, row); });
    assert.deepEqual(hash.finish(), { count: sample.count, utf8Bytes: sample.utf8Bytes, sha256: sample.sha256 });
  }
});

test('UTF8_hash_preserves_emoji_at_every_chunk_boundary_without_whole_buffer', () => {
  const M = codec();
  const text = 'A'.repeat(65535) + '😀한B';
  const expected = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const update = crypto.Hash.prototype.update; let calls = 0;
  crypto.Hash.prototype.update = function(value, ...args) { calls++; assert((typeof value === 'string' ? value.length : value.byteLength) <= 65536, 'bounded hash chunk'); return update.call(this, value, ...args); };
  try { assert.equal(M.hashUtf8(text), expected); }
  finally { crypto.Hash.prototype.update = update; }
  assert(calls >= 2);
  assert.equal(M.hashUtf8('A😀B'), vectors.utf16ChunkBoundaryVectors[0].expectedSha256);
  assert.notEqual(vectors.utf16ChunkBoundaryVectors[2].wrongIndependentChunksSha256, M.hashUtf8('A😀B'));
});

test('touch_hasher_checks_contiguity_and_reserves_item_credits', () => {
  const M = codec(), row = vectors.sourceSequences[1].rows[0];
  assert.throws(() => M.createTouchHasher(vectors.operationKey).update(1, row), /INVALID|RESOURCE_LIMIT/);
  const hash = M.createTouchHasher(vectors.operationKey);
  for (let i = 0; i < 8192; i++) hash.update(i, { ...row, key: 'libra:touch:' + i });
  assert.throws(() => hash.update(8192, row), /RESOURCE_LIMIT/);
  assert.equal(hash.finish().count, 8192);
  assert.throws(() => M.encodeTouch({ ...row, key: 'x'.repeat(4097) }), /PROFILE|RESOURCE_LIMIT/);
  assert.throws(() => M.encodeTouch({ ...row, sourceId: 'x'.repeat(241) }), /INVALID|QUARANTINED/);
});

test('numeric_tokens_use_only_approved_result_budgets_and_match_parsed_number_safety',()=>{
 const M=codec();
 const values=[
  '1.'+'0'.repeat(2048),
  '-0.'+'0'.repeat(2048),
  '0e'+'9'.repeat(2048),
  '-0e-'+'9'.repeat(2048),
  '9'.repeat(2048)+'e-2048',
  '0.'+'0'.repeat(2048)+'1e2049',
  '1'+'0'.repeat(2048)+'e-2048',
  '1e-'+'9'.repeat(2048),
  '9007199254740991.4'+'9'.repeat(2048),
  '9007199254740991.5',
  '-9007199254740991.5',
  '9007199254740992',
  '1e'+'9'.repeat(2048),
  '9'.repeat(2048)+'e-2032',
  '1e309',
  '1e308'
 ];
 for(const text of values){
  const parsed=JSON.parse(text),admitted=Number.isFinite(parsed)&&(!Number.isInteger(parsed)||Number.isSafeInteger(parsed));
  if(admitted)assert.doesNotThrow(()=>M.scanResultJson(text),'valid bounded token length '+text.length);
  else assert.throws(()=>M.scanResultJson(text),/INVALID_JSON|RESOURCE_LIMIT/,'invalid numeric value length '+text.length);
 }
 assert(Object.is(JSON.parse(values[1]),-0));assert.equal(JSON.parse(values[7]),0);
 const parse=JSON.parse;JSON.parse=()=>{throw Error('NUMERIC_SCANNER_MUST_NOT_PARSE');};
 try{assert.doesNotThrow(()=>M.scanResultJson(values[0]));}finally{JSON.parse=parse;}
});
