'use strict';
// Pure transport validation. A digest establishes integrity, never owner authority.
function createGradiaReadV2Protocol({sha256}) {
  if (typeof sha256 !== 'function') throw new TypeError('GRADIA_V2_HASH_REQUIRED');
  const MiB = 1048576;
  const defaults = {contentBytes:4*MiB,items:1024,metadataBytes:2*MiB,nativeMetadataBytes:MiB,
    queryBytes:32768,frameBytes:MiB,fragmentBytes:131072,frames:256,transferBytes:32*MiB,
    issuedRecordBytes:8*MiB,issuedRecords:4,physicalReads:4,managedBytes:64*MiB,
    renderedBytes:262144,metadataDepth:8,metadataNodes:131072};
  const maxima = {contentBytes:32*MiB,items:8192,metadataBytes:16*MiB,nativeMetadataBytes:8*MiB,
    queryBytes:131072,frameBytes:MiB,fragmentBytes:131072,frames:2048,transferBytes:256*MiB,
    issuedRecordBytes:64*MiB,issuedRecords:4,physicalReads:4,managedBytes:256*MiB,
    renderedBytes:4*MiB,metadataDepth:8,metadataNodes:1048576};
  const fail = reason => { throw new TypeError('GRADIA_V2_' + reason); };
  const integer = (value, positive=false) => {
    if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || Object.is(value,-0)) fail('INTEGER');
    return value;
  };
  const checkedAdd = (a,b) => { integer(a);integer(b);if(a>Number.MAX_SAFE_INTEGER-b)fail('OVERFLOW');return a+b; };
  const checkedMultiply = (a,b) => { integer(a);integer(b);if(b && a>Math.floor(Number.MAX_SAFE_INTEGER/b))fail('OVERFLOW');return a*b; };
  function plain(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('OBJECT');
    const proto=Object.getPrototypeOf(value);
    if(proto!==null && proto!==Object.prototype) fail('PROTOTYPE');
  }
  function fields(value,required,optional=[]) {
    plain(value);const keys=Reflect.ownKeys(value),out=Object.create(null);
    if(keys.length>required.length+optional.length)fail('FIELDS');
    for(const key of keys){if(typeof key!=='string'||(!required.includes(key)&&!optional.includes(key)))fail('FIELDS');const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value'in d)||!d.enumerable)fail('ACCESSOR');out[key]=d.value;}
    for(const key of required)if(!Object.hasOwn(out,key))fail('MISSING_FIELD');
    return out;
  }
  function array(value,max=1048576){
    if(!Array.isArray(value))fail('ARRAY');if(Object.getPrototypeOf(value)!==Array.prototype)fail('PROTOTYPE');const length=Object.getOwnPropertyDescriptor(value,'length').value;integer(length);if(length>max)fail('NODES');
    const keys=Reflect.ownKeys(value);if(keys.length!==length+1)fail('ARRAY_FIELDS');
    const out=[];for(let i=0;i<length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d)||!d.enumerable)fail('ACCESSOR');out.push(d.value);}return out;
  }
  // Exact JSON string byte measure without allocating a serialized string/buffer.
  function stringSize(value,max=16*MiB,nonempty=false){
    if(typeof value!=='string'||(nonempty&&!value.length)||value.length>max)fail('STRING');
    let utf8=0,jsonBytes=2;
    for(let i=0;i<value.length;i++){
      const c=value.charCodeAt(i);let bytes;
      if(c>=0xd800&&c<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))fail('UNSUPPORTED_TEXT');bytes=4;}
      else if(c>=0xdc00&&c<=0xdfff)fail('UNSUPPORTED_TEXT');
      else bytes=c<128?1:c<2048?2:3;
      // Input code units are capped at 32 MiB before this loop: UTF-8 <= 3*n
      // and JSON <= 6*n+2, both far below the safe-integer ceiling.
      utf8+=bytes;
      jsonBytes+=c===34||c===92?2:c<32?(c===8||c===9||c===10||c===12||c===13?2:6):bytes;
      if(utf8>max)fail('STRING_BYTES');
    }
    return {utf8,jsonBytes};
  }
  function prepareCanonical(value,maxBytes){
    let bytes=0,nodes=0;const ancestors=new Set();
    const add=n=>{bytes=checkedAdd(bytes,n);if(bytes>maxBytes)fail('CANONICAL_BYTES');};
    function visit(v,depth){
      if(depth>8)fail('DEPTH');if(++nodes>1048576)fail('NODES');
      if(v===null){add(4);return null;}
      if(typeof v==='string'){add(stringSize(v).jsonBytes);return v;}
      if(typeof v==='number'){integer(v);add(String(v).length);return v;}
      if(typeof v==='boolean'){add(v?4:5);return v;}
      if(!v||typeof v!=='object')fail('VALUE');if(ancestors.has(v))fail('CYCLE');ancestors.add(v);
      let out;
      if(Array.isArray(v)){
        const values=array(v);add(2+Math.max(0,values.length-1));out=[];for(const item of values)out.push(visit(item,depth+1));
      }else{
        plain(v);const keys=Reflect.ownKeys(v);if(keys.length>1048576-nodes)fail('NODES');if(keys.some(k=>typeof k!=='string'))fail('FIELDS');keys.sort();out=Object.create(null);add(2+Math.max(0,keys.length-1));
        for(const key of keys){const d=Object.getOwnPropertyDescriptor(v,key);if(!d||!('value'in d)||!d.enumerable)fail('ACCESSOR');if(++nodes>1048576)fail('NODES');add(stringSize(key,256).jsonBytes+1);out[key]=visit(d.value,depth+1);}
      }
      ancestors.delete(v);return out;
    }
    return {normalized:visit(value,0),bytes};
  }
  function encodePrepared(prepared){
    // Object insertion order cannot encode lexical integer-like keys. Emit the
    // already-validated bounded tree directly, serializing primitives only.
    const parts=[];
    function emit(value){
      if(value===null||typeof value!=='object'){parts.push(JSON.stringify(value));return;}
      if(Array.isArray(value)){
        parts.push('[');for(let i=0;i<value.length;i++){if(i)parts.push(',');emit(value[i]);}parts.push(']');
      }else{
        const keys=Object.keys(value).sort();parts.push('{');
        for(let i=0;i<keys.length;i++){if(i)parts.push(',');parts.push(JSON.stringify(keys[i]),':');emit(value[keys[i]]);}parts.push('}');
      }
    }
    emit(prepared.normalized);
    const encoded=new TextEncoder().encode(parts.join(''));
    if(encoded.byteLength!==prepared.bytes)fail('ENCODING_MISMATCH');return encoded;
  }
  function canonicalBytes(value){return encodePrepared(prepareCanonical(value,16*MiB));}
  function validateLimits(raw={}){
    const value=fields(raw,[],[...Object.keys(defaults),'itemBytes']),out={};
    for(const key of Object.keys(defaults)){const n=Object.hasOwn(value,key)?integer(value[key],true):defaults[key];if(n>maxima[key])fail('LIMIT_'+key);out[key]=n;}
    if(Object.hasOwn(value,'itemBytes')&&value.itemBytes!==out.contentBytes)fail('ITEM_LIMIT');
    out.itemBytes=out.contentBytes;return Object.freeze(out);
  }
  const id=value=>{stringSize(value,256,true);return value;};
  const nullableId=value=>value===null?null:id(value);
  const hash=value=>{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('HASH');return value;};
  const kinds=['content','corpus-metadata','native-metadata','selection-metadata'];
  function entry(raw,pageKind){
    plain(raw);const discriminant=Object.getOwnPropertyDescriptor(raw,'kind');if(discriminant&&!('value'in discriminant))fail('ACCESSOR');
    let e;
    if(!discriminant){
      if(pageKind!=='content')fail('ENTRY_KIND');e=fields(raw,['itemId','fragmentIndex','text','utf8Bytes']);id(e.itemId);integer(e.fragmentIndex);integer(e.utf8Bytes);if(stringSize(e.text,131072).utf8!==e.utf8Bytes)fail('CONTENT_BYTES');
    }else if(discriminant.value==='item-descriptor'){
      if(pageKind!=='corpus-metadata')fail('ENTRY_KIND');e=fields(raw,['kind','itemId','profile','contentBytes','contentHash','groupId']);id(e.itemId);nullableId(e.groupId);integer(e.contentBytes);if(e.contentBytes>32*MiB)fail('CONTENT_BYTES');hash(e.contentHash);
      if(!['libra.canonical.memory-text.v1','libra.micro.claims-text.v1','libra.micro.source-span.v1'].includes(e.profile))fail('PROFILE');
    }else if(discriminant.value==='source-proof'){
      if(pageKind!=='corpus-metadata')fail('ENTRY_KIND');e=fields(raw,['kind','proofId','sourceId','sourceHash']);id(e.proofId);id(e.sourceId);hash(e.sourceHash);
    }else if(discriminant.value==='native-ref'){
      if(pageKind!=='native-metadata')fail('ENTRY_KIND');e=fields(raw,['kind','messageId','generationId','speakerId','speakerName','contentHash','requestContentHash']);id(e.messageId);for(const key of ['generationId','speakerId','speakerName'])nullableId(e[key]);if(typeof e.contentHash!=='string'||!/^[a-f0-9]{8}:[0-9]{1,16}$/.test(e.contentHash))fail('NATIVE_HASH');hash(e.requestContentHash);
    }else if(discriminant.value==='selection-item'){
      if(pageKind!=='selection-metadata')fail('ENTRY_KIND');e=fields(raw,['kind','selectionIndex','itemId']);integer(e.selectionIndex);id(e.itemId);
    }else fail('ENTRY_KIND');
    return Object.freeze(e);
  }
  function validateFrame(raw){
    const frame=fields(raw,['schema','requestId','issuerId','transferId','pageKind','pageIndex','entries','frameHash']);
    if(frame.schema!=='gradia.owner-read.v2'||!kinds.includes(frame.pageKind))fail('SCHEMA');for(const key of ['requestId','issuerId','transferId'])id(frame[key]);integer(frame.pageIndex);if(frame.pageIndex>=2048)fail('PAGE_INDEX');hash(frame.frameHash);
    // Each closed entry is larger than 32 wire bytes; bound the reference array
    // before walking it. Check the cumulative complete envelope before encoding
    // and stop at the first overflowing entry, rather than scanning the transfer.
    const inputs=array(frame.entries,Math.floor(MiB/32));frame.entries=[];
    let wireBytes=prepareCanonical(frame,MiB).bytes;
    for(const rawEntry of inputs){
      const normalized=entry(rawEntry,frame.pageKind);
      wireBytes=checkedAdd(wireBytes,prepareCanonical(normalized,MiB).bytes+(frame.entries.length?1:0));
      if(wireBytes>MiB)fail('FRAME_BYTES');frame.entries.push(normalized);
    }
    if(!frame.entries.length)fail('EMPTY_FRAME');Object.freeze(frame.entries);
    const core=Object.create(null);for(const key of Object.keys(frame))if(key!=='frameHash')core[key]=frame[key];
    if(hash(sha256(encodePrepared(prepareCanonical(core,MiB))))!==frame.frameHash)fail('FRAME_HASH');return Object.freeze(frame);
  }
  return Object.freeze({validateLimits,validateFrame,canonicalBytes,checkedAdd,checkedMultiply});
}
