'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createCurrentSchema, NAMESPACES } = require('../server/portable/logical_migration.cjs');
const { hashManifest } = require('../../UPDATER/core/checkpoint.cjs');
const { buildMigratedDataNext } = require('../../UPDATER/core/migration-required.cjs');
const identity = require('../../UPDATER/core/data-identity.cjs');

function digest(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

(async()=>{
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-migration-data-next-')));
  const sourceRoot = path.resolve(__dirname, '..', '..');
  try {
    const oldProgram = path.join(root, 'PROGRAM');
    const oldData = path.join(root, 'DATA');
    const update = path.join(root, '.update');
    const programNext = path.join(update, 'PROGRAM.next');
    const releaseData = path.join(update, 'candidate-0.3.52', 'DATA');
    fs.mkdirSync(update, {recursive:true});
    await fsp.cp(path.join(sourceRoot, 'PROGRAM'), oldProgram, {recursive:true});
    await fsp.cp(path.join(sourceRoot, 'PROGRAM'), programNext, {recursive:true});
    await fsp.cp(path.join(sourceRoot, 'DATA'), releaseData, {recursive:true});
    fs.writeFileSync(path.join(oldProgram,'VERSION.txt'),'0.3.51\n');
    fs.writeFileSync(path.join(programNext,'VERSION.txt'),'0.3.52\n');
    for (const rel of ['config','migrations','logs','backups/manual','backups/auto','backups/pre-migration','backups/deleted-scopes','backups/recovery-quarantine']) fs.mkdirSync(path.join(oldData,rel),{recursive:true});
    fs.writeFileSync(path.join(oldData,'runtime-token.txt'),'r'.repeat(64)+'\n');
    fs.writeFileSync(path.join(oldData,'config','compute-signing-key.txt'),'s'.repeat(64)+'\n');
    fs.writeFileSync(path.join(oldData,'config','server-config.json'),JSON.stringify({schema:'memory-suite.server-config.v1',host:'127.0.0.1',port:48991,autoBackup:false,computeEnabled:false,computeWorkers:4},null,2));
    fs.writeFileSync(path.join(oldData,'data-layout.json'),JSON.stringify({schema:'memory-suite.data-layout.v1',layoutVersion:1,lastServerVersion:'0.3.51'},null,2));
    fs.writeFileSync(path.join(oldData,'이_DATA_폴더를_통째로_백업하세요.txt'),'fixture');
    fs.mkdirSync(path.join(oldData,'runtime','portable-transfers'),{recursive:true});
    // A genuine legacy PROGRAM may have an exporter that cannot understand
    // runtime state created by later server builds. migration_required must
    // use the candidate PROGRAM's exporter against the stopped legacy DATA.
    fs.writeFileSync(path.join(oldProgram,'tools','portable_export_stopped.cjs'),
      "module.exports={exportStopped:async()=>{throw new Error('legacy_exporter_should_not_be_used')}};\n");
    const scope={schema:'memory-suite.scope-catalog.v1',updatedAt:Date.now(),namespaces:{}};
    for (const ns of NAMESPACES) {
      const dir=path.join(oldData,'stores',ns); fs.mkdirSync(dir,{recursive:true});
      const dbFile=path.join(dir,`${ns}.sqlite`); const db=new DatabaseSync(dbFile);
      try {
        createCurrentSchema(db,ns,'0.3.51');
        const live=JSON.stringify({namespace:ns,value:'live'});
        db.prepare('INSERT INTO kv(space,key,value_json,deleted,revision,digest,updated_at) VALUES (?,?,?,?,?,?,?)').run('plugin','live',live,0,7,digest(live),Date.now());
        db.prepare('INSERT INTO kv(space,key,value_json,deleted,revision,digest,updated_at) VALUES (?,?,?,?,?,?,?)').run('plugin','gone',null,1,9,digest(`tombstone:${ns}:plugin:gone:9`),Date.now());
      } finally { db.close(); }
      scope.namespaces[ns]=[{space:'plugin',ownerId:`owner-${ns}`,updatedAt:Date.now()}];
    }
    fs.writeFileSync(path.join(oldData,'config','scope-catalog.json'),JSON.stringify(scope,null,2));
    // Fresh apply bootstraps identity before the immutable migration snapshot.
    identity.ensureDataInstanceIdentity(oldData);
    const sourceIdentity=identity.capture(oldData);
    const before=await hashManifest(oldData);
    const receipt={schema:'librarian.update-candidate.v1',currentVersion:'0.3.51',targetVersion:'0.3.52',updatePolicy:'migration_required',programNext,releaseDataTemplate:releaseData};
    const result=await buildMigratedDataNext({rootDir:root,receipt,logger:()=>{}});
    assert.equal(result.dataInstanceId.length,32);
    assert.notEqual(result.dataInstanceId,sourceIdentity.dataInstanceId);
    const dataNext=path.join(update,'DATA.next');
    assert.equal(identity.capture(dataNext).seedSha256,sourceIdentity.seedSha256);
    assert.equal(fs.readFileSync(path.join(dataNext,'runtime-token.txt'),'utf8').trim(),'r'.repeat(64));
    assert.equal(fs.readFileSync(path.join(dataNext,'config','compute-signing-key.txt'),'utf8').trim(),'s'.repeat(64));
    const cfg=JSON.parse(fs.readFileSync(path.join(dataNext,'config','server-config.json'),'utf8'));
    assert.equal(cfg.port,48991); assert.equal(cfg.autoBackup,false); assert.equal(cfg.computeEnabled,false); assert.equal(cfg.computeWorkers,4);
    for (const ns of NAMESPACES) {
      const db=new DatabaseSync(path.join(dataNext,'stores',ns,`${ns}.sqlite`),{readOnly:true});
      try { assert.equal(Number(db.prepare('SELECT COUNT(*) c FROM kv').get().c),2); assert.equal(Number(db.prepare("SELECT revision FROM kv WHERE key='gone'").get().revision),9); }
      finally { db.close(); }
    }
    const after=await hashManifest(oldData);
    assert.equal(after.treeSha256,before.treeSha256);
    process.stdout.write('remote_update_migration_data_next_test: PASS\n');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
