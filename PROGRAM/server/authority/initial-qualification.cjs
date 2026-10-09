'use strict';
// Explicit internal preparation only. No startup/capability entrypoint calls this.
const C=require('./contracts.cjs');
const Core=require('./control-store.cjs');
const Owner=require('./owner-store.cjs');
const busy=error=>error?.code==='AUTHORITY_BUSY'||/busy|locked/i.test(error?.message||'');
function createInitialOwnerQualifier({dataDir,control,resolveOwnerStore,authorityProfile}){
 const profile=C.authorityProfile(authorityProfile);
 const verifyProfile=()=>{const witness=Core.assertAuthorityStore(control,{dataDir});if(C.witnessProfile(witness).id!==profile.id)C.fail('AUTHORITY_PROFILE_MISMATCH');};
 verifyProfile();C.synchronous(resolveOwnerStore);
 const historical=()=>control.readInitialQualification();
 const commitFailures=new WeakSet();
 function runGate(){
  let busyPhase='control_busy',failurePhase,callbackCompleted=false;
  try{return control.withExclusiveGate(permit=>{
   busyPhase='owner_busy';
   const context=Core.assertInitialQualificationContext(permit);if(context.authorityProfile!==profile.id)C.fail('AUTHORITY_PROFILE_MISMATCH');
   const stores=profile.owners.map(n=>C.noPromise(resolveOwnerStore(n)));
   for(let i=0;i<stores.length;i++){const p=Owner.preflightInitialOwner(stores[i],permit);if(p.namespace!==profile.owners[i])C.fail('INVALID_OWNER_STORE');}
   if(context.branch==='FIRST')for(const store of stores)Owner.installOwnerGuards(store,{activationId:context.activationId,generation:context.generation,controlPermit:permit});
   const locks=[];let result;
   try{for(const store of stores)locks.push(Owner.lockOwnerForInitialQualification(store,permit));result=control.commitInitialQualification(permit,locks);}
   catch(error){if(busy(error))failurePhase='owner_busy';throw error;}
   finally{for(const lock of locks.reverse())lock.end();busyPhase='control_busy';}
   callbackCompleted=true;return result;
  });}catch(error){if(callbackCompleted)commitFailures.add(error);if(busy(error)&&!error.initialQualificationBusyReason)error.initialQualificationBusyReason=failurePhase||busyPhase;throw error;}
 }
 function qualifyInitialOwners(){
  let receipt=null;
  const committedBusy=reason=>({outcome:'committed',receipt,currentQualification:{status:'busy',reason}});
  try{
   verifyProfile();receipt=historical();
   if(receipt&&control.readWitness().pendingIntent)return committedBusy('ordinary_pending');
   try{runGate();}
   catch(error){
    // Only a failure after the complete callback is a COMMIT ambiguity.
    // A later pending intent must never hide already-observed corrupt evidence.
    if(!busy(error)&&!commitFailures.has(error))throw error;
    const durable=historical();if(!durable)throw error;receipt=durable;
    if(control.readWitness().pendingIntent)return committedBusy('ordinary_pending');
    if(busy(error))return committedBusy(error.initialQualificationBusyReason||'control_busy');
    // A committed result can be reconciled under genuine locks without FIRST.
    runGate();
   }
   receipt=historical();if(!receipt)C.fail('INITIAL_QUALIFICATION_CONFLICT');
   const witness=control.readWitness();
   if(witness.pendingIntent)return committedBusy('ordinary_pending');
   if(witness.status!=='ready')return committedBusy('witness_changed');
   return {outcome:'committed',receipt,currentQualification:{status:'ready',witness}};
  }catch(error){
   if(busy(error)){if(receipt)return committedBusy('control_busy');const unknown=Object.assign(new Error('AUTHORITY_BUSY'),{code:'AUTHORITY_BUSY',outcome:'unknown'});throw unknown;}
   if(receipt)error.historicalReceipt=receipt;throw error;
  }
 }
 return Object.freeze({qualifyInitialOwners});
}
module.exports={createInitialOwnerQualifier};
