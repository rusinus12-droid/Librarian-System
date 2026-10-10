/* LIBRA READONLY SOURCE CONTEXT v1
 * Opaque instance-local handles are provenance inside this owner, not a host
 * mutation certificate or a serializable corpus proof. No background work.
 */
function createLibraReadonlySourceContext(owner) {
  'use strict';
  const MiB=1024*1024,MAX_ROWS=16384,MAX_CHARS=2*MiB,MAX_METADATA=MiB;
  const handles=new WeakMap(),requests=new Map();
  const fail=code=>{throw Object.assign(new Error(code),{code});};
  const frozen=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const v of Object.values(value))frozen(v);Object.freeze(value);}return value;};
  const field=(value,key)=>{if(!value||typeof value!=='object')fail('NATIVE_IDENTITY_UNAVAILABLE');const d=Object.getOwnPropertyDescriptor(value,key);if(!d)return undefined;if(!Object.hasOwn(d,'value'))fail('NATIVE_IDENTITY_UNAVAILABLE');return d.value;};
  const id=value=>{if(typeof value!=='string'||!value||value.length>512||value.trim()!==value||/[\0\r\n]/.test(value))fail('NATIVE_IDENTITY_UNAVAILABLE');return value;};
  const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.getOwnPropertySymbols(value).length||Object.getOwnPropertyNames(value).sort().join('|')!==keys.slice().sort().join('|'))fail('READ_CONTEXT_REQUEST_INVALID');for(const k of keys){const d=Object.getOwnPropertyDescriptor(value,k);if(!d||!Object.hasOwn(d,'value'))fail('READ_CONTEXT_REQUEST_INVALID');}return value;};
  const wellFormed=value=>{for(let i=0;i<value.length;i++){const n=value.charCodeAt(i);if(n>=0xd800&&n<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(n>=0xdc00&&n<=0xdfff)return false;}return true;};
  const now=()=>performance.now();
  function retire(s,status){if(s.status==='live'||s.status==='pending')s.status=status;s.view=null;s.identity=null;try{if(s.route)owner.storage.releaseReadonlyRouteObservation({handle:s.route.handle,requestId:s.requestId});}finally{s.route=null;if(!s.physical)requests.delete(s.requestId);}}
  function check(s){if(owner.isDisposed()){retire(s,'READ_CONTEXT_DISPOSED');fail('READ_CONTEXT_DISPOSED');}if(s.status!=='live'&&s.status!=='pending')fail(s.status);if(now()>=s.deadline){retire(s,'READ_CONTEXT_EXPIRED');fail('READ_CONTEXT_EXPIRED');}}
  function state(input,released=false){exact(input,['handle','requestId']);const s=handles.get(input.handle);if(!s||s.requestId!==input.requestId)fail('INVALID_READ_CONTEXT_HANDLE');if(!released)check(s);return s;}
  function nativeSnapshot(character,withSource){
    const characterId=id(field(character,'chaId')),chats=field(character,'chats'),page=field(character,'chatPage');
    if(!Array.isArray(chats)||chats.length>4096||!Number.isSafeInteger(page)||page<0||page>=chats.length)fail('NATIVE_IDENTITY_UNAVAILABLE');
    const selected=chats[page],chatId=id(field(selected,'id')),byId=new Map();
    for(const chat of chats){const key=id(field(chat,'id'));if(byId.has(key))fail('NATIVE_IDENTITY_UNAVAILABLE');byId.set(key,chat);}
    const copies=[],chain=[],seen=new Set();let current=selected,totalRows=0,totalChars=0,metadataChars=JSON.stringify({characterId,chatId,chain:[]}).length;
    while(current){
      const currentId=id(field(current,'id'));if(seen.has(currentId)||seen.size>=64)fail('NATIVE_LINEAGE_UNAVAILABLE');seen.add(currentId);
      const rows=field(current,'message');if(!Array.isArray(rows)||rows.length>MAX_ROWS||totalRows+rows.length>MAX_ROWS)fail('READ_CONTEXT_SOURCE_LIMIT');totalRows+=rows.length;
      const identities=[],sourceRows=[],markerRows=[],messageIds=new Set();
      for(const raw of rows){
        const messageId=id(field(raw,'chatId')),role=field(raw,'role'),disabled=field(raw,'disabled')===true,isComment=field(raw,'isComment')===true,saying=field(raw,'saying')??'';
        if(typeof role!=='string'||role.length>32||typeof saying!=='string'||saying.length>512||messageIds.has(messageId))fail('NATIVE_IDENTITY_UNAVAILABLE');messageIds.add(messageId);
        const identity={chatId:messageId,role,disabled,isComment,saying};metadataChars+=JSON.stringify(identity).length+1;
        if(metadataChars*2>MAX_METADATA)fail('READ_CONTEXT_METADATA_LIMIT');identities.push(identity);
        // Native lineage comments are identity carriers. Ordinary source bodies
        // are never read, normalized, compared or hashed on currentness checks.
        let body='';if(withSource&&currentId===chatId||disabled&&isComment){body=field(raw,'data');if(typeof body!=='string')fail('NATIVE_SOURCE_UNSUPPORTED');totalChars+=body.length;if(totalChars>MAX_CHARS)fail('READ_CONTEXT_SOURCE_LIMIT');if(!wellFormed(body))fail('NATIVE_SOURCE_UNSUPPORTED');}
        markerRows.push(disabled&&isComment?{...identity,data:body}:identity);
        if(withSource&&currentId===chatId)sourceRows.push({...identity,data:body});
      }
      const fmIndex=field(current,'fmIndex')??-1;if(!Number.isSafeInteger(fmIndex)||fmIndex< -1)fail('NATIVE_IDENTITY_UNAVAILABLE');
      const mark=owner.lineage.marker({message:markerRows});
      if(mark.present&&!mark.valid)fail('NATIVE_LINEAGE_UNAVAILABLE');
      const marker=mark.present?{parentChatId:id(mark.parentChatId),forkMessageId:id(mark.forkMessageId),markerIndex:mark.markerIndex}:null;
      metadataChars+=JSON.stringify({chatId:currentId,fmIndex,messages:[],marker}).length+1;
      if(metadataChars*2>MAX_METADATA)fail('READ_CONTEXT_METADATA_LIMIT');
      chain.push({chatId:currentId,fmIndex,messages:identities,marker});
      if(withSource&&currentId===chatId)copies.push({id:currentId,fmIndex,message:sourceRows});
      if(!mark.present)break;current=byId.get(mark.parentChatId);if(!current)fail('NATIVE_LINEAGE_UNAVAILABLE');
    }
    for(let i=0;i<chain.length-1;i++){
      const child=chain[i],parent=chain[i+1],mark=child.marker;
      if(!mark||mark.markerIndex<1||child.fmIndex!==parent.fmIndex||child.messages[mark.markerIndex-1]?.chatId!==mark.forkMessageId||parent.messages[mark.markerIndex-1]?.chatId!==mark.forkMessageId)fail('NATIVE_LINEAGE_UNAVAILABLE');
      for(let n=0;n<mark.markerIndex;n++)if(JSON.stringify(child.messages[n])!==JSON.stringify(parent.messages[n]))fail('NATIVE_LINEAGE_UNAVAILABLE');
    }
    const lineage={schema:'libra.native-lineage-identity-observation.v1',kind:chain.length>1?'native_branch':'independent_chat',status:'identity-observed',characterId,hostChatId:chatId,path:chain.map(item=>item.chatId).reverse(),sourcePrefixVerified:false,inheritanceEligible:false};
    return {characterId,chatId,identity:JSON.stringify({characterId,chatId,chain}),lineage,chat:withSource?copies[0]:null};
  }
  function capturedPairs(chat){
    const pairs=[];let pending=null,chars=0;
    const append=(target,row,index,body)=>{if(!target)return {chatIds:[row.chatId],text:body,index,endIndex:index};target.chatIds.push(row.chatId);target.text+='\n\n'+body;target.endIndex=index;return target;};
    for(let index=0;index<chat.message.length;index++){
      const row=chat.message[index];if(row.disabled||row.isComment)continue;
      const role=['user','human','player'].includes(row.role)?'user':['char','assistant','character','bot','ai','model'].includes(row.role)?'assistant':'';
      if(!role)continue;const body=owner.projectSource(role,row);if(typeof body!=='string')fail('NATIVE_SOURCE_UNSUPPORTED');chars+=body.length+2;if(chars>MAX_CHARS)fail('READ_CONTEXT_SOURCE_LIMIT');if(!body)continue;
      if(role==='user'){pending=append(pending,row,index,body);continue;}
      if(!pending){if(pairs.length)pairs[pairs.length-1].assistant=append(pairs[pairs.length-1].assistant,row,index,body);continue;}
      pairs.push({turn:pairs.length+1,user:pending,assistant:append(null,row,index,body)});pending=null;
    }
    return pairs;
  }
  async function capture(input){
    exact(input,['requestId','durationMs']);if(typeof input.requestId!=='string'||!/^[A-Za-z0-9._:-]{1,240}$/.test(input.requestId)||!Number.isSafeInteger(input.durationMs)||input.durationMs<1||input.durationMs>120000)fail('READ_CONTEXT_REQUEST_INVALID');
    for(const s of requests.values())if(!s.physical&&now()>=s.deadline)retire(s,'READ_CONTEXT_EXPIRED');
    if(requests.has(input.requestId))fail('READ_CONTEXT_REQUEST_IN_USE');if(requests.size>=4)fail('READ_CONTEXT_LIMIT');
    const s={requestId:input.requestId,deadline:now()+input.durationMs,status:'pending',physical:true,route:null,checks:0};requests.set(s.requestId,s);
    try{
      check(s);const host=await owner.readHost();check(s);const snapshot=nativeSnapshot(host,true),pairs=capturedPairs(snapshot.chat);
      const lineage=snapshot.lineage;
      s.route=await owner.storage.observeReadonlyRoute({requestId:s.requestId,characterId:snapshot.characterId,chatId:snapshot.chatId,durationMs:input.durationMs});check(s);
      s.publicationGeneration=owner.publicationGeneration(s.route.summary.scope);
      s.identity=snapshot.identity;const summary=frozen({schema:'libra.readonly-source-context.v1',usage:'request-local-source-snapshot',requestId:s.requestId,scope:s.route.summary.scope,route:s.route.summary,completedPairCount:pairs.length,publicationGeneration:s.publicationGeneration,sourcePolicy:'captured-final-source-no-edit-tracking',nativeCurrentness:'explicit-identity-only',actualHostQualified:false,sourceCaptureAdmission:'unsupported'});
      s.view=frozen({summary,pairs,lineage});s.status='live';const handle=Object.freeze({});handles.set(handle,s);return Object.freeze({handle,summary});
    }catch(error){retire(s,error.code||'READ_CONTEXT_UNAVAILABLE');throw error;}
    finally{s.physical=false;if(s.status!=='live')requests.delete(s.requestId);}
  }
  async function assertCurrent(input){
    const s=state(input);if(s.physical)fail('READ_CONTEXT_BUSY');if(s.checks>=64)fail('READ_CONTEXT_CHECK_LIMIT');s.checks++;s.physical=true;
    try{
      const host=await owner.readHost();check(s);let identity;try{identity=nativeSnapshot(host,false).identity;}catch(error){if(/^NATIVE_/.test(error.code||''))fail('NATIVE_IDENTITY_CHANGED');throw error;}
      if(identity!==s.identity)fail('NATIVE_IDENTITY_CHANGED');
      await owner.storage.assertReadonlyRouteCurrent({handle:s.route.handle,requestId:s.requestId});check(s);
      if(owner.publicationGeneration(s.view.summary.scope)!==s.publicationGeneration)fail('OWNER_PUBLICATION_CHANGED');
      return frozen({status:'request-local-current',nativeCurrentness:'identity-only',originalTextCompared:false,semanticModeEpoch:null,actualHostQualified:false});
    }catch(error){retire(s,error.code||'READ_CONTEXT_UNAVAILABLE');throw error;}
    finally{s.physical=false;if(s.status!=='live')requests.delete(s.requestId);}
  }
  return Object.freeze({capture,assertCurrent,
    readCaptured(input){return state(input).view;},
    async admitSourceCapture(input){await assertCurrent(input);return frozen({status:'unsupported',code:'SOURCE_PROOF_UNAVAILABLE',reasons:['host_mutation_authority_unavailable','semantic_mode_epoch_unavailable','authenticated_backend_binding_unavailable'],corpusEligible:false});},
    release(input){const s=state(input,true);retire(s,'READ_CONTEXT_RELEASED');return Object.freeze({status:s.status});},
    cancel(input){exact(input,['requestId']);const s=requests.get(input.requestId);if(s)retire(s,'READ_CONTEXT_CANCELLED');return Object.freeze({status:s?s.status:'READ_CONTEXT_NOT_FOUND'});},
    dispose(){for(const s of requests.values())retire(s,'READ_CONTEXT_DISPOSED');}
  });
}
/* END LIBRA READONLY SOURCE CONTEXT */
