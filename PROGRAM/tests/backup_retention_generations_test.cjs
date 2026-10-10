'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createMemorySuiteServer}=require('../server/server.cjs');
function fake(root,id,ts){const dir=path.join(root,id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({schema:'memory-suite.backup.v1',id,kind:'auto',label:'fake',createdAt:new Date(ts).toISOString(),createdAtMs:ts,stores:{}}));}
async function main(){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ms-retention-'));
 const root=path.join(dataDir,'backups','auto'); fs.mkdirSync(root,{recursive:true});
 const now=Date.now();
 for(let i=0;i<12;i++) fake(root,`recent-${i}`,now-(i+1)*60*1000);
 for(let day=1;day<=20;day++) fake(root,`daily-${day}`,now-day*24*60*60*1000-6*60*60*1000);
 const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false}); await app.listen();
 try{
  await app.createBackup('auto','retention-trigger');
  const auto=app.listBackups().filter(x=>x.kind==='auto');
  assert.ok(auto.length<=24,`generational retention should remain bounded, got ${auto.length}`);
  for(let i=0;i<11;i++) assert.ok(auto.some(x=>x.id===`recent-${i}`),`recent-${i} should be retained`);
  assert.ok(auto.some(x=>x.label==='retention-trigger'),'newest real backup should be retained');
  assert.ok(auto.some(x=>Number(x.createdAtMs)<now-12*24*60*60*1000),'weekly generations should preserve at least one older recovery point');
  process.stdout.write(`backup_retention_generations_test: PASS kept=${auto.length}\n`);
 } finally {await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
}
main().catch(e=>{process.stderr.write(`backup_retention_generations_test: FAIL\n${e.stack||e}\n`);process.exitCode=1;});
