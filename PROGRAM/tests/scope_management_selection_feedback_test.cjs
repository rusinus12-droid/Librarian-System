'use strict';
// A scope row that cannot be selected must say why. Before this contract a disabled box looked
// like a dead control ("clicking the box does nothing"). Real shared panel code (libra and hayaku
// variants), real bridge fixture, jsdom DOM; no replacement UI.
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){for(let n=0;n<500;n++){if(await fn())return;await delay(10);}throw Error('timed out: '+label);}
const deadline=setTimeout(()=>{throw Error('scope selection feedback test timeout');},90000);
const adapter=ns=>async({records})=>({scopes:records.map(row=>{const id=row.logicalKey.slice(ns.length+1);return {scopeId:id,scopeKey:id,characterId:'one',chatId:id};}),
  records:records.map(row=>({...row,classification:'scope',scopeId:row.logicalKey.slice(ns.length+1)})),blockers:[],completeKnownScopes:true});
const mount=async(g,dom)=>{const host=dom.window.document.getElementById('host');await g.bridge.mountScopeManagementPanel(host);
  const q=selector=>host.querySelector(selector);await until(()=>!/확인하고 있습니다/.test(q('[data-scope-summary]').textContent),'catalog');return {host,q};};
const rowOf=(host,id)=>host.querySelector(`[data-scope-row="${id}"]`);
(async()=>{
 for(const variant of variants.filter(row=>row[0]!=='flashback')){
  const ns=variant[0];
  const values=new Map([[ns+'.A','A_SOURCE'],[ns+'.B','B_SOURCE'],[ns+'.C','C_SOURCE']]);
  const catalog={characters:[{chaId:'one',name:'인물',chats:['A','B','C'].map(id=>({id,name:'채팅 '+id}))}]};
  // 1) plugin-only: other chats are selectable, the current chat says why it is not.
  let g=await fixture(variant,{values:new Map(values),catalog,adapter:adapter(ns),bridgeOptions:{scopeManagement:true}}),dom=new JSDOM('<!doctype html><div id="host"></div>');
  try{
   const {host,q}=await mount(g,dom);
   assert.equal(q('[data-scope-readonly]').hidden,true,`${ns}: no read-only banner on a secure context`);
   const current=rowOf(host,'A'),other=rowOf(host,'B');
   assert.equal(current.getAttribute('data-selectable'),'false');assert.match(current.querySelector('[data-scope-reason]').textContent,/현재 열려 있는 채팅/);
   assert.equal(other.getAttribute('data-selectable'),'true');assert.equal(other.querySelector('[data-scope-reason]'),null);
   const box=other.querySelector('[data-scope-select]');assert.equal(box.disabled,false);box.checked=true;box.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
   assert.match(q('[data-scope-selection]').textContent,/1/,`${ns}: selecting a row responds`);
   current.querySelector('td[data-scope-select-cell]').dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));
   assert.match(q('[data-scope-result]').textContent,/선택할 수 없음 · 현재 열려 있는 채팅/,`${ns}: clicking a blocked box explains why`);
   assert.match(current.querySelector('[data-scope-select]').getAttribute('aria-label'),/현재 열려 있는 채팅/,'the reason is also the accessible name');
   // Flashback-style: ticking is allowed; the action decides. Pruning only covers list leftovers, so a scope with data is skipped with a reason.
   const prune=q('[data-scope-action=prune]'),del=q('[data-scope-action=delete]');
   assert.equal(prune.disabled,true,`${ns}: prune is off while only a scope with data is ticked`);
   assert.equal(del.disabled,false,`${ns}: delete is on for a ticked scope that can be deleted`);
   prune.disabled=false;prune.onclick();
   await until(()=>/실행할 수 있는 스코프가 없습니다/.test(q('[data-scope-result]').textContent),'skip explanation');
   assert.match(q('[data-scope-result]').textContent,/자료가 있어 목록 정리 대상이 아닙니다/,`${ns}: the skip names the reason`);
   assert.equal(q('[data-scope-confirm]').hidden,true,`${ns}: nothing to confirm when every ticked row is skipped`);
   assert.equal(g.values.get(ns+'.B'),'B_SOURCE',`${ns}: skipped data is untouched`);
  }finally{dom.window.close();await g.close();}
  // 2) Local copies remain selectable in server mode; the server option checks its own inventory.
  g=await fixture(variant,{values:new Map(values),catalog,adapter:adapter(ns),bridgeOptions:{scopeManagement:true}});dom=new JSDOM('<!doctype html><div id="host"></div>');
  try{
   g.values.set(g.registryKey,JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:ns,legacyGlobalModeImported:true,globalMigrationRemoteHistory:false,entries:{
     A:{scopeId:'A',scopeKey:'A',characterId:'one',chatId:'A',mode:'plugin_only',origin:'user_explicit'},
     B:{scopeId:'B',scopeKey:'B',characterId:'one',chatId:'B',mode:'server_only',origin:'user_explicit'}}}));
   const {host,q}=await mount(g,dom);
   assert.equal(rowOf(host,'B').getAttribute('data-selectable'),'true',`${ns}: retained local data can be selected in server mode`);
   const menu=q('[data-scope-delete-target]');assert.deepEqual(Array.from(menu.options,o=>o.value),['local','server','both']);
   menu.value='server';menu.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await until(()=>!q('[data-scope-refresh]').disabled,'server inventory');
   const row=rowOf(host,'B');assert.equal(row.getAttribute('data-selectable'),'false',`${ns}: absent server data is not reported as deletable`);
   row.querySelector('td[data-scope-select-cell]').dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));
   assert.match(q('[data-scope-result]').textContent,/선택한 위치|서버 자료.*확인/);
  }finally{dom.window.close();await g.close();}
  // 3) no WebCrypto (http / insecure context): the catalog is view-only and the panel says so.
  g=await fixture(variant,{values:new Map(values),catalog,adapter:adapter(ns),bridgeOptions:{scopeManagement:true}});dom=new JSDOM('<!doctype html><div id="host"></div>');
  try{
   g.context.crypto=undefined;
   const {host,q}=await mount(g,dom);
   assert.equal(q('[data-scope-readonly]').hidden,false,`${ns}: insecure context shows the read-only banner`);
   assert.match(q('[data-scope-readonly]').textContent,/https 또는 localhost/);
   assert.match(rowOf(host,'B').querySelector('[data-scope-reason]').textContent,/보안 연결이 아니어서 목록 보기만 가능/);
   assert.ok([...host.querySelectorAll('[data-scope-select]')].every(box=>box.disabled),'nothing is selectable without a fingerprint');
  }finally{dom.window.close();await g.close();}
  // 4) References allow selection/backup, but deletion skips the referenced
  // row with an explicit reason while processing an independent selected row.
  const referencedAdapter=async input=>{const result=await adapter(ns)(input);result.records=result.records.map(row=>({...row,dependencyKeys:row.logicalKey===ns+'.A'?[ns+'.B']:[]}));return result;};
  g=await fixture(variant,{values:new Map(values),catalog,adapter:referencedAdapter,bridgeOptions:{scopeManagement:true}});dom=new JSDOM('<!doctype html><div id="host"></div>');
  try{
   const {host,q}=await mount(g,dom),referenced=rowOf(host,'B');
   assert.equal(referenced.querySelector('[data-scope-select]').disabled,false,'referenced scope remains selectable');
   assert.match(referenced.querySelector('[data-scope-reason]').textContent,/참조 중.*삭제·정리.*제외/);
   for(const id of ['B','C']){const box=rowOf(host,id).querySelector('[data-scope-select]');box.checked=true;box.dispatchEvent(new dom.window.Event('change',{bubbles:true}));}
   assert.equal(q('[data-scope-action=export]').disabled,false,'referenced bytes can be backed up');
   const pending=q('[data-scope-action=delete]').onclick();
   await until(()=>!q('[data-scope-confirm]').hidden,'mixed selection confirmation');
   assert.match(q('[data-scope-confirm-text]').textContent,/제외 1개.*보존/s);
   assert.match(q('[data-scope-confirm-text]').textContent,/참조 중.*삭제·정리/s);
   const ack=q('[data-scope-delete-ack]');ack.checked=true;ack.dispatchEvent(new dom.window.Event('change',{bubbles:true}));q('[data-scope-approve]').click();await pending;
   assert.equal(g.values.get(ns+'.B'),'B_SOURCE','referenced bytes stay untouched');
   assert.equal(g.values.has(ns+'.C'),false,'independent selected scope is deleted');
   assert.match(q('[data-scope-result]').textContent,/완료 1\/1개.*제외 1개/s);
  }finally{dom.window.close();await g.close();}
  console.log('PASS '+ns+': blocked scope rows explain why; selectable rows respond');
 }
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(deadline));
