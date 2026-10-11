'use strict';
const assert=require('node:assert/strict');
const transformSource=source=>{
 const readerStart=source.indexOf('    const readActiveMicroMemory = async '),readerEnd=source.indexOf('\n    };',readerStart)+7;
 assert.ok(readerStart>0&&readerEnd>readerStart);let reader=source.slice(readerStart,readerEnd);
 for(const [anchor,phase] of [['head = await storage.getVerifiedJson(headKey, scope, null);','hydration'],['finalHead = await storage.getVerifiedJson(headKey, scope, null);','physical-reread']]){
  assert.equal(reader.split(anchor).length,2);reader=reader.replace(anchor,anchor.replace('await storage.getVerifiedJson(headKey, scope, null)','await observeMicroHeadRead(\''+phase+'\', headKey, () => storage.getVerifiedJson(headKey, scope, null))'));
 }
 source=source.slice(0,readerStart)+reader+source.slice(readerEnd);
 const corpusStart=source.indexOf('    const activeMicroRecallCorpus = async '),corpusEnd=source.indexOf('\n    };',corpusStart)+7;
 assert.ok(corpusStart>0&&corpusEnd>corpusStart);let corpus=source.slice(corpusStart,corpusEnd);
 const catalog='const head = await storage.getVerifiedJson(headKey, scope, null);';assert.equal(corpus.split(catalog).length,2);
 corpus=corpus.replace(catalog,"const head = await observeMicroHeadRead('catalog', headKey, () => storage.getVerifiedJson(headKey, scope, null));");
 source=source.slice(0,corpusStart)+corpus+source.slice(corpusEnd);
 const seam='    const readActiveMicroMemory = async ';assert.equal(source.split(seam).length,2);
 return source.replace(seam,`    const observeMicroHeadRead = (phase, headKey, read) => {
      (globalThis.__MICRO_HEAD_READS__ ||= []).push({ phase, headKey });
      return read();
    };
    globalThis.__MICRO_HEAD_READ_TEST__ = { readActive: (...args) => readActiveMicroMemory(...args) };
${seam}`);
};
module.exports={transformSource};
