'use strict';
const assert=require('node:assert/strict');
const acorn=require('acorn');
const {createOocGui}=require('./fixtures/libra_memory_ooc_gui_fixture.cjs');
// The current registered BOOK menu has no separately selectable compatibility shell.
// This seam only exposes the real retained closure; it does not replace a product function.
// Native registered-entry evidence is supplied by the other three unchanged-byte suites.
function exposeCompatibilityShell(source){
 const ast=acorn.parse(source,{ecmaVersion:'latest'}),declarations=[];
 const walk=node=>{if(!node||typeof node!=='object')return;if(node.type==='VariableDeclaration')for(const d of node.declarations)if(['ArrowFunctionExpression','FunctionExpression'].includes(d.init?.type))declarations.push({d,node,code:source.slice(d.init.start,d.init.end)});for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);};walk(ast);
 const shell=declarations.filter(x=>x.code.includes('libra-agent-prompts-memory-libra')).sort((a,b)=>a.code.length-b.code.length)[0];
 const binding=declarations.filter(x=>x.code.includes('.peekSnapshot()')&&x.code.includes('worldlineId')&&x.code.includes('openSerial')).sort((a,b)=>a.code.length-b.code.length)[0];
 assert(shell&&binding,'real compatibility shell and scope binding are retained');
 const core=binding.code.match(/([\w$]+)\.peekSnapshot\(/)?.[1];assert(core);
 const seam=`;globalThis.__LIBRA_OOC_TEST__={shell:()=>${shell.d.id.name}(),binding:()=>${binding.d.id.name}(),setWorldline:id=>{const value=${core}.peekSnapshot();value.continuityState={...(value.continuityState||{}),worldlineId:id};}};`;
 return source.slice(0,shell.node.end)+seam+source.slice(shell.node.end);
}
(async()=>{
 const h=await createOocGui({transformSource:exposeCompatibilityShell});const cases=[];
 try{
  await h.open();const seam=h.context.__LIBRA_OOC_TEST__;
  const main=h.document.querySelector('[data-render-region="main"]');assert(main);
  main.replaceChildren(seam.shell());assert.equal(h.ooc(),null);
  h.disclosure('Memory analysis prompts').open=true;await h.waitFor(()=>h.disclosure('고급 Prompt Studio · 구역별 직접 편집'));
  await h.expandOoc();assert.equal(h.document.querySelectorAll('#prompt-studio-ooc-builder').length,1);
  const ids=h.ooc().querySelector('select').querySelectorAll('option').map(n=>n.value);
  assert.deepEqual(ids,Array.from(h.api.debugPromptStudioOocTargets({})).filter(n=>n.domain==='memory').map(n=>n.id));
  assert.equal(h.modelCalls.length,0);assert.equal(h.promptWrites().length,0);cases.push('real retained shared shell mounts the same lazy memory-only OOC panel');
  let release;const pendingReply=new Promise(resolve=>{release=resolve;});h.modelQueue.push(()=>pendingReply);
  const input=h.ooc().querySelector('textarea');input.value='Preserve durable memory preference';await input.emit('input');
  const pending=h.button('OOC 보내기',h.ooc()).emit('click');await h.waitFor(()=>h.modelCalls.length===1);
  const initial=seam.binding();seam.setWorldline('synthetic-alternate');assert.notEqual(seam.binding().worldlineId,initial.worldlineId);assert.equal(seam.binding().openSerial,initial.openSerial);assert.equal(seam.binding().scopeKey,initial.scopeKey);
  release({type:'success',result:'STALE_WORLDLINE_REPLY'});await pending;
  assert(!h.ooc().textContent.includes('STALE_WORLDLINE_REPLY'));assert.equal(h.promptWrites().length,0);assert.equal(h.networkCalls.length,0);cases.push('worldline-only snapshot change invalidates a pending reply without save');
  console.log(JSON.stringify({status:'PASS',cases,boundary:'synthetic DOM; test-only lexical exposure of real shared-shell builder and snapshot worldline; not registered second route or native host proof'}));
 }finally{await h.cleanup();}
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
