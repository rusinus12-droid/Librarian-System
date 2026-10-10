'use strict';
const C=require('./contracts.cjs');
const M=require('./receipt-codec.cjs');
const L=M.LIMITS;
const DDL=[
 'CREATE TABLE authority_write_results(generation TEXT NOT NULL,namespace TEXT NOT NULL,operation_id TEXT NOT NULL,response_json TEXT NOT NULL,utf8_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(generation,namespace,operation_id))',
 'CREATE TABLE authority_write_touches(generation TEXT NOT NULL,namespace TEXT NOT NULL,operation_id TEXT NOT NULL,ordinal INTEGER NOT NULL,space TEXT NOT NULL,key TEXT NOT NULL,source_id TEXT NOT NULL,source_generation TEXT NOT NULL,source_version INTEGER NOT NULL,present INTEGER NOT NULL,revision INTEGER,digest TEXT,PRIMARY KEY(generation,namespace,operation_id,ordinal),UNIQUE(generation,namespace,operation_id,space,key))'
];
const keyArgs=k=>[k.generation,k.namespace,k.operationId];
const where='generation=? AND namespace=? AND operation_id=?';
const text=(c,max)=>`typeof(${c})='text' AND LENGTH(CAST(${c} AS BLOB))<=${max}`;
const integer=(c,min=0)=>`typeof(${c})='integer' AND ${c} BETWEEN ${min} AND 9007199254740991`;
const project=(columns,valid)=>`CASE WHEN ${valid} THEN 1 ELSE 0 END AS valid,`+columns.map(c=>`CASE WHEN ${valid} THEN ${c} ELSE NULL END AS ${c}`).join(',');
const quarantine=()=>C.fail('AUTHORITY_QUARANTINED');
function checked(row){if(row&&row.valid!==1)quarantine();return row;}
function boundedJsonColumn(column,limit=1048576){return `CASE WHEN ${text(column,limit)} THEN ${column} ELSE NULL END AS ${column}`;}
function parseControl(textValue){try{M.scanResultJson(textValue,1048576);const value=JSON.parse(textValue);if(C.canonical(value)!==textValue)quarantine();return value;}catch{quarantine();}}
function loadOrdinary(db,operationId){
 const valid=`${text('fingerprint',64)} AND ${text('response_json',L.originalResultBytes)}`;
 return checked(db.prepare(`SELECT ${project(['fingerprint','response_json'],valid)} FROM operations WHERE operation_id=?`).get(operationId));
}
function inspectOriginal(row){try{const scan=M.scanResultJson(row.response_json);return {encoding:'json-utf8.v1',utf8Bytes:scan.utf8Bytes,sha256:M.hashUtf8(row.response_json)};}catch{quarantine();}}
function readOrdinaryResult(db,operationId){const row=loadOrdinary(db,operationId);if(!row)return null;inspectOriginal(row);return JSON.parse(row.response_json);}
function retainOrdinaryResult(db,intent){
 // Existence/fingerprint lookup never loads the response. The actual load is one
 // atomic CASE projection, even if an untrusted row changed after this preflight.
 const meta=checked(db.prepare(`SELECT ${project(['fingerprint'],text('fingerprint',64))},LENGTH(CAST(response_json AS BLOB)) AS response_bytes,typeof(response_json) AS response_type FROM operations WHERE operation_id=?`).get(intent.operationId));
 if(!meta){if(['kv','batch'].includes(intent.operationClass))C.fail('ORDINARY_RECEIPT_MISSING');return null;}
 if(meta.fingerprint!==intent.fingerprint)C.fail('OPERATION_CONFLICT');if(meta.response_type!=='text'||meta.response_bytes>L.originalResultBytes)quarantine();
 const row=loadOrdinary(db,intent.operationId);if(!row||row.fingerprint!==intent.fingerprint)quarantine();const result=inspectOriginal(row);
 db.prepare('INSERT INTO authority_write_results(generation,namespace,operation_id,response_json,utf8_bytes,sha256) SELECT ?,?,?,response_json,?,? FROM operations WHERE operation_id=? AND fingerprint=?').run(...keyArgs(intent),result.utf8Bytes,result.sha256,intent.operationId,intent.fingerprint);
 return result;
}
function retainTouch(db,intent,ordinal,stamp){M.encodeTouch(stamp);db.prepare('INSERT INTO authority_write_touches VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(...keyArgs(intent),ordinal,stamp.space,stamp.key,stamp.sourceId,stamp.generation,stamp.version,stamp.present?1:0,stamp.revision,stamp.digest);}
function hasRetainedEvidence(db,key){return !!(db.prepare(`SELECT 1 FROM authority_write_results WHERE ${where} LIMIT 1`).get(...keyArgs(key))||db.prepare(`SELECT 1 FROM authority_write_touches WHERE ${where} LIMIT 1`).get(...keyArgs(key)));}
const resultValid=`${text('response_json',L.originalResultBytes)} AND ${integer('utf8_bytes',1)} AND utf8_bytes<=${L.originalResultBytes} AND ${text('sha256',64)}`;
const touchValid=`${integer('ordinal')} AND ordinal<${L.touchedKeys} AND ${text('space',6)} AND space IN ('plugin','local') AND ${text('key',L.writerKeyUtf8Bytes)} AND ${text('source_id',240)} AND ${text('source_generation',240)} AND ${integer('source_version',1)} AND ${integer('present')} AND present IN (0,1) AND (revision IS NULL OR (${integer('revision',1)})) AND (digest IS NULL OR (${text('digest',64)}))`;
function verifyReceiptPayloads(db,receipt,{includeResult=false}={}){
 try{
  M.validateCompactReceipt(receipt);const args=keyArgs(receipt);let result=null;
  if(receipt.ordinaryResult===null){if(db.prepare(`SELECT 1 FROM authority_write_results WHERE ${where} LIMIT 1`).get(...args))quarantine();}
  else{
   // Keep this large temporary out of the returned receipt/metadata object.
   const row=checked(db.prepare(`SELECT ${project(['response_json','utf8_bytes','sha256'],resultValid)} FROM authority_write_results WHERE ${where}`).get(...args));if(!row)quarantine();
   const descriptor=inspectOriginal(row);if(descriptor.utf8Bytes!==row.utf8_bytes||descriptor.sha256!==row.sha256||C.canonical(descriptor)!==C.canonical(receipt.ordinaryResult))quarantine();
   if(includeResult)result=JSON.parse(row.response_json);
  }
  const hasher=M.createTouchHasher(receipt),load=db.prepare(`SELECT ${project(['ordinal','space','key','source_id','source_generation','source_version','present','revision','digest'],touchValid)} FROM authority_write_touches WHERE ${where} AND ordinal=?`);
  for(let ordinal=0;ordinal<receipt.touchedSources.count;ordinal++){
   const row=checked(load.get(...args,ordinal));if(!row)quarantine();hasher.update(ordinal,{space:row.space,key:row.key,sourceId:row.source_id,generation:row.source_generation,version:row.source_version,present:row.present===1,revision:row.revision,digest:row.digest});
  }
  // Metadata-only sentinel also catches invalid negative/non-integer ordinals.
  if(db.prepare(`SELECT 1 FROM authority_write_touches WHERE ${where} AND (typeof(ordinal)<>'integer' OR ordinal<0 OR ordinal>=?) LIMIT 1`).get(...args,receipt.touchedSources.count))quarantine();
  if(C.canonical(hasher.finish())!==C.canonical({count:receipt.touchedSources.count,utf8Bytes:receipt.touchedSources.utf8Bytes,sha256:receipt.touchedSources.sha256}))quarantine();return result;
 }catch{quarantine();}
}
const keyValid=`${text('space',6)} AND space IN ('plugin','local') AND ${text('key',L.writerKeyUtf8Bytes)} AND ${integer('revision',1)} AND ${integer('deleted')} AND deleted IN (0,1) AND ${text('digest',64)}`;
function readLifecycle(db,space,key){
 const valid=`${text('space',6)} AND space IN ('plugin','local') AND ${text('key',L.writerKeyUtf8Bytes)} AND ${text('source_id',240)} AND ${text('generation',240)} AND ${integer('version',1)} AND ${integer('present')} AND present IN (0,1) AND (revision IS NULL OR (${integer('revision',1)})) AND (digest IS NULL OR (${text('digest',64)}))`;
 const row=checked(db.prepare(`SELECT ${project(['space','key','source_id','generation','version','present','revision','digest'],valid)} FROM authority_source_lifecycle WHERE space=? AND key=?`).get(space,key));
 if(row){try{M.encodeTouch({space:row.space,key:row.key,sourceId:row.source_id,generation:row.generation,version:row.version,present:row.present===1,revision:row.revision,digest:row.digest});}catch{quarantine();}}
 return row;
}
function preflightOwnerKeys(db,onRow){
 // Indexed rowid stepping avoids loading an unbounded historical key collection.
 const columns=`CAST(rowid AS TEXT) AS cursor,${project(['space','key','deleted','revision','digest'],keyValid)}`,first=db.prepare(`SELECT ${columns} FROM kv ORDER BY rowid LIMIT 1`),next=db.prepare(`SELECT ${columns} FROM kv WHERE rowid>? ORDER BY rowid LIMIT 1`);
 for(let row=first.get();row;row=next.get(BigInt(row.cursor))){if(row.valid!==1)M.assertWriterKey(null,null);M.assertWriterKey(row.space,row.key);if(onRow)onRow(row);}
}
module.exports={DDL,retainOrdinaryResult,retainTouch,verifyReceiptPayloads,hasRetainedEvidence,preflightOwnerKeys,readLifecycle,keyValid,boundedJsonColumn,parseControl,readOrdinaryResult};
