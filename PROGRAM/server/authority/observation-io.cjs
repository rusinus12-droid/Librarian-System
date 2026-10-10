'use strict';
// Internal ownership primitives. No writer open, bootstrap, recovery or raw DB
// file descriptor is permitted here. Filesystem checks are observed-path facts,
// never a filesystem ABA/external-writer exclusion proof.
const fs=require('node:fs'),path=require('node:path'),{DatabaseSync}=require('node:sqlite'),{performance}=require('node:perf_hooks');
const C=require('./contracts.cjs'),J=require('./observation-json.cjs');
const BUDGETS=new WeakSet(),SESSIONS=new WeakMap(),MiB=J.MiB;
const LIMITS=Object.freeze({sourceBytes:MiB,metadataBytes:MiB,authorityBytes:8*MiB,sourceEvents:32768,authorityEvents:2048,keys:8192,managedBytes:64*MiB,handles:4,checks:8,attempts:3});
function newCounters(){return {attempts:0,sourceRowEvents:0,sourceMetadataBytes:0,authorityRowEvents:0,authorityMetadataBytes:0,admittedSerializedBytes:0,materializedSerializedBytes:0,hydratedNarrativeBytes:0,returnedNarrativeBytes:0,proofBytes:0,peakManagedCreditBytes:0};}
function createBudget({ledger,deadline,checkDeadline=deadline,counters}){
 const local={sourceMetadataBytes:0,authorityMetadataBytes:0,sourceRowEvents:0,authorityRowEvents:0,materializedSerializedBytes:0,hydratedNarrativeBytes:0};let held=0,ended=false;
 const budget={check(){if(performance.now()>=deadline)C.fail('OBSERVATION_EXPIRED');if(performance.now()>=checkDeadline)C.fail('OBSERVATION_CHECK_TIMEOUT');if(ended)C.fail('OBSERVATION_ENDED');},
 reserve(bytes){budget.check();if(!Number.isSafeInteger(bytes)||bytes<0||ledger.active+ledger.retained+bytes>LIMITS.managedBytes)C.fail('RESOURCE_LIMIT');held+=bytes;ledger.active+=bytes;ledger.peak=Math.max(ledger.peak,ledger.active+ledger.retained);counters.peakManagedCreditBytes=Math.max(counters.peakManagedCreditBytes,ledger.peak);return bytes;},
 settle(reservation,actual){if(actual>reservation||actual<0)C.fail('RESOURCE_LIMIT');held-=reservation-actual;ledger.active-=reservation-actual;},
 charge(kind,bytes,events=1){budget.check();const b=kind==='authority'?'authorityMetadataBytes':'sourceMetadataBytes',e=kind==='authority'?'authorityRowEvents':'sourceRowEvents';local[b]+=bytes;counters[b]+=bytes;local[e]+=events;counters[e]+=events;if(local[b]>(kind==='authority'?LIMITS.authorityBytes:LIMITS.metadataBytes)||local[e]>(kind==='authority'?LIMITS.authorityEvents:LIMITS.sourceEvents))C.fail('RESOURCE_LIMIT');},
 content(field,bytes){local[field]+=bytes;counters[field]+=bytes;if(local[field]>MiB)C.fail('RESOURCE_LIMIT');},
 trim(bytes){if(bytes>held||bytes<0)C.fail('RESOURCE_LIMIT');ledger.active-=held-bytes;held=bytes;},
 finish(retained=0){if(ended)return;if(retained>held)C.fail('RESOURCE_LIMIT');ledger.active-=held;ledger.retained+=retained;held=0;ended=true;},
 get held(){return held;},counters};BUDGETS.add(budget);return budget;
}
function assertBudget(b){if(!BUDGETS.has(b))C.fail('INVALID_OBSERVATION_BUDGET');b.check();return b;}
function width(value){if(value===null)return 1;if(typeof value==='number')return 8;if(typeof value==='string')return Buffer.byteLength(value);if(value instanceof Uint8Array)return value.byteLength;C.fail('AUTHORITY_QUARANTINED');}
function readError(error){if(/database (?:is )?(?:locked|busy)/i.test(error.message))C.fail('AUTHORITY_BUSY');throw error;}
function acquireRows(db,sql,args,budget,{kind='authority',maximum=8*MiB,blob=false,many=false,overhead=262144}={}){
 assertBudget(budget);const reservation=budget.reserve(maximum*3+overhead);let rows;
 try{const statement=db.prepare(sql);rows=many?statement.all(...args):[statement.get(...args)].filter(Boolean);budget.check();let bytes=0,objects=0;
  for(const row of rows){objects+=1+Object.keys(row).length;for(const v of Object.values(row))bytes+=width(v);}
  budget.charge(kind,bytes,Math.max(1,rows.length));if(bytes>maximum)C.fail('RESOURCE_LIMIT');
  for(const row of rows)for(const key of Object.keys(row))if(row[key] instanceof Uint8Array&&!blob)row[key]=J.decode(row[key],true);
  budget.settle(reservation,bytes*3+objects*256);return many?rows:rows[0];
 }catch(error){readError(error);}
}
// Existing validators retain their SQL semantics. Their bounded TEXT branches
// become bounded BLOB branches on this private adapter, before SQLite returns
// them to JavaScript. Every payload is fatally decoded under reserved credit.
const TEXT_COLUMNS=new Set(['type','name','tbl_name','sql','activation_id','generation','physical_json','status','authority_profile','namespace','binding_json','operation_id','kind','journal_json','value','guard_fingerprint','receipt_retention','scope_id','scope_key','mode','override_kind','dependency_digest','transition_json']);
function evidenceDatabase(db,budget){return {prepare(sql){
 const rewritten=sql.replace(/THEN ([a-z_]+) ELSE NULL END AS \1/g,(all,column)=>TEXT_COLUMNS.has(column)?`THEN CAST(${column} AS BLOB) ELSE NULL END AS ${column}`:all);
 return {get(...args){return acquireRows(db,rewritten,args,budget);},all(...args){return acquireRows(db,rewritten,args,budget,{many:true});}};
 }};}
function stat(file){try{return fs.lstatSync(file,{bigint:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function checkedPath(file){const resolved=path.resolve(file),root=path.parse(resolved).root,parts=resolved.slice(root.length).split(path.sep).filter(Boolean);if(parts.length>128)C.fail('SOURCE_PROOF_UNAVAILABLE');let current=root;for(let i=0;i<parts.length;i++){current=path.join(current,parts[i]);const s=stat(current);if(s&&(s.isSymbolicLink()||(i<parts.length-1&&!s.isDirectory())))C.fail('AUTHORITY_QUARANTINED');}return resolved;}
function regular(file,{optional=false}={}){const s=stat(checkedPath(file));if(!s){if(optional)return null;C.fail('AUTHORITY_QUARANTINED');}if(!s.isFile()||s.nlink!==1n)C.fail('AUTHORITY_QUARANTINED');return s;}
function preflightFile(file,budget){budget.check();const main=regular(file);if(main.size===0n)C.fail('AUTHORITY_QUARANTINED');for(const suffix of ['-wal','-shm'])regular(file+suffix,{optional:true});const journal=regular(file+'-journal',{optional:true});if(journal&&journal.size>0n)C.fail('SOURCE_PROOF_UNAVAILABLE');budget.charge('authority',128,4);return {dev:main.dev,ino:main.ino};}
function checkFile(file,identity,budget){const now=preflightFile(file,budget);if(now.dev!==identity.dev||now.ino!==identity.ino)C.fail('AUTHORITY_QUARANTINED');}
function begin(file,budget){const identity=preflightFile(file,budget);let db;
 try{db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0;');budget.check();
  // Ownership exists before BEGIN, including an error reported after real BEGIN.
  db.exec('BEGIN');budget.check();if(acquireRows(db,'PRAGMA main.encoding',[],budget,{maximum:64}).encoding!=='UTF-8')C.fail('SOURCE_PROFILE_UNAVAILABLE');
  return {db,file,identity,budget,ended:false};
 }catch(error){if(db)try{end({db,file,identity,budget,ended:false},false);}catch(ending){if(ending.code!=='OBSERVATION_READ_END_FAILED')throw ending;}readError(error);}
}
function end(state,verify=true){if(state.ended)return;let failure;try{state.db.exec('ROLLBACK');}catch(error){failure=error;}try{state.db.close();}catch{require('./control-store.cjs').fatalUnsafeEnd();}state.ended=true;state.metadata=null;state.evidence=null;state.db=null;if(failure)C.fail('OBSERVATION_READ_END_FAILED');if(verify)checkFile(state.file,state.identity,state.budget);}
function boundedFile(file,maximum,budget,{optional=false}={}){
 budget.check();const s=regular(file,{optional});if(!s){budget.charge('authority',1);return null;}if(s.size>BigInt(maximum))C.fail('AUTHORITY_QUARANTINED');const reservation=budget.reserve(maximum*3+1024);
 const bytes=require('./control-store.cjs').readBoundedEvidenceFile(file,maximum,{optional});budget.charge('authority',bytes?.length||1);const value=bytes===null?null:J.decode(bytes,true);budget.settle(reservation,(bytes?.length||0)*3+256);return value;
}
function bindingEvidence(context,budget){
 const Core=require('./control-store.cjs'),{dataDir,marker,profile}=context;
 const encoded=boundedFile(path.join(dataDir,'config','server-authority.json'),65536,budget);let current;try{current=J.parse(encoded).value;if(C.canonical(current)!==C.canonical(marker))C.fail('AUTHORITY_QUARANTINED');}catch{C.fail('AUTHORITY_QUARANTINED');}
 boundedFile(path.join(dataDir,'config','data-instance.json'),4096,budget);Core.verifyPhysical(dataDir,marker.physicalBinding);
 if(C.canonical(Core.fileIdentity(path.join(dataDir,'stores','_authority','server-authority.sqlite')))!==C.canonical(marker.controlFileIdentity))C.fail('AUTHORITY_QUARANTINED');
 for(const name of profile.owners)if(C.canonical(Core.fileIdentity(Core.ownerFile(dataDir,name)))!==C.canonical(marker.ownerBindings[name].fileIdentity))C.fail('AUTHORITY_QUARANTINED');
 if(stat(checkedPath(path.join(dataDir,'migrations','restore-transaction.json'))))C.fail('SOURCE_PROOF_UNAVAILABLE');
 const resetText=boundedFile(path.join(dataDir,'config','namespace-reset.json'),MiB,budget,{optional:true});let reset;
 try{reset=resetText===null?null:J.parse(resetText).value;if(resetText!==null){J.plain(reset);if(reset.pending!=null)C.fail('SOURCE_PROOF_UNAVAILABLE');if(reset.epochs!==undefined)J.plain(reset.epochs);}}catch(e){if(e.code==='SOURCE_PROOF_UNAVAILABLE')throw e;C.fail('AUTHORITY_QUARANTINED');}
 const epochs={};for(const name of profile.owners){epochs[name]=reset?.epochs&&Object.hasOwn(reset.epochs,name)?reset.epochs[name]:0;C.boundedInteger(epochs[name]);if(epochs[name]!==marker.ownerBindings[name].resetEpoch)C.fail('AUTHORITY_QUARANTINED');}
 return C.hash({present:resetText!==null,epochs,pending:null,rawSha256:resetText===null?null:require('./receipt-codec.cjs').hashUtf8(resetText)});
}
function openOwnerSession(controlReader,budget){
 const context=require('./control-store.cjs').assertBackendObservationControlReader(controlReader);assertBudget(budget);bindingEvidence(context,budget);
 const marker=context.marker,binding=marker.ownerBindings.libra,file=require('./control-store.cjs').ownerFile(context.dataDir,'libra'),state=begin(file,budget);
 state.context=context;state.namespace='libra';state.dataDir=context.dataDir;state.filePath=file;state.physicalBinding=marker.physicalBinding;state.binding=binding;state.evidence=evidenceDatabase(state.db,budget);
 const session=Object.freeze({close(){end(state);}});SESSIONS.set(session,state);
 try{const proof=require('./owner-store.cjs').verifyOwnerReadSnapshot(session);state.proof=proof;return session;}catch(e){end(state,false);throw e;}
}
function assertOwnerSession(session){const state=SESSIONS.get(session);if(!state||state.ended)C.fail('INVALID_OBSERVATION_SESSION');assertBudget(state.budget);state.context.assertLive();return state;}
module.exports={LIMITS,newCounters,createBudget,assertBudget,acquireRows,evidenceDatabase,begin,end,bindingEvidence,openOwnerSession,assertOwnerSession};
