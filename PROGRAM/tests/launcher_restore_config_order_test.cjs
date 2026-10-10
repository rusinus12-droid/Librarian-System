'use strict';
// Actual foreground/background functions, actual journal recovery/SQLite, and
// actual CLI argument parser. Process spawn and existing-server health are the
// only launcher seams. Resolved preferences are exposed at the unchanged server
// factory return for assertions. No socket, installed GUI or provider call is made.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),launcherPath=path.join(root,'tools/platform_launcher.cjs');
const Module=require('node:module');
const serverFile=path.join(root,'server/server.cjs'),serverModule=new Module(serverFile,module);serverModule.filename=serverFile;serverModule.paths=Module._nodeModulePaths(path.dirname(serverFile));
const serverSource=fs.readFileSync(serverFile,'utf8'),anchor='    computeSigningKeyPath: computeSigning.keyPath,';assert(serverSource.includes(anchor));
serverModule._compile(serverSource.replace(anchor,anchor+'\n    observedStartupPreferences: {autoBackup, computeEnabled:computeConfigured, computeWorkers:options.computeWorkers},'),serverFile);
const server=serverModule.exports,metadata=require('../server/core/migration_metadata.cjs'),launcher=require('../tools/platform_launcher.cjs');
function fixture(){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'lib-launch-order-'));fs.mkdirSync(path.join(data,'config'),{recursive:true});fs.mkdirSync(path.join(data,'migrations'));
 const file=path.join(data,'config/server-config.json'),before={schema:'memory-suite.server-config.v1',host:'127.0.0.1',port:47630,autoBackup:true,computeEnabled:true,computeWorkers:1};fs.writeFileSync(file,JSON.stringify(before));
 const app=server.createMemorySuiteServer({dataDir:data,autoBackup:false,computeEnabled:false});app.repositories.hayaku.mutate({kind:'set',space:'plugin',key:'hayaku.value',value:'BEFORE',operationId:'fixture-before',expectedRevision:0});app.server.emit('close');
 const plan=metadata.planMigrationMetadataInstall(data,{serverConfig:{autoBackup:false,computeEnabled:false,computeWorkers:5}}),db=path.join(data,'stores/hayaku/hayaku.sqlite'),journal=path.join(data,'migrations/restore-transaction.json');
 fs.writeFileSync(journal,JSON.stringify({schema:'memory-suite.restore-transaction.v1',id:'launcher-test',phase:'PREPARED',mode:'online',items:[{namespace:'hayaku',currentPath:db,tempPath:db+'.temp',rollbackPath:db+'.rollback',hadCurrent:true}],migrationMetadata:plan}));metadata.applyMigrationMetadataPlan(data,plan);
 return {data,file,before,journal};
}
async function run(mode,fault=''){
 const f=fixture(),captured=[];let spawned=false,healthCalls=0,spawnAttempts=0;const module={exports:{}};
 const nativeRequire=createRequire(launcherPath),requireSeam=name=>name==='node:child_process'?{spawnSync(){throw Error('unexpected child sync');},spawn(_exe,args){spawnAttempts++;const parsed=server.parseArgs(args.slice(2));const childApp=server.createMemorySuiteServer(parsed);try{captured.push(childApp.observedStartupPreferences);}finally{childApp.server.emit('close');}spawned=true;const child=new EventEmitter();child.unref=()=>{};child.kill=()=>{};child.pid=1;if(mode==='foreground')setImmediate(()=>child.emit('exit',0,null));return child;}}:nativeRequire(name);
 const context={require:requireSeam,module,exports:module.exports,__dirname:path.dirname(launcherPath),process:{...process,stdout:{write(){}},stderr:{write(){}},once(){}},console,Buffer,setTimeout,clearTimeout,AbortController,URL,fetch:()=>{throw Error('external network forbidden');}};vm.createContext(context);
 vm.runInContext(fs.readFileSync(launcherPath,'utf8')+'\ninspectExistingServer = async () => { healthCalls(); return existingHealth(); }; module.exports.run = {foreground:serveForeground,background:serveBackground};',context);
 context.healthCalls=()=>{healthCalls++;};context.existingHealth=()=>fault==='live-maintenance'||spawned?{maintenanceMode:fault==='live-maintenance',version:'fixture',dataInstanceId:'fixture'}:null;
 const initial=launcher.readConfig(f.data),journalBefore=fs.readFileSync(f.journal),write=fs.writeFileSync;let injected=false;
 if(fault==='rollback-io')fs.writeFileSync=function(file,...args){if(String(file)===f.file){injected=true;throw Object.assign(Error('fixture recovery EIO'),{code:'EIO'});}return write.call(fs,file,...args);};
 try{
  if(fault==='rollback-io')await assert.rejects(()=>module.exports.run[mode](initial,f.data),/fixture recovery EIO/);
  else await module.exports.run[mode](initial,f.data);
 }finally{fs.writeFileSync=write;}
 if(fault){assert.equal(captured.length,0,'no healthy child admitted after failed recovery or live maintenance');assert.deepEqual(fs.readFileSync(f.journal),journalBefore);if(fault==='rollback-io'){assert(injected);assert.equal(spawnAttempts,1);}else assert.equal(spawnAttempts,0);}
 else {assert.equal(captured.length,1);assert.equal(captured[0].autoBackup,true);assert.equal(captured[0].computeEnabled,true);assert.equal(captured[0].computeWorkers,1);assert.equal(fs.existsSync(f.journal),false);}
 console.log(JSON.stringify({mode,fault: fault||'interrupted-restore',spawnAttempts,healthyChildren:captured.length,healthCalls,settings:captured[0]||null}));
}
(async()=>{
 for(const mode of ['foreground','background'])for(const fault of ['','rollback-io','live-maintenance'])await run(mode,fault);
 for(const cfg of [{autoBackup:false,computeEnabled:false,computeWorkers:0},{autoBackup:true,computeEnabled:true,computeWorkers:1}]){
  const f=fixture();server.recoverInterruptedRestore(f.data);fs.writeFileSync(f.file,JSON.stringify({...f.before,...cfg}));
  const initial=launcher.readConfig(f.data),args=server.parseArgs(launcher.serverArguments(initial,f.data).slice(2));
  assert.equal(args.portableSettingsFromData,true);let app=server.createMemorySuiteServer(args);
  try{assert.deepEqual(app.observedStartupPreferences,cfg);}finally{app.server.emit('close');}
  const overridden=server.parseArgs([...launcher.serverArguments(initial,f.data).slice(2),'--no-auto-backup','--no-compute','--compute-workers','3']);app=server.createMemorySuiteServer(overridden);
  try{assert.deepEqual(app.observedStartupPreferences,{autoBackup:false,computeEnabled:false,computeWorkers:3});}finally{app.server.emit('close');}
 }
 for(const invalid of [null,'{invalid',JSON.stringify({schema:'memory-suite.server-config.v1',host:'127.0.0.1',port:47630,computeEnabled:'false',computeWorkers:0})]){
  const f=fixture();server.recoverInterruptedRestore(f.data);if(invalid===null)fs.rmSync(f.file);else fs.writeFileSync(f.file,invalid);
  assert.throws(()=>server.createMemorySuiteServer(server.parseArgs(['--data-dir',f.data,'--portable-settings-from-data'])),invalid===null?/server_config_missing/:undefined);
 }
 const defaults=server.parseArgs([]);assert.equal(defaults.portableSettingsFromData,undefined);assert.equal(defaults.explicitPortableSettings,undefined);assert.equal(defaults.computeWorkers,0);assert.equal(defaults.autoBackup,true);assert.equal(defaults.computeEnabled,true);
 assert.throws(()=>server.parseArgs(['--compute-workers','0']),/invalid_compute_workers/);
 const f=fixture(),app=server.createMemorySuiteServer({dataDir:f.data,autoBackup:false,computeEnabled:false,computeWorkers:3});
 try{assert.equal(app.interruptedRestoreRecovery.action,'rollback');assert.equal(app.repositories.hayaku.get('plugin','hayaku.value').value,'BEFORE');assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),f.before);assert.equal(fs.existsSync(f.journal),false);assert.deepEqual(app.observedStartupPreferences,{autoBackup:false,computeEnabled:false,computeWorkers:3});console.log('PASS direct server startup retains its own recovery and explicit API preferences');}finally{app.server.emit('close');}
})().catch(e=>{console.error(e);process.exitCode=1;});
