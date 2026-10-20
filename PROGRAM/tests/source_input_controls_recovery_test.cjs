'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const sdk=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceInput.libra.source.js'),'utf8');
const ui=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceInputControls.source.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
async function setup(owner,{fail=false}={}){
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),ctx=vm.createContext({});vm.runInContext(sdk+'\n'+ui,ctx);
 let stored=JSON.stringify({sourceRules:{version:1,ignoredTags:['custom-default'],unwrapTags:[],sourceTags:[],controls:[]},externalRulesVersion:1,keep:{future:true}}),writes=0,reads=0,busy=false;
 const config={owner,read:async()=>stored,write:async body=>{writes++;if(fail)return false;stored=body;return true;},busy:()=>busy,
  readSample:async()=>{reads++;return {text:'outside<original>keep<wrapper>wrapped</wrapper><drop>private</drop></original>',label:'마지막 메시지'};}};
 const policy=ctx.createMemorySuiteSourceInputPolicy(config),root=dom.window.document.querySelector('main');
 ctx.mountMemorySuiteSourceInputControls(root,{...config,policy});await policy.ready();for(let i=0;i<8;i++)await Promise.resolve();
 const find=q=>root.querySelector(q),set=(node,value)=>{node.value=value;node.dispatchEvent(new dom.window.Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}));};
 const add=(value,action='ignoredTags')=>{find('[data-source-input-add]').click();const input=dom.window.document.activeElement;assert.ok(input.matches('[data-rule-value]'));const row=input.closest('[data-source-input-row]');set(input,value);set(row.querySelector('[data-rule-action]'),action);return row;};
 return {root,find,set,add,policy,ctx,get stored(){return JSON.parse(stored);},get writes(){return writes;},get reads(){return reads;},busy:value=>busy=value,allowWrite:()=>fail=false,
  apply:()=>find('[data-source-input-apply]').onclick(),preview:()=>find('[data-source-input-preview]').onclick(),close:()=>{policy.dispose();dom.window.close();}};
}
for(const owner of ['hayaku','flashback']){
 test(owner+': add, delete and undo preserve edited values and order without saving',async()=>{const f=await setup(owner);try{
  const row=f.add('wrapper','unwrapTags');f.add('original','sourceTags');row.querySelector('[data-rule-delete]').click();
  assert.equal(f.root.contains(row),false);assert.equal(f.find('[data-source-input-undo]').disabled,false);
  f.find('[data-source-input-undo]').click();assert.equal(f.root.contains(row),true);assert.equal(row.querySelector('[data-rule-value]').value,'wrapper');assert.equal(row.querySelector('select').value,'unwrapTags');
  assert.deepEqual([...f.root.querySelectorAll('[data-rule-value]')].map(n=>n.value),['custom-default','wrapper','original','']);assert.equal(f.writes,0);assert.equal(f.reads,0);
  await f.apply();assert.deepEqual(f.stored.sourceRules.unwrapTags,['wrapper']);assert.deepEqual(f.stored.sourceRules.sourceTags,['original']);assert.deepEqual(f.stored.keep,{future:true});
 }finally{f.close();}});
 test(owner+': restore means factory defaults, stays a draft until verified Apply',async()=>{const f=await setup(owner);try{
  f.find('[data-source-input-defaults]').click();assert.deepEqual(f.stored.sourceRules.ignoredTags,['custom-default']);assert.equal(f.writes,0);
  assert.deepEqual([...f.root.querySelectorAll('[data-rule-value]')].map(n=>n.value).filter(Boolean),['lb-xnai','thoughts']);
  await f.apply();assert.deepEqual(f.stored.sourceRules.ignoredTags,['lb-xnai','thoughts']);assert.deepEqual(f.stored.sourceRules.controls,['html-comment','lbdata']);
 }finally{f.close();}});
 test(owner+': unsaved source selection, unwrapping and exclusion preview locally without chat or storage writes',async()=>{const f=await setup(owner);try{
  f.add('original','sourceTags');f.add('wrapper','unwrapTags');f.add('drop');await f.preview();
  assert.equal(f.find('[data-source-input-output]').textContent,'keepwrapped');assert.match(f.find('[data-source-input-preview-status]').textContent,/まだ|아직 적용하지 않은/);assert.equal(f.writes,0);assert.equal(f.reads,1);
  await f.apply();assert.equal(JSON.stringify(f.stored).includes('private'),false);assert.equal(f.reads,1);
 }finally{f.close();}});
 test(owner+': busy and rejected storage retain draft and prior active policy',async()=>{const f=await setup(owner,{fail:true});try{
  f.add('drop');f.busy(true);await f.apply();assert.equal(f.writes,0);f.busy(false);await f.apply();assert.match(f.find('[data-source-input-status]').textContent,/실패/);
  assert.deepEqual(plain(f.policy.sourceRules().ignoredTags),['custom-default']);assert.equal(f.find('[data-source-input-apply]').disabled,false);
  f.allowWrite();await f.apply();assert.deepEqual(f.stored.sourceRules.ignoredTags,['custom-default','drop']);
 }finally{f.close();}});
}
