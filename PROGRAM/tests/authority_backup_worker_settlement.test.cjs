'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {Worker}=require('node:worker_threads'),{DatabaseSync}=require('node:sqlite');
const root=path.resolve(__dirname,'..');
const inheritedGuard=process.env.NODE_OPTIONS?.match(/--require[= ]([^ ]*\/no-network\.cjs)/)?.[1];
const guard=inheritedGuard||path.resolve(root,'../../evidence/no-network.cjs');
if(inheritedGuard){
 assert(require.cache[require.resolve(guard)],'selected inherited audited guard is already loaded');
 assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(guard)).digest('hex'),'2506ba6fa47e2c23827ffcb65f08179134a01d8a39032c58cf88fc649a8b15f3','current reviewed A4 guard identity');
}
const strict=require('./fixtures/authority_strict_guard_probe.cjs').capture();
function fixture(t,mode='success'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lib-task5a-worker-')),src=path.join(dir,'source.sqlite'),dst=path.join(dir,'target.sqlite');
 const db=new DatabaseSync(src);db.exec('CREATE TABLE kv(deleted INTEGER NOT NULL);INSERT INTO kv VALUES(0);');db.close();
 const state={worker:null,exited:false,error:null},release=new SharedArrayBuffer(4);let messageResolve,exitResolve;
 const message=new Promise(resolve=>messageResolve=resolve),exited=new Promise(resolve=>exitResolve=resolve);
 class TestWorker extends Worker{
  constructor(file,options){
   assert.equal(file,path.join(root,'server/backup_worker.cjs'));
   super(path.join(__dirname,'fixtures/authority_backup_worker_wrapper.cjs'),{workerData:{...options.workerData,realWorker:file,guard,release,mode},execArgv:[...process.execArgv,'--require',guard],env:{...process.env,NODE_OPTIONS:process.env.NODE_OPTIONS}});
   state.worker=this;this.on('message',m=>messageResolve(m));this.on('error',e=>state.error=e);this.once('exit',code=>{state.exited=true;exitResolve(code);});
  }
 }
 const file=path.join(root,'server/server.cjs'),source=fs.readFileSync(file,'utf8'),start=source.indexOf('function createBackupStoresInWorker(tasks) {'),end=source.indexOf('\nfunction issueCapabilityToken',start);
 assert(start>=0&&end>start);const run=vm.runInNewContext(source.slice(start,end)+'\ncreateBackupStoresInWorker',{Worker:TestWorker,path,__dirname:path.join(root,'server')},{filename:file});
 const unblock=()=>{Atomics.store(new Int32Array(release),0,1);Atomics.notify(new Int32Array(release),0);};
 const promise=run([{namespace:'libra',file:'libra.sqlite',sourcePath:mode==='failure'?path.join(dir,'missing.sqlite'):src,targetPath:dst}]);
 let settled=false;const outcome=promise.then(value=>{settled=true;return {value};},error=>{settled=true;return {error};});
 t.after(async()=>{unblock();if(state.worker&&!state.exited)await state.worker.terminate();await exited;await outcome;fs.rmSync(dir,{recursive:true,force:true});strict?.verify();});
 return {state,message,exited,unblock,promise,outcome,settled:()=>settled,dst};
}
test('backup_success_remains_pending_until_real_worker_exit',async t=>{
 const f=fixture(t);assert.equal((await f.message).ok,true);await new Promise(setImmediate);
 assert.equal(f.state.exited,false);assert.equal(f.settled(),false,'real success message is provisional');assert.equal(fs.existsSync(f.dst),true);
 f.unblock();assert.equal(await f.exited,0);const result=await f.outcome;assert.equal(result.error,undefined);assert.equal(result.value.libra.records,1);
});
test('real_late_error_after_success_rejects_after_exit',async t=>{
 const f=fixture(t,'late-error');assert.equal((await f.message).ok,true);f.unblock();assert.equal(await f.exited,1);assert.match(f.state.error.message,/fixture_worker_late_error/);
 const result=await f.outcome;assert.ok(result.error,'actual late error and exit1 cannot retain earlier success');
});
test('failure_message_waits_for_actual_exit',async t=>{
 const f=fixture(t,'failure');assert.equal((await f.message).ok,false);await new Promise(setImmediate);
 assert.equal(f.state.exited,false);assert.equal(f.settled(),false,'failure message does not release worker ownership');
 f.unblock();assert.equal(await f.exited,1);assert.ok((await f.outcome).error);
});
test('nonzero_exit_overrides_success',async t=>{
 const f=fixture(t,'exit-nonzero');await f.message;f.unblock();assert.equal(await f.exited,2);assert.match((await f.outcome).error?.message||'',/backup_worker_exit:2/);
});
for(const mode of ['duplicate','conflict'])test(mode+'_result_rejects_only_after_exit',async t=>{
 const f=fixture(t,mode);await f.message;await new Promise(setImmediate);assert.equal(f.settled(),false);f.unblock();assert.equal(await f.exited,0);assert.ok((await f.outcome).error,'multiple result messages refuse success');
});
test('exit_without_result_rejects',async t=>{const f=fixture(t,'no-result');assert.equal(await f.exited,0);assert.match((await f.outcome).error?.message||'',/without_result/);});
test('worker_error_without_result_rejects_after_exit',async t=>{const f=fixture(t,'error-no-result');assert.equal(await f.exited,1);assert.ok(f.state.error);assert.ok((await f.outcome).error);});
