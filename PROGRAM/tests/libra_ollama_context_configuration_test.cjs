'use strict';
// Regression for the measured discrepancy: common preflight honored the preset
// context, while the native adapter silently used a separate 32K default.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
const start=source.indexOf('  const ollamaContextWindowTokens ='),end=source.indexOf('  const ollamaPromptRatioKey =',start);
assert.ok(start>=0&&end>start);
const context=vm.createContext({text:x=>String(x??''),tryJsonParse:(x,f)=>{try{return JSON.parse(x);}catch{return f;}},
  clampInt:(x,min,max,f)=>Number.isFinite(Number(x))?Math.max(min,Math.min(max,Math.trunc(Number(x)))):f});
vm.runInContext(source.slice(start,end)+';globalThis.read=ollamaContextWindowTokens;',context);
assert.equal(context.read({}),32768);
assert.equal(context.read({context_window:131072}),131072,'the native adapter must honor the manual context setting');
assert.equal(context.read({context_window:262144}),262144);
assert.equal(context.read({context_window:131072,extra_body_json:'{"options":{"num_ctx":65536}}'}),65536,'explicit native override has precedence');
assert.equal(context.read({model:'m',metadata_model_id:'m',catalog_context_window:131072}),131072);
assert.equal(context.read({model:'new-model',metadata_model_id:'old-model',catalog_context_window:131072}),32768,'stale catalog metadata is not authoritative');
console.log('PASS Ollama native context follows manual/catalog settings and explicit overrides');
