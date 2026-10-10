'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createMemorySuiteServer}=require('../server/server.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const waitFor=async(predicate,{timeoutMs=5000,intervalMs=50}={})=>{const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){const value=predicate();if(value)return value;await sleep(intervalMs);}return predicate();};
async function json(url,init={}){const r=await fetch(url,init);const t=await r.text();return{r,p:t?JSON.parse(t):{}};}
async function main(){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ms-auto-policy-'));
 const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:true,changeSettledBackupDelayMs:30,autoBackupMinCooldownMs:2000,autoBackupIntervalMs:60000});
 const address=await app.listen(); const base=`http://127.0.0.1:${address.port}`;
 try{
  const boot=await json(`${base}/bootstrap`,{headers:{'X-Memory-Suite-Plugin':'libra'}});
  const h={Authorization:`Bearer ${boot.p.token}`,'X-Memory-Suite-Plugin':'libra','Content-Type':'application/json'};
  const set=async (id,val)=>json(`${base}/v1/kv/set`,{method:'POST',headers:h,body:JSON.stringify({namespace:'libra',space:'plugin',key:'libra:auto:policy',value:{val},operationId:id})});
  await set('auto_policy_test_000001',1);
  let auto=await waitFor(()=>{const rows=app.listBackups().filter(x=>x.kind==='auto');return rows.length>=1?rows:null;});
  assert.equal(auto?.length,1,'first settled change should back up');
  await set('auto_policy_test_000002',2); await sleep(100);
  auto=app.listBackups().filter(x=>x.kind==='auto'); assert.equal(auto.length,1,'cooldown should prevent immediate second full backup');
  await sleep(2200);
  auto=app.listBackups().filter(x=>x.kind==='auto'); assert.ok(auto.length>=2,'deferred backup should run after cooldown');
  const health=await json(`${base}/health`); assert.equal(health.p.autoBackupPolicy.minCooldownMs,2000); assert.equal(health.p.autoBackupPolicy.intervalMs,60000);
  process.stdout.write('auto_backup_policy_test: PASS\n');
 } finally{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
}
main().catch(e=>{process.stderr.write(`auto_backup_policy_test: FAIL\n${e.stack||e}\n`);process.exitCode=1;});
