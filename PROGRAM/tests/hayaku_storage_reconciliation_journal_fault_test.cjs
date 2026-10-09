'use strict';
// Execute the production journal functions with a faultable storage boundary.
// Assert physical records, not just the in-memory cache or success flags.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const program = process.argv[2] || path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(program, 'plugins/HAYAKU_Locator_Continuity.js'), 'utf8');
const start = source.indexOf('  const emptyStorageReconciliationJournal =');
const end = source.indexOf('  const storageReconciliationReadbackSupersedesEntry =', start);
assert(start >= 0 && end > start);
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function fixture() {
  const schema = 'hayaku.storage_reconciliation_journal.v1';
  const prior = { id:'prior', key:'hayaku.v2.ledger.prior', scopeKey:'prior-scope', serializedHash:'prior-hash', createdAt:Date.now() };
  let physical = JSON.stringify({schema, version:1, entries:[prior]});
  let reads = 0, writes = 0, readFault = '', writeFault = '';
  const Memory = {storageReconciliationJournalQueue:Promise.resolve(), storageReconciliationJournalLoaded:false, storageReconciliationJournalCache:null, storageReconciliationJournalStats:{loads:0,writes:0,failed:0}};
  const api = vm.runInNewContext(source.slice(start,end) + '\n;({upsert:upsertStorageReconciliationJournalEntry, remove:removeStorageReconciliationJournalEntries, load:loadStorageReconciliationJournal});', {
    Memory, STORAGE_RECONCILIATION_JOURNAL_SCHEMA:schema, STORAGE_RECONCILIATION_JOURNAL_KEY:'journal', STORAGE_RECONCILIATION_JOURNAL_MAX_ENTRIES:64, STORAGE_RECONCILIATION_JOURNAL_TTL_MS:14*86400000,
    now:()=>Date.now(), objectish:v=>v && typeof v==='object' && !Array.isArray(v), compact:(v,n)=>String(v??'').slice(0,n), ensureArray:v=>Array.isArray(v)?v:[], finiteNonNegativeInteger:(v,f)=>Number.isFinite(Number(v))?Math.max(0,Math.floor(Number(v))):f,
    safeJsonParse:(v,f)=>{try{return JSON.parse(v);}catch{return f;}}, stableHash64:hash,
    RisuCompat:{
      getStorageItemOutcome:async()=>{reads++;return readFault ? {state:readFault,reason:'injected_read_fault'} : {state:'fulfilled',value:physical};},
      setStorageItemOutcome:async(k,v)=>{
        writes++;
        if(writeFault==='rejected') return {state:'rejected',reason:'injected_write_rejection'};
        if(writeFault==='readback_rejected') readFault='rejected';
        if(writeFault==='readback_timeout') readFault='indeterminate';
        if(!writeFault) physical=v;
        return {state:'fulfilled'};
      }
    }
  });
  return {api,Memory,ids:()=>JSON.parse(physical).entries.map(row=>row.id),stats:()=>({reads,writes}),readFault:value=>{readFault=value;},writeFault:value=>{writeFault=value;},heal:()=>{readFault='';writeFault='';},add:()=>api.upsert({id:'new',key:'hayaku.v2.ledger.new',scopeKey:'new-scope',serializedHash:'new-hash'}, {records:[]})};
}
(async()=>{
  const results=[];
  const check=async(name,fn)=>{try{await fn();results.push({name,status:'PASS'});}catch(e){results.push({name,status:'FAIL',error:e.message});}};
  for(const fault of ['rejected','indeterminate']) await check(`cold ${fault} read cannot replace existing journal`,async()=>{
    const f=fixture();f.readFault(fault);
    await assert.rejects(f.add(),e=>e.code==='HAYAKU_STORAGE_RECONCILIATION_JOURNAL_READ_UNCONFIRMED');
    assert.equal(f.stats().writes,0);assert.deepEqual(f.ids(),['prior']);assert.equal(f.Memory.storageReconciliationJournalLoaded,false);
    f.heal();assert.equal((await f.add()).durable,true);assert.deepEqual(f.ids(),['prior','new']);
  });
  for(const fault of ['rejected','indeterminate']) await check(`forced ${fault} read invalidates older cache`,async()=>{
    const f=fixture();await f.api.load();f.readFault(fault);
    await assert.rejects(f.api.load(true));await assert.rejects(f.add());
    assert.equal(f.stats().writes,0);assert.deepEqual(f.ids(),['prior']);
  });
  for(const fault of ['rejected','noop','readback_rejected','readback_timeout']) await check(`failed removal ${fault} is re-read before a later add`,async()=>{
    const f=fixture();await f.api.load();f.writeFault(fault);
    const removal=await f.api.remove(['prior']);
    assert.equal(removal.durable,false);assert.notEqual(removal.state,'fulfilled');
    assert.deepEqual(f.ids(),['prior']);assert.equal(f.Memory.storageReconciliationJournalLoaded,false);assert.equal(f.Memory.storageReconciliationJournalCache,null);
    f.heal();const readsBefore=f.stats().reads;
    assert.equal((await f.add()).durable,true);assert(f.stats().reads>=readsBefore+2,'physical reload plus write readback required');assert.deepEqual(f.ids(),['prior','new']);
    assert.equal((await f.api.remove(['new'])).durable,true);assert.deepEqual(f.ids(),['prior']);
  });
  console.log(JSON.stringify({test:'hayaku_storage_reconciliation_journal_fault_test',passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,cases:results}));
  if(results.some(r=>r.status==='FAIL')) process.exitCode=1;
})();
