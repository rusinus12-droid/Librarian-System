'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const program=process.env.REGRESSION_PROGRAM||path.resolve(__dirname,'..');
const actions=['status','backups','history','backup-create','backup-check','restore-plan','restore-execute'];
for(const file of ['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js']){
 test(file+': removed independent owner action rejects before connection while retained manager actions preserve dispatch',async()=>{
  const source=fs.readFileSync(path.join(program,'sdk',file),'utf8').replace(/\r\n/g, '\n');
  const matches=[...source.matchAll(/managerControl: (async \(action, body = \{\}\) => \{[\s\S]*?\n    \}),\n    managerGetDiagnostics,/g)];
  assert.equal(matches.length,1,'unambiguous actual managerControl method');
  let connections=0;const requests=[];
  const managerControl=vm.runInNewContext('('+matches[0][1]+')',{
   managerConnection:async()=>{connections++;return {capabilities:{'manager-control.v1':true}};},
   managerRequest:async(method,url,body)=>{requests.push({method,url,body});return {result:'retained-manager-result'};}
  });
  await assert.rejects(managerControl('wm-import',{}),/control_action_not_supported/);
  assert.equal(connections,0,'removed action cannot open a connection');assert.equal(requests.length,0);
  for(const action of actions){const body={operationId:'synthetic-operation'};assert.equal(await managerControl(action,body),'retained-manager-result');const request=requests.at(-1),readOnly=['status','backups','history'].includes(action);assert.equal(request.method,readOnly?'GET':'POST');assert.equal(request.url,'/v1/manager/control/'+action);assert.equal(request.body,readOnly?null:body);}
  assert.equal(connections,actions.length);
 });
}
test('health summary recognizes retained owners and no independent WM owner without changing report safety',()=>{
 const source=fs.readFileSync(path.join(program,'sdk/MemorySuiteHealthRecovery.source.js'),'utf8');
 const sdk=vm.runInNewContext(source+'\nMemorySuiteHealthRecovery;');
 assert.equal(sdk.report({owner:'WM',known:true,complete:false}).owner,'UNKNOWN');
 for(const owner of ['LIBRA','HAYAKU','FLASHBACK','LIA','RETRACE']){
  const report=sdk.report({owner,known:true,complete:false,issues:[{code:'VALID_CHECK',count:2}]});
  assert.equal(report.owner,owner);assert.equal(report.known,true);assert.equal(report.complete,false);assert.equal(report.status,'incomplete');assert.equal(report.readOnly,true);assert.equal(report.automaticModelReanalysis,false);assert.equal(report.automaticPhysicalRepair,false);assert.equal(report.issues[0].code,'VALID_CHECK');assert.equal(report.issues[0].count,2);assert.equal(Object.isFrozen(report),true);
 }
 assert.equal(sdk.report({owner:'unrecognized'}).owner,'UNKNOWN');
});
