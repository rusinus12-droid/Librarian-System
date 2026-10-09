'use strict';
// Explicitly weaker owner-local copy/switch profile. Shares WM SQLite and ACL;
// never supplies a native fence, native CAS, IPC incarnation or source authority.
const PROFILE='wm.manual-copy-switch.v1';
module.exports={PROFILE,createManualStore({transaction,meta,setMeta,all,storeBlob,blob,sha,stable,fresh,fail:storageFail,identity,limits}){
 const fail=(reason,statusCode=400)=>{try{storageFail(reason);}catch(e){e.statusCode=statusCode;throw e;}};
 const parse=(k,fallback=null)=>{const v=meta(k);return v===undefined?fallback:JSON.parse(v);};
 const put=(k,v)=>setMeta(k,stable(v));
 const token=v=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v),digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
 const exact=(v,ks)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join('|')!==ks.slice().sort().join('|'))fail('manual_input_invalid');};
 const state=()=>parse('manual:state',{activeId:null,revision:'empty'});
 const gen=id=>{if(!token(id))fail('manual_generation_invalid');const g=parse('manual:g:'+id);if(!g)fail('manual_generation_missing');return g;};
 const rows=id=>all("SELECT value FROM metadata WHERE substr(key,1,?)=? ORDER BY key",('manual:r:'+id+':').length,'manual:r:'+id+':').map(v=>JSON.parse(v.value)).sort((a,b)=>a.id.localeCompare(b.id));
 const descriptors=id=>rows(id).map(({chunks,offset,...d})=>d);
 const inventory=id=>sha(Buffer.from(stable(descriptors(id))));
 const same=(a,b)=>stable(a)===stable(b);
 function descriptor(d){exact(d,['id','space','key','domain','bytes','sha256','tombstone']);if(!digest(d.id)||!['plugin','local','archive'].includes(d.space)||typeof d.key!=='string'||!d.key||Buffer.byteLength(d.key)>8192||d.id!==sha(Buffer.from(d.space+'\n'+d.key))||!['canonical','cold','raw','raw_history','lineage','orphan'].includes(d.domain)||!Number.isSafeInteger(d.bytes)||d.bytes<0||d.bytes>limits.maxGenerationBytes||!digest(d.sha256)||typeof d.tombstone!=='boolean'||d.tombstone&&(d.bytes!==0||d.sha256!==sha(Buffer.alloc(0))))fail('manual_record_invalid');}
 const checkedExpected=e=>{exact(e,['activeId','revision']);if(e.activeId!==null&&!token(e.activeId)||!token(e.revision))fail('manual_expected_invalid');};
 const requireCurrent=(g,e)=>{if(!same(state(),e)||state().activeId!==g)fail('manual_source_changed',409);};
 function bytes(row){let at=0;const parts=row.chunks.map(c=>{if(c.offset!==at)fail('manual_record_integrity');at+=c.bytes;return blob(c.sha256,c.bytes);});const out=Buffer.concat(parts);if(at!==row.bytes||sha(out)!==row.sha256)fail('manual_record_integrity');return out;}
 function verify(id){const g=gen(id),ds=descriptors(id);if(ds.length!==g.records||inventory(id)!==g.inventoryDigest)fail('manual_inventory_mismatch');for(const r of rows(id))bytes(r);return g;}
 return function manual(action,input){return transaction(()=>{
  if(input?.profile!==PROFILE)fail('manual_profile_required');const v={...input};delete v.profile;
  if(action==='status'){exact(v,[]);const s=state();return {profile:PROFILE,...s,identity:{authorityId:identity.authorityId,storeId:identity.storeId,datasetId:identity.datasetId,backendId:identity.backendId},allWritersFenced:false,nativeAtomic:false,limits:{maxChunkBytes:Math.min(262144,limits.maxMigrationChunkBytes),maxRecordBytes:limits.maxGenerationBytes,maxItems:limits.maxMigrationItems},inventoryDigest:s.activeId?inventory(s.activeId):sha(Buffer.from('[]'))};}
  if(action==='begin'){
   exact(v,['generation','expected','records','inventoryDigest']);checkedExpected(v.expected);if(!token(v.generation)||!digest(v.inventoryDigest)||!Array.isArray(v.records)||v.records.length>limits.maxMigrationItems)fail('manual_begin_invalid');v.records.forEach(descriptor);
   if(new Set(v.records.map(d=>d.id)).size!==v.records.length||sha(Buffer.from(stable(v.records.slice().sort((a,b)=>a.id.localeCompare(b.id)))))!==v.inventoryDigest)fail('manual_inventory_mismatch');
   const old=parse('manual:g:'+v.generation);if(old){if(old.inventoryDigest!==v.inventoryDigest||!same(old.expected,v.expected))fail('manual_operation_conflict',409);return {ok:true,state:old.state};}
   if(!same(state(),v.expected))fail('manual_destination_changed',409);
   let total=0;for(const d of v.records){total+=d.bytes;if(!Number.isSafeInteger(total)||total>limits.maxMigrationBytes)fail('manual_capacity');}
   put('manual:g:'+v.generation,{generation:v.generation,expected:v.expected,inventoryDigest:v.inventoryDigest,records:v.records.length,state:'copying'});
   for(const d of v.records)put('manual:r:'+v.generation+':'+d.id,{...d,chunks:[],offset:0});return {ok:true,state:'copying'};
  }
  if(action==='stage-status'){exact(v,['generation','id']);gen(v.generation);if(!digest(v.id))fail('manual_record_invalid');const r=parse('manual:r:'+v.generation+':'+v.id);if(!r)fail('manual_record_missing');return {offset:r.offset,complete:r.offset===r.bytes};}
  if(action==='chunk'){
   exact(v,['generation','id','offset','data']);const g=gen(v.generation),key='manual:r:'+v.generation+':'+v.id,r=parse(key);if(!r||!Number.isSafeInteger(v.offset)||v.offset<0||typeof v.data!=='string'||v.data.length>4*Math.ceil(Math.min(262144,limits.maxMigrationChunkBytes)/3))fail('manual_chunk_invalid');
   const b=Buffer.from(v.data,'base64');if(b.toString('base64')!==v.data||!b.length||v.offset+b.length>r.bytes)fail('manual_chunk_invalid');const h=sha(b),prior=r.chunks.find(c=>c.offset===v.offset);
   if(prior){if(prior.sha256!==h||prior.bytes!==b.length)fail('manual_chunk_conflict',409);return {ok:true,offset:r.offset};}
   if(g.state!=='copying'||v.offset!==r.offset)fail('manual_chunk_conflict',409);storeBlob(b,h);r.chunks.push({offset:v.offset,bytes:b.length,sha256:h});r.offset+=b.length;put(key,r);return {ok:true,offset:r.offset};
  }
  if(action==='seal'){exact(v,['generation','inventoryDigest']);const g=verify(v.generation);if(g.inventoryDigest!==v.inventoryDigest)fail('manual_inventory_mismatch');if(g.state==='copying'){g.state='verified';put('manual:g:'+v.generation,g);}return {ok:true,inventoryDigest:g.inventoryDigest};}
  if(action==='activate'){
   exact(v,['generation','expected','inventoryDigest']);checkedExpected(v.expected);const g=verify(v.generation),s=state();if(g.inventoryDigest!==v.inventoryDigest||!same(g.expected,v.expected))fail('manual_operation_conflict',409);
   if(s.activeId===v.generation&&g.state==='active')return {ok:true,...s,inventoryDigest:inventory(v.generation)};
   if(g.state!=='verified'||!same(s,v.expected))fail('manual_destination_changed',409);if(s.activeId){const old=gen(s.activeId);old.state='retired';put('manual:g:'+s.activeId,old);}g.state='active';put('manual:g:'+v.generation,g);const next={activeId:v.generation,revision:fresh('manual-revision')};put('manual:state',next);return {ok:true,...next,inventoryDigest:g.inventoryDigest};
  }
  if(action==='list'){
   exact(v,['generation','expectedRevision','cursor']);requireCurrent(v.generation,{activeId:v.generation,revision:v.expectedRevision});if(!Number.isSafeInteger(v.cursor)||v.cursor<0)fail('manual_cursor_invalid');const list=descriptors(v.generation),end=Math.min(list.length,v.cursor+128);return {records:list.slice(v.cursor,end),nextCursor:end<list.length?end:null,revision:v.expectedRevision};
  }
  if(action==='lookup'){
   exact(v,['generation','id']);if(state().activeId!==v.generation||!digest(v.id))fail('manual_source_changed',409);const r=parse('manual:r:'+v.generation+':'+v.id);return {record:r?(({chunks,offset,...d})=>d)(r):null,revision:state().revision};
  }
  if(action==='read'){
   exact(v,['generation','id','sha256','offset','maxBytes']);gen(v.generation);const r=parse('manual:r:'+v.generation+':'+v.id);if(!r||r.sha256!==v.sha256)fail('manual_source_changed',409);if(!Number.isSafeInteger(v.offset)||v.offset<0||v.offset>r.bytes||!Number.isSafeInteger(v.maxBytes)||v.maxBytes<1||v.maxBytes>262144)fail('manual_chunk_invalid');const b=bytes(r).subarray(v.offset,v.offset+v.maxBytes);return {data:b.toString('base64'),offset:v.offset,nextOffset:v.offset+b.length<r.bytes?v.offset+b.length:null,totalBytes:r.bytes,sha256:r.sha256};
  }
  if(action==='write'){
   exact(v,['generation','expectedRevision','record','value','operationId']);if(!token(v.operationId))fail('manual_operation_invalid');descriptor(v.record);if(v.record.space==='archive'||typeof v.value!=='string')fail('manual_write_invalid');const b=Buffer.from(v.value);if(b.length!==v.record.bytes||sha(b)!==v.record.sha256)fail('manual_record_invalid');
   const opKey='manual:op:'+v.operationId,fp=sha(Buffer.from(stable(v))),old=parse(opKey);if(old){if(old.fingerprint!==fp)fail('manual_operation_conflict',409);return old.receipt;}
   requireCurrent(v.generation,{activeId:v.generation,revision:v.expectedRevision});storeBlob(b,v.record.sha256);put('manual:r:'+v.generation+':'+v.record.id,{...v.record,chunks:b.length?[{offset:0,bytes:b.length,sha256:v.record.sha256}]:[],offset:b.length});const s={activeId:v.generation,revision:fresh('manual-revision')};put('manual:state',s);const g=gen(v.generation);g.records=descriptors(v.generation).length;g.inventoryDigest=inventory(v.generation);put('manual:g:'+v.generation,g);const receipt={ok:true,...s,record:v.record};put(opKey,{fingerprint:fp,receipt});return receipt;
  }
  fail('manual_action_invalid',404);
 });};
}};

// Optional extension of the existing SQLite backup component. Manual metadata
// and immutable blobs remain in their original tables; restored execution stays
// subject to the WM recovery admission gate.
const manualToken=v=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v);
const manualDigest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function isManualMetadataKey(k){return k==='manual:state'||/^manual:g:[A-Za-z0-9:_-]{1,128}$/.test(k)||/^manual:r:[A-Za-z0-9:_-]{1,128}:[a-f0-9]{64}$/.test(k)||/^manual:op:[A-Za-z0-9:_-]{1,128}$/.test(k);}
function manualBackupFail(){throw Object.assign(Error('backup_manual_integrity'),{code:'WM_backup_manual_integrity',statusCode:409});}
function manualExact(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join('|')!==keys.slice().sort().join('|'))manualBackupFail();}
function validateManualSummary(v){manualExact(v,['profile','metadataDigest','generations','records','bytes','activeId']);if(v.profile!==PROFILE||!manualDigest(v.metadataDigest)||v.activeId!==null&&!manualToken(v.activeId)||!['generations','records','bytes'].every(k=>Number.isSafeInteger(v[k])&&v[k]>=0))manualBackupFail();return v;}
function inspectManualBackup(db){
 const crypto=require('node:crypto'),stable=v=>Array.isArray(v)?'['+v.map(stable).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v),sha=v=>crypto.createHash('sha256').update(v).digest('hex'),digest=crypto.createHash('sha256');
 const rows=db.prepare("SELECT key,value FROM metadata WHERE substr(key,1,7)='manual:' ORDER BY key"),one=db.prepare('SELECT value FROM metadata WHERE key=?'),read=k=>{const raw=one.get(k)?.value;return raw===undefined?null:JSON.parse(raw);};
 let metadataCount=0,generations=0,records=0,bytes=0,activeCount=0;const state=read('manual:state')||{activeId:null,revision:'empty'};manualExact(state,['activeId','revision']);if(state.activeId!==null&&!manualToken(state.activeId)||!manualToken(state.revision))manualBackupFail();
 const sum=(a,b)=>{const n=a+b;if(!Number.isSafeInteger(n)||n<0)manualBackupFail();return n;};
 function descriptor(d){manualExact(d,['id','space','key','domain','bytes','sha256','tombstone']);if(!manualDigest(d.id)||!['plugin','local','archive'].includes(d.space)||typeof d.key!=='string'||!d.key||Buffer.byteLength(d.key)>8192||d.id!==sha(Buffer.from(d.space+'\n'+d.key))||!['canonical','cold','raw','raw_history','lineage','orphan'].includes(d.domain)||!Number.isSafeInteger(d.bytes)||d.bytes<0||!manualDigest(d.sha256)||typeof d.tombstone!=='boolean'||d.tombstone&&(d.bytes!==0||d.sha256!==sha(Buffer.alloc(0))))manualBackupFail();}
 for(const row of rows.iterate()){
  if(!isManualMetadataKey(row.key))manualBackupFail();metadataCount++;digest.update(stable([row.key,row.value])+'\n');const v=JSON.parse(row.value);
  if(row.key.startsWith('manual:g:')){
   manualExact(v,['generation','expected','inventoryDigest','records','state']);manualExact(v.expected,['activeId','revision']);if(row.key!=='manual:g:'+v.generation||!manualToken(v.generation)||v.expected.activeId!==null&&!manualToken(v.expected.activeId)||!manualToken(v.expected.revision)||!manualDigest(v.inventoryDigest)||!Number.isSafeInteger(v.records)||v.records<0||!['copying','verified','active','retired'].includes(v.state))manualBackupFail();
   const hash=crypto.createHash('sha256');hash.update('[');let count=0;for(const r of db.prepare('SELECT value FROM metadata WHERE substr(key,1,?)=? ORDER BY key').iterate(('manual:r:'+v.generation+':').length,'manual:r:'+v.generation+':')){const {chunks,offset,...d}=JSON.parse(r.value);descriptor(d);if(count++)hash.update(',');hash.update(stable(d));}hash.update(']');if(count!==v.records||hash.digest('hex')!==v.inventoryDigest)manualBackupFail();if(v.state==='active'){activeCount++;if(state.activeId!==v.generation)manualBackupFail();}generations++;
  }else if(row.key.startsWith('manual:r:')){
   const {chunks,offset,...d}=v;descriptor(d);if(!Array.isArray(chunks)||!Number.isSafeInteger(offset)||offset<0||offset>d.bytes)manualBackupFail();const prefix=row.key.slice(9,-65),g=read('manual:g:'+prefix);if(!g||row.key!=='manual:r:'+g.generation+':'+d.id)manualBackupFail();let at=0;const full=crypto.createHash('sha256');
   for(const c of chunks){manualExact(c,['offset','bytes','sha256']);if(c.offset!==at||!Number.isSafeInteger(c.bytes)||c.bytes<=0||!manualDigest(c.sha256))manualBackupFail();const stored=db.prepare('SELECT utf8_bytes,length(payload) n FROM blobs WHERE sha256=?').get(c.sha256);if(!stored||stored.utf8_bytes!==c.bytes||stored.n!==c.bytes)manualBackupFail();const partHash=crypto.createHash('sha256');for(let pos=0;pos<c.bytes;pos+=262144){const part=db.prepare('SELECT substr(payload,?,?) payload FROM blobs WHERE sha256=?').get(pos+1,Math.min(262144,c.bytes-pos),c.sha256).payload;partHash.update(part);full.update(part);}if(partHash.digest('hex')!==c.sha256)manualBackupFail();at=sum(at,c.bytes);}
   if(at!==offset||g.state!=='copying'&&at!==d.bytes||at===d.bytes&&full.digest('hex')!==d.sha256)manualBackupFail();records++;bytes=sum(bytes,d.bytes);
  }else if(row.key.startsWith('manual:op:')){manualExact(v,['fingerprint','receipt']);manualExact(v.receipt,['ok','activeId','revision','record']);if(!manualDigest(v.fingerprint)||v.receipt.ok!==true||!manualToken(v.receipt.activeId)||!manualToken(v.receipt.revision)||!read('manual:g:'+v.receipt.activeId))manualBackupFail();descriptor(v.receipt.record);}
 }
 if(!metadataCount)return undefined;if(activeCount!==(state.activeId===null?0:1))manualBackupFail();return validateManualSummary({profile:PROFILE,metadataDigest:digest.digest('hex'),generations,records,bytes,activeId:state.activeId});
}
Object.assign(module.exports,{isManualMetadataKey,inspectManualBackup,validateManualSummary});
