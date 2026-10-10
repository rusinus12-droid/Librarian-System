'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {test}=require('node:test');const {check}=require('./fixtures/flashback_gui_inventory_contract.cjs');
const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
const program=path.resolve(__dirname,'..');
test('inventory contract accepts coherent growth and rejects missing controls and audit rows',async()=>{
 const h=await createFlashback(program);
 try{
  const source=fs.readFileSync(path.join(program,'plugins/Flashback_Memory.js'),'utf8'),html=await h.api._test.buildUiHtml();
  const input={api:h.api,html,source};check(input);
  assert.throws(()=>check({...input,html:html.replace('id="argSetting_lexicalWeight"','id="removedControl"')}),/rendered control missing: lexical_weight/);
  assert.throws(()=>check({...input,html:html.replace(/<tr data-argument-row="lexical_weight">[\s\S]*?<\/tr>/,'')}),/rendered audit covers/);
  assert.throws(()=>check({...input,html:html.replace('aria-controls="panel-restore"','aria-controls="missing-restore"')}),/matching panel/);
  const extra={name:'fixture_extra',key:'fixtureExtra',group:'general'},t=h.api._test;
  const augmented={_test:{...t,flashbackArgumentSettingFields:[...t.flashbackArgumentSettingFields,extra],flashbackArgumentSettingRows:()=>[...t.flashbackArgumentSettingRows(),{...extra,editable:true,controlId:'argSetting_fixtureExtra'}],argumentSettingControlForKey:k=>k==='fixtureExtra'?'argSetting_fixtureExtra':t.argumentSettingControlForKey(k)}};
  check({api:augmented,source:source+'\n//@arg fixture_extra string Additional current setting\n',html:html+'<input id="argSetting_fixtureExtra"><tr data-argument-row="fixture_extra"></tr>'});
  assert.equal(h.networkCalls.length,0);
 }finally{await h.cleanup();}
});
