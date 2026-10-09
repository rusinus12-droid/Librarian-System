'use strict';
// Private test adapter only: no shipping export or caller flag creates authority.
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./libra_recall_test_runtime.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
const entry = text => ({key:'lmai_memory::receipt',comment:'lmai_memory',content:text,custom:{nested:['owned']}});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
let originalCode, instrumentedCode;
async function fixture() {
  const r = await load({transformCode(code) {
    if (code === originalCode) return instrumentedCode;
    originalCode = code;
    const ast = require('acorn').parse(code, {ecmaVersion:'latest'}), found = {};
    const pending = [ast];
    while (pending.length) {
      const node=pending.pop(); if (!node || typeof node!=='object') continue;
      if (node.type==='VariableDeclarator' && ['LibraDataStorage','validationSources'].includes(node.id?.name)) {
        assert.equal(found[node.id.name],undefined,'unique private declaration');found[node.id.name]=node;
      }
      for (const value of Object.values(node)) if(Array.isArray(value))pending.push(...value);else if(value&&typeof value==='object')pending.push(value);
    }
    const inserts=[];
    for(const [name,statement] of [['LibraDataStorage','globalThis.__RECEIPTS__ = typeof validationSources === "undefined" ? null : validationSources;'],['validationSources','globalThis.__RECEIPT_SIZE__ = () => scopes.size;']]) {
      if(!found[name]) { assert.equal(name,'validationSources','storage declaration exists'); continue; }
      const body=found[name].init.callee.body.body, returns=body.filter(node=>node.type==='ReturnStatement');
      assert.equal(returns.length,1,'unique private module return');inserts.push({at:returns[0].start,text:statement});
    }
    for(const insert of inserts.sort((a,b)=>b.at-a.at))code=code.slice(0,insert.at)+insert.text+code.slice(insert.at);
    const unload = /RisuCompat\.onUnload\(async/g;
    assert.equal([...code.matchAll(unload)].length, 1, 'actual unload registration seam');
    code = code.replace(unload, '((handler)=>(globalThis.__UNLOAD__=handler,RisuCompat.onUnload(handler)))(async');
    const close = code.lastIndexOf('})();');
    instrumentedCode = code.slice(0,close) + '\n;globalThis.__RECEIPT_COMPAT__=RisuCompat;\n' + code.slice(close);
    return instrumentedCode;
  }});
  r.d = r.api.LibraDataStorage; r.v = r.context.__RECEIPTS__; r.compat = r.context.__RECEIPT_COMPAT__;
  assert.ok(r.v, 'private validation-source receipt foundation is present');
  r.v = { ...r.v, size: r.context.__RECEIPT_SIZE__ };
  r.scope = r.d.scopeKeyFor(r.char,r.chat); r.key = r.d.storageKeyFor(r.scope);
  r.raw = JSON.stringify({version:'1.0',scopeKey:r.scope,entryCount:1,updatedAt:17,resetGeneration:0,entries:[entry('A')]});
  await r.compat.pluginStorage.setItem(r.key,r.raw);
  r.owner = r.v.createOwner(r.scope); assert.ok(r.owner);
  return r;
}
async function acquired(r, owner=r.owner) { const receipt=await r.v.acquire(owner); assert.ok(receipt,'successful strict acquisition'); return receipt; }
function source(r, receipt, owner=r.owner) { return r.v.source(owner,receipt); }
function holdWrite(r, operation='setItem', mode='ok') {
  const entered=deferred(), gate=deferred(), original=r.compat.pluginStorage[operation];
  r.compat.pluginStorage[operation]=async (...args)=>{if(args[0]===r.key){entered.resolve();await gate.promise;if(mode==='throw_before')throw Error('lost_ack_before');}
    const result=await original(...args);if(args[0]===r.key&&mode==='throw_after')throw Error('lost_ack_after');return result;};
  return {entered:entered.promise,release:gate.resolve,restore:()=>{r.compat.pluginStorage[operation]=original;}};
}

test('each acquisition physically rereads strict storage and issues a fresh opaque token for exact issued source',async()=>{
  const r=await fixture();let reads=0;const get=r.compat.pluginStorage.getItem;
  r.compat.pluginStorage.getItem=async(key,options)=>{if(key===r.key){reads++;assert.equal(options.strict,true);}return get(key,options);};
  const a=await acquired(r), first=source(r,a);assert.equal(reads,1);assert.equal(first.raw,r.raw);assert.equal(r.d.isVerifiedReadonlyEntries(first.entries),true);
  const b=await acquired(r), second=source(r,b);assert.equal(reads,2);assert.notEqual(a,b);assert.equal(first,second,'only immutable source content can be reused');
  assert.equal(source(r,a),null,'old attempt is not a new observation');assert.equal(Object.keys(b).length,0);assert(Object.isFrozen(b));
  assert(Object.isFrozen(second.entries[0].custom.nested));assert.throws(()=>second.entries[0].custom.nested.push('forged'));
  assert.equal(r.v.matches(r.owner,b,second),true);
  for(const fake of [clone(second),{...second},Object.freeze({...second,entries:Object.freeze(second.entries.map(e=>Object.freeze({...e})))}),{...second,raw:second.raw+' '},{...second,resetGeneration:2}]) assert.equal(r.v.matches(r.owner,b,fake),false);
  r.v.close(r.owner);
});
test('forged, copied, cross-owner and cross-scope receipts never confer authority',async()=>{
  const r=await fixture(), a=await acquired(r), o2=r.v.createOwner(r.scope), b=await acquired(r,o2), other=r.v.createOwner(r.scope+'-other');
  for(const fake of [{},{...a},clone(a),Object.freeze({}),Object.create(a)])assert.equal(source(r,fake),null);
  assert.equal(source(r,a,o2),null);assert.equal(source(r,b),null);assert.equal(source(r,a,other),null);assert.equal(source(r,a,{}),null);
  r.v.close(r.owner);assert.ok(source(r,b,o2),'closing one owner preserves another');r.v.close(o2);r.v.close(other);
});
test('missing, corrupt, foreign, legacy-ambiguous and throwing reads revoke old proof and do not mint new proof',async()=>{
  const r=await fixture();const cases=[null,'bad',JSON.stringify({scopeKey:r.scope+'-foreign',entries:[]}),JSON.stringify({scopeKey:r.scope,resetGeneration:-1,entries:[]})];
  for(const raw of cases){const old=await acquired(r);raw===null?r.store.delete(r.key):r.store.set(r.key,raw);assert.equal(await r.v.acquire(r.owner),null);assert.equal(source(r,old),null);r.store.set(r.key,r.raw);}
  const old=await acquired(r),get=r.compat.pluginStorage.getItem;r.compat.pluginStorage.getItem=async()=>{throw Error('physical read unavailable');};
  assert.equal(await r.v.acquire(r.owner),null);assert.equal(source(r,old),null);r.compat.pluginStorage.getItem=get;assert.ok(await acquired(r));
  const explicit=r.v.createOwner(r.scope.replace(/persona:default$/,'persona:explicit'));
  assert.equal(await r.v.acquire(explicit),null,'default-persona fallback cannot mint proof');r.v.close(explicit);r.v.close(r.owner);
});
test('same-size changed bytes and external source updates require a new source object; missing chunks fail closed',async()=>{
  const r=await fixture(),a=await acquired(r),first=source(r,a);const changed=r.raw.replace('"A"','"B"');assert.equal(changed.length,r.raw.length);
  r.store.set(r.key,changed);const b=await acquired(r);assert.notEqual(source(r,b),first);assert.equal(source(r,a),null);
  await r.compat.pluginStorage.setItem(r.key,JSON.stringify({scopeKey:r.scope,entries:[entry('large '.repeat(120000))]}));
  const c=await acquired(r),manifest=JSON.parse(r.store.get(r.key));assert.ok(manifest.__libraChunkedStorageV1);r.store.delete(manifest.chunks[0]);
  assert.equal(await r.v.acquire(r.owner),null);assert.equal(source(r,c),null);r.v.close(r.owner);
});
test('a write beginning or settling while a physical read awaits cannot certify its old bytes',async()=>{
  const r=await fixture(),entered=deferred(),gate=deferred(),get=r.compat.pluginStorage.getItem;let first=true;
  r.compat.pluginStorage.getItem=async(...args)=>{const raw=await get(...args);if(args[0]===r.key&&first){first=false;entered.resolve();await gate.promise;}return raw;};
  const acquiring=r.v.acquire(r.owner);await entered.promise;assert.equal((await r.d.saveVerified(r.scope,[entry('B')],{isCurrent:async()=>true})).ok,true);
  gate.resolve();assert.equal(await acquiring,null);r.compat.pluginStorage.getItem=get;assert.equal(source(r,await acquired(r)).entries[0].content,'B');r.v.close(r.owner);
});
for(const writer of ['save','saveVerified','reset','remove']) for(const lateOwner of [false,true]) test(`${writer}: in-flight source mutation rejects receipts, including owner created ${lateOwner?'after':'before'} write start`,async()=>{
  const r=await fixture(), old=await acquired(r);if(lateOwner)r.v.close(r.owner);
  const operation=writer==='remove'?'removeItem':'setItem',hold=holdWrite(r,operation);
  const writing=writer==='save'?r.d.save(r.char,r.chat,[entry('B')]):writer==='saveVerified'?r.d.saveVerified(r.scope,[entry('B')],{isCurrent:async()=>true}):writer==='reset'?r.d.resetVerified(r.scope,{expectedGeneration:0,isCurrent:async()=>true}):r.d.remove(r.char,r.chat);
  await hold.entered;if(lateOwner)r.owner=r.v.createOwner(r.scope);
  assert.equal(source(r,old),null,'revoked before attempted physical mutation');assert.equal(await r.v.acquire(r.owner),null,'no authority while canonical write pending');
  hold.release();const result=await writing;assert.equal(writer==='remove'?result:result.ok,true,'writer does not self-invalidate');
  assert.equal(source(r,old),null);hold.restore();r.v.close(r.owner);
});
for(const writer of ['save','saveVerified','remove']) for(const mode of ['throw_before','throw_after']) test(`${writer}: uncertain ${mode} revokes old receipts before mutation and permits fresh recovery`,async()=>{
  const r=await fixture(),old=await acquired(r),hold=holdWrite(r,writer==='remove'?'removeItem':'setItem',mode);
  const writing=writer==='save'?r.d.save(r.char,r.chat,[entry('B')]):writer==='saveVerified'?r.d.saveVerified(r.scope,[entry('B')],{isCurrent:async()=>true}):r.d.remove(r.char,r.chat);
  await hold.entered;assert.equal(source(r,old),null);hold.release();await writing;hold.restore();assert.equal(source(r,old),null);
  if(writer==='remove')r.store.set(r.key,r.raw);const fresh=r.v.createOwner(r.scope);assert.ok(await acquired(r,fresh));r.v.close(fresh);r.v.close(r.owner);
});
test('local A to B to exact A does not revive an old receipt; unchanged save does not write or self-invalidate',async()=>{
  const r=await fixture(),a=await acquired(r);let writes=0;const set=r.compat.pluginStorage.setItem;r.compat.pluginStorage.setItem=async(...args)=>{writes++;return set(...args);};
  const unchanged=await r.d.save(r.char,r.chat,[entry('A')]);assert.equal(unchanged.ok,true);assert.equal(unchanged.unchanged,true);assert.equal(writes,0);assert.ok(source(r,a));
  assert.equal((await r.d.save(r.char,r.chat,[entry('B')])).ok,true);assert.equal(source(r,a),null);
  assert.equal((await r.d.save(r.char,r.chat,[entry('A')])).ok,true);r.store.set(r.key,r.raw);assert.equal(source(r,a),null,'equal bytes do not renew old phase');assert.equal(source(r,await acquired(r)).raw,r.raw);r.v.close(r.owner);
});
test('ordinary queued writer and reset cancellation ordering stays unchanged',async()=>{
  const r=await fixture(),hold=holdWrite(r);const first=r.d.save(r.char,r.chat,[entry('B')]);await hold.entered;
  const reset=r.d.resetVerified(r.scope,{expectedGeneration:0,isCurrent:async()=>true}),late=r.d.save(r.char,r.chat,[entry('late')]);
  hold.release();assert.equal((await first).ok,true);assert.equal((await reset).ok,true);assert.equal((await late).ok,false);
  const final=await r.d.readVerified(r.scope);assert.equal(final.resetGeneration,1);assert.equal(final.entries.length,0);r.v.close(r.owner);
});
test('runtime view invalidation is terminal and cannot affect a different scope owner',async()=>{
  const r=await fixture(),a=await acquired(r),otherScope=r.scope+'-other';r.store.set(r.d.storageKeyFor(otherScope),JSON.stringify({scopeKey:otherScope,entries:[entry('other')]}));
  const other=r.v.createOwner(otherScope),b=await acquired(r,other);r.d.invalidateRuntimeView(r.scope);assert.equal(source(r,a),null);assert.equal(await r.v.acquire(r.owner),null);
  assert.ok(source(r,b,other));r.v.close(other);r.v.close(r.owner);
});
test('close is terminal/idempotent and retained handles do not pin request owners or retired source roots',async()=>{
  assert.equal(typeof global.gc,'function','run with --expose-gc');const r=await fixture();let retained;
  const refs=await (async()=>{let owner=r.v.createOwner(r.scope);retained=await acquired(r,owner);let material=source(r,retained,owner);const refs=[new WeakRef(owner),new WeakRef(material.entries)];
    r.v.close(owner);r.v.close(owner);assert.equal(r.v.source(owner,retained),null);assert.equal(await r.v.acquire(owner),null);owner=null;material=null;return refs;})();
  r.v.close(r.owner);r.owner=null;
  r.store.set(r.key,JSON.stringify({scopeKey:r.scope,entries:[entry('replacement')]}));await r.d.readVerified(r.scope,{readonly:true});
  for(let i=0;i<12;i++){await tick();global.gc();}
  assert.equal(refs[0].deref(),undefined,'retained opaque receipt does not keep owner');assert.equal(refs[1].deref(),undefined,'closed private backing does not keep evicted immutable source');assert.equal(Object.keys(retained).length,0);
});
test('actual unload disposes before awaits, is idempotent, and late reads/writes cannot resurrect owners',async()=>{
  const r=await fixture(),a=await acquired(r),hold=holdWrite(r);const writing=r.d.saveVerified(r.scope,[entry('B')],{isCurrent:async()=>true});await hold.entered;
  const unloading=r.context.__UNLOAD__();assert.equal(r.v.size(),0,'actual unload hook disposes before any observer or cleanup await');assert.equal(source(r,a),null);assert.equal(await r.v.acquire(r.owner),null);assert.equal(r.v.createOwner(r.scope),null,'unloaded instance refuses new owners');
  hold.release();await writing;await unloading;await r.context.__UNLOAD__();assert.equal(source(r,a),null);assert.equal(await r.v.acquire(r.owner),null);
});
test('all owners and scope revisions retire after repeated scope churn, including disposal while read is pending',async()=>{
  const r=await fixture();r.v.close(r.owner);for(let i=0;i<80;i++){const owner=r.v.createOwner(r.scope+'-'+i);assert.ok(owner);r.v.close(owner);assert.equal(await r.v.acquire(owner),null);}
  r.owner=r.v.createOwner(r.scope);const get=r.compat.pluginStorage.getItem,entered=deferred(),gate=deferred();r.compat.pluginStorage.getItem=async(...args)=>{const raw=await get(...args);entered.resolve();await gate.promise;return raw;};
  const pending=r.v.acquire(r.owner);await entered.promise;r.v.close(r.owner);gate.resolve();assert.equal(await pending,null);r.compat.pluginStorage.getItem=get;
  assert.equal(r.v.size(),0,'no per-observed-scope historical revision registry');
});
test('actual factory baseline-owner prewrite exception releases the private write marker',async()=>{
  const r=await fixture(),old=await acquired(r);
  const options={get reanalysisBaselineToken(){throw Error('caller option getter failed');}};
  await assert.rejects(r.d.save(r.char,r.chat,[entry('changed')],options),/caller option getter failed/,'legacy rejection is preserved');assert.equal(source(r,old),null);
  assert.ok(await r.v.acquire(r.owner),'a failed prewrite callback cannot leave the scope permanently in flight');r.v.close(r.owner);assert.equal(r.v.size(),0);
});
for(const variant of ['changed','equal','late_failure','newer_closed','local_aba','reset','scope_recreated'])test(`cross-owner acquisition ordering: ${variant} cannot let a late old read replace or revoke a newer observation`,async()=>{
  const r=await fixture(),olderOwner=r.owner,entered=deferred(),gate=deferred(),get=r.compat.pluginStorage.getItem;let first=true;
  r.compat.pluginStorage.getItem=async(...args)=>{const raw=await get(...args);if(args[0]===r.key&&first){first=false;entered.resolve();await gate.promise;if(variant==='late_failure')throw Error('old read failed late');}return raw;};
  const older=r.v.acquire(olderOwner);await entered.promise;
  if(variant==='local_aba'){
    assert.equal((await r.d.saveVerified(r.scope,[entry('B')],{expectedGeneration:0,isCurrent:async()=>true})).ok,true);
    assert.equal((await r.d.saveVerified(r.scope,[entry('A')],{expectedGeneration:0,isCurrent:async()=>true})).ok,true);
    r.store.set(r.key,r.raw);
  }else if(variant==='reset')assert.equal((await r.d.resetVerified(r.scope,{expectedGeneration:0,isCurrent:async()=>true})).ok,true);
  else if(variant==='scope_recreated')r.v.close(olderOwner);
  else if(variant!=='equal')r.store.set(r.key,r.raw.replace('"A"','"B"'));
  const newerOwner=r.v.createOwner(r.scope),newer=await acquired(r,newerOwner),latest=source(r,newer,newerOwner);
  assert.equal(latest.raw,r.store.get(r.key));
  if(variant==='newer_closed')r.v.close(newerOwner);
  gate.resolve();assert.equal(await older,null,'a read started before the newer observation cannot issue late authority');
  if(variant!=='newer_closed')assert.equal(source(r,newer,newerOwner),latest,'discarding an older completion must preserve newer authority');
  r.v.close(olderOwner);r.v.close(newerOwner);assert.equal(r.v.size(),0);
});
test('a newer pending cross-owner read fences an older completion without replaying either physical read',async()=>{
  const r=await fixture(),aEntered=deferred(),bEntered=deferred(),aGate=deferred(),bGate=deferred(),get=r.compat.pluginStorage.getItem;let reads=0;
  r.compat.pluginStorage.getItem=async(...args)=>{const raw=await get(...args);if(args[0]===r.key){const order=++reads;if(order===1){aEntered.resolve();await aGate.promise;}if(order===2){bEntered.resolve();await bGate.promise;}}return raw;};
  const older=r.v.acquire(r.owner);await aEntered.promise;r.store.set(r.key,r.raw.replace('"A"','"B"'));const newerOwner=r.v.createOwner(r.scope),newer=r.v.acquire(newerOwner);await bEntered.promise;
  aGate.resolve();assert.equal(await older,null);bGate.resolve();const receipt=await newer;assert.ok(receipt);assert.equal(source(r,receipt,newerOwner).entries[0].content,'B');assert.equal(reads,2);
  r.v.close(r.owner);r.v.close(newerOwner);
});

test('observed acquisition carries the exact single strict read for issued, missing and failed outcomes',async()=>{
 const r=await fixture();assert.equal(typeof r.v.acquireObserved,'function','private observed acquisition exists');
 let reads=0;const get=r.compat.pluginStorage.getItem;r.compat.pluginStorage.getItem=async(...args)=>{if(args[0]===r.key)reads++;return get(...args)};
 const issued=await r.v.acquireObserved(r.owner);assert.equal(issued.status,'issued');assert.equal(reads,1);assert.equal(issued.read,source(r,issued.receipt));
 r.store.delete(r.key);const missing=await r.v.acquireObserved(r.owner);assert.equal(missing.status,'missing');assert.equal(reads,2);assert.equal(missing.receipt,null);assert.equal(missing.read.ok,true);assert.equal(missing.read.missing,true);
 r.store.set(r.key,'bad');const failed=await r.v.acquireObserved(r.owner);assert.equal(failed.status,'read_failed');assert.equal(reads,3);assert.equal(failed.receipt,null);assert.equal(failed.read.reason,'canonical_invalid');
 r.compat.pluginStorage.getItem=async()=>{reads++;throw Error('unavailable')};const unavailable=await r.v.acquireObserved(r.owner);assert.equal(unavailable.status,'read_failed');assert.equal(reads,4);assert.equal(unavailable.read.reason,'canonical_read_unavailable');r.v.close(r.owner);
});
test('observed acquisition distinguishes stale completion and busy/closed no-read outcomes',async()=>{
 const r=await fixture();assert.equal(typeof r.v.acquireObserved,'function');
 const entered=deferred(),gate=deferred(),get=r.compat.pluginStorage.getItem;let reads=0;
 r.compat.pluginStorage.getItem=async(...args)=>{const raw=await get(...args);reads++;entered.resolve();await gate.promise;return raw};
 const pending=r.v.acquireObserved(r.owner);await entered.promise;r.v.revoke(r.scope);gate.resolve();const stale=await pending;assert.equal(stale.status,'stale');assert.equal(stale.read.raw,r.raw);assert.equal(stale.receipt,null);assert.equal(reads,1);
 r.compat.pluginStorage.getItem=async(...args)=>{reads++;return get(...args)};
 const writing=r.v.beginWrite(r.scope);const busy=await r.v.acquireObserved(r.owner);assert.equal(busy.status,'busy');assert.equal(busy.read,null);assert.equal(reads,1);r.v.endWrite(writing);
 r.v.close(r.owner);const closed=await r.v.acquireObserved(r.owner);assert.equal(closed.status,'closed');assert.equal(closed.read,null);assert.equal(reads,1);
});
