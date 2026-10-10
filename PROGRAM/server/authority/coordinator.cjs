'use strict';
const C=require('./contracts.cjs');
const M=require('./receipt-codec.cjs');
const {assertControlPermit}=require('./control-store.cjs');
const {applyOwnerMutation,lockOwnerForRecovery,verifyOwnerGuards,readOwnerReceipt}=require('./owner-store.cjs');
function exactReceipt(receipt,intent){
 try{M.validateCompactReceipt(receipt);}catch{C.fail('AUTHORITY_QUARANTINED');}
 for(const field of ['generation','namespace','operationId','fingerprint','operationClass','controlSequence','fenceEpoch'])if(receipt[field]!==intent[field])C.fail('AUTHORITY_QUARANTINED');
 for(const field of ['physicalBinding','ownerBinding'])if(C.canonical(receipt[field])!==C.canonical(intent[field]))C.fail('AUTHORITY_QUARANTINED');
 return receipt;
}
function storedIntent(operation){const {status,decision,...intent}=operation;return intent;}
function createAuthorityCoordinator({control,resolveOwnerStore}){
 if(!control||typeof resolveOwnerStore!=='function')C.fail('INVALID_AUTHORITY_COORDINATOR');
 const resolve=intent=>{const store=resolveOwnerStore(intent.namespace);const proof=verifyOwnerGuards(store);if(proof.namespace!==intent.namespace||proof.generation!==intent.generation||C.canonical(proof.physicalBinding)!==C.canonical(intent.physicalBinding)||C.canonical(proof.ownerBinding)!==C.canonical(intent.ownerBinding))C.fail('AUTHORITY_QUARANTINED');return store;};
 function terminal(operation){
  if(!operation||operation.status==='pending')return operation;
  const actual=readOwnerReceipt(resolve(operation),operation);
  if(operation.status==='committed'){
   exactReceipt(actual,operation);
   if(operation.decision?.status!=='committed'||C.canonical(actual)!==C.canonical(operation.decision.receipt))C.fail('AUTHORITY_QUARANTINED');
  }else if(operation.status!=='aborted'||operation.decision?.status!=='aborted'||actual)C.fail('AUTHORITY_QUARANTINED');
  return operation;
 }
 function reconcile(key){
  return control.withExclusiveGate(permit=>{
   const gate=assertControlPermit(permit),operation=gate.readOperation(key);
   if(!operation)return null;if(operation.status!=='pending')return terminal(operation);
   const intent=storedIntent(operation),lock=lockOwnerForRecovery(resolve(intent),permit);let receipt;
   try{receipt=lock.readReceipt(intent);if(receipt)exactReceipt(receipt,intent);}finally{lock.end();}
   return control.finalizeIntent(permit,intent,receipt?{status:'committed',receipt}:{status:'aborted'});
  });
 }
 const api={
  transitionRoute(input){
   const Core=require('./control-store.cjs'),Owner=require('./owner-store.cjs');
   const witness=Core.assertAuthorityStore(control);if(C.witnessProfile(witness).id!==C.CORE3_AUTHORITY_PROFILE)C.fail('AUTHORITY_PROFILE_UNSUPPORTED');
   return control.withExclusiveGate(permit=>{
    const context=Core.assertInitialQualificationContext(permit);if(context.branch!=='REPLAY')C.fail('INITIAL_QUALIFICATION_REQUIRED');
    const locks=[];try{for(const namespace of C.CORE3_OWNERS)locks.push(Owner.lockOwnerForInitialQualification(resolveOwnerStore(namespace),permit));return control.commitRouteTransition(permit,input,locks);}
    finally{for(const lock of locks.reverse())lock.end();}
   });
  },
  runMutation(input,work){
   C.synchronous(work);const witness=control.readWitness();C.profileNamespace(input?.namespace,C.witnessProfile(witness).id);
   const value=C.intent({...input,generation:input.generation??witness.generation});
   const qualified=verifyOwnerGuards(resolveOwnerStore(value.namespace));
   if(qualified.namespace!==value.namespace||qualified.generation!==value.generation||C.canonical(qualified.physicalBinding)!==C.canonical(witness.physicalBinding))C.fail('AUTHORITY_QUARANTINED');
   let intent;
   try{intent=control.publishIntent(value);}
   catch(error){
    // Failed COMMIT is ambiguous. A committed durable intent is eligible to run;
    // absence means no owner work has been attempted, never a success claim.
    const operation=control.readOperation(value);
    if(!operation)throw error;
    if(operation.fingerprint!==value.fingerprint||operation.operationClass!==value.operationClass)throw error;
    if(error.code==='OPERATION_CONFLICT')throw error;
    if(operation.status!=='pending')return terminal(operation);intent=storedIntent(operation);
   }
   if(intent.status&&intent.status!=='pending')return terminal(intent);
   try{
    return control.withExclusiveGate(permit=>{
     const current=assertControlPermit(permit).readOperation(intent);
     if(!current)C.fail('AUTHORITY_QUARANTINED');
     if(current.status!=='pending')return terminal(current);
     const active=storedIntent(current);
     if(C.canonical(active)!==C.canonical(intent))C.fail('OPERATION_CONFLICT');
     const receipt=exactReceipt(applyOwnerMutation(resolve(active),permit,active,work),active);
     return control.finalizeIntent(permit,active,{status:'committed',receipt});
    });
   }catch(error){
    // Owner-store either ended the transaction or fail-stopped before this point.
    // Recovery still acquires the real owner lock; timing never proves abort.
    const outcome=reconcile(intent);
    if(outcome?.status==='committed')return outcome;
    throw error;
   }
  },
  recoverPending(){const pending=control.readWitness().pendingIntent;return pending?reconcile(pending):null;},
  cancelOperation(key){C.operationKey(key);return reconcile(key);},
  inspectOperation(key){return terminal(control.readOperation(C.operationKey(key)));}
 };
 return Object.freeze(api);
}
module.exports={createAuthorityCoordinator};
