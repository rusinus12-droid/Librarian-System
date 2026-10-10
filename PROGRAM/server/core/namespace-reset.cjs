'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const physicalIdentity=require('./data-instance-identity.cjs');
const {assertLegacyAuthorityUnavailable}=require('../authority/legacy-admission.cjs');
const JOB_SCHEMA='memory-suite.namespace-reset-job.v2';
const admissionError=code=>Object.assign(new Error(code),{code:code.toUpperCase()});
function readResetState(dataDir){
 const file=path.join(dataDir,'config','namespace-reset.json');let state;
 try{if(!fs.lstatSync(file).isFile())throw Error('not_file');state=JSON.parse(fs.readFileSync(file,'utf8'));}
 catch(error){if(error.code==='ENOENT')return null;throw admissionError('namespace_reset_journal_invalid');}
 if(!state||typeof state!=='object'||Array.isArray(state))throw admissionError('namespace_reset_journal_invalid');
 return state;
}
function validatePending(state,dataDir,namespaces){
 const job=state.pending;if(job===null||job===undefined)return null;
 if(typeof job!=='object'||Array.isArray(job)||job.schema!==JOB_SCHEMA||typeof job.dataInstanceId!=='string'||!/^[-_A-Za-z0-9]{32}$/.test(job.dataInstanceId)||job.dataIdentityContract!==physicalIdentity.contract)throw admissionError('namespace_reset_physical_binding_invalid');
 const selected=job.namespaces,completed=job.completed;
 if(!Array.isArray(namespaces)||!Array.isArray(selected)||!selected.length||selected.some(ns=>typeof ns!=='string'||!namespaces.includes(ns))||new Set(selected).size!==selected.length||!Array.isArray(completed)||completed.some(ns=>!selected.includes(ns))||new Set(completed).size!==completed.length||typeof job.id!=='string'||!job.id||!state.epochs||typeof state.epochs!=='object'||selected.some(ns=>!Number.isInteger(state.epochs[ns])||state.epochs[ns]<1))throw admissionError('namespace_reset_job_invalid');
 if(Object.hasOwn(state,'history')&&(!Array.isArray(state.history)||state.history.some(row=>!row||typeof row!=='object'||Array.isArray(row)||typeof row.id!=='string'||!row.id.trim())))throw admissionError('namespace_reset_history_invalid');
 const current=physicalIdentity.readDataInstanceIdentity(dataDir);
 if(current.dataInstanceId!==job.dataInstanceId||current.dataIdentityContract!==job.dataIdentityContract)throw admissionError('namespace_reset_physical_binding_changed');
 return job;
}
function preflightPhysicalAdmission(dataDir,namespaces){
 const state=readResetState(dataDir);
 if(state)validatePending(state,dataDir,namespaces);
 return state;
}

// Journal lives outside namespace databases and is not cleared by a reset.
module.exports=function createNamespaceReset({dataDir,dataInstanceId,dataIdentityContract,repositories,backup,setMaintenance,canStart=()=>true,clearCatalog=()=>{}}){
  const file=path.join(dataDir,'config','namespace-reset.json');
  const namespaces=Object.keys(repositories);
  const requireLegacy=()=>assertLegacyAuthorityUnavailable({dataDir,namespaces});
  requireLegacy();
  let state=preflightPhysicalAdmission(dataDir,namespaces)||{epochs:{},pending:null};
  const captureAuthority=()=>{
    requireLegacy();
    const current=physicalIdentity.readDataInstanceIdentity(dataDir);
    if((dataInstanceId!==undefined&&current.dataInstanceId!==dataInstanceId)||(dataIdentityContract!==undefined&&current.dataIdentityContract!==dataIdentityContract))throw admissionError('namespace_reset_physical_binding_changed');
    return current;
  };
  const admitPending=()=>{
    validatePending(state,dataDir,namespaces);
    const persisted=preflightPhysicalAdmission(dataDir,namespaces);
    if(!persisted?.pending||JSON.stringify(persisted.pending)!==JSON.stringify(state.pending)||JSON.stringify(persisted.epochs)!==JSON.stringify(state.epochs))throw admissionError('namespace_reset_journal_changed');
  };
  const plans=new Map();let busy=false;
  const save=()=>{requireLegacy();fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';const fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(state));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);};
  const finish=()=>{
    requireLegacy();
    const job=state.pending;if(!job)return;
    admitPending();
    for(const ns of job.namespaces){
      if(job.completed.includes(ns))continue;
      admitPending();
      const db=repositories[ns].database;
      db.exec('BEGIN IMMEDIATE');
      try{db.exec('DELETE FROM kv; DELETE FROM operations;');if(Number(db.prepare('SELECT COUNT(*) AS n FROM kv').get().n)!==0)throw Error('reset_readback_failed');db.exec('COMMIT');}
      catch(e){try{db.exec('ROLLBACK');}catch(_){}throw e;}
      job.completed.push(ns);save();
    }
    admitPending();
    clearCatalog(job.namespaces);
    state.last={...job,finishedAt:Date.now()};state.history=[...(state.history||[]).filter(row=>row.id!==job.id),state.last].slice(-100);state.pending=null;save();
  };
  // An interrupted reset stays fenced and resumes before HTTP accepts requests.
  finish();
  return {
    epochs:()=>({...state.epochs}),
    active:()=>busy||!!state.pending,
    advanceEpochs(namespaces){
      requireLegacy();
      if(busy||state.pending)throw Error('namespace_reset_in_progress');
      if(!Array.isArray(namespaces)||namespaces.some(ns=>!Object.hasOwn(repositories,ns)))throw Error('reset_invalid_namespaces');
      for(const ns of new Set(namespaces))state.epochs[ns]=(state.epochs[ns]||0)+1;
      save();return {...state.epochs};
    },
    plan(namespaces){
      if(!Array.isArray(namespaces)||!namespaces.length||namespaces.some(n=>typeof n!=='string'||!Object.hasOwn(repositories,n)))throw Error('reset_invalid_namespaces');
      if(state.pending)throw Error('reset_interrupted_restart_server');
      for(const [id,p] of plans)if(p.expiresAt<Date.now())plans.delete(id);
      if(plans.size>=20)throw Error('reset_plan_limit');
      const selected=[...new Set(namespaces)].sort();
      const plan={id:crypto.randomUUID(),namespaces:selected,expiresAt:Date.now()+120000,epochs:{...state.epochs}};
      plans.set(plan.id,plan);return {...plan,confirmation:'RESET '+selected.join(',')};
    },
    async execute({planId,confirmation,withoutBackup=false}){
      requireLegacy();
      if(typeof withoutBackup!=='boolean')throw Error('reset_backup_choice_invalid');
      if(state.pending)throw Error('reset_interrupted_restart_server');
      const plan=plans.get(planId);
      if(!canStart()||busy||!plan||plan.expiresAt<Date.now()||confirmation!=='RESET '+plan.namespaces.join(','))throw Error('reset_confirmation_invalid');
      if(JSON.stringify(plan.epochs)!==JSON.stringify(state.epochs))throw Error('reset_plan_stale');
      busy=true;setMaintenance(true);
      try{
        const admission=captureAuthority();
        let backupId=null;
        if(!withoutBackup){const result=await backup();backupId=result?.result?.id;if(!backupId)throw Error('reset_backup_unverified');}
        const binding=captureAuthority();
        if(binding.dataInstanceId!==admission.dataInstanceId||binding.dataIdentityContract!==admission.dataIdentityContract)throw admissionError('namespace_reset_physical_binding_changed');
        // Every old client is fenced before deletion begins, including after restart.
        for(const ns of plan.namespaces)state.epochs[ns]=(state.epochs[ns]||0)+1;
        state.pending={schema:JOB_SCHEMA,...binding,id:plan.id,namespaces:plan.namespaces,completed:[],backupId,withoutBackup:withoutBackup===true,startedAt:Date.now()};save();
        plans.delete(plan.id);finish();return {...state.last,epochs:{...state.epochs},verified:true};
      }finally{busy=false;setMaintenance(false);}
    },
    allows(namespace,header){let supplied={};try{supplied=JSON.parse(header||'{}');}catch(_){}return !state.pending&&Number(supplied[namespace]||0)===Number(state.epochs[namespace]||0);}
  };
};
module.exports.preflightPhysicalAdmission=preflightPhysicalAdmission;
