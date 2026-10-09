'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{EventEmitter}=require('node:events');
const {createMemorySuiteServer,NAMESPACES}=require('../server/server.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'inactive-storage-owner-'));
let app=createMemorySuiteServer({dataDir:dir,token:'offline-fixture-only-not-a-real-credential',computeEnabled:false,autoBackup:false});
const request=async(plugin,url,body,token)=>{const req=new EventEmitter();Object.assign(req,{url,method:body?'POST':'GET',headers:{'x-memory-suite-plugin':plugin,...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json'},resume(){},destroy(){}});const res=new EventEmitter();let result;res.writeHead=(status,headers)=>{res.statusCode=status;res.headers=headers};res.getHeader=name=>res.headers?.[name];res.end=bytes=>{result={status:res.statusCode,body:JSON.parse(String(bytes||'{}'))};res.emit('finish')};const task=app.server.listeners('request')[0](req,res);if(body){req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end')}await task;return result};
(async()=>{try{
 assert.deepEqual(NAMESPACES,['flashback','hayaku','libra','lia','retrace'],'legacy compatibility inventory stays five');
 for(const ns of ['flashback','hayaku','libra'])assert.equal(fs.existsSync(path.join(dir,'stores',ns,ns+'.sqlite')),true,ns+' keeps server storage');
 for(const ns of ['lia','retrace'])assert.equal(fs.existsSync(path.join(dir,'stores',ns,ns+'.sqlite')),false,ns+' must not create a fresh owner repository');
 const boot=await request('flashback_hayaku_bridge','/bootstrap');assert.equal(boot.status,200);assert.deepEqual(boot.body.authorization.roles,['manager']);assert.deepEqual(boot.body.authorization.writeNamespaces,[]);
 const lia=await request('lia_persona_linker','/bootstrap');assert.equal(lia.status,200);assert.deepEqual(lia.body.authorization.writeNamespaces,[]);
 const forbidden=await request('flashback_hayaku_bridge','/v1/kv/set',{namespace:'retrace',space:'plugin',key:'new-owner-data',value:'forbidden',operationId:'offline-owner-write-test'},boot.body.token);assert.equal(forbidden.status,403);
 const control=await request('flashback_hayaku_bridge','/v1/manager/control/status',null,boot.body.token);assert.equal(control.status,200,'manager control remains usable without owner grant');
 for(const plugin of ['flashback_memory','hayaku_locator_continuity','libra']){const core=await request(plugin,'/bootstrap');assert.equal(core.body.authorization.roles.includes('owner'),true);assert.equal(core.body.authorization.writeNamespaces.length,1);}
 const backup=await app.createBackup('manual','offline-inactive-owner-test');
 for(const ns of NAMESPACES)assert(backup.result.stores[ns],'backup retains legacy compatibility slot '+ns);
 for(const ns of ['lia','retrace'])assert.equal(fs.existsSync(path.join(dir,'stores',ns,ns+'.sqlite')),false,ns+' backup does not activate storage');
 const legacyPath=path.join(dir,'stores/retrace/retrace.sqlite');fs.mkdirSync(path.dirname(legacyPath),{recursive:true});app.repositories.flashback.vacuumInto(legacyPath);
 await app.close();for(const repo of Object.values(app.repositories))repo.close();app.diagnosticJournal.close();
 const {DatabaseSync}=require('node:sqlite'),crypto=require('node:crypto'),db=new DatabaseSync(legacyPath),value=JSON.stringify({preserved:'legacy backup'}),digest=crypto.createHash('sha256').update(value).digest('hex');
 db.prepare('INSERT INTO kv(space,key,value_json,deleted,revision,digest,updated_at) VALUES (?,?,?,?,?,?,?)').run('plugin','memory_session_bridge:hayaku_ledger_backup:old:backup',value,0,1,digest,1);db.close();
 const before=crypto.createHash('sha256').update(fs.readFileSync(legacyPath)).digest('hex');
 app=createMemorySuiteServer({dataDir:dir,token:'offline-fixture-only-not-a-real-credential',computeEnabled:false,autoBackup:false});
 assert.deepEqual(app.repositories.retrace.get('plugin','memory_session_bridge:hayaku_ledger_backup:old:backup').value,{preserved:'legacy backup'});
 assert.equal(app.repositories.retrace.legacyReadOnly,true);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(legacyPath)).digest('hex'),before,'existing legacy file is read without metadata writes');
 console.log('retrace_inactive_storage_owner_test: PASS (core writers, manager ACL, five backup slots, no new inactive stores, exact existing legacy bytes)');
}finally{await app.close();for(const repo of Object.values(app.repositories))repo.close();fs.rmSync(dir,{recursive:true,force:true})}})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
