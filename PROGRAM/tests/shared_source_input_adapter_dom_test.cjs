'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom'),{ownerFixture}=require('./fixtures/shared_reanalysis_owner_fixture.cjs');
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
for(const owner of ['hayaku','flashback'])test(owner+' real input-policy adapter previews its actual current normalizer locally',async()=>{
 const options={};if(owner==='flashback')options.source=fs.readFileSync(path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8')
  .replace('  publicApi._test.renderFlashbackSourceEditStatus =','  publicApi._test.getSourceInput=getFlashbackSourceInput;publicApi._test.normalizeInput=canonicalChatResponseText;\n  publicApi._test.renderFlashbackSourceEditStatus =');
 const f=await ownerFixture(owner,options),dom=new JSDOM('<main></main>');
 try{
  f.edit('<unknown>LOCAL_OWNER_PREVIEW</unknown><Thoughts>PRIVATE_REASONING_MARKER</Thoughts><lb-xnai>{{inlay::image}}</lb-xnai>');
  const raw=f.chat.message[1].data,api=f.api._test,policy=owner==='hayaku'?api.getHayakuSourceInput():api.getSourceInput();
  const expected=owner==='hayaku'?api.canonicalHistoryText(raw,'assistant'):api.normalizeInput(raw),root=dom.window.document.querySelector('main');
  const writes=[],set=f.store.setItem.bind(f.store);f.store.setItem=async(k,v)=>{writes.push(v);return set(k,v)};
  policy.mountControls(root);await policy.ready();await tick();assert.equal(root.querySelectorAll('[data-source-input-list]').length,1);
  await root.querySelector('[data-source-input-preview]').onclick();assert.equal(root.querySelector('[data-source-input-output]').textContent,expected);
  assert.equal(f.calls(),0);assert.equal(writes.some(v=>String(v).includes('LOCAL_OWNER_PREVIEW')),false);
  assert.equal(root.querySelectorAll('unknown').length,0,'sample is rendered only as text');
  await f.api.setSourceEditRules({version:1,ignoredTags:['thoughts'],unwrapTags:['unknown'],sourceTags:[],controls:[]});
  assert.equal(f.calls(),0);assert.ok((await f.records()).some(r=>JSON.stringify(r).includes('Alice signed the agreement.')),'rule edit does not invalidate prior memory');
 }finally{await f.dispose();dom.window.close();}
});
