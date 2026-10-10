'use strict';
// Required explicit artifact directory: missing actual builds are a failure, never a skip.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {verify,expected}=require('./execution_task_profiles_test.cjs');
const acorn=require('../tools/build_plugins.cjs').resolveAcorn();
assert.ok(acorn,'Offline Acorn toolchain required');
const artifactRoot=process.env.EXECUTION_PROFILE_ARTIFACTS;
assert.ok(artifactRoot,'Set EXECUTION_PROFILE_ARTIFACTS to actual Full/Min build parent');
const names=['LIBRA.js','Flashback_Memory.js','HAYAKU_Locator_Continuity.js'];
const report=[];
for(const variant of ['Full','Min']) for(const name of names) {
  const file=path.join(artifactRoot,variant,'plugins',name),src=fs.readFileSync(file,'utf8');
  const ast=acorn.parse(src,{ecmaVersion:'latest',sourceType:'script'}),matches=[];
  function walk(node) {
    if(!node||typeof node!=='object')return;
    if(node.type==='CallExpression'&&['ArrowFunctionExpression','FunctionExpression'].includes(node.callee.type)) {
      const body=src.slice(node.start,node.end);
      if(body.includes('Embedding dimensions must be auto')&&body.includes('Unregistered generation task:')&&body.includes('memory-suite.invocation-plan.v1'))matches.push(node);
    }
    for(const [key,value] of Object.entries(node))if(!['start','end'].includes(key)) {
      if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);
    }
  }
  walk(ast);matches.sort((a,b)=>(a.end-a.start)-(b.end-b.start));assert.ok(matches.length,'Actual contract IIFE not found: '+file);
  const node=matches[0],expression=src.slice(node.start,node.end);
  const C=vm.runInNewContext('('+expression+')',{URL,URLSearchParams,TextEncoder,TextDecoder,setTimeout,clearTimeout},{timeout:1000});
  verify(C,expected(name));
  // Physical ledger, vectors and classified terminal semantics run against each actual artifact.
  const ledger=C.createLedger({maxRequests:1});const row=ledger.reserve('metadata');ledger.settle(row,'outcome_unknown');
  assert.equal(ledger.snapshot().pendingRequests,1);assert.throws(()=>ledger.reserve(),e=>e.code==='EMBEDDING_PHYSICAL_PENDING');
  assert.throws(()=>C.vector([0,0]),e=>e.code==='INVALID_RESPONSE');assert.throws(()=>C.vector([1,2],{dimensions:3}),e=>e.code==='DIMENSION_MISMATCH');
  assert.equal(C.completion({content:'{}',finishReason:'length'}).state,'truncated');assert.equal(C.completion({content:'{}'}).state,'unknown');
  report.push({variant,name,sha256:crypto.createHash('sha256').update(src).digest('hex'),contractStart:node.start,contractEnd:node.end,tasks:Object.keys(C.TASK_DEFAULTS).length});
}
console.log(JSON.stringify({test:'execution_task_profiles_artifact',providerCalls:0,artifacts:report},null,2));
