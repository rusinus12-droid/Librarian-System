'use strict';
const assert = require('node:assert/strict');
// Independent test-only trace of the actual registered hook, usable against A1
// and A2. The signature trace adds a counted traversal; report that overhead.
function traceSource(source) {
  source='globalThis.__libraA2Trace={signatureCalls:0,signatureRefs:0,refFingerprints:0,catalogReconstructions:0,memoryLoads:0,vectorLoads:0,rawHistoryRows:0,sourceDigestPairs:0};\n'+source;
  for(const [name,prefix] of [
    ['recallCatalogSignature','globalThis.__libraA2Trace.signatureCalls++, globalThis.__libraA2Trace.signatureRefs+=listMemoryRefs(manifest).length'],
    ['recallCatalogRefFingerprint','globalThis.__libraA2Trace.refFingerprints++'],
    ['sourceDigest','globalThis.__libraA2Trace.sourceDigestPairs+=batch.length']
  ]){
    const re=new RegExp(`const ${name} = (\\w+) => ([\\s\\S]*?);\\n`);
    assert.equal((source.match(new RegExp(`const ${name} =`,'g'))||[]).length,1);
    assert.ok(re.test(source),name);
    source=source.replace(re,(_,arg,expression)=>`const ${name} = ${arg} => (${prefix}, ${expression});\n`);
  }
  for(const [needle,code] of [
    ['const recallCatalogEntryFromMemory = async ref => {','globalThis.__libraA2Trace.catalogReconstructions++;'],
    ['const loadMemoryRef = async ref => {','globalThis.__libraA2Trace.memoryLoads++;'],
    ['const loadVectorForMemory = async memory => {','globalThis.__libraA2Trace.vectorLoads++;'],
    ['const rawMessages = rawChatMessages(chat);','globalThis.__libraA2Trace.rawHistoryRows+=rawMessages.length;']
  ]){assert.equal(source.split(needle).length,2,needle);source=source.replace(needle,needle+code);}
  return source;
}
module.exports={traceSource};
