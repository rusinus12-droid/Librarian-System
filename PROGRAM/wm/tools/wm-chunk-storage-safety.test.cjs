'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,seed,SIZE,SENTINEL}=require('./wm-chunk-storage-fixture.cjs');
const rows=[];
const plain=x=>JSON.parse(JSON.stringify(x));
const snapshot=f=>[...f.values];
async function check(name,fn){try{await fn();rows.push({name,ok:true});console.log('PASS '+name);}catch(e){rows.push({name,ok:false,error:e.message,stack:e.stack});console.log('FAIL '+name+' '+e.message);}if(global.gc)global.gc();}
const bad={
 foreign:m=>m.chunks[0]='foreign-scope',prefix_lookalike:m=>m.chunks[0]='target-other::chunk:v1:legacy:0000',
 wrong_root:m=>m.key='other',wrong_schema:m=>m.schemaVersion=2,string_schema:m=>m.schemaVersion='1',missing_schema:m=>delete m.schemaVersion,
 duplicate:m=>m.chunks[1]=m.chunks[0],reordered:m=>m.chunks.reverse(),mixed_generation:m=>m.chunks[1]='target::chunk:v1:other:0001',
 nested_generation:m=>m.chunks=m.chunks.map((_,i)=>`target::chunk:v1:other::chunk:v1:gen:${String(i).padStart(4,'0')}`),colon_generation:m=>m.chunks=m.chunks.map((_,i)=>`target::chunk:v1:generation:with:separator:${String(i).padStart(4,'0')}`),
 empty_generation:m=>m.chunks=m.chunks.map((_,i)=>`target::chunk:v1::${String(i).padStart(4,'0')}`),
 unpadded_ordinal:m=>m.chunks[0]='target::chunk:v1:legacy-time_abcdef:0',wrong_count:m=>m.chunks.pop(),
 negative_length:m=>m.length=-1,small_length:m=>m.length=SIZE,string_length:m=>m.length=String(m.length),unsafe_length:m=>m.length=Number.MAX_SAFE_INTEGER+1,
 no_array:m=>m.chunks='foreign-scope',empty_chunks:m=>m.chunks=[],nonstring_chunk:m=>m.chunks[0]=17
};
(async()=>{
for(const [name,mutate]of Object.entries(bad))await check('invalid_manifest_'+name,async()=>{
 const f=await fixture(),m=seed(f);mutate(m);f.values.set('target',JSON.stringify(m));f.values.set('foreign-scope','KEEP');const before=snapshot(f);f.operations.length=0;
 assert.equal(await f.api.getItem('target'),null,'ordinary read rejects invalid manifest');assert.equal(f.diagnostics().storage.lastError,'storage_read_invalid_manifest','ordinary null preserves explicit error diagnostic');
 await assert.rejects(f.api.getItem('target',{strict:true}),/storage_read_failed/);
 assert.equal(await f.api.setItem('target','new'),false,'invalid prior manifest is not destructively repaired');
 await assert.rejects(f.api.setItem('target','new',{strict:true}),e=>e.storageWriteUnverified===false,'strict set reports no root issue');
 assert.equal(await f.api.removeItem('target'),false);assert.deepEqual(snapshot(f),before,'all stored bytes preserved');
 assert.deepEqual(f.operations.filter(x=>x[0]!=='get'||x[1]!=='target'),[],'no listed chunk read or mutation');
});
for(const action of ['strict_read','small_set','large_set','remove'])await check('foreign_manifest_direct_'+action,async()=>{
 const f=await fixture(),m=seed(f);m.chunks[0]='foreign-scope';f.values.set('target',JSON.stringify(m));f.values.set('foreign-scope','KEEP');const before=snapshot(f);f.operations.length=0;
 if(action==='strict_read')await assert.rejects(f.api.getItem('target',{strict:true}),/storage_read_failed/);
 else if(action==='remove')assert.equal(await f.api.removeItem('target'),false);
 else assert.equal(await f.api.setItem('target',action==='small_set'?'new':'n'.repeat(SIZE+99)),false);
 assert.deepEqual(snapshot(f),before);assert(!f.operations.some(x=>x[0]!=='get'||x[1]!=='target'));
});
for(const stamp of ['l4ix20','l4ix20_ab12cd','l4ix20-01234567-89ab-cdef-0123-456789abcdef-1','l4ix20-rand-rand-1'])await check('valid_legacy_stamp_'+stamp,async()=>{
 const f=await fixture(),text='한🙂'.repeat(190000),m=seed(f,'target',text,stamp);assert.equal(await f.api.getItem('target',{strict:true}),text);assert.equal(await f.api.getItem('target'),text);
 assert.equal(await f.api.setItem('target','small'),true);assert(m.chunks.every(k=>!f.values.has(k)));assert.equal(await f.api.getItem('target',{strict:true}),'small');
});
await check('ordinary_sentinel_text_is_not_manifest',async()=>{const f=await fixture();for(const s of ['not json '+SENTINEL,JSON.stringify({[SENTINEL]:false,chunks:['foreign']})]){f.values.set('target',s);assert.equal(await f.api.getItem('target',{strict:true}),s);assert.equal(await f.api.setItem('target','small'),true);}});
for(const defect of ['missing','short','balanced_wrong_boundaries'])await check('physical_chunk_'+defect,async()=>{
 const f=await fixture(),m=seed(f);if(defect==='missing')f.values.delete(m.chunks[0]);else if(defect==='short')f.values.set(m.chunks[0],'short');else{f.values.set(m.chunks[0],f.values.get(m.chunks[0]).slice(0,-1));f.values.set(m.chunks[1],'x'+f.values.get(m.chunks[1]));}
 assert.equal(await f.api.getItem('target'),null);await assert.rejects(f.api.getItem('target',{strict:true}),/storage_read_failed/);
});
for(const failure of ['false','throw','false_after_delete','throw_after_delete','noop','readback_throw','readback_old','readback_new'])await check('remove_root_'+failure,async()=>{
 const f=await fixture(),m=seed(f),before=f.values.get('target'),del=f.raw.removeItem,get=f.raw.getItem;let issued=false;
 f.raw.removeItem=async k=>{if(k!=='target')return del(k);issued=true;if(failure==='false')return false;if(failure==='throw')throw Error('root failure');if(failure==='false_after_delete'){await del(k);return false;}if(failure==='throw_after_delete'){await del(k);throw Error('root failure after delete');}if(failure==='noop')return true;return del(k);};
 f.raw.getItem=async k=>{if(k==='target'&&issued){if(failure==='readback_throw')throw Error('readback failure');if(failure==='readback_old')return before;if(failure==='readback_new'){f.values.set(k,'later-root');return 'later-root';}}return get(k);};
 assert.equal(await f.api.removeItem('target'),false);assert(m.chunks.every(k=>f.values.has(k)),'chunks survive unconfirmed root unlink');
});
for(const failure of ['false','throw','noop'])await check('remove_chunk_'+failure,async()=>{
 const f=await fixture(),m=seed(f),del=f.raw.removeItem;f.raw.removeItem=async k=>{if(k!==m.chunks[0])return del(k);if(failure==='false')return false;if(failure==='throw')throw Error('chunk failure');return true;};
 assert.equal(await f.api.removeItem('target'),false,'no all-cleared success');assert.equal(f.diagnostics().storage.lastError,'storage_cleanup_unverified');assert(!f.values.has('target'));assert(f.values.has(m.chunks[0]));assert(f.values.has(m.chunks[1]),'stop cleanup at first unconfirmed delete');
});
await check('remove_root_before_chunks_and_verify_absence',async()=>{const f=await fixture(),m=seed(f);f.operations.length=0;assert.equal(await f.api.removeItem('target'),true);const rm=f.operations.filter(x=>x[0]==='remove');assert.deepEqual(rm.map(x=>x[1]),['target',...m.chunks]);assert.equal(f.values.size,0);assert.equal(await f.api.removeItem('target'),true);});
await check('remove_late_root_change_stops_cleanup',async()=>{const f=await fixture(),m=seed(f),del=f.raw.removeItem;f.raw.removeItem=async k=>{const v=await del(k);if(k===m.chunks[0])f.values.set('target','later-root');return v;};assert.equal(await f.api.removeItem('target'),false);assert(f.values.has(m.chunks[1]));assert.equal(f.values.get('target'),'later-root');});
await check('remove_last_chunk_late_root_change_is_not_all_clear',async()=>{const f=await fixture(),m=seed(f),del=f.raw.removeItem;f.raw.removeItem=async k=>{const v=await del(k);if(k===m.chunks.at(-1))f.values.set('target','later-root');return v;};assert.equal(await f.api.removeItem('target'),false);assert.equal(f.values.get('target'),'later-root');});
await check('remove_observed_root_change_before_unlink_preserves_data',async()=>{const f=await fixture(),m=seed(f),get=f.raw.getItem;let first=true;f.raw.getItem=async k=>{const v=await get(k);if(k==='target'&&first){first=false;f.values.set(k,'later-root');}return v;};assert.equal(await f.api.removeItem('target'),false);assert.equal(f.values.get('target'),'later-root');assert(m.chunks.every(k=>f.values.has(k)));});
await check('set_cleanup_failure_preserves_verified_success',async()=>{const f=await fixture(),m=seed(f);f.raw.removeItem=async()=>false;assert.equal(await f.api.setItem('target','new',{strict:true}),true);assert.equal(f.diagnostics().storage.lastError,'storage_cleanup_unverified');assert.equal(await f.api.getItem('target',{strict:true}),'new');assert(m.chunks.every(k=>f.values.has(k)));});
await check('set_late_prior_root_return_stops_cleanup',async()=>{const f=await fixture(),m=seed(f),old=f.values.get('target'),get=f.raw.getItem;let reads=0;f.raw.getItem=async k=>{if(k==='target'&&f.values.get(k)==='new'&&++reads===2)f.values.set(k,old);return get(k);};await f.api.setItem('target','new');assert(m.chunks.every(k=>f.values.has(k)));assert.equal(await f.api.getItem('target',{strict:true}),'x'.repeat(SIZE+99));});
for(const failure of ['false','throw','false_after_write','throw_after_write','readback_mismatch'])await check('staging_second_chunk_'+failure,async()=>{
 const f=await fixture();f.values.set('target','PRIOR');f.values.set('target::chunk:v1:other:0000','KEEP');const set=f.raw.setItem,get=f.raw.getItem;let n=0,failed='';
 f.raw.setItem=async(k,v)=>{if(k.startsWith('target::chunk:')&&++n===2){failed=k;if(failure.endsWith('after_write'))await set(k,v);if(failure.startsWith('false'))return false;if(failure.startsWith('throw'))throw Error('stage failure');}return set(k,v);};f.raw.getItem=async k=>k===failed&&failure==='readback_mismatch'?'bad':get(k);
 await assert.rejects(f.api.setItem('target','x'.repeat(SIZE*2+99),{strict:true}),e=>e.storageWriteUnverified===false);assert.equal(f.values.get('target'),'PRIOR');assert.deepEqual([...f.values.keys()],['target','target::chunk:v1:other:0000']);
});
for(const failure of ['false_after_write','throw_after_write','readback_throw','readback_mismatch'])await check('issued_root_preserves_staged_'+failure,async()=>{
 const f=await fixture();f.values.set('target','PRIOR');const set=f.raw.setItem,get=f.raw.getItem;let issued=false;
 f.raw.setItem=async(k,v)=>{await set(k,v);if(k==='target'){issued=true;if(failure==='false_after_write')return false;if(failure==='throw_after_write')throw Error('issued');}return true;};f.raw.getItem=async k=>{if(k==='target'&&issued){if(failure==='readback_throw')throw Error('ambiguous');if(failure==='readback_mismatch')return 'other';}return get(k);};
 await assert.rejects(f.api.setItem('target','x'.repeat(SIZE+99),{strict:true}),e=>e.storageWriteUnverified===true);const m=JSON.parse(f.values.get('target'));assert(m.chunks.every(k=>f.values.has(k)));assert(!f.operations.some(x=>x[0]==='remove'));
});
for(const ambiguity of ['root_changed','root_read_throw','cleanup_false','cleanup_throw'])await check('staging_preserve_uncertain_'+ambiguity,async()=>{
 const f=await fixture();f.values.set('target','PRIOR');const set=f.raw.setItem,get=f.raw.getItem;let n=0,failed=false;
 f.raw.setItem=async(k,v)=>{if(k.startsWith('target::chunk:')&&++n===2){failed=true;if(ambiguity==='root_changed')f.values.set('target','LATER');return false;}return set(k,v);};f.raw.getItem=async k=>{if(failed&&k==='target'&&ambiguity==='root_read_throw')throw Error('read ambiguous');return get(k);};if(ambiguity==='cleanup_false')f.raw.removeItem=async()=>false;if(ambiguity==='cleanup_throw')f.raw.removeItem=async()=>{throw Error('cleanup failure')};
 assert.equal(await f.api.setItem('target','x'.repeat(SIZE*2+99)),false);assert.equal(f.diagnostics().storage.lastError,'storage_chunk_set_failed');assert.equal(f.diagnostics().storage.lastCleanupError,'storage_staging_cleanup_unverified');assert.equal([...f.values.keys()].filter(k=>k.includes('::chunk:')).length,1,'uncertain staged data retained');
});
await check('previous_root_read_error_blocks_all_mutation',async()=>{const f=await fixture();f.values.set('target','PRIOR');f.raw.getItem=async()=>{throw Error('unavailable')};assert.equal(await f.api.setItem('target','new'),false);assert.equal(await f.api.removeItem('target'),false);assert.equal(f.values.get('target'),'PRIOR');assert(!f.operations.some(x=>x[0]!=='get'));});
await check('roundtrip_boundary_and_unique_generation',async()=>{const f=await fixture();for(const n of [0,SIZE,SIZE+1,SIZE*2]){const text='x'.repeat(n);assert.equal(await f.api.setItem('target',text,{strict:true}),true);assert.equal(await f.api.getItem('target',{strict:true}),text);}const first=JSON.parse(f.values.get('target'));assert.equal(await f.api.setItem('target','y'.repeat(SIZE*2)),true);const second=JSON.parse(f.values.get('target'));assert(first.chunks.every(k=>!second.chunks.includes(k)&&!f.values.has(k)));});
const report={kind:process.env.WM_CHUNK_DIST?'actual production artifact with observation-only exports':'exact source wrapper extraction',artifact:process.env.WM_CHUNK_DIST||null,passed:rows.filter(r=>r.ok).length,failed:rows.filter(r=>!r.ok).length,externalCalls:0,realModelCalls:0,rows};
const file=process.env.WM_CHUNK_REPORT||path.resolve(__dirname,'../evidence/chunk-safety-results.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,failed:report.failed}));process.exitCode=report.failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
