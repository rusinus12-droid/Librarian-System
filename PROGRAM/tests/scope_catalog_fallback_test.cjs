'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createMemorySuiteServer}=require('../server/server.cjs');
async function main(){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ms-catalog-fallback-'));
 fs.mkdirSync(path.join(dataDir,'config'),{recursive:true});
 const previous={schema:'memory-suite.scope-catalog.v1',updatedAt:1,namespaces:{libra:[{namespace:'libra',scopeId:'safe-old',members:[],links:[],baseClassification:'unverified'}]}};
 fs.writeFileSync(path.join(dataDir,'config','scope-catalog.previous.json'),JSON.stringify(previous));
 fs.writeFileSync(path.join(dataDir,'config','scope-catalog.json'),'{ broken json');
 const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});
 const address=await app.listen();
 try{
  const base=`http://127.0.0.1:${address.port}`;
  const boot=await fetch(`${base}/bootstrap`,{headers:{'X-Memory-Suite-Plugin':'flashback_hayaku_bridge'}}).then(r=>r.json());
  const h={Authorization:`Bearer ${boot.token}`,'X-Memory-Suite-Plugin':'flashback_hayaku_bridge','Content-Type':'application/json'};
  const scopes=await fetch(`${base}/v1/manager/scopes`,{headers:h}).then(r=>r.json());
  assert.equal(scopes.ok,true);
  assert.ok(scopes.result.scopes.some(s=>s.scopeId==='safe-old'));
  const health=await fetch(`${base}/health`).then(r=>r.json());
  assert.equal(health.scopeCatalogDegraded,true);
  const plan=await fetch(`${base}/v1/manager/scope-delete/plan`,{method:'POST',headers:h,body:JSON.stringify({namespace:'libra',scopeId:'safe-old'})});
  assert.equal(plan.status,409);
  const payload=await plan.json();
  assert.equal(payload.error,'scope_catalog_degraded_delete_blocked');
  const backup=await app.createBackup('manual','catalog-fallback');
  assert.equal(backup.result.scopeCatalog.source,'previous');
  assert.equal(backup.result.scopeCatalog.degradedAtBackup,true);
  process.stdout.write('scope_catalog_fallback_test: PASS\n');
 } finally {await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
}
main().catch(e=>{process.stderr.write(`scope_catalog_fallback_test: FAIL\n${e.stack||e}\n`);process.exitCode=1;});
