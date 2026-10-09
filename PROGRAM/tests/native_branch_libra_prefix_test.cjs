'use strict';
// Execute the production selector. Digest is a deterministic boundary adapter;
// full canonical storage/digest behavior is covered by native_branch_libra_runtime_test.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const s=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
function part(a,b){const i=s.indexOf(a),j=s.indexOf(b,i);assert(i>=0&&j>i);return s.slice(i,j)}
const code=part('    const nativeCopyPairSignature =','    const nativeCopySharedPrefixPairs =')+part('    const batchForStart =','    const transcript =')+part('    const nativeCopyExpectedCurrentStarts =','    const nativeCopyReceiptIsCompletenessVerified =');
const f=vm.runInNewContext(code+';({select:nativeCopyExpectedCurrentStarts,sourceDigest})',{BATCH_SIZE:5,string:x=>String(x??'').trim(),digest:x=>JSON.stringify(x),asArray:x=>Array.isArray(x)?x:[],asObject:x=>x&&typeof x==='object'?x:{}});
const pairs=Array.from({length:15},(_,i)=>({turn:i+1,user:{text:'U'+i,chatId:'u'+i},assistant:{text:'A'+i,chatId:'a'+i}}));
const manifest={memories:{}};for(const start of [1,6,11])manifest.memories[start]={status:'committed',key:'m'+start,turnRange:{start},sourceDigest:f.sourceDigest(pairs.slice(start-1,start+4))};
const result=(p,limit)=>Array.from(f.select(manifest,pairs,p,limit));
assert.deepEqual(result(pairs,7),[1]);assert.deepEqual(result(pairs,4),[]);assert.deepEqual(result(pairs,15),[1,6,11]);
const changed=structuredClone(pairs);changed[2].assistant.text='changed';assert.deepEqual(result(changed,15),[],'a reconverged later 5-turn range is not an ancestor');
const after=structuredClone(pairs);after[7].assistant.text='changed';assert.deepEqual(result(after,15),[1]);
manifest.memories[6].sourceDigest='stale revision';assert.deepEqual(result(pairs,10),[1]);
console.log(JSON.stringify({test:'native_branch_libra_prefix',passed:6}));
