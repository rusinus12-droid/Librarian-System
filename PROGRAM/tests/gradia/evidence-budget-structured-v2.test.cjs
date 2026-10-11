'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createMeter,request,transformBoth,envelope,sha}=require('./fixtures/gradia-budget-profile.cjs');
const source=fs.readFileSync(path.resolve(__dirname,'../../plugins/GRADIA.js'),'utf8');
const start=source.indexOf('  const ANALYSIS_SCHEMA ='),end=source.indexOf('  const analysisSourceMaterialRules =',start);
assert.ok(start>0&&end>start);
const patchConstant=source.match(/const SERIAL_DRAFT_PATCH_SCHEMA\s*=\s*(['"])([^'"\r\n]+)\1;/);assert.ok(patchConstant);
const constructors=vm.runInNewContext('const SERIAL_DRAFT_PATCH_SCHEMA='+JSON.stringify(patchConstant[2])+';\n'+source.slice(start,end)+'\n({analysisJsonSchemaForStage,aidePatchJsonSchemaForStage})',{}, {timeout:100});
const formats=[];
for(const stage of ['shadow_act','aide_character','aide_world','aide_plot'])for(const phase of ['analysis',...(stage==='shadow_act'?[]:['patch'])])formats.push(JSON.parse(JSON.stringify({type:'json_schema',json_schema:{name:`gradia_${stage}_${phase}`,strict:true,schema:constructors[phase==='analysis'?'analysisJsonSchemaForStage':'aidePatchJsonSchemaForStage'](stage)}})));
const inputFor=format=>transformBoth(request({output:4096}),body=>({...body,response_format:format}));
test('seven actual normal/heavy schema wrappers are pinned and fully charged in the exact envelope',async()=>{
 for(const format of formats){
  const input=inputFor(format),meter=createMeter(),result=await meter.evaluate(input),bytes=Buffer.byteLength(JSON.stringify(format));
  assert.equal(result.status,'available',format.json_schema.name);assert.equal(result.fits,true);
  assert.equal(result.witness.structuredSchemaName,format.json_schema.name);
  assert.equal(result.witness.structuredSchemaSha256,sha(JSON.stringify(format)));
  assert.equal(result.witness.structuredSchemaByteAllowance,bytes);
  assert.ok(result.witness.finalInputAllowance>=Buffer.byteLength(input.finalBody)+bytes,'schema has an explicit additional conservative framing allowance');
  assert.equal(result.witness.effectiveOutputReserve,4096);assert.equal(result.witness.safetyMargin,6400);
  assert.equal(result.witness.finalPayloadHash,sha(input.finalBody));assert.equal(meter.assertDispatch(result.witness,envelope(input)),true);
 }
});
test('schema/name/strictness/hash drift and arbitrary fields remain unavailable',async()=>{
 const base=formats[0];
 for(const change of [f=>{f.json_schema.name+='_retry';},f=>{f.json_schema.name='gradia_aide_character_patch';},f=>{f.json_schema.strict=false;},f=>{f.json_schema.schema.description='unqualified change';},f=>{f.json_schema.schema.$ref='external';},f=>{f.json_schema.schema.properties.extra={type:'string'};},f=>{f.extra=true;}]){
  const altered=structuredClone(base);change(altered);const result=await createMeter().evaluate(inputFor(altered));assert.equal(result.status,'unavailable');assert.equal(result.reason,'token_accounting_unavailable');
 }
 for(const format of [{type:'json_object'},{type:'json_schema',json_schema:{name:'arbitrary',strict:true,schema:{type:'object'}}}])assert.equal((await createMeter().evaluate(inputFor(format))).status,'unavailable');
 const tools=transformBoth(inputFor(base),body=>({...body,tools:[]}));assert.equal((await createMeter().evaluate(tools)).status,'unavailable');
});
test('structured allowance cannot hide a context overflow or changed dispatch schema',async()=>{
 const input=inputFor(formats[0]);input.context.limit=10000;const meter=createMeter(),result=await meter.evaluate(input);
 assert.equal(result.status,'available');assert.equal(result.fits,false);assert.throws(()=>meter.assertDispatch(result.witness,envelope(input)),/WITNESS/);
 const good=inputFor(formats[1]),accepted=await meter.evaluate(good);const changed=JSON.parse(good.finalBody);changed.response_format.json_schema.strict=false;
 assert.throws(()=>meter.assertDispatch(accepted.witness,{...envelope(good),body:JSON.stringify(changed)}),/DISPATCH_CHANGED/);
});
test('schema hashing await cannot substitute caller-mutated body or context',async()=>{
 const input=inputFor(formats[0]),original={...input},oldBody=input.finalBody;let release,calls=0;
 const meter=createMeter(value=>{calls++;return calls===1?new Promise(resolve=>{release=()=>resolve(sha(value));}):sha(value);});
 const pending=meter.evaluate(input);assert.equal(typeof release,'function');
 input.finalBody='changed after admission';input.context.limit=1;release();
 const result=await pending;assert.equal(result.fits,true);assert.equal(result.witness.contextLimit,128000);
 assert.equal(result.witness.finalPayloadHash,sha(oldBody));assert.equal(meter.assertDispatch(result.witness,envelope(original)),true);
 assert.throws(()=>meter.assertDispatch(result.witness,envelope(input)),/DISPATCH_CHANGED/);
});
