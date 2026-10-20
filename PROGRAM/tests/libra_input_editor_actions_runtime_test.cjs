'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {JSDOM}=require('jsdom');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
test('LIBRA editor adds, restores deletions and defaults through the existing durable policy',async()=>{
 const dom=new JSDOM('<main></main>'),document=dom.window.document;
 const seam='const libraSourceInput = createLibraSourceInputPolicy(libraSourceInputConfig);';
 const f=await createLibraVmHarness({}, {},{contextGlobals:{document},transformSource:source=>{
  assert.equal(source.split(seam).length,2);return source.replace(seam,seam+' globalThis.__mountInput=mountLibraSourceInputControls;');
 }});
 try{
  const root=document.querySelector('main'),set=(node,value)=>{node.value=value;node.dispatchEvent(new dom.window.Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}));};
  const current=()=>JSON.parse(JSON.stringify(f.api.getSourceEditRules()));
  const writes=f.storageWrites.length;f.context.__mountInput(root);
  const find=selector=>root.querySelector(selector),rows=()=>[...root.querySelectorAll('[data-source-input-row]')];
  for(let i=0;i<50&&find('[data-source-input-add]').disabled;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(f.storageWrites.length,writes,'opening the rule editor writes nothing');
  const defaults=current();assert.ok(defaults.ignoredTags.includes('lb-xnai'));
  find('[data-source-input-add]').click();assert.ok(document.activeElement.matches('[data-rule-value]'));
  let row=rows().at(-1);set(row.querySelector('[data-rule-value]'),'custom_tag');
  set(row.querySelector('[data-rule-action]'),'unwrapTags');
  await find('[data-source-input-apply]').onclick();assert.ok(current().unwrapTags.includes('custom_tag'));
  row=rows().find(row=>row.querySelector('[data-rule-value]').value==='custom_tag');
  const index=rows().indexOf(row);set(row.querySelector('[data-rule-action]'),'sourceTags');
  row.querySelector('[data-rule-delete]').click();assert.equal(row.isConnected,false);
  find('[data-source-input-undo]').click();assert.equal(rows()[index],row);
  assert.equal(row.querySelector('[data-rule-action]').value,'sourceTags','undo preserves edited action and position');
  assert.ok(current().unwrapTags.includes('custom_tag'),'undo is still a local draft');
  await find('[data-source-input-apply]').onclick();assert.ok(current().sourceTags.includes('custom_tag'));
  const custom=current();find('[data-source-input-defaults]').click();assert.deepEqual(current(),custom);
  assert.match(find('[data-source-input-status]').textContent,/초안.*적용/);
  await find('[data-source-input-apply]').onclick();assert.deepEqual(current(),defaults);
  // Existing controller rejects a dropped durable write and retains the draft.
  find('[data-source-input-add]').click();set(document.activeElement,'retry_tag');
  const write=f.context.risuai.pluginStorage.setItem;f.context.risuai.pluginStorage.setItem=async()=>true;
  await find('[data-source-input-apply]').onclick();assert.deepEqual(current(),defaults);
  assert.match(find('[data-source-input-status]').textContent,/실패/);
  assert.ok([...root.querySelectorAll('[data-rule-value]')].some(n=>n.value==='retry_tag'));
  f.context.risuai.pluginStorage.setItem=write;await find('[data-source-input-apply]').onclick();assert.ok(current().ignoredTags.includes('retry_tag'));
  find('[data-source-input-defaults]').click();await find('[data-source-input-apply]').onclick();assert.deepEqual(current(),defaults,'factory restore clears saved custom ignored tags too');
 }finally{await f.cleanup();dom.window.close();}
});
