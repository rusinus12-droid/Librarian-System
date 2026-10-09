'use strict';
// Fixed closed page schemas. Transport integrity is not producer/native authority.
// Caller reserves iterator.reservationBytes before next(); retained outputs need
// their own reservations. This module cannot mutate the endpoint credit ledger.
function createGradiaReadV2Frames({protocol,sha256}) {
  if(!protocol||typeof protocol.canonicalBytes!=='function'||typeof sha256!=='function')throw new TypeError('GRADIA_V2_FRAMES_DEPENDENCY');
  const MiB=1048576;
  const fail=reason=>{throw new TypeError('GRADIA_V2_FRAMES_'+reason);};
  const integer=(value,positive=false)=>{if(!Number.isSafeInteger(value)||value<(positive?1:0)||Object.is(value,-0))fail('INTEGER');return value;};
  const checkedAdd=protocol.checkedAdd,checkedMultiply=protocol.checkedMultiply;
  // Executable sources are private, trusted synchronous producers, never IPC data.
  // Capture intrinsics instead of looking up next/return/iterator on a producer.
  const generatorPrototype=Object.getPrototypeOf(Object.getPrototypeOf((function*(){})()));
  const iteratorPrototype=Object.getPrototypeOf(generatorPrototype);
  const generatorNext=Object.getOwnPropertyDescriptor(generatorPrototype,'next').value;
  const generatorReturn=Object.getOwnPropertyDescriptor(generatorPrototype,'return').value;
  const iteratorIdentity=Object.getOwnPropertyDescriptor(iteratorPrototype,Symbol.iterator).value;
  function admitGenerator(value){
    if(!value||typeof value!=='object')fail('ITERATOR');
    const proto=Object.getPrototypeOf(value);
    if(!proto||Object.getPrototypeOf(proto)!==generatorPrototype||Reflect.ownKeys(proto).length!==0)fail('ITERATOR_PROTOTYPE');
    const own=Reflect.ownKeys(value);
    if(own.some(key=>key!=='reservationBytes'))fail('ITERATOR_FIELDS');
    if(own.length){const descriptor=Object.getOwnPropertyDescriptor(value,'reservationBytes');if(!descriptor||!('value'in descriptor))fail('ACCESSOR');integer(descriptor.value);}
    if(Object.getPrototypeOf(generatorPrototype)!==iteratorPrototype
      ||Object.getOwnPropertyDescriptor(generatorPrototype,'next')?.value!==generatorNext
      ||Object.getOwnPropertyDescriptor(generatorPrototype,'return')?.value!==generatorReturn
      ||Object.getOwnPropertyDescriptor(iteratorPrototype,Symbol.iterator)?.value!==iteratorIdentity)fail('ITERATOR_INTRINSICS');
  }

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
  function measuredScalar(value){
    if(value===null)return 4;
    if(typeof value==='string')return stringSize(value).jsonBytes;
    if(typeof value==='number'){integer(value);return String(value).length;}
    if(Array.isArray(value)&&value.length===0)return 2;
    fail('SCALAR');
  }
  function measureRecord(value){let bytes=2;const keys=Object.keys(value);if(keys.length)bytes+=keys.length-1;for(const key of keys)bytes=checkedAdd(bytes,stringSize(key,256).jsonBytes+1+measuredScalar(value[key]));return bytes;}
  function expose(generator,reservationBytes){Object.defineProperty(generator,'reservationBytes',{value:reservationBytes,enumerable:true});return generator;}
  function fragmentText(raw){
    const input=fields(raw,['itemId','text'],['maxFragmentBytes']);id(input.itemId);const max=input.maxFragmentBytes===undefined?131072:integer(input.maxFragmentBytes,true);if(max>131072)fail('FRAGMENT_BYTES');if(typeof input.text!=='string')fail('STRING');
    const reservationBytes=checkedAdd(checkedMultiply(max,2),1024);
    return expose((function*(){
      stringSize(input.text,32*MiB); // whole-input validity, no whole-input encoding/copy
      if(!input.text.length){yield Object.freeze({itemId:input.itemId,fragmentIndex:0,text:'',utf8Bytes:0});return;}
      let start=0,bytes=0,index=0;
      for(let i=0;i<input.text.length;){const c=input.text.charCodeAt(i),units=c>=0xd800&&c<=0xdbff?2:1,n=units===2?4:c<128?1:c<2048?2:3;if(n>max)fail('CODE_POINT_EXCEEDS_FRAGMENT');
        if(bytes+n>max){yield Object.freeze({itemId:input.itemId,fragmentIndex:index++,text:input.text.slice(start,i),utf8Bytes:bytes});start=i;bytes=0;}
        bytes+=n;i+=units;
      }
      if(start<input.text.length)yield Object.freeze({itemId:input.itemId,fragmentIndex:index,text:input.text.slice(start),utf8Bytes:bytes});
    })(),reservationBytes);
  }
  function iterateFrames(raw){
    const input=fields(raw,['binding','entries','limits']);
    const limits=protocol.validateLimits(input.limits);
    const binding=fields(input.binding,['schema','requestId','issuerId','transferId','pageKind']);
    if(binding.schema!=='gradia.owner-read.v2'||!kinds.includes(binding.pageKind))fail('SCHEMA');for(const key of ['requestId','issuerId','transferId'])id(binding[key]);Object.freeze(binding);
    // Conservative application-controlled simultaneous bytes: UTF-16 core/wire,
    // their UTF-8 buffers, bounded hash-input copy, pending-entry encoding and
    // fragment text. Engine/host allocation overhead remains separately qualified.
    let arrayLength=null;
    if(Array.isArray(input.entries)){
      if(Object.getPrototypeOf(input.entries)!==Array.prototype)fail('PROTOTYPE');
      arrayLength=integer(Object.getOwnPropertyDescriptor(input.entries,'length').value);
      if(arrayLength>limits.metadataNodes)fail('NODES');
    }else admitGenerator(input.entries);
    // Array inputs are already caller-owned. Reserve their bounded key scan as
    // well; values are still read one at a time, without copying the transfer.
    const reservationBytes=checkedAdd(checkedAdd(checkedMultiply(limits.frameBytes,16),4096),arrayLength===null?0:checkedMultiply(arrayLength,64));
    function* source(){
      if(arrayLength!==null){
        if(Reflect.ownKeys(input.entries).length!==arrayLength+1)fail('ARRAY_FIELDS');
        for(let i=0;i<arrayLength;i++){const d=Object.getOwnPropertyDescriptor(input.entries,String(i));if(!d||!('value'in d)||!d.enumerable)fail('ACCESSOR');yield d.value;}
      }else{
        let done=false;
        try{for(;;){const step=generatorNext.call(input.entries);if(step.done){done=true;return;}yield step.value;}}
        finally{if(!done)generatorReturn.call(input.entries);}
      }
    }
    return expose((function*(){
      if(reservationBytes>limits.managedBytes)fail('MANAGED_BYTES');
      let pageIndex=0,aggregate=0,contentBytes=0,metadataBytes=2,metadataNodes=1;
      let group=[],entryBytes=0,lastItem=null,lastFragment=-1,itemBytes=0,selectionIndex=0;
      const seen=new Set();
      const baseBytes=()=>measureRecord({...binding,pageIndex,entries:[]});
      const wireSize=(count,size)=>checkedAdd(baseBytes()+size+Math.max(0,count-1),79); // comma + "frameHash":64-hex
      function finish(){
        const predicted=wireSize(group.length,entryBytes);
        if(pageIndex>=limits.frames||predicted>limits.frameBytes)fail('FRAME_LIMIT');
        const nextAggregate=checkedAdd(aggregate,predicted);if(nextAggregate>limits.transferBytes)fail('TRANSFER_BYTES');
        const core={...binding,pageIndex,entries:Object.freeze(group)};
        const preimage=protocol.canonicalBytes(core),frameHash=hash(sha256(preimage));
        const frame=Object.freeze({...core,frameHash});
        const wireBytes=protocol.canonicalBytes(frame).byteLength;
        if(wireBytes!==predicted)fail('MEASUREMENT');
        aggregate=nextAggregate;pageIndex=checkedAdd(pageIndex,1);
        const result=Object.freeze({frame,wireBytes,coreBytes:preimage.byteLength,reservationBytes});
        group=[];entryBytes=0;return result;
      }
      for(const rawEntry of source()){
        const e=entry(rawEntry,binding.pageKind),size=measureRecord(e);
        metadataNodes=checkedAdd(metadataNodes,1+2*Object.keys(e).length);if(metadataNodes>limits.metadataNodes)fail('NODES');
        if(binding.pageKind==='content'){
          if(e.utf8Bytes>limits.fragmentBytes)fail('FRAGMENT_BYTES');
          if(e.itemId!==lastItem){if(seen.has(e.itemId)||e.fragmentIndex!==0)fail('FRAGMENT_ORDER');seen.add(e.itemId);if(seen.size>limits.items)fail('ITEMS');lastItem=e.itemId;lastFragment=-1;itemBytes=0;}
          if(e.fragmentIndex!==(lastFragment<0?0:checkedAdd(lastFragment,1)))fail('FRAGMENT_ORDER');lastFragment=e.fragmentIndex;
          itemBytes=checkedAdd(itemBytes,e.utf8Bytes);contentBytes=checkedAdd(contentBytes,e.utf8Bytes);if(itemBytes>limits.itemBytes||contentBytes>limits.contentBytes)fail('CONTENT_BYTES');
        }else{
          metadataBytes=checkedAdd(metadataBytes,size+(metadataBytes===2?0:1));
          if(metadataBytes>(binding.pageKind==='native-metadata'?limits.nativeMetadataBytes:limits.metadataBytes))fail('METADATA_BYTES');
          if(e.kind==='item-descriptor'||e.kind==='selection-item'){if(seen.has(e.itemId))fail('DUPLICATE_ITEM');seen.add(e.itemId);if(seen.size>limits.items)fail('ITEMS');}
          if(e.kind==='selection-item'&&e.selectionIndex!==selectionIndex++)fail('SELECTION_ORDER');
        }
        if(group.length&&wireSize(group.length+1,checkedAdd(entryBytes,size))>limits.frameBytes)yield finish();
        if(wireSize(group.length+1,checkedAdd(entryBytes,size))>limits.frameBytes)fail('ENTRY_EXCEEDS_FRAME');
        group.push(e);entryBytes=checkedAdd(entryBytes,size);
      }
      if(group.length)yield finish();
    })(),reservationBytes);
  }
  return Object.freeze({fragmentText,iterateFrames});
}
