/* Opt-in extension history. Immutable cold pages; canonical owner publishes only roots.
 * Ordinary native get/set plus readback is NOT CAS, a distributed lock, or writer qualification. */
const WmExtensionHistory = (() => {
  'use strict';
  const C=typeof WmStorageContracts!=='undefined'?WmStorageContracts:require('./wm-storage-contracts.source.js');
  const COMMENT='lmai_extension_history',SCHEMA='wm.extension-history.v1',PAGE='wm.extension-history-page.v1';
  const LIMITS=Object.freeze({pageBytes:65536,chunkBytes:32768,recordBytes:262144,windowRows:48,keyBytes:8192,indexDepth:64});
  const utf8=s=>new TextEncoder().encode(s),decode=b=>new TextDecoder('utf-8',{fatal:true}).decode(b),copy=v=>JSON.parse(JSON.stringify(v));
  const digest=b=>C.hashBytes(b),id=v=>typeof v==='string'&&/^eh-[a-f0-9]{64}$/.test(v),ref=v=>v===null||id(v);
  const historyRow=r=>r&&['lmai_extension_event','lmai_extension_lock'].includes(r.comment);
  const pendingRow=r=>r.comment==='lmai_extension_event'&&!['processed','superseded'].includes(r.extensionStatus);
  const queueKey=r=>JSON.stringify([r.extensionScope,r.extensionPacketId])+'\n'+r.key;
  const isPaged=lore=>Array.isArray(lore)&&lore.some(r=>r?.comment===COMMENT);
  // Keeps existing synchronous callers synchronous for inline legacy data. Paged
  // callers await the same public operation; there is no synchronous cold miss.
  function run(iterator){function step(value,failed=false){let s;try{s=failed?iterator.throw(value):iterator.next(value);}catch(e){throw e;}while(!s.done){if(s.value&&typeof s.value.then==='function')return s.value.then(v=>step(v),e=>step(e,true));s=iterator.next(s.value);}return s.value;}return step();}
  function createHistory({owner,scope,eventScope=scope,mode='plugin_only',profile=null,limits={}}={}) {
    if(mode!=='plugin_only'&&(mode!=='server_only'||profile!=='server-pinned-roots-v2'||owner?.profile!==profile))throw Error('history_server_dependency_roots_unsupported');
    profile=mode==='server_only'?profile:'native-single-runtime-readback-v1';
    if(!owner||typeof owner.getItem!=='function'||typeof owner.setItem!=='function')throw Error('history_owner_unavailable');
    if(typeof scope!=='string'||!scope||utf8(scope).length>8192)throw Error('history_scope_invalid');
    const L={...LIMITS,...limits};for(const k of Object.keys(LIMITS))if(!Number.isSafeInteger(L[k])||L[k]<1||L[k]>LIMITS[k])throw Error('history_limits_invalid');
    if(L.chunkBytes>32768||L.pageBytes<4096)throw Error('history_limits_invalid');
    let pageReads=0,pageWrites=0,maxReadBytes=0;
    const storageKey=logicalId=>'wm.cold.extension.'+logicalId;
    const checkRoot=root=>{if(!root||root.schema!==SCHEMA||root.version!==1||root.scope!==scope||root.eventScope!==eventScope||root.profile!==profile||!['ready','copying','verifying'].includes(root.phase)||!['records','pending','legacyRoot','head'].every(k=>ref(root[k]))||!['count','revision'].every(k=>Number.isSafeInteger(root[k])&&root[k]>=0)||JSON.stringify(root.limits)!==JSON.stringify(L)||utf8(JSON.stringify(root)).length>8192)throw Error('history_manifest_invalid');return root;};
    const empty=()=>({schema:SCHEMA,version:1,scope,eventScope,profile,phase:'ready',records:null,pending:null,legacyRoot:null,head:null,count:0,revision:0,limits:{...L}});
    function fromLore(lore){const rows=lore.filter(r=>r?.comment===COMMENT);if(rows.length!==1)throw Error('history_manifest_invalid');let root;try{root=JSON.parse(rows[0].content);}catch{throw Error('history_manifest_invalid');}return checkRoot(root);}
    const toRow=root=>({key:COMMENT+'::state',comment:COMMENT,content:JSON.stringify(checkRoot(root)),mode:'normal',insertorder:6,alwaysActive:false});
    function replaceRoot(lore,root){const row=toRow(root),i=lore.findIndex(r=>r?.comment===COMMENT);if(i<0)lore.push(row);else lore[i]=row;return lore;}
    async function writePage(kind,data,dependencies=[]){
      const raw=JSON.stringify({version:1,kind,data}),deps=[...new Set(dependencies.filter(Boolean))];if(!deps.every(id))throw Error('history_dependency_invalid');
      const logicalId='eh-'+await digest(utf8(JSON.stringify([scope,raw,deps]))),page={schema:PAGE,scope,logicalId,raw,dependencies:deps},text=JSON.stringify(page);
      if(utf8(text).length>L.pageBytes)throw Error('history_page_limit');
      const key=storageKey(logicalId),prior=await owner.getItem(key);if(prior!==null&&prior!==undefined&&prior!==text)throw Error('history_immutable_conflict');
      if(prior===null||prior===undefined){await owner.setItem(key,text);pageWrites++;}
      if(await owner.getItem(key)!==text)throw Error('history_page_readback');
      return logicalId;
    }
    async function readPage(logicalId,kind=null){
      if(!id(logicalId))throw Error('history_page_reference_invalid');const text=await owner.getItem(storageKey(logicalId));pageReads++;
      if(typeof text!=='string')throw Error('history_page_missing');const bytes=utf8(text).length;maxReadBytes=Math.max(maxReadBytes,bytes);if(bytes>L.pageBytes)throw Error('history_page_limit');
      let page,body;try{page=JSON.parse(text);body=JSON.parse(page.raw);}catch{throw Error('history_page_corrupt');}
      if(page.schema!==PAGE||page.scope!==scope||page.logicalId!==logicalId||!Array.isArray(page.dependencies)||!page.dependencies.every(id)||new Set(page.dependencies).size!==page.dependencies.length||body.version!==1||kind&&body.kind!==kind||'eh-'+await digest(utf8(JSON.stringify([scope,page.raw,page.dependencies])))!==logicalId)throw Error('history_page_corrupt');
      return body.data;
    }
    const keyCheck=key=>{if(typeof key!=='string'||!key||utf8(key).length>L.keyBytes)throw Error('history_key_limit');};
    async function node(root){if(!root)return null;const n=await readPage(root,'index');if(!n||typeof n.key!=='string'||!id(n.value)||!ref(n.left)||!ref(n.right)||!Number.isSafeInteger(n.height)||n.height<1||n.height>L.indexDepth)throw Error('history_index_corrupt');keyCheck(n.key);return n;}
    const height=async r=>(await node(r))?.height||0;
    async function make(n){const h=1+Math.max(await height(n.left),await height(n.right));if(h>L.indexDepth)throw Error('history_index_depth');return writePage('index',{key:n.key,value:n.value,left:n.left,right:n.right,height:h},[n.value,n.left,n.right]);}
    async function balance(n){
      const delta=await height(n.left)-await height(n.right);
      if(delta>1){let l=await node(n.left);if(await height(l.left)<await height(l.right)){const lr=await node(l.right);n.left=await make({...lr,left:await make({...l,right:lr.left})});l=await node(n.left);}return make({...l,right:await make({...n,left:l.right})});}
      if(delta< -1){let r=await node(n.right);if(await height(r.right)<await height(r.left)){const rl=await node(r.left);n.right=await make({...rl,right:await make({...r,left:rl.right})});r=await node(n.right);}return make({...r,left:await make({...n,right:r.left})});}
      return make(n);
    }
    async function lookup(root,key){keyCheck(key);for(let depth=0;root;depth++){if(depth>=L.indexDepth)throw Error('history_index_depth');const n=await node(root);if(key===n.key)return n.value;root=key<n.key?n.left:n.right;}return null;}
    async function change(root,key,value,depth=0){
      keyCheck(key);if(depth>=L.indexDepth)throw Error('history_index_depth');const n=await node(root);
      if(!n)return value?make({key,value,left:null,right:null}):null;
      if(key<n.key)n.left=await change(n.left,key,value,depth+1);else if(key>n.key)n.right=await change(n.right,key,value,depth+1);else if(value)n.value=value;else{
        if(!n.left)return n.right;if(!n.right)return n.left;
        let successor=await node(n.right),steps=0;while(successor.left){if(++steps>=L.indexDepth)throw Error('history_index_depth');successor=await node(successor.left);}
        n.key=successor.key;n.value=successor.value;n.right=await change(n.right,successor.key,null,depth+1);
      }
      return balance(n);
    }
    async function range(root,{cursor='',prefix='',limit=L.windowRows}={}){
      if(!Number.isSafeInteger(limit)||limit<1||limit>L.windowRows)throw Error('history_window_limit');
      const out=[],stack=[];let current=root;
      while(current||stack.length){while(current){if(stack.length>=L.indexDepth)throw Error('history_index_depth');const n=await node(current);if(n.key<=cursor||prefix&&n.key<prefix){current=n.right;continue;}stack.push(n);current=n.left;}
        if(!stack.length)break;const n=stack.pop();if(prefix&&!n.key.startsWith(prefix))break;out.push({key:n.key,value:n.value});if(out.length>limit)break;current=n.right;}
      const more=out.length>limit;if(more)out.pop();return {items:out,nextCursor:more?out.at(-1).key:null};
    }
    const encode64=bytes=>{let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return globalThis.btoa?globalThis.btoa(text):Buffer.from(bytes).toString('base64');};
    const decode64=text=>{if(typeof text!=='string'||text.length>4*Math.ceil(L.chunkBytes/3)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))throw Error('history_chunk_corrupt');const bytes=globalThis.atob?Uint8Array.from(atob(text),c=>c.charCodeAt(0)):new Uint8Array(Buffer.from(text,'base64'));if(encode64(bytes)!==text||bytes.length>L.chunkBytes)throw Error('history_chunk_corrupt');return bytes;};
    async function storeRecord(row,previous=null){
      if(!historyRow(row)||typeof row.content!=='string')throw Error('history_row_invalid');keyCheck(row.key);
      const bytes=utf8(JSON.stringify(row));let next=null;
      for(let end=bytes.length;end>0;){const start=Math.max(0,end-L.chunkBytes);next=await writePage('chunk',{data:encode64(bytes.subarray(start,end)),next},[next]);end=start;}
      return writePage('record',{key:row.key,bytes:bytes.length,sha256:await digest(bytes),first:next,previous},[next,previous]);
    }
    async function recordMeta(pointer){const meta=await readPage(pointer,'record');if(!meta||!Number.isSafeInteger(meta.bytes)||meta.bytes<1||!/^[a-f0-9]{64}$/.test(meta.sha256)||!id(meta.first)||!ref(meta.previous))throw Error('history_record_corrupt');return meta;}
    async function* chunks(pointer){const meta=await recordMeta(pointer);let next=meta.first,total=0,count=0;while(next){if(++count>Math.ceil(meta.bytes/L.chunkBytes))throw Error('history_chunk_cycle');const chunk=await readPage(next,'chunk');if(!ref(chunk.next))throw Error('history_chunk_corrupt');const bytes=decode64(chunk.data);total+=bytes.length;if(!bytes.length||total>meta.bytes)throw Error('history_chunk_corrupt');yield bytes;next=chunk.next;}if(total!==meta.bytes)throw Error('history_record_length');}
    async function readRecord(pointer){if(!pointer)return null;const meta=await recordMeta(pointer);if(meta.bytes>L.recordBytes)throw Error('history_record_decode_limit');const bytes=new Uint8Array(meta.bytes);let offset=0;for await(const chunk of chunks(pointer)){bytes.set(chunk,offset);offset+=chunk.length;}if(await digest(bytes)!==meta.sha256)throw Error('history_record_digest');let row;try{row=JSON.parse(decode(bytes));}catch{throw Error('history_record_corrupt');}if(!historyRow(row)||row.key!==meta.key||typeof row.content!=='string')throw Error('history_record_corrupt');return row;}
    async function get(root,key){checkRoot(root);return readRecord(await lookup(root.records,key));}
    async function getLegacy(root,key){checkRoot(root);return readRecord(await lookup(root.legacyRoot,key));}
    async function* readRecordChunks(root,key){checkRoot(root);const pointer=await lookup(root.records,key);if(pointer)yield* chunks(pointer);}
    async function seal(root){const prior=root.head,next={...root,revision:root.revision+1};if(!Number.isSafeInteger(next.revision))throw Error('history_revision_limit');next.head=await writePage('manifest',{...next,head:prior},[next.records,next.pending,next.legacyRoot,prior]);return checkRoot(next);}
    async function put(root,row,{legacy=false}={}){
      checkRoot(root);const previous=await lookup(root.records,row.key);let value;
      if(previous){const meta=await recordMeta(previous),hash=await digest(utf8(JSON.stringify(row)));if(meta.sha256===hash)return root;
        const old=await readRecord(previous);if(old.comment!==row.comment)throw Error('history_record_kind_changed');
        if(row.comment==='lmai_extension_lock'){
          // Only a revision head may advance. Its new immutable version must
          // already exist in this same root and bind the exact predecessor.
          let prior,next,version;try{prior=JSON.parse(old.content);next=JSON.parse(row.content);}catch{throw Error('history_lock_immutable');}
          if(!row.key.startsWith('lmai_extension_lock::frp:')||prior.schema!=='wm.extension-lock.v1'||next.schema!==prior.schema||next.key!==row.key||prior.key!==row.key||!Number.isSafeInteger(next.revision)||next.revision!==prior.revision+1||typeof next.versionKey!=='string'||!next.versionKey.startsWith('lmai_extension_lock::frp-version:'))throw Error('history_lock_immutable');
          const versionRow=await readRecord(await lookup(root.records,next.versionKey));
          try{version=JSON.parse(versionRow?.content || 'null');}catch{throw Error('history_revision_head_invalid');}
          if(versionRow?.comment!=='lmai_extension_lock'||version?.schema!=='wm.extension-lock.v1'||version.key!==next.versionKey||version.headKey!==row.key||version.previous!==prior.versionKey||JSON.stringify(version.record)!==JSON.stringify(next.record))throw Error('history_revision_head_invalid');
        }
      }
      value=await storeRecord(row,previous);let next={...root,records:await change(root.records,row.key,value),count:root.count+(previous?0:1)};
      if(row.comment==='lmai_extension_event'){
        if(typeof row.extensionScope!=='string'||row.extensionScope!==eventScope||typeof row.extensionPacketId!=='string'||!['pending','waiting','dispatching','prepared','uncertain','processed','superseded'].includes(row.extensionStatus))throw Error('history_event_index_invalid');
        if(previous){const old=await readRecord(previous);if(queueKey(old)!==queueKey(row))throw Error('history_event_identity_changed');}
        next.pending=await change(root.pending,queueKey(row),pendingRow(row)?value:null);
      }
      if(legacy)next.legacyRoot=await change(root.legacyRoot,row.key,value);
      return seal(next);
    }
    async function pending(root,{cursor='',limit=L.windowRows,packetId=null}={}){
      checkRoot(root);const prefix=packetId===null?'':JSON.stringify([eventScope,packetId])+'\n';const page=await range(root.pending,{cursor:cursor||'',limit,prefix}),rows=[];
      for(const item of page.items){const row=await readRecord(item.value);if(!pendingRow(row)||queueKey(row)!==item.key)throw Error('history_pending_index_corrupt');rows.push(row);}
      return {rows,nextCursor:page.nextCursor,windowLimit:L.windowRows};
    }
    // Bounded ordered reads over the same immutable record index. No archive scan.
    async function scan(root,{cursor='',prefix='',limit=L.windowRows}={}){
      checkRoot(root);const page=await range(root.records,{cursor, prefix,limit}),rows=[];
      for(const item of page.items)rows.push(await readRecord(item.value));
      return {rows,nextCursor:page.nextCursor,windowLimit:L.windowRows};
    }
    async function before(root,key,{prefix=''}={}){
      checkRoot(root);keyCheck(key);let pointer=root.records,candidate=null;
      for(let depth=0;pointer;depth++){if(depth>=L.indexDepth)throw Error('history_index_depth');const n=await node(pointer);
        if(n.key<key){candidate=n;pointer=n.right;}else pointer=n.left;
      }
      return candidate&&(!prefix||candidate.key.startsWith(prefix))?readRecord(candidate.value):null;
    }
    async function sourceFingerprint(rows){const parts=[];for(const row of rows)parts.push(await digest(utf8(JSON.stringify(row))));return digest(utf8(JSON.stringify(parts)));}
    async function migrate(lore,{limit=L.windowRows,restartOnSourceChange=false}={}){
      if(!Number.isSafeInteger(limit)||limit<1||limit>L.windowRows)throw Error('history_window_limit');
      const source=lore.filter(historyRow);let root=isPaged(lore)?fromLore(lore):empty();
      if(isPaged(lore)&&root.phase==='ready'){if(source.length)throw Error('history_inline_rows_after_cutover');return {done:true,copied:0,lore:copy(lore),root};}
      // Legacy canonical hydration is exceptional and explicit. Only migration scans
      // the supplied source; steady-state get/put/queue never load it again.
      const sourceDigest=await sourceFingerprint(source);
      if(!root.migration)root={...root,phase:'copying',migration:{sourceDigest,total:source.length,cursor:0,verifyCursor:0}};
      if(root.migration.sourceDigest!==sourceDigest||root.migration.total!==source.length){
        if(!restartOnSourceChange)throw Error('migration_source_changed');
        // A new explicit source attempt retains the earlier immutable manifest chain.
        root={...empty(),head:root.head,legacyRoot:root.legacyRoot,revision:root.revision,phase:'copying',migration:{sourceDigest,total:source.length,cursor:0,verifyCursor:0,restarts:(root.migration.restarts||0)+1}};
      }
      const unique=new Set();for(const row of source){if(unique.has(row.key))throw Error('migration_duplicate_identity');unique.add(row.key);}
      let copied=0;
      if(root.phase==='copying'){
        while(root.migration.cursor<source.length&&copied<limit){const i=root.migration.cursor;root=await put(root,source[i],{legacy:true});root={...root,migration:{...root.migration,cursor:i+1}};copied++;}
        if(root.migration.cursor===source.length)root={...root,phase:'verifying'};
      }else{
        while(root.migration.verifyCursor<source.length&&copied<limit){const i=root.migration.verifyCursor,p=await lookup(root.records,source[i].key),meta=await recordMeta(p);const expected=utf8(JSON.stringify(source[i]));if(meta.sha256!==await digest(expected))throw Error('migration_readback_changed');let offset=0;for await(const chunk of chunks(p)){for(let b=0;b<chunk.length;b++)if(chunk[b]!==expected[offset+b])throw Error('migration_readback_changed');offset+=chunk.length;}if(offset!==expected.length)throw Error('migration_readback_changed');root={...root,migration:{...root.migration,verifyCursor:i+1}};copied++;}
        if(root.migration.verifyCursor===source.length)root={...root,phase:'ready'};
      }
      root=await seal(root);const done=root.phase==='ready',next=lore.filter(r=>r?.comment!==COMMENT&&(!done||!historyRow(r))).map(copy);next.push(toRow(root));
      return {done,copied,lore:next,root};
    }
    return Object.freeze({empty,fromLore,toRow,replaceRoot,get,getLegacy,put,pending,scan,before,migrate,readRecordChunks,storageKey,limits:Object.freeze(L),stats:()=>({pageReads,pageWrites,maxReadBytes,retainedPages:0}),qualifications:Object.freeze({nativeAtomic:false,allWriterOwnership:false,serverActivation:false})});
  }
  return Object.freeze({createHistory,COMMENT,SCHEMA,PAGE,LIMITS,isPaged,historyRow,run});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=WmExtensionHistory;
