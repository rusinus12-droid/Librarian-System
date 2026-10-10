'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createMemorySuiteServer}=require('../server/server.cjs');
const retired=['lia','retrace'],hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const files=root=>{const out=[];const visit=d=>{for(const name of fs.readdirSync(d).sort()){const p=path.join(d,name);if(fs.lstatSync(p).isDirectory())visit(p);else out.push([path.relative(root,p),hash(p)]);}};visit(root);return out;};
async function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'retired-restore-')),dataDir=path.join(root,'DATA');let app;
 const f={root,dataDir,async close(){if(app){await app.close();app.server.emit('close');app.diagnosticJournal?.close();app=null;}},async open(){app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});await app.listen();return app;},get app(){return app;}};
 t.after(async()=>{await f.close();fs.rmSync(root,{recursive:true,force:true});});await f.open();return f;}
const dbfile=(f,ns)=>path.join(f.dataDir,'stores',ns,ns+'.sqlite');
const rowBackup=(f,id)=>f.app.listBackups().find(row=>row.id===id);
function rejectWrites(repo,ns){assert.equal(repo.legacyReadOnly,true);assert.throws(()=>repo.mutate({kind:'set',space:'plugin',key:ns+':new',value:1,operationId:'retired-restore-write-'+ns,expectedRevision:0}),/retired_storage_owner_read_only/);assert.throws(()=>repo.applyConditionalBatch([{kind:'set',space:'plugin',key:ns+':new',value:1,expectedRevision:0}],{operationId:'retired-restore-batch-'+ns}),/retired_storage_owner_read_only/);}

test('explicit all-five restore materializes absent retired backup inventory only as read-only',async t=>{
 const f=await fixture(t);for(const ns of retired){assert.equal(fs.existsSync(dbfile(f,ns)),false);assert.equal(f.app.repositories[ns].ephemeral,true);rejectWrites(f.app.repositories[ns],ns);}
 const backup=await f.app.createBackup('manual','fresh-five-slot'),row=rowBackup(f,backup.result.id),before=files(row.path);
 for(const ns of retired)assert.equal(fs.existsSync(dbfile(f,ns)),false,'backup must not provision retired source stores');
 const restored=await f.app.restoreBackup(backup.result.id);assert.deepEqual(restored.result.namespaces,['flashback','hayaku','libra','lia','retrace']);
 for(const ns of retired){assert.equal(fs.existsSync(dbfile(f,ns)),true);assert.equal(f.app.repositories[ns].ephemeral,false);rejectWrites(f.app.repositories[ns],ns);assert.equal(hash(dbfile(f,ns)),row.stores[ns].sha256);}
 assert.deepEqual(files(row.path),before,'original backup bytes unchanged');await f.close();await f.open();for(const ns of retired)rejectWrites(f.app.repositories[ns],ns);
});
test('historical nonempty retired backup restores exact inventory without metadata rewrite or live writers',async t=>{
 const f=await fixture(t),empty=await f.app.createBackup('manual','seed-template'),template=rowBackup(f,empty.result.id);await f.close();
 for(const ns of retired){const dest=dbfile(f,ns);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(template.path,template.stores[ns].file),dest);const db=new DatabaseSync(dest);try{db.prepare('INSERT INTO kv VALUES(?,?,?,0,1,?,?)').run('plugin',ns+':history',JSON.stringify({legacy:ns}),'a'.repeat(64),1);db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run('preserved-unknown-field','historical-'+ns);}finally{db.close();}}
 await f.open();const backup=await f.app.createBackup('manual','historical-retired'),row=rowBackup(f,backup.result.id),before=files(row.path);await f.close();
 for(const ns of retired){const db=new DatabaseSync(dbfile(f,ns));try{db.prepare('UPDATE kv SET value_json=?').run(JSON.stringify({later:ns}));}finally{db.close();}}
 await f.open();await f.app.restoreBackup(backup.result.id,retired);
 for(const ns of retired){const repo=f.app.repositories[ns];assert.deepEqual(repo.get('plugin',ns+':history').value,{legacy:ns});rejectWrites(repo,ns);assert.equal(repo.database.prepare('SELECT value FROM metadata WHERE key=?').get('preserved-unknown-field').value,'historical-'+ns);assert.equal(hash(dbfile(f,ns)),row.stores[ns].sha256);}
 assert.deepEqual(files(row.path),before);
});
test('staging copy failure removes owned temporary copies without changing current stores or backup',async t=>{
 const f=await fixture(t);f.app.repositories.flashback.mutate({kind:'set',space:'plugin',key:'restore-current',value:'preserve',operationId:'current-before-stage',expectedRevision:0});
 const backup=await f.app.createBackup('manual','copy-fault'),row=rowBackup(f,backup.result.id),before=files(row.path),copy=fs.copyFileSync;let injected=false;
 fs.copyFileSync=function(from,to,...args){if(!injected&&String(to).includes('hayaku.sqlite.restore-temp-')){injected=true;throw Error('RESTORE_STAGING_COPY_FAULT');}return copy.call(this,from,to,...args);};
 try{await assert.rejects(f.app.restoreBackup(backup.result.id),/RESTORE_STAGING_COPY_FAULT/);}finally{fs.copyFileSync=copy;}
 assert.equal(injected,true);assert.equal(f.app.repositories.flashback.get('plugin','restore-current').value,'preserve');assert.deepEqual(files(f.dataDir).filter(([p])=>p.includes('.restore-temp-')),[]);for(const ns of retired)assert.equal(fs.existsSync(dbfile(f,ns)),false);assert.deepEqual(files(row.path),before);
});
test('invalid retired backup digest refuses before destination creation and cleans earlier staging',async t=>{
 const f=await fixture(t),backup=await f.app.createBackup('manual','invalid-retired'),row=rowBackup(f,backup.result.id),source=path.join(row.path,row.stores.lia.file);fs.appendFileSync(source,'synthetic-invalid-byte');const before=files(row.path);
 await assert.rejects(f.app.restoreBackup(backup.result.id),/backup_store_digest_mismatch:lia/);assert.equal(fs.existsSync(path.dirname(dbfile(f,'lia'))),false);assert.deepEqual(files(f.dataDir).filter(([p])=>p.includes('.restore-temp-')),[]);assert.deepEqual(files(row.path),before,'refusal preserves even invalid original backup bytes');
});
