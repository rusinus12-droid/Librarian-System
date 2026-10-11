"use strict";
// Deterministic offline provider vectors exercise the real configured-model
// adapter. They represent fixture entities/concepts, never production hashing.
const {createFixture}=require('./flashback_native_runtime_fixture.cjs');
const concepts=[/수정구슬|crystal/i,/망토|cloak/i,/민수|Minsu/i,/아리아|Aria/i,/Alice|brass key/i,/니콜로|Nicolo/i,/Mary Jane/i];
const dimensions=concepts.length+1;
function vector(text){const result=concepts.map(pattern=>pattern.test(String(text))?1:0);result.push(result.some(Boolean)?0:1);const norm=Math.hypot(...result);return result.map(value=>value/norm);}
async function createModelFixture(options={}){return createFixture({...options,nativeFetch:async(url,init)=>{
 if(!String(url).startsWith('https://recall.fixture.invalid/'))throw Error('Unexpected fixture transport route');
 const body=JSON.parse(init.body);if(!Array.isArray(body.input))throw Error('Expected real batched model input');
 return new Response(JSON.stringify({data:body.input.map((text,index)=>({index,embedding:vector(text)}))}),{status:200});
}});}
const modelSettings={embeddingProvider:'openai_compat',embeddingModel:'recall-fixture',embeddingUrl:'https://recall.fixture.invalid/v1',embeddingKey:'fixture-only',embeddingDimensions:dimensions,embeddingEnabled:true};
module.exports={createModelFixture,modelSettings};
