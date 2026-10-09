'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const family=key=>key.startsWith('hayaku.v2.source-evidence.')?'evidence':key.startsWith('hayaku.v2.ledger.')?'ledger':'other';
async function physicalStore(root){
 await fsp.mkdir(root,{recursive:true});const events=[],writes=new Map();let serial=0,armed=null;
 const file=key=>path.join(root,digest(String(key))+'.json');
 async function checkpoint(op,key,value){
  if(!armed||armed.hit||armed.family!==family(String(key))||armed.op!==op)return;
  if(op==='readback'&&!(writes.get(String(key))>0))return;
  armed.hit=true;armed.event={op,key:String(key),enteredAt:Date.now(),valueSHA:value==null?'':digest(String(value))};events.push({kind:'gate-enter',...armed.event});armed.enter(armed.event);await armed.wait;events.push({kind:'gate-release',op,key:String(key),at:Date.now()});
 }
 const store={root,events,rejectLedgerWrite:false,rejectMetadataReads:false,
  async getItem(key){if(store.rejectMetadataReads&&String(key).startsWith('__memory_suite_internal_scope_routes_v1__:'))throw Error('CONTROLLED_STORAGE_AUTHORITY_READ_UNAVAILABLE');let value=null,physicalSHA='';try{const bytes=await fsp.readFile(file(key)),record=JSON.parse(bytes);assert.equal(record.key,String(key));value=record.value;physicalSHA=digest(bytes);}catch(error){if(error.code!=='ENOENT')throw error;}
   events.push({kind:'physical-read',family:family(String(key)),key:String(key),at:Date.now(),exists:value!=null,physicalSHA});await checkpoint(value==null?'read':'readback',key,value);return value;},
  async setItem(key,value){events.push({kind:'write-admitted',family:family(String(key)),key:String(key),at:Date.now(),valueSHA:digest(typeof value==='string'?value:JSON.stringify(value))});await checkpoint('write',key,value);
   if(store.rejectLedgerWrite&&family(String(key))==='ledger')throw Error('CONTROLLED_CANONICAL_LEDGER_WRITE_REJECTED');
   const bytes=Buffer.from(JSON.stringify({key:String(key),value})),target=file(key),temp=target+'.tmp-'+process.pid+'-'+(++serial),handle=await fsp.open(temp,'w');try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}await fsp.rename(temp,target);writes.set(String(key),(writes.get(String(key))||0)+1);events.push({kind:'physical-write-fsync',family:family(String(key)),key:String(key),at:Date.now(),physicalSHA:digest(bytes),valueSHA:digest(typeof value==='string'?value:JSON.stringify(value))});return true;},
  async removeItem(key){try{await fsp.unlink(file(key));}catch(error){if(error.code!=='ENOENT')throw error;}},
  async keys(){const result=[];for(const name of await fsp.readdir(root)){if(name.endsWith('.json'))result.push(JSON.parse(await fsp.readFile(path.join(root,name))).key);}return result;},
  async length(){return (await store.keys()).length;},async key(index){return (await store.keys())[index]??null;},async clear(){throw Error('DIAGNOSTIC_DESTRUCTIVE_CLEAR_FORBIDDEN');},
  arm(targetFamily,op){assert.equal(armed,null);let enter,release;const entered=new Promise(resolve=>enter=resolve),wait=new Promise(resolve=>release=resolve);armed={family:targetFamily,op,hit:false,enter,release,wait};return {entered,release,hit:()=>armed.hit};},
  async physicalValue(key){return JSON.parse(await fsp.readFile(file(key))).value;},
  async inventory(){const result=[];for(const name of (await fsp.readdir(root)).filter(name=>name.endsWith('.json')).sort()){const bytes=await fsp.readFile(path.join(root,name)),record=JSON.parse(bytes);result.push({key:record.key,family:family(record.key),bytes:bytes.length,physicalSHA:digest(bytes),valueSHA:digest(typeof record.value==='string'?record.value:JSON.stringify(record.value))});}return result;}
 };
 return store;
}
function observeInlineReturns(sourcePath,destination){
 const original=fs.readFileSync(sourcePath,'utf8'),start=original.indexOf('  const writeStorageLedgerDirect = async '),end=original.indexOf('\n  const writeStorageLedger = ',start);assert(start>=0&&end>start);
 const section=original.slice(start,end),at=section.lastIndexOf('    return result;');assert(at>=0);
 const observed=section.slice(0,at)+"    globalThis.__HAYAKU_INLINE_LEDGER_RETURN_OBSERVATION__.push({at:Date.now(),scopeKey:scope.key,saved:result.saved,durable:result.durable,storageState:result.storageState,reason:result.reason,ledgerWritePolicy:result.ledgerWritePolicy,containsOld:result.ledger?.records?.some(row=>row.raw.includes('READSET_OLD'))===true,containsNew:result.ledger?.records?.some(row=>row.raw.includes('READSET_NEW'))===true});\n"+section.slice(at);
 let rebuilt=original.slice(0,start)+observed+original.slice(end);const exposure='    globalThis.HAYAKU = exposedApi;';assert(rebuilt.includes(exposure));
 const finish='      return { state, reason: finalReason, durable: state === \'confirmed\' || state === \'replayed\' || state === \'superseded\', ...extra };';assert(rebuilt.includes(finish));rebuilt=rebuilt.replace(finish,"      globalThis.__HAYAKU_EVENTUAL_LEDGER_RETURN_OBSERVATION__.push({at:Date.now(),state,reason:finalReason,durable:state==='confirmed'||state==='replayed'||state==='superseded'});\n"+finish);
 const body="globalThis.__HAYAKU_INLINE_LEDGER_RETURN_OBSERVATION__=[];globalThis.__HAYAKU_EVENTUAL_LEDGER_RETURN_OBSERVATION__=[];\n"+rebuilt.replace(exposure,'    globalThis.__HAYAKU_DIAGNOSTIC_STORAGE_BRIDGE__=MemorySuiteStorageBridge;\n'+exposure);fs.writeFileSync(destination,body);return {originalSHA:digest(Buffer.from(original)),observedSHA:digest(Buffer.from(body)),limit:'scalar inline/eventual return observation and storage API exposure in owned diagnostic copy only; no added await, timer, predicate or authority behavior'};
}
module.exports={physicalStore,digest,family,observeInlineReturns};
