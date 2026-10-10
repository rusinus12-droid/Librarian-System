'use strict';
// A separate, bounded original-result profile. Generic control JSON is unchanged.
const crypto = require('node:crypto');
const C = require('./contracts.cjs');
const LIMITS = Object.freeze({originalResultBytes:134217728,compactReceiptBytes:65536,resultNodes:65536,resultDepth:32,writerKeyUnits:4096,writerKeyUtf8Bytes:12288,touchRowBytes:32768,touchedKeys:8192,touchedBytes:268435456,operationKeyBytes:1024});
const PROFILE='memory-suite.task4-writer-key-profile.v1';
function scanResultJson(text, byteLimit=LIMITS.originalResultBytes) {
 if(typeof text!=='string')C.fail('INVALID_JSON');
 const utf8Bytes=Buffer.byteLength(text);if(utf8Bytes>byteLimit)C.fail('RESOURCE_LIMIT');
 let i=0,nodes=0;const bad=()=>C.fail('INVALID_JSON');
 const ws=()=>{while(i<text.length&&[32,9,10,13].includes(text.charCodeAt(i)))i++;};
 function node(depth){if(++nodes>LIMITS.resultNodes||depth>LIMITS.resultDepth)C.fail('RESOURCE_LIMIT');}
 function string(){if(text[i++]!=='"')bad();while(i<text.length){const ch=text.charCodeAt(i++);if(ch===34)return;if(ch<32)bad();if(ch===92){const e=text[i++];if(e==='u'){for(let n=0;n<4;n++)if(!/[0-9a-fA-F]/.test(text[i++]||'!'))bad();}else if(!['"','\\','/','b','f','n','r','t'].includes(e))bad();}}bad();}
 function value(depth){node(depth);ws();const ch=text[i];
  if(ch==='"'){string();return;}
  if(ch==='['||ch==='{'){const object=ch==='{',end=object?'}':']';i++;ws();if(text[i]===end){i++;return;}while(true){if(object){node(depth+1);string();ws();if(text[i++]!==':')bad();}value(depth+1);ws();if(text[i]===end){i++;return;}if(text[i++]!==',')bad();ws();} }
  for(const token of ['null','true','false'])if(text.startsWith(token,i)){i+=token.length;return;}
  // Scan decimal magnitude without materializing a token. A JSON number rounds
  // to a finite, safe-integer-or-fraction double iff its exact absolute value is
  // below 9007199254740991.5 (the ties-to-even midpoint before 2^53). Larger
  // finite doubles are all unsafe integers; overflow is therefore rejected too.
  let integerDigits=0,leadingZeros=0,prefix='',nonzero=false;
  const digit=integerPart=>{const ch=text[i++];if(integerPart)integerDigits++;if(!nonzero&&ch==='0')leadingZeros++;else{nonzero=true;if(prefix.length<17)prefix+=ch;}};
  if(text[i]==='-')i++;
  if(text[i]==='0')digit(true);else{if(!(text[i]>='1'&&text[i]<='9'))bad();while(text[i]>='0'&&text[i]<='9')digit(true);}
  if(text[i]==='.'){i++;const at=i;while(text[i]>='0'&&text[i]<='9')digit(false);if(i===at)bad();}
  let exponent=0,negativeExponent=false;
  if(text[i]==='e'||text[i]==='E'){
   i++;if(text[i]==='+'||text[i]==='-'){negativeExponent=text[i]==='-';i++;}const at=i;
   // Any exponent beyond the entire bounded input length cannot be balanced by
   // its mantissa. Saturation preserves comparisons without integer overflow.
   while(text[i]>='0'&&text[i]<='9'){exponent=Math.min(LIMITS.originalResultBytes+64,exponent*10+text.charCodeAt(i)-48);i++;}if(i===at)bad();
  }
  if(nonzero){const order=integerDigits-leadingZeros+(negativeExponent?-exponent:exponent);if(order>16||(order===16&&prefix.padEnd(17,'0')>='90071992547409915'))bad();}

 }
 ws();value(0);ws();if(i!==text.length)bad();return {nodes,utf8Bytes};
}
function hashUtf8(text){const hash=crypto.createHash('sha256');for(let start=0;start<text.length;){let end=Math.min(start+65536,text.length);if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff&&text.charCodeAt(end)>=0xdc00&&text.charCodeAt(end)<=0xdfff)end--;hash.update(text.slice(start,end),'utf8');start=end;}return hash.digest('hex');}
function assertWriterKey(space,key){if(!['plugin','local'].includes(space)||typeof key!=='string'||!key.length||key.length>LIMITS.writerKeyUnits||Buffer.byteLength(key)>LIMITS.writerKeyUtf8Bytes||/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(key))throw Object.assign(new Error('AUTHORITY_WRITER_KEY_PROFILE_UNAVAILABLE:'+PROFILE),{code:'AUTHORITY_WRITER_KEY_PROFILE_UNAVAILABLE',profile:PROFILE});}
function fields(value,names){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==names.slice().sort().join('|'))C.fail('INVALID_RECEIPT');}
function digest(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))C.fail('INVALID_RECEIPT');}
function encodeTouch(row){fields(row,['space','key','sourceId','generation','version','present','revision','digest']);assertWriterKey(row.space,row.key);C.identifier(row.sourceId);C.identifier(row.generation);C.boundedInteger(row.version,1);if(typeof row.present!=='boolean')C.fail('INVALID_RECEIPT');if(row.revision!==null)C.boundedInteger(row.revision,1);if(row.digest!==null&&(typeof row.digest!=='string'||Buffer.byteLength(row.digest)>64))C.fail('INVALID_RECEIPT');if(row.present&&(row.revision===null||row.digest===null))C.fail('INVALID_RECEIPT');const text=C.canonical(row);if(Buffer.byteLength(text)>LIMITS.touchRowBytes)C.fail('RESOURCE_LIMIT');return text;}
function createTouchHasher(operationKey){const k=C.canonical(C.operationKey(operationKey));if(Buffer.byteLength(k)>LIMITS.operationKeyBytes)C.fail('RESOURCE_LIMIT');const hash=crypto.createHash('sha256');const prefix=n=>{const b=Buffer.allocUnsafe(4);b.writeUInt32BE(n);hash.update(b);};hash.update('memory-suite.owner-source-stamp-sequence.v1\0');prefix(Buffer.byteLength(k));hash.update(k);let count=0,utf8Bytes=0,done=false;
 return Object.freeze({update(ordinal,row){if(done||ordinal!==count)C.fail('INVALID_RECEIPT');if(count>=LIMITS.touchedKeys)C.fail('RESOURCE_LIMIT');const text=encodeTouch(row),bytes=Buffer.byteLength(text);if(utf8Bytes+bytes>LIMITS.touchedBytes)C.fail('RESOURCE_LIMIT');prefix(ordinal);prefix(bytes);hash.update(text);count++;utf8Bytes+=bytes;},finish(){if(done)C.fail('INVALID_RECEIPT');done=true;return {count,utf8Bytes,sha256:hash.digest('hex')};}});
}
function validateCompactReceipt(value,expected={}){fields(value,['contract','generation','namespace','operationId','fingerprint','operationClass','controlSequence','fenceEpoch','physicalBinding','ownerBinding','ordinaryResult','touchedSources']);if(value.contract!==C.OWNER_RECEIPT_CONTRACT)C.fail('INVALID_RECEIPT');C.intent(value);C.boundedInteger(value.controlSequence,1);C.boundedInteger(value.fenceEpoch,1);
 fields(value.physicalBinding,['dataInstanceId','dataIdentityContract','controlStoreId']);C.physicalBinding(value.physicalBinding);fields(value.ownerBinding,['fileIdentity','resetEpoch']);C.boundedInteger(value.ownerBinding.resetEpoch);fields(value.ownerBinding.fileIdentity,['device','inode','pathHash']);for(const k of ['device','inode'])if(typeof value.ownerBinding.fileIdentity[k]!=='string'||!/^\d{1,240}$/.test(value.ownerBinding.fileIdentity[k]))C.fail('INVALID_RECEIPT');digest(value.ownerBinding.fileIdentity.pathHash);
 if(value.ordinaryResult!==null){fields(value.ordinaryResult,['encoding','utf8Bytes','sha256']);if(value.ordinaryResult.encoding!=='json-utf8.v1')C.fail('INVALID_RECEIPT');C.boundedInteger(value.ordinaryResult.utf8Bytes,1);if(value.ordinaryResult.utf8Bytes>LIMITS.originalResultBytes)C.fail('RESOURCE_LIMIT');digest(value.ordinaryResult.sha256);}else if(['kv','batch'].includes(value.operationClass))C.fail('INVALID_RECEIPT');
 const touch=value.touchedSources;fields(touch,['encoding','count','utf8Bytes','sha256']);if(touch.encoding!=='owner-source-stamp-sequence.v1')C.fail('INVALID_RECEIPT');C.boundedInteger(touch.count);C.boundedInteger(touch.utf8Bytes);digest(touch.sha256);if(touch.count>LIMITS.touchedKeys||touch.utf8Bytes>LIMITS.touchedBytes||touch.utf8Bytes>touch.count*LIMITS.touchRowBytes||(touch.count===0&&touch.utf8Bytes!==0))C.fail('RESOURCE_LIMIT');
 for(const name of ['physicalBinding','ownerBinding'])if(expected[name]&&C.canonical(expected[name])!==C.canonical(value[name]))C.fail('INVALID_RECEIPT');if(expected.operationKey&&C.canonical(C.operationKey(expected.operationKey))!==C.canonical(C.operationKey(value)))C.fail('INVALID_RECEIPT');const text=C.canonical(value);if(Buffer.byteLength(text)>LIMITS.compactReceiptBytes)C.fail('RESOURCE_LIMIT');return value;
}
module.exports={LIMITS,PROFILE,scanResultJson,hashUtf8,assertWriterKey,encodeTouch,createTouchHasher,validateCompactReceipt};
