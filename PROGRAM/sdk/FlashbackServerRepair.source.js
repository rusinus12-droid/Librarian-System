/* Flashback server-vector restoration owner protocol. Standalone and deliberately
 * unbound: the live owner must supply a pinned, non-bootstrap transport, durable
 * owner journal, and host/settings/profile/source authority checks before use.
 * There is no provider callback or client-vector publication path.
 * This factory does not enable Flashback's physicalRepairAllowed GUI capability.
 */
const FlashbackServerRepair = (() => {
  'use strict';
  const contract='flashback.server-vector-repair.v2';
  const clone=value=>JSON.parse(JSON.stringify(value));
  const validId=value=>typeof value==='string'&&/^[A-Za-z0-9._-]{16,100}$/.test(value);
  const fail=code=>{throw Object.assign(new Error(code),{code});};
  const seal=result=>Object.freeze({contract,ownerAdapterBound:false,physicalRepairAllowed:false,hostAuthorityVerified:false,originalVectorBytesVerified:false,vectorProof:'none',sourceMutationAllowed:false,...result});
  const create=options=>{
    if(!options||['send','assertCurrent','assertCurrentSync','makeOperationId','makeRequestId'].some(k=>typeof options[k]!=='function')
      ||typeof options.journal?.read!=='function'||typeof options.journal?.compareAndSwap!=='function')fail('REPAIR_OWNER_ADAPTER_REQUIRED');
    const source=options.binding||{};
    if(Object.keys(source).some(k=>!['scopeKey','dataInstanceId','epoch','mode','authorityDigest'].includes(k))||typeof source.scopeKey!=='string'||!source.scopeKey
      ||typeof source.dataInstanceId!=='string'||!source.dataInstanceId||source.mode!=='server_only'||!Number.isSafeInteger(source.epoch)||source.epoch<0
      ||!/^[a-f0-9]{64}$/.test(source.authorityDigest||''))fail('REPAIR_BINDING_REQUIRED');
    const binding=Object.freeze(clone(source)),bindingText=JSON.stringify(binding),offers=new WeakMap(),running=new WeakMap();let disposed=false,busy=false,cancellationGeneration=0;
    const sync=signal=>{if(disposed||signal?.aborted)fail('REPAIR_EXECUTION_CANCELLED');options.assertCurrentSync();};
    const boundary=async signal=>{sync(signal);await options.assertCurrent();sync(signal);};
    const readIntent=async()=>{
      const value=await options.journal.read();if(value==null)return null;
      if(value.contract!==contract||JSON.stringify(value.binding)!==bindingText||!validId(value.operationId)||!validId(value.requestId)
        ||!['prepared','reservation_pending','reserved','submitted','completed','cancelled','unknown'].includes(value.state))fail('REPAIR_JOURNAL_UNVERIFIED');
      return clone(value);
    };
    // The adapter must perform an atomic durable compare-and-swap, including
    // across runtime instances. A read-then-write emulation is not this contract.
    const persist=async(value,expected)=>{
      const swapped=await options.journal.compareAndSwap(clone(expected),clone(value));
      if(swapped!==true)fail('REPAIR_JOURNAL_SUPERSEDED');
      const read=await readIntent();if(JSON.stringify(read)!==JSON.stringify(value))fail('REPAIR_JOURNAL_SUPERSEDED');return read;
    };
    const validate=(value,intent,states)=>{
      if(!value||value.schema!==contract||value.operationId!==intent.operationId||value.durable!==true||!states.includes(value.state)
        ||value.hostAuthorityVerified!==false||value.profileAuthorityVerified!==false||value.physicalRepairAllowed!==false)fail('REPAIR_RECEIPT_UNVERIFIED');
      return value;
    };
    const send=async(action,extra,signal)=>{await boundary(signal);sync(signal);return await options.send(action,{...binding,...extra});};
    const status=async intent=>{
      // Reconciliation is read-only on the original pinned transport even when
      // host navigation has revoked a new restoration request. Never bootstrap or retry.
      return validate(await options.send('status',{...binding,operationId:intent.operationId}),intent,['reserved','submitted','completed','cancelled','unknown']);
    };
    const reconciled=async(intent,reason='REPAIR_OUTCOME_UNCONFIRMED')=>{
      try{const receipt=await status(intent),next={...intent,state:receipt.state};let journalCurrent=true;
        try{await persist(next,intent);}catch(error){if(error?.code!=='REPAIR_JOURNAL_SUPERSEDED')throw error;journalCurrent=false;}
        return seal({status:receipt.state==='completed'?'completed':receipt.state==='cancelled'?'cancelled':'uncertain',operationId:intent.operationId,
          state:receipt.state,reconciled:true,journalCurrent,providerOutcome:'not_used',originalVectorBytesVerified:receipt.originalVectorBytesVerified===true,vectorProof:receipt.vectorProof,finalVerification:false,
          reason:journalCurrent?reason:'REPAIR_JOURNAL_SUPERSEDED'});
      }catch(_){return seal({status:'uncertain',operationId:intent.operationId,state:'unknown',reconciled:false,journalCurrent:false,finalVerification:false,reason:'REPAIR_OUTCOME_UNCONFIRMED'});}
    };
    const preview=async({shardIndex,backupId}={})=>{
      try{await boundary();if(busy)return seal({allowed:false,reason:'REPAIR_OWNER_BUSY'});const intent=await readIntent();
        if(intent&&!['completed','cancelled'].includes(intent.state))return seal({allowed:false,reason:'REPAIR_UNRESOLVED_OPERATION',operationId:intent.operationId});
        const receipt=await send('preview',{shardIndex,backupId});await boundary();
        if(receipt?.schema===contract&&receipt.allowed===false&&['payload_already_valid','strong_backup_proof_required','strong_backup_proof_unavailable'].includes(receipt.reason))return seal({allowed:false,reason:receipt.reason});
        if(receipt?.schema!==contract||receipt.allowed!==true||receipt.strongProofAvailable!==true||receipt.readOnly!==true||receipt.shardIndex!==shardIndex
          ||!/^[a-f0-9]{64}$/.test(receipt.fingerprint||'')||receipt.hostAuthorityVerified!==false||receipt.physicalRepairAllowed!==false)fail('REPAIR_PREVIEW_UNVERIFIED');
        const offer=seal({allowed:true,actionKind:'restore_referenced_vector_payload',shardIndex,vectorCount:receipt.vectorCount});
        offers.set(offer,{shardIndex,backupId:receipt.backupId,previewFingerprint:receipt.fingerprint});return offer;
      }catch(_){return seal({allowed:false,reason:'REPAIR_PREVIEW_UNAVAILABLE'});}
    };
    const execute=async(offer,{signal:externalSignal}={})=>{
      const generation=cancellationGeneration,signal={get aborted(){return externalSignal?.aborted===true||generation!==cancellationGeneration;}};
      const selected=offers.get(offer);offers.delete(offer);
      if(!selected||busy)return seal({status:'blocked',reason:'REPAIR_OFFER_UNAVAILABLE'});
      busy=true;let intent=null,reserveIssued=false;
      try{
        await boundary(signal);const pending=await readIntent();if(pending&&!['completed','cancelled'].includes(pending.state))fail('REPAIR_UNRESOLVED_OPERATION');
        const operationId=options.makeOperationId(),requestId=options.makeRequestId();if(!validId(operationId)||!validId(requestId))fail('REPAIR_OPERATION_ID_INVALID');
        intent={contract,binding:clone(binding),operationId,requestId,state:'prepared',shardIndex:selected.shardIndex};
        intent=await persist(intent,pending);await boundary(signal);
        intent=await persist({...intent,state:'reservation_pending'},intent);await boundary(signal);sync(signal);reserveIssued=true;
        const reserved=validate(await options.send('reserve',{...binding,...selected,operationId}),intent,['reserved']);
        if(reserved.reconciled===true)fail('REPAIR_EXISTING_OPERATION_REQUIRES_RECONCILIATION');
        intent=await persist({...intent,state:'reserved'},intent);
        const submitted=validate(await send('submitted',{operationId,requestId},signal),intent,['submitted']);
        intent=await persist({...intent,state:'submitted'},intent);
        if(submitted.requestId!==requestId||submitted.wireAuthorized!==false||submitted.publicationAuthorized!==true||submitted.reconciled!==false)fail('REPAIR_SUBMISSION_UNCONFIRMED');
        await boundary(signal);const committed=validate(await send('commit',{operationId,requestId},signal),intent,['completed']);
        intent=await persist({...intent,state:'completed'},intent);await boundary(signal);
        return seal({status:'completed',operationId,state:'completed',providerIssued:false,providerOutcome:'not_used',originalVectorBytesVerified:committed.originalVectorBytesVerified===true,vectorProof:committed.vectorProof,reconciled:false,finalVerification:true});
      }catch(_){if(intent&&reserveIssued)return await reconciled(intent);if(intent&&signal.aborted){try{await persist({...intent,state:'cancelled'},intent);}catch(_){}}return seal({status:'blocked',providerIssued:false,reason:'REPAIR_NOT_SUBMITTED'});}
      finally{busy=false;}
    };
    const repair=(offer,runOptions)=>{
      if(runOptions!==undefined&&(!runOptions||typeof runOptions!=='object'))return Promise.resolve(seal({status:'blocked',reason:'REPAIR_NO_PRODUCER_ACCEPTED'}));
      if(offer&&running.has(offer))return running.get(offer);
      const work=execute(offer,runOptions);
      if(offer&&typeof offer==='object'){running.set(offer,work);work.then(()=>running.delete(offer),()=>running.delete(offer));}return work;
    };
    const resume=async()=>{try{const intent=await readIntent();if(intent?.state==='prepared')return seal({status:'blocked',state:'prepared',reason:'REPAIR_UNISSUED_INTENT_CANCEL_AVAILABLE'});if(intent?.state==='cancelled')return seal({status:'cancelled',state:'cancelled'});return intent?await reconciled(intent):seal({status:'idle'});}catch(_){return seal({status:'blocked',reason:'REPAIR_JOURNAL_UNVERIFIED'});}};
    const cancel=async()=>{
      cancellationGeneration++;
      try{const intent=await readIntent();if(!intent)return seal({status:'idle'});
        if(intent.state==='prepared'){await persist({...intent,state:'cancelled'},intent);return seal({status:'cancelled',operationId:intent.operationId,state:'cancelled',providerOutcome:'not_used'});}
        if(['completed','cancelled'].includes(intent.state))return seal({status:intent.state,operationId:intent.operationId,state:intent.state,providerOutcome:'not_used'});
        const receipt=validate(await send('cancel',{operationId:intent.operationId}),intent,['cancelled','unknown']);await persist({...intent,state:receipt.state},intent);
        return seal({status:receipt.state==='cancelled'?'cancelled':'uncertain',operationId:intent.operationId,state:receipt.state,providerOutcome:receipt.providerOutcome});
      }catch(_){return seal({status:'uncertain',reason:'REPAIR_CANCELLATION_UNCONFIRMED'});}
    };
    return Object.freeze({preview,repair,resume,cancel,dispose:()=>{disposed=true;}});
  };
  return Object.freeze({contract,create});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=FlashbackServerRepair;
