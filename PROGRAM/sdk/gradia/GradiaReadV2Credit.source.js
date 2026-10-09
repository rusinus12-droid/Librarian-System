'use strict';
// Application-declared representation bytes, not JavaScript/host peak heap.
function createGradiaReadV2Credit({maxManagedBytes,maxPhysicalReads}) {
  const fail=reason=>{throw new TypeError('GRADIA_V2_CREDIT_'+reason);};
  const integer=(value,positive=false)=>{if(!Number.isSafeInteger(value)||value<(positive?1:0)||Object.is(value,-0))fail('INTEGER');return value;};
  integer(maxManagedBytes,true);integer(maxPhysicalReads,true);
  if(maxManagedBytes>268435456||maxPhysicalReads>4)fail('LIMIT');
  const records=new Map();let managedBytes=0,physicalReads=0;
  const kinds=new Set(['utf16-text','bytes','metadata','frame','reassembly','encoding','selected-prompt','physical']);
  function id(value){if(typeof value!=='string'||!value.length||value.length>256)fail('ID');let bytes=0;for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const n=value.charCodeAt(++i);if(!(n>=0xdc00&&n<=0xdfff))fail('ID');bytes+=4;}else if(c>=0xdc00&&c<=0xdfff)fail('ID');else bytes+=c<128?1:c<2048?2:3;if(bytes>256)fail('ID');}return value;}
  function data(raw,keys){if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('FIELDS');const proto=Object.getPrototypeOf(raw);if(proto!==null&&proto!==Object.prototype)fail('PROTOTYPE');const own=Reflect.ownKeys(raw);if(own.length!==keys.length)fail('FIELDS');const result={};for(const key of own){if(!keys.includes(key))fail('FIELDS');const d=Object.getOwnPropertyDescriptor(raw,key);if(!d||!('value'in d)||!d.enumerable)fail('ACCESSOR');result[key]=d.value;}return result;}
  function add(raw,physical){const r=data(raw,physical?['id','bytes']:['id','bytes','kind']);id(r.id);integer(r.bytes);if(!physical&&!kinds.has(r.kind))fail('KIND');if(records.has(r.id))fail('DUPLICATE');if(r.bytes>maxManagedBytes-managedBytes)fail('BYTES');if(physical&&physicalReads>=maxPhysicalReads)fail('PHYSICAL_READS');
    records.set(r.id,{bytes:r.bytes,kind:physical?'physical':r.kind,physical,pending:physical,retired:false});managedBytes+=r.bytes;if(physical)physicalReads++;return Object.freeze({id:r.id,bytes:r.bytes});}
  const get=key=>{id(key);const record=records.get(key);if(!record)fail('UNKNOWN');return record;};
  const reserve=raw=>add(raw,false),beginPhysical=raw=>add(raw,true);
  const retire=key=>{const record=get(key);record.retired=true;};
  const settle=key=>{const record=get(key);if(!record.physical||!record.pending)fail('SETTLEMENT');record.pending=false;physicalReads--;return Object.freeze({retired:record.retired,retainedBytes:record.bytes});};
  const release=key=>{const record=get(key);if(record.pending)fail('UNSETTLED');managedBytes-=record.bytes;records.delete(key);};
  const snapshot=()=>{const byKind=Object.create(null);let retired=0,settledPhysical=0;for(const record of records.values()){byKind[record.kind]=(byKind[record.kind]||0)+record.bytes;if(record.retired)retired++;if(record.physical&&!record.pending)settledPhysical++;}return {managedBytes,physicalReads,reservations:records.size,retired,settledPhysical,kinds:byKind};};
  return Object.freeze({reserve,beginPhysical,retire,settle,release,snapshot});
}
