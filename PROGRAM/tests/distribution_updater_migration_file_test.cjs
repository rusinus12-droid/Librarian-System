'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {shouldCopyUpdater}=require('../tools/build_distribution.cjs');
const {createZipFromDirectory,readZipEntries,verifyZipAgainstDirectory}=require('../tools/zip_writer.cjs');
assert.equal(shouldCopyUpdater('core/migration-required.cjs'),true,'migration-required updater core must be included in release');
assert.equal(shouldCopyUpdater('core/data-identity.cjs'),true,'standalone physical identity producer must be included in release');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'lib-updater-identity-package-'));
try{
 const source=path.resolve(__dirname,'../../UPDATER'),stage=path.join(temp,'stage'),updater=path.join(stage,'UPDATER');
 fs.cpSync(source,updater,{recursive:true,filter:file=>fs.statSync(file).isDirectory()||shouldCopyUpdater(path.relative(source,file).split(path.sep).join('/'))});
 const zip=path.join(temp,'updater.zip');createZipFromDirectory(stage,zip);
 assert.equal(verifyZipAgainstDirectory(zip,stage).ok,true);
 const entries=readZipEntries(zip);assert.ok(entries.some(v=>v.name==='UPDATER/core/data-identity.cjs'));
 const extracted=path.join(temp,'extracted');
 for(const entry of entries){const file=path.join(extracted,...entry.name.split('/'));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,entry.bytes);}
 assert.equal(fs.existsSync(path.join(extracted,'PROGRAM')),false,'recovery must load while PROGRAM is absent');
 const core=require(path.join(extracted,'UPDATER/core/program-only.cjs')),identity=require(path.join(extracted,'UPDATER/core/data-identity.cjs'));
 const data=path.join(temp,'DATA');fs.mkdirSync(path.join(data,'config'),{recursive:true});
 assert.throws(()=>core.dataInstanceId(data),e=>e.code==='DATA_INSTANCE_IDENTITY_UNAVAILABLE');
 identity.ensureDataInstanceIdentity(data);const id=core.dataInstanceId(data);assert.equal(id.length,32);
 assert.deepEqual(identity.readDataInstanceIdentity(data),require('../server/core/data-instance-identity.cjs').readDataInstanceIdentity(data));
 fs.writeFileSync(path.join(data,'runtime-token.txt'),'fixture-token-rotation-'.repeat(4));assert.equal(core.dataInstanceId(data),id);
 for(const entry of entries)assert.ok(!/(?:^|\/)(?:update-state\.json|operation-lock\.sqlite|latest\.log)$/.test(entry.name));
 console.log('distribution_updater_migration_file_test: PASS (ZIP reopen + PROGRAM-absent require + physical identity)');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
