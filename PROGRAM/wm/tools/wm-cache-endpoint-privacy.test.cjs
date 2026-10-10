'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,plain}=require('./wm-native-cache-support.cjs');
const cfg=(url)=>({enabled:true,provider:'ollama',url,key:'synthetic-header-key',model:'tiny-3',timeout:120000});
const legacy=(m,url,dim=3)=>{const endpointHash=String(m.TokenizerEngine.simpleHash(url.replace(/\/+$/,'')));return {schema:'libra.embedding.fingerprint.v1',provider:'ollama',model:'tiny-3',endpointHash,dim,key:`ollama:tiny-3:${endpointHash}:${dim}`};};
test('RAM cache records and repaired-cache debug serialize neither endpoint secrets nor endpoint-derived hashes',async()=>{
 const f=await fixture(),m=f.r.api.MemoryEngine;m.clearDerivedCaches();
 const secrets=['synthetic-user-info','synthetic-password-value','synthetic-path-token','synthetic-query-token'];
 const url='http://'+secrets[0]+':'+secrets[1]+'@127.0.0.1:9999/'+secrets[2]+'/v1/embeddings?token='+secrets[3]+'&padding='+'x'.repeat(10000);
 m.CONFIG.embed={...cfg(url),provider:'openai'};
 f.r.host.nativeFetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify({data:[{embedding:[1,.25,-.5]}]})});
 assert.deepEqual(plain(await m.EmbeddingEngine.getEmbedding('Synthetic private endpoint witness')),[1,.25,-.5]);
 const cache=f.r.api.MemoryState.embeddingCache,serialized=JSON.stringify({entries:[...cache.cache],debug:m.EmbeddingEngine.getDebugSnapshot()});
 for(const secret of [...secrets,String(m.TokenizerEngine.simpleHash(url))])assert(!serialized.includes(secret),'repaired RAM record/debug contains no raw endpoint secret or endpoint-derived hash');
 assert(cache.stats.bytes>=url.length*2,'private exact witness bytes are charged to the existing bounded LRU');
 const count=m.EmbeddingEngine.getDebugSnapshot().cacheHits;await m.EmbeddingEngine.getEmbedding('Synthetic private endpoint witness');assert.equal(m.EmbeddingEngine.getDebugSnapshot().cacheHits,count+1);
 // The inherited public v1 diagnostic is intentionally unchanged, not covered by the RAM privacy guarantee.
 assert.equal(m.EmbeddingEngine.getFingerprintMeta([1,.25,-.5]).endpointHash,String(m.TokenizerEngine.simpleHash(url)));
});
test('public legacy fingerprint identity remains compatible with persisted v1 metadata',async()=>{
 const f=await fixture(),m=f.r.api.MemoryEngine,url='http://127.0.0.1:9999';m.CONFIG.embed=cfg(url);
 assert.deepEqual(plain(m.EmbeddingEngine.getFingerprintMeta([1,.25,-.5])),legacy(m,url));
});
test('actual integrity reader accepts saved/imported v1 fingerprint after a fresh runtime and still catches mismatches',async()=>{
 const f=await fixture(),url='http://127.0.0.1:9999',m=f.r.api.MemoryEngine;m.CONFIG.embed={...cfg(url),dimension:3};
 const fp=legacy(m,url),entry={key:'legacy-fingerprint',comment:'lmai_memory',content:'[META:'+JSON.stringify({t:1,embeddingFingerprint:fp})+']\nSynthetic saved legacy fingerprint'};
 assert.equal((await f.d.saveVerified(f.scope,[entry],{isCurrent:async()=>true})).ok,true);
 const saved=plain((await f.d.readVerified(f.scope)).entries),fresh=await fixture(),engine=fresh.r.api.MemoryEngine;engine.CONFIG.embed={...cfg(url),dimension:3};
 const scanner=fresh.r.context.LIBRA_IntegrityScanner;assert(scanner);scanner.resetState();scanner.scanBatch(saved,{scopeKey:fresh.scope,batchLimit:100,maxMs:1000});
 assert.equal(scanner.listFindings({type:'embedding_fingerprint_mismatch'}).length,0,'unchanged saved v1 space is accepted');
 const bad={...entry,content:'[META:'+JSON.stringify({t:1,embeddingFingerprint:{...fp,model:'other-model'}})+']\nSynthetic incompatible fingerprint'};
 scanner.resetState();scanner.scanBatch([bad],{scopeKey:fresh.scope,batchLimit:100,maxMs:1000});assert(scanner.listFindings({type:'embedding_fingerprint_mismatch'}).length>0,'compatibility reader remains active');
});
