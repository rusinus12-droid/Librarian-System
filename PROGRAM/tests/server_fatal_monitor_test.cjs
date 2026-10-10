"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');const mod=path.resolve(__dirname,'../server/core/fatal-monitor.cjs');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'suite-fatal-'));
try {for(const kind of ['exception','rejection']){
 const data=path.join(temp,kind),code=`require(${JSON.stringify(mod)}).installFatalMonitor({dataDir:${JSON.stringify(data)},version:'test'});setTimeout(()=>console.log('SERVICE_CONTINUED'),1000);${kind==='exception'?"setImmediate(()=>{throw new Error('secret-source-body')});":"Promise.reject(new Error('secret-source-body'));"}`;
 const r=spawnSync(process.execPath,['--unhandled-rejections=throw','-e',code],{encoding:'utf8',timeout:5000});
 assert.equal(r.status,1);assert.ok(!r.stdout.includes('SERVICE_CONTINUED'));
 const text=fs.readFileSync(path.join(data,'logs/fatal-error.log'),'utf8');assert.ok(!text.includes('secret-source-body'));const event=JSON.parse(text);assert.equal(event.origin,kind==='exception'?'uncaughtException':'unhandledRejection');assert.equal(event.errorFingerprint.length,64);assert.deepEqual(fs.readdirSync(data),['logs']);
}const {installFatalMonitor}=require(mod);const n=process.listenerCount('uncaughtException');const dispose=installFatalMonitor({dataDir:path.join(temp,'clean')});assert.equal(process.listenerCount('uncaughtException'),n);dispose();console.log('PASS fatal monitor observes exception/rejection, preserves exit=1, no backup or DB work');}finally{fs.rmSync(temp,{recursive:true,force:true});}
