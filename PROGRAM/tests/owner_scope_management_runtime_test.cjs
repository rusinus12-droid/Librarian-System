'use strict';
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let n=0;n<500;n++){if(fn())return;await delay(10);}throw Error('scope manager did not settle');}
const deadline=setTimeout(()=>{throw Error('scope management regression timeout');},60000);
(async()=>{
 for(const variant of variants.filter(row=>row[0]!=='flashback')){
  const f=await fixture(variant,{bridgeOptions:{scopeManagement:true}}),ns=variant[0],key=ns+'.B';
  try{
   const before=[...f.values];let c=await f.bridge.inspectScopeCatalog();
   assert.deepEqual([...f.values],before,'opening inventory is read-only');assert.equal(c.rows.length,3);
   assert.equal(c.rows.find(row=>row.scopeId==='A').current,true);assert.equal(c.rows.find(row=>row.scopeId==='B').current,false);
   assert.ok(!JSON.stringify(c).includes('B_SOURCE'),'catalog never contains memory bodies');
   const request=(catalog,id,action)=>({scopeId:id,action,expectedFingerprint:catalog.rows.find(row=>row.scopeId===id).fingerprint});
   await assert.rejects(()=>f.bridge.manageScope({scopeId:'missing',action:'sync',expectedFingerprint:'forged'}),/MANAGEMENT_CHANGED/);
   const stale=request(c,'B','sync');f.values.set(key,'B_NEW');await assert.rejects(()=>f.bridge.manageScope(stale),/MANAGEMENT_CHANGED/);f.values.set(key,'B_SOURCE');
   c=await f.bridge.inspectScopeCatalog();const result=await f.bridge.manageScope(request(c,'B','sync'));assert.equal(result.ok,true);
   assert.equal((await f.bridge.getScopeMode({scopeId:'B'})).mode,'plugin_only','copy never changes authority');
   await assert.rejects(()=>f.bridge.deletePluginStorageAfterServerVerification({scope:{scopeId:'B',scopeKey:'B'},preserveMode:true}),/MANAGEMENT_REQUIRES_SERVER_ONLY/);
   assert.equal(f.values.get(key),'B_SOURCE','retained-policy cleanup cannot erase a plugin-only original');
   let server=f.app.repositories[ns].database.prepare('SELECT key,value_json FROM kv WHERE deleted=0').all();
   assert.ok(server.some(row=>row.key===key&&JSON.parse(row.value_json)==='B_SOURCE'));
   assert.ok(!server.some(row=>row.key===ns+'.A'),'only the selected scope is copied');assert.equal(f.values.get(ns+'.A'),'A_SOURCE');
   f.values.set(key,'B_CONFLICT');c=await f.bridge.inspectScopeCatalog();
   await assert.rejects(()=>f.bridge.manageScope(request(c,'B','sync')),/scope_sync_incomplete/);
   assert.equal(f.values.get(key),'B_CONFLICT');server=f.app.repositories[ns].database.prepare('SELECT key,value_json FROM kv WHERE key=?').get(key);assert.equal(JSON.parse(server.value_json),'B_SOURCE');f.values.set(key,'B_SOURCE');
   await f.bridge.setGlobalMode('server_only');c=await f.bridge.inspectScopeCatalog();const registry=f.values.get(f.registryKey);
   await assert.rejects(()=>f.bridge.manageScope(request(c,'A','cleanup')),/CLEANUP_BLOCKED/);
   const cleaned=await f.bridge.manageScope(request(c,'B','cleanup'));assert.equal(cleaned.deleted,1);assert.equal(f.values.has(key),false);assert.equal(f.values.get(ns+'.A'),'A_SOURCE');
   assert.equal(f.values.get(f.registryKey),registry,'cleanup preserves the global and per-scope policy');
   c=await f.bridge.inspectScopeCatalog();const restored=await f.bridge.manageScope(request(c,'B','restore'));assert.equal(restored.restored,1);assert.equal(f.values.get(key),'B_SOURCE');
   assert.equal((await f.bridge.getScopeMode({scopeId:'B'})).mode,'server_only');

   c=await f.bridge.inspectScopeCatalog();assert.equal(c.rows.find(row=>row.scopeId==='B').canDelete,true);
   await f.bridge.setGlobalMode('plugin_only');c=await f.bridge.inspectScopeCatalog();
   const localRequest=request(c,'B','delete');assert.equal(c.rows.find(row=>row.scopeId==='B').canDelete,true);
   const originalRemove=f.store.removeItem.bind(f.store);f.store.removeItem=async name=>name===key?false:originalRemove(name);
   await assert.rejects(()=>f.bridge.manageScope(localRequest),error=>/SCOPE_DATA_DELETE_FAILED/.test(error.code)&&error.rollback.restored===true);
   assert.equal(f.values.get(key),'B_SOURCE','failed local deletion rolls back');f.store.removeItem=originalRemove;
   c=await f.bridge.inspectScopeCatalog();const backup=await f.bridge.manageScope(request(c,'B','export'));
   assert.equal(backup.records.find(row=>row.key===key).value,'B_SOURCE','explicit backup contains selected original');
   await assert.rejects(()=>f.bridge.manageScope(request(c,'A','delete')),/SCOPE_DATA_DELETE_BLOCKED/);
   const deleted=await f.bridge.manageScope(request(c,'B','delete'));assert.equal(deleted.deleted,1);assert.equal(f.values.has(key),false);
   assert.equal(f.values.get(ns+'.A'),'A_SOURCE','selected local deletion preserves other scopes');
   assert.equal(JSON.parse(f.app.repositories[ns].database.prepare('SELECT value_json FROM kv WHERE key=?').get(key).value_json),'B_SOURCE','local data deletion never changes server copy');
   console.log('PASS '+ns+': full catalog, selected copy, conflicts, stale requests, current-scope protection, cleanup and restore');
  }finally{await f.close();}
  const values=new Map(Array.from({length:337},(_,i)=>[ns+'.'+(i===0?'A':i===1?'B':'K'+i),'PRIVATE_BODY_'+i]));values.set(ns+'.ORPHAN','PRIVATE_ORPHAN');
  const catalog={characters:[{chaId:'one',name:'<img src=x onerror=bad>',chats:Array.from({length:337},(_,i)=>({id:i===0?'A':i===1?'B':'K'+i,name:'Chat '+i}))}]};
  const g=await fixture(variant,{values,catalog,adapter:async({hostScopes,records})=>({scopes:records.map(row=>{const id=row.logicalKey.slice(ns.length+1);return {scopeId:id,scopeKey:id,characterId:id==='ORPHAN'?'removed':'one',chatId:id};}),records:records.map(row=>({...row,classification:'scope',scopeId:row.logicalKey.slice(ns.length+1)})),blockers:[],completeKnownScopes:true}),bridgeOptions:{scopeManagement:true}}),dom=new JSDOM('<!doctype html><div id="host"></div>');
  try{
   const host=dom.window.document.getElementById('host');await g.bridge.mountScopeManagementPanel(host);
   const q=selector=>host.querySelector(selector);assert.match(q('[data-scope-summary]').textContent,/338/);
   assert.equal(host.querySelectorAll('[data-scope-row]').length,50,'bounded rendering does not cap the inventory');assert.equal(host.querySelectorAll('img').length,0,'native labels are escaped');
   q('[data-scope-filter]').value='detached';q('[data-scope-filter]').dispatchEvent(new dom.window.Event('change'));
   assert.equal(host.querySelectorAll('[data-scope-row]').length,1);assert.equal(q('[data-scope-row]').getAttribute('data-scope-row'),'ORPHAN');
   q('[data-scope-filter]').value='all';q('[data-scope-search]').value='K336';q('[data-scope-search]').dispatchEvent(new dom.window.Event('input'));
   assert.equal(host.querySelectorAll('[data-scope-row]').length,1,'search includes scopes beyond the first page');
   q('[data-scope-select-all]').checked=true;q('[data-scope-select-all]').dispatchEvent(new dom.window.Event('change'));assert.match(q('[data-scope-selection]').textContent,/1/);
   const pending=q('[data-scope-action="delete"]').onclick();await until(()=>q('[data-scope-confirm]').hidden===false);
   q('[data-scope-cancel]').click();await pending;assert.equal(g.values.get(ns+'.K336'),'PRIVATE_BODY_336');
   const json=q('[data-scope-diagnostics-text]').value;assert.ok(!json.includes('PRIVATE_BODY_'));
   g.host.getDatabase=async()=>{throw Error('HOST_UNAVAILABLE');};
   q('[data-scope-refresh]').click();await until(()=>!q('[data-scope-refresh]').disabled);
   assert.match(q('[data-scope-summary]').textContent,/미완료/);assert.ok(!JSON.parse(q('[data-scope-diagnostics-text]').value).rows.some(row=>row.canManage));
   g.context.crypto=undefined;const readOnly=await g.bridge.inspectScopeCatalog();
   assert.equal(readOnly.rows.length,338,'missing WebCrypto still permits viewing all local scopes');
   assert.ok(readOnly.blockers.some(row=>row.code==='scope_catalog_read_only_crypto_unavailable'));
   assert.ok(readOnly.rows.every(row=>!row.canManage&&!row.fingerprint),'unfingerprinted inventory cannot authorize a write');
   console.log('PASS '+ns+': 338 scopes, pagination, search, orphan filter, escaped names, cancellation and unavailable inventory');
  }finally{dom.window.document.getElementById('host').remove();dom.window.close();await g.close();}
 }

 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const plugin=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
 const fragment=plugin.slice(plugin.indexOf('// BEGIN LIBRA GLOBAL DISCOVERY ADAPTER'),plugin.indexOf('// END LIBRA GLOBAL DISCOVERY ADAPTER'));
 const stableDraftHash=value=>{let h=0x811c9dc5;for(const c of String(value).toLowerCase().replace(/[\s.,!?…。，、！？:;'"“”‘’()[\]{}<>#*_=`~|\\/—–-]+/g,''))h=Math.imul(h^c.charCodeAt(0),0x01000193);return(h>>>0).toString(16).padStart(8,'0');};
 const libraAdapter=vm.runInNewContext(fragment+'\nmemorySuiteLibraDiscoverGlobalScopes',{stableDraftHash});
 const key='libra:v1:scope:B:manifest',registryKey='libra:v1:scope-registry:v1';
 const registry={'two::B':{scopeKey:'B',characterId:'two',chatId:'B'},'missing::Z':{scopeKey:'Z',characterId:'missing',chatId:'Z'}};
 const data=JSON.stringify({schema:'libra.manifest.v1',scopeKey:'B',characterId:'two',chatId:'B',memories:{},inheritedMemories:[],padding:'x'.repeat(524288)});
 const chunks=Array.from({length:Math.ceil(data.length/524288)},(_,i)=>key+'::chunk:v1:stamp:'+String(i).padStart(4,'0'));
 const values=new Map([[registryKey,JSON.stringify(registry)],[key,JSON.stringify({__libraChunkedStorageV1:true,schemaVersion:1,key,length:data.length,chunks})],...chunks.map((key,i)=>[key,data.slice(i*524288,(i+1)*524288)])]);
 const f=await fixture(variants.find(row=>row[0]==='libra'),{values,adapter:libraAdapter,bridgeOptions:{scopeManagement:true,scopeRegistryKeys:[registryKey],pluginPrefixes:['libra:v1:'],resolveKeyScope:async()=>({kind:'scope',scopeId:'B',scopeKey:'B'})}});
 try{
  values.set(f.registryKey,JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:'libra',legacyGlobalModeImported:true,globalMigrationRemoteHistory:false,entries:{A:{scopeId:'A',scopeKey:'A',characterId:'one',chatId:'A',mode:'plugin_only',origin:'user_explicit'}}}));
  const request=(c,id,action)=>({scopeId:id,action,expectedFingerprint:c.rows.find(row=>row.scopeId===id).fingerprint});
  let c=await f.bridge.inspectScopeCatalog();assert.equal(c.completeKnownScopes,true);
  const orphan=c.rows.find(row=>row.scopeId==='Z');assert.equal(orphan.detached,true);assert.equal(orphan.registryEntries,1);assert.equal(orphan.canDelete,true);
  const staleB=request(c,'B','delete');await f.bridge.manageScope(request(c,'Z','prune'));
  assert.equal(JSON.parse(values.get(registryKey))['missing::Z'],undefined,'prune removes only selected empty registry entry');
  assert.ok(JSON.parse(values.get(registryKey))['two::B']);
  // An unrelated registry cleanup does not invalidate another selected data scope.
  const before=new Map(values),remove=f.store.removeItem.bind(f.store);
  f.store.removeItem=async name=>name===chunks[1]?false:remove(name);
  await assert.rejects(()=>f.bridge.manageScope(staleB),error=>error.rollback?.restored===true);
  for(const [name,value]of before)assert.equal(values.get(name),value,'partial physical deletion restores exact baseline '+name);
  f.store.removeItem=async name=>{const result=await remove(name);if(name===chunks[0])f.setCurrent('B');return result;};
  await assert.rejects(()=>f.bridge.manageScope(staleB),error=>/MANAGEMENT_CHANGED/.test(error.code)&&error.rollback?.restored===true);
  for(const [name,value]of before)assert.equal(values.get(name),value,'chat switch rolls back selected deletion '+name);
  f.setCurrent('A');f.store.removeItem=remove;c=await f.bridge.inspectScopeCatalog();assert.equal(c.completeKnownScopes,true,'rollback leaves no orphan physical chunks');
  await f.bridge.manageScope(request(c,'B','delete'));
  assert.equal(values.has(key),false);assert.ok(chunks.every(name=>!values.has(name)));assert.deepEqual(JSON.parse(values.get(registryKey)),{});
  c=await f.bridge.inspectScopeCatalog();assert.equal(c.completeKnownScopes,true);
  assert.equal(c.rows.some(row=>row.scopeId==='Z'),false,'pruned orphan registry no longer appears');
  console.log('PASS libra: native registry-only prune, independent selections, legacy chunks and failure rollback');
 }finally{await f.close();}
 const referenceAdapter=async({hostScopes,records})=>({scopes:hostScopes.map(scope=>({...scope,scopeId:scope.chatId,scopeKey:scope.chatId})),records:records.map(row=>({...row,classification:'scope',scopeId:row.logicalKey.slice('hayaku.'.length),dependencyKeys:row.logicalKey==='hayaku.A'?['hayaku.B']:[]})),blockers:[],completeKnownScopes:true});
 const protectedFixture=await fixture(variants[0],{adapter:referenceAdapter,bridgeOptions:{scopeManagement:true}});
 try{const c=await protectedFixture.bridge.inspectScopeCatalog(),b=c.rows.find(row=>row.scopeId==='B');assert.equal(b.referenced,true);assert.equal(b.canDelete,false);
  await assert.rejects(()=>protectedFixture.bridge.manageScope({scopeId:'B',action:'delete',expectedFingerprint:b.fingerprint}),/SCOPE_DATA_DELETE_BLOCKED/);assert.equal(protectedFixture.values.get('hayaku.B'),'B_SOURCE');
  console.log('PASS hayaku: cross-scope references block local deletion');
 }finally{await protectedFixture.close();}
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(deadline));
