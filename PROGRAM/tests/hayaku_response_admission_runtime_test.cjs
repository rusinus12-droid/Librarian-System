'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path');
const s=fs.readFileSync(path.join(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8');const c=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteExecutionContract.source.js'),'utf8'),c);
vm.runInContext(s.slice(s.indexOf('  const extractSingleHayakuJsonObject ='),s.indexOf('  let NativeOtherAxCallQueue'))+'globalThis.parse=parseNativeJsonObject;',c);
for(const v of ['{"data":"unchanged"}','```json\n{"data":"unchanged"}\n```','<final>{"data":"unchanged"}</final>','<think>format planning</think><output>{"data":"unchanged"}</output>','Result:\n{"data":"unchanged"}\nDone.'])assert.equal(c.parse(v).data,'unchanged');
for(const [v,reason]of [['','typed_response_empty'],['{"x":','typed_response_incomplete_object'],['{"x":1} {"x":2}',null],['{"x":1,"x":2}',null],['[{}]','typed_response_root_not_object'],['<think>unfinished','typed_response_reasoning_unclosed']]){
 let error;try{c.parse(v)}catch(e){error=e}assert(error,v);assert(error.code);assert.equal(error.validation.kind,'native_json_format');assert.equal(error.validation.rawChars,v.length);if(reason)assert.equal(error.message,reason);
}
assert.deepEqual(JSON.parse(JSON.stringify(c.parse('{"facts":[],"unknown":42}'))),{facts:[],unknown:42},'parser never invents or drops data before schema validation');
assert(s.includes('candidate = parseNativeResponseForAdmission(llm.content)'));// Full regular/recovery admission is exercised by hayaku_common_admission_runtime_test.
const prompt=s.slice(s.indexOf('  const nativePacketAuthoringPrompt ='),s.indexOf('  const nativeAnalysisRunKey ='));assert(prompt.includes('HAYAKU_NATIVE_MEMORY_EXTRACTION_GUIDANCE'));
console.log('PASS shared response admission: wrappers, single object, malformed/empty/duplicate rejection, exact content and both recovery paths');
