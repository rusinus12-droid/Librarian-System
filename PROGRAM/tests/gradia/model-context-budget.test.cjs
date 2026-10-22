'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const factory=new Function(fs.readFileSync(path.join(__dirname,'../../sdk/GradiaModelContextBudget.source.js'),'utf8')+'\nreturn createGradiaModelContextBudget;')();
const meter=()=>factory({digest:sha});
function request({format='chat_completions',model='configured-model',context=262144,output=32768,user='Current input',evidence='Complete source evidence'}={}){
 const messages=[{role:'system',content:'Keep the current scene.'},{role:'user',content:user}];
 let body;
 if(format==='chat_completions')body={model,messages,max_completion_tokens:output,reasoning_effort:'medium'};
 if(format==='responses')body={model,input:messages.map(m=>({role:m.role,content:[{type:'input_text',text:m.content}]})),max_output_tokens:output};
 if(format==='anthropic')body={model,system:'Native system',messages:[messages[1]],max_tokens:output,output_config:{format:{type:'json_schema',schema:{type:'object',properties:{text:{type:'string'}}}}}};
 if(format==='gemini')body={systemInstruction:{parts:[{text:'Native system'}]},contents:[{role:'user',parts:[{text:user}]}],generationConfig:{maxOutputTokens:output,responseMimeType:'application/json',responseJsonSchema:{type:'object'}}};
 if(format==='ollama_native')body={model,messages,options:{num_predict:output,num_ctx:context},format:'json'};
 const baseBody=JSON.stringify(body),m=meter();
 const finalBody=m.replaceEvidence(baseBody,format,model,'',evidence);
 const providerId='configured-provider',routeIdentity='https://configured.invalid/generate';
 return {providerId,modelId:model,routeIdentity,requestFormat:format,context:{source:'configured',sourceIdentity:'preset:current',limit:context,providerId,modelId:model,routeIdentity},baseBody,finalBody,renderedEvidence:evidence,renderedByteLimit:4*1024*1024};
}
const envelope=input=>({providerId:input.providerId,modelId:input.modelId,routeIdentity:input.routeIdentity,requestFormat:input.requestFormat,method:'POST',body:input.finalBody});
test('Unicode reference and evidence use configured tokens separately from transport bytes',async()=>{
 const input=request({user:'가'.repeat(96000),evidence:'나'.repeat(30000)}),m=meter(),r=await m.evaluate(input);
 assert.equal(r.fits,true);assert(r.witness.serializedPayloadBytes>128000);assert(r.witness.renderedEvidenceBytes>65536);
 assert.equal(r.witness.contextLimit,262144);assert.equal(r.witness.effectiveOutputReserve,32768);
 assert.equal(r.witness.meterKind,'unicode-text-estimate-plus-framing');assert(r.witness.finalInputAllowance<r.witness.serializedPayloadBytes);
 assert.equal(m.assertDispatch(r.witness,envelope(input)),true);
});
for(const format of ['chat_completions','responses','anthropic','gemini','ollama_native'])test(format+' counts its actual final output field and complete payload',async()=>{
 const input=request({format}),m=meter(),r=await m.evaluate(input);
 assert.equal(r.fits,true,JSON.stringify(r));assert.equal(r.witness.effectiveOutputReserve,32768);assert.equal(m.assertDispatch(r.witness,envelope(input)),true);
 assert.throws(()=>m.assertDispatch(r.witness,{...envelope(input),body:input.finalBody+' '}));
 assert.throws(()=>m.assertDispatch(r.witness,{...envelope(input),routeIdentity:'https://other.invalid'}));
});
test('native text, schemas, actual output and safety all consume model context',()=>{
 const m=meter(),input=request({context:8192,output:4096,user:'가'.repeat(5000)}),r=m.inspect(input);
 assert.equal(r.fits,false);assert.equal(r.reason,'model_context_exceeded');
 const smaller=request({context:8192,output:1024,user:'가'.repeat(5000)});assert.equal(m.inspect(smaller).fits,true);
 const body=JSON.parse(smaller.finalBody);body.response_format={type:'json_schema',json_schema:{schema:{description:'가'.repeat(7000)}}};
 const changed={...smaller,finalBody:JSON.stringify(body)};changed.baseBody=m.replaceEvidence(changed.finalBody,changed.requestFormat,changed.modelId,changed.renderedEvidence,'');
 assert.equal(m.inspect(changed).fits,false);
});
test('byte resource cap remains independent, bounded before JSON.parse',()=>{
 const input=request({user:'x'.repeat(3000)}),m=meter();let parses=0;const original=JSON.parse;
 try{JSON.parse=(...a)=>{parses++;return original(...a);};const r=m.inspect({...input,payloadByteLimit:100});assert.equal(r.reason,'payload_budget_exceeded');assert.equal(parses,0);}finally{JSON.parse=original;}
});
test('model metadata and native prompt changes cannot be resealed as evidence',async()=>{
 const input=request(),m=meter();
 for(const patch of [{limit:0},{modelId:'changed'},{providerId:'changed'},{routeIdentity:'https://other.invalid'}])assert.equal(m.inspect({...input,context:{...input.context,...patch}}).status,'unavailable');
 const final=JSON.parse(input.finalBody);final.messages[0].content='changed policy';assert.equal(m.inspect({...input,finalBody:JSON.stringify(final)}).reason,'payload_binding_changed');
 const r=await m.evaluate(input);assert.throws(()=>m.assertDispatch({...r.witness},envelope(input)));
});
test('a caller cannot replace the body during a digest await',async()=>{
 let release;const input=request(),original=input.finalBody,m=factory({digest:async s=>{await new Promise(r=>release=r);return sha(s);}}),pending=m.evaluate(input);
 input.finalBody='changed';release();const r=await pending;assert.equal(r.witness.finalPayloadHash,sha(original));
 assert.throws(()=>m.assertDispatch(r.witness,envelope(input)));
});
test('accessors and inherited request fields cannot replace the inspected body',async()=>{
 let reads=0;const input=request(),m=meter();
 Object.defineProperty(input,'finalBody',{get(){reads++;return '{}';},enumerable:true});
 assert.equal((await m.evaluate(input)).status,'unavailable');assert.equal(reads,0);
 assert.equal(m.inspect(Object.create(request())).status,'unavailable');
});
test('multimodal content and malformed text are not silently undercounted',()=>{
 const input=request(),m=meter(),body=JSON.parse(input.finalBody);body.messages[0].content=[{type:'image_url',image_url:{url:'x'}}];
 assert.equal(m.inspect({...input,finalBody:JSON.stringify(body)}).status,'unavailable');
 assert.throws(()=>request({user:'\ud800'}),/unsupported_text/);
});
test('only the exact shared-reference cache markers on system parts are accepted',async()=>{
 const anthropic=marker=>{const body={model:'configured-model',system:[{type:'text',text:'Shared reference',...marker},{type:'text',text:'Native system'}],messages:[{role:'user',content:'Current input'}],max_tokens:4096};return JSON.stringify(body);};
 const chat=(systemMarker,userMarker)=>JSON.stringify({model:'configured-model',messages:[{role:'system',content:[{type:'text',text:'Shared reference',...systemMarker}]},{role:'user',content:[{type:'text',text:'Current input',...userMarker}]}],max_completion_tokens:4096});
 const m=meter();
 assert.ok(m.replaceEvidence(anthropic({cache_control:{type:'ephemeral'}}),'anthropic','configured-model','','Evidence'));
 assert.ok(m.replaceEvidence(chat({prompt_cache_breakpoint:{mode:'explicit'}},{}),'chat_completions','configured-model','','Evidence'));
 for(const [body,format] of [[anthropic({cache_control:{type:'ephemeral',ttl:'1h'}}),'anthropic'],[anthropic({cache_control:{type:'persistent'}}),'anthropic'],
  [chat({},{prompt_cache_breakpoint:{mode:'explicit'}}),'chat_completions'],[chat({},{cache_control:{type:'ephemeral'}}),'chat_completions'],[chat({other:true},{}),'chat_completions']])
  assert.throws(()=>m.replaceEvidence(body,format,'configured-model','','Evidence'),/payload_format_unsupported|LIB_READ|unsupported/);
});
