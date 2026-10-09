'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { createMemorySuiteServer } = require('../server/server.cjs');
const createReset = require('../server/core/namespace-reset.cjs');
const { readDataInstanceIdentity } = require('../server/core/data-instance-identity.cjs');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const namespaces = ['flashback','hayaku','libra','lia','retrace'];
const schema = 'memory-suite.namespace-reset-job.v2';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const tree = root => {
  const rows = [];
  function visit(dir) { for (const name of fs.readdirSync(dir).sort()) { const file = path.join(dir, name), stat = fs.lstatSync(file); if (stat.isDirectory()) visit(file); else { assert.ok(stat.isFile(), 'plain synthetic DATA files'); const bytes = fs.readFileSync(file); rows.push({ file: path.relative(root,file).replaceAll('\\','/'), bytes: bytes.length, sha256: hash(bytes) }); } } }
  visit(root); return rows;
};
const call = async (url, route, body, token) => {
  const response = await fetch(url + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type':'application/json','X-Memory-Suite-Plugin':'flashback_hayaku_bridge', ...(token ? { Authorization:'Bearer '+token } : {}) }, ...(body ? { body:JSON.stringify(body) } : {}), signal:AbortSignal.timeout(10000) });
  return { status:response.status, data:await response.json() };
};
async function prepare(dataDir) {
  const app = createMemorySuiteServer({ host:'127.0.0.1',port:0,dataDir,autoBackup:false });
  try {
    for (const namespace of namespaces) app.repositories[namespace].mutate({ kind:'set',space:'plugin',key:'physical-reset-preserve',value:{namespace},operationId:namespace+'_physical_fixture_000000',expectedRevision:0 });
    fs.writeFileSync(path.join(dataDir,'config','scope-catalog.json'),JSON.stringify({schema:'memory-suite.scope-catalog.v1',namespaces:Object.fromEntries(namespaces.map(ns=>[ns,{fixture:true}]))})+'\n');
    await app.listen();
  } finally { await app.close(); }
  return readDataInstanceIdentity(dataDir);
}
function pending(dataDir, pin, changes = {}) {
  const job = { schema, dataInstanceId:pin.dataInstanceId, dataIdentityContract:pin.dataIdentityContract,
    id:'physical-admission-fixture',namespaces:[...namespaces].sort(),completed:[],backupId:null,withoutBackup:true,startedAt:Date.now(),...changes };
  const state = { epochs:Object.fromEntries(namespaces.map(ns=>[ns,1])),pending:job };
  fs.writeFileSync(path.join(dataDir,'config','namespace-reset.json'),JSON.stringify(state)+'\n'); return state;
}
async function producer(root) {
  const dataDir=path.join(root,'PRODUCER'),validOldHistory={id:'legacy-complete',legacy:true};
  fs.mkdirSync(path.join(dataDir,'config'),{recursive:true});
  fs.writeFileSync(path.join(dataDir,'config','namespace-reset.json'),JSON.stringify({epochs:{},pending:null,history:[validOldHistory]})+'\n');
  const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});
  try {
    const address=await app.listen(),url='http://127.0.0.1:'+address.port,connection=(await call(url,'/bootstrap')).data;
    const plan=(await call(url,'/v1/manager/reset/plan',{namespaces},connection.token)).data.result;
    const result=await call(url,'/v1/manager/reset/execute',{planId:plan.id,confirmation:plan.confirmation,withoutBackup:true},connection.token);
    assert.equal(result.status,200,JSON.stringify(result.data));
    const journal=JSON.parse(fs.readFileSync(path.join(dataDir,'config','namespace-reset.json')));
    assert.equal(journal.last.schema,schema,'normal actual reset producer publishes versioned physical job');
    assert.equal(journal.last.dataInstanceId,connection.dataInstanceId,'producer binds exact current physical32');
    assert.match(journal.last.dataInstanceId,/^[-_A-Za-z0-9]{32}$/);
    assert.equal(journal.last.dataIdentityContract,'memory-suite.physical-data-identity.v1');
    assert.deepEqual(journal.history[0],validOldHistory,'valid old history contents preserved without new pin requirements');
    return { case:'actual-normal-producer',physicalId:connection.dataInstanceId,journal };
  } finally { await app.close(); }
}
async function negative(root,name,change,expected) {
  const dataDir=path.join(root,name),pin=await prepare(dataDir);pending(dataDir,pin);
  await change(dataDir,pin);
  const before=tree(dataDir);
  assert.throws(()=>createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false}),expected,name+': actual constructor refusal');
  assert.deepEqual(tree(dataDir),before,name+': every DATA file raw bytes unchanged before startup writes');
  return { case:name,before,after:tree(dataDir),allDataBytesPreserved:true };
}
function storeCounts(dataDir) {
  return Object.fromEntries(namespaces.map(namespace=>{
    const db=new DatabaseSync(path.join(dataDir,'stores',namespace,namespace+'.sqlite'),{readOnly:true});
    try{return [namespace,{kv:db.prepare('SELECT COUNT(*) AS n FROM kv').get().n,operations:db.prepare('SELECT COUNT(*) AS n FROM operations').get().n}];}
    finally{db.close();}
  }));
}
async function historyNegative(root,name,history) {
  const dataDir=path.join(root,name),pin=await prepare(dataDir),state=pending(dataDir,pin);state.history=history;
  fs.writeFileSync(path.join(dataDir,'config','namespace-reset.json'),JSON.stringify(state)+'\n');
  const beforeStores=storeCounts(dataDir),before=tree(dataDir);
  const guard='C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs';
  assert.ok(process.env.NODE_OPTIONS?.includes(guard));assert.ok(process.execArgv.includes(guard));
  const child=spawnSync(process.execPath,['--require',guard,__filename,'--history-child'],{env:{...process.env,RESET_HISTORY_CHILD_DATA:dataDir},encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(child.error,undefined,'owned constructor child finished within deadline');
  const line=String(child.stdout).split(/\r?\n/).find(row=>row.startsWith('HISTORY_CHILD_RECEIPT '));assert.ok(line,'actual child receipt');
  const childReceipt=JSON.parse(line.slice('HISTORY_CHILD_RECEIPT '.length)),after=tree(dataDir),afterStores=storeCounts(dataDir);
  const beforeWriteRejected=child.status===1&&childReceipt.error==='namespace_reset_history_invalid'&&JSON.stringify(before)===JSON.stringify(after);
  return {case:name,history,before,after,beforeStores,afterStores,beforeWriteRejected,child:{...childReceipt,exit:child.status,signal:child.signal,stdout:child.stdout,stderr:child.stderr}};
}
async function historyChild() {
  const dataDir=path.resolve(process.env.RESET_HISTORY_CHILD_DATA),temp=path.resolve(os.tmpdir());
  assert.ok(dataDir.startsWith(temp+path.sep)&&dataDir.includes('LIB-reset-physical-admission-'),'exact synthetic constructor child DATA');
  let app,receipt,exit;
  try {app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});await app.listen();await app.close();receipt={type:'history-child',pid:process.pid,accepted:true,error:null};exit=0;}
  catch(error){receipt={type:'history-child',pid:process.pid,accepted:false,error:String(error.message),code:error.code||null};exit=1;}
  // Constructor failure cannot return app handles; flush evidence then end only this owned child.
  process.stdout.write('HISTORY_CHILD_RECEIPT '+JSON.stringify(receipt)+'\n',()=>process.exit(exit));
}
async function main() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'LIB-reset-physical-admission-')),receipts=[];
  try {
    if(process.argv.includes('--history-red')) {
      for(const [name,value] of [['history-top-object',{}],['history-null-entry',[null]],['history-missing-id',[{}]]])receipts.push(await historyNegative(root,name,value));
      if(process.env.RESET_PHYSICAL_EVIDENCE)fs.writeFileSync(process.env.RESET_PHYSICAL_EVIDENCE,JSON.stringify({phase:'before-history-check',receipts},null,2)+'\n');
      for(const row of receipts)console.log(row.case+': beforeWriteRejected='+row.beforeWriteRejected+', childExit='+row.child.exit+', error='+row.child.error);
      assert.ok(receipts.every(row=>row.beforeWriteRejected),'all malformed history inputs must be refused before any DATA write');
      return;
    }
    receipts.push(await producer(root)); // RED first: baseline lacks this real producer pin.
    const edit=(dir,fn)=>{const file=path.join(dir,'config','namespace-reset.json'),state=JSON.parse(fs.readFileSync(file));fn(state.pending);fs.writeFileSync(file,JSON.stringify(state)+'\n');};
    receipts.push(await negative(root,'foreign32',dir=>edit(dir,job=>{job.dataInstanceId='A'.repeat(32);}),/namespace_reset_physical_binding_changed/));
    receipts.push(await negative(root,'token24',dir=>edit(dir,job=>{job.dataInstanceId='A'.repeat(24);}),/namespace_reset_physical_binding_invalid/));
    receipts.push(await negative(root,'missing-pin',dir=>edit(dir,job=>{delete job.dataInstanceId;}),/namespace_reset_physical_binding_invalid/));
    receipts.push(await negative(root,'no-contract',dir=>edit(dir,job=>{delete job.dataIdentityContract;}),/namespace_reset_physical_binding_invalid/));
    receipts.push(await negative(root,'wrong-contract',dir=>edit(dir,job=>{job.dataIdentityContract='memory-suite.data-instance-token.v1';}),/namespace_reset_physical_binding_invalid/));
    receipts.push(await negative(root,'legacy-unbound',dir=>edit(dir,job=>{delete job.schema;delete job.dataInstanceId;delete job.dataIdentityContract;}),/namespace_reset_physical_binding_invalid/));
    receipts.push(await negative(root,'missing-seed',dir=>fs.unlinkSync(path.join(dir,'config','data-instance.json')),error=>error.code==='DATA_INSTANCE_IDENTITY_UNAVAILABLE'));
    receipts.push(await negative(root,'corrupt-seed',dir=>fs.writeFileSync(path.join(dir,'config','data-instance.json'),'{}'),error=>error.code==='DATA_INSTANCE_IDENTITY_INVALID'));
    receipts.push(await negative(root,'malformed-journal',dir=>fs.writeFileSync(path.join(dir,'config','namespace-reset.json'),'{'),/namespace_reset_journal_invalid/));
    receipts.push(await negative(root,'malformed-journal-object',dir=>fs.writeFileSync(path.join(dir,'config','namespace-reset.json'),'[]'),/namespace_reset_journal_invalid/));
    receipts.push(await negative(root,'unknown-namespace',dir=>edit(dir,job=>{job.namespaces.push('foreign-owner');}),/namespace_reset_job_invalid/));
    receipts.push(await negative(root,'duplicate-namespace',dir=>edit(dir,job=>{job.namespaces.push('hayaku');}),/namespace_reset_job_invalid/));
    receipts.push(await negative(root,'foreign-completed',dir=>edit(dir,job=>{job.completed=['foreign-owner'];}),/namespace_reset_job_invalid/));
    receipts.push(await negative(root,'duplicate-completed',dir=>edit(dir,job=>{job.completed=['hayaku','hayaku'];}),/namespace_reset_job_invalid/));
    receipts.push(await negative(root,'non-array-selected',dir=>edit(dir,job=>{job.namespaces='hayaku';}),/namespace_reset_job_invalid/));
    receipts.push(await negative(root,'non-array-completed',dir=>edit(dir,job=>{job.completed='hayaku';}),/namespace_reset_job_invalid/));
    receipts.push(await negative(root,'malformed-pending-value',dir=>{const file=path.join(dir,'config','namespace-reset.json'),state=JSON.parse(fs.readFileSync(file));state.pending=false;fs.writeFileSync(file,JSON.stringify(state));},/namespace_reset_physical_binding_invalid/));
    for(const [name,value] of [['history-top-object',{}],['history-null-entry',[null]],['history-missing-id',[{}]]]){
      const row=await historyNegative(root,name,value);assert.equal(row.beforeWriteRejected,true,name+': before-any-DATA-write admission');assert.deepEqual(row.afterStores,row.beforeStores,name+': actual stores/operations preserved');receipts.push(row);
    }
    const terminalRows=[];
    for(const [name,history] of [['valid',[{id:'old-complete',legacy:true}]],['top-object',{}],['null-entry',[null]],['missing-id',[{}]]]){
      const terminalDir=path.join(root,'LEGACY-TERMINAL-'+name);await prepare(terminalDir);
      const file=path.join(terminalDir,'config','namespace-reset.json'),legacyBytes=Buffer.from(JSON.stringify({epochs:{flashback:7},pending:null,last:{id:'old-complete',completed:['flashback']},history})+'\n');
      fs.writeFileSync(file,legacyBytes);
      const terminal=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:terminalDir,autoBackup:false});
      try {await terminal.listen();assert.ok(fs.readFileSync(file).equals(legacyBytes),'terminal '+name+' journal raw bytes noop');}
      finally {await terminal.close();}
      assert.ok(fs.readFileSync(file).equals(legacyBytes),'terminal '+name+' journal unchanged after close');
      terminalRows.push({name,rawSha256:hash(legacyBytes)});
    }
    receipts.push({case:'terminal-legacy-noop',terminalRows});
    assert.equal(typeof createReset.preflightPhysicalAdmission,'function');
    if(process.env.RESET_PHYSICAL_EVIDENCE)fs.writeFileSync(process.env.RESET_PHYSICAL_EVIDENCE,JSON.stringify({receipts},null,2)+'\n');
    console.log('namespace_reset_physical_admission_test: PASS ('+receipts.length+' actual producer/constructor/raw-byte controls)');
  } finally { assert.equal(path.dirname(root).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase());assert.ok(path.basename(root).startsWith('LIB-reset-physical-admission-'));fs.rmSync(root,{recursive:true,force:true});assert.equal(fs.existsSync(root),false); }
}
if(require.main===module)(process.argv.includes('--history-child')?historyChild():main()).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={tree,pending,prepare};
