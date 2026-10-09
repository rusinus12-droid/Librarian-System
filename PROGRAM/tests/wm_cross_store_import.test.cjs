'use strict';
// FEATURE-FIRST basic in-process SQLite checks, not a crash/concurrency matrix.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const F = require('./helpers/wm-fixture.cjs');
const {createWmStore} = require('../server/wm/store.cjs');
const {createWmPins} = require('../server/wm/pins.cjs');
const B = require('../server/wm/backup.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.env.WM_BASIC_CHECKPOINT || os.tmpdir(), 'wm-cross-store-basic-'));
  const databasePath = path.join(root, 'source.sqlite'), identity = F.storeIdentity();
  const store = createWmStore({databasePath, identity}), pins = createWmPins({store, bootId:'cross-import-source'});
  t.after(() => store.close());
  const initial = store.initializeScope(F.initialization()).receipt.head;
  const items = ['raw', 'cold', 'raw_history', 'lineage', 'orphan'].map(domain => {
    const payload = Buffer.from('original password and secret story\r\n🌍 ' + domain);
    return {payload, descriptor:{...F.item(domain, 'import-' + domain), bytes:payload.length,
      sha256:F.sha(payload), dependencies:domain === 'raw_history' ? ['import-raw'] : []}};
  });
  store.putInventoryItems(F.inventoryWrite({items}));
  const input = F.storeWrite(initial, {items:items.map(x=>x.descriptor).sort((a,b)=>a.logicalId.localeCompare(b.logicalId))});
  const prepared = store.prepare(input); assert.equal(store.publish(prepared).status, 'committed');
  // Historical closure includes another committed revision and a genuine empty scope.
  const next = F.storeWrite(prepared.head, {operationId:'write-2', generationId:'generation-2', raw:'Later\r\n🌍', items:input.manifest.items});
  const nextPrepared = store.prepare(next); assert.equal(store.publish(nextPrepared).status, 'committed');
  store.initializeScope(F.initialization('scope-empty', 'initialize-empty'));
  const lease = pins.acquire('scope-a').lease;
  const backupRoot = path.join(root, 'backup'), backup = B.createWmBackup({store, pins, outputDir:backupRoot, restoreEnabled:true});
  const component = backup.capture({backupId:'cross-store-component'}), targetPath = path.join(root, 'target', 'wm.sqlite');
  const request = {operationId:'import-operation', component, backupRoot, targetDatasetId:'dataset-target', targetBackendId:'server-target'};
  return {root, databasePath, identity, store, pins, input, prepared, nextPrepared, lease, backup, component, backupRoot, targetPath, request,
    importer:B.createWmBackupImport({targetPath, importEnabled:true})};
}
function apply(importer, plan) { return importer.apply({planId:plan.planId, confirmation:plan.confirmation, requestFingerprint:plan.requestFingerprint}); }

test('cross-store import reopens all generations with fresh authority and unchanged six-domain bytes', t => {
  const f = fixture(t), sourceFingerprint = f.backup.currentFingerprint(), sourceHash = B.hashFile(path.join(f.backupRoot, f.component.file));
  const plan = f.importer.prepare(f.request);
  assert.deepEqual(f.importer.prepare(f.request), plan);
  for (const key of ['authorityId','storeId','routeGeneration','writerEpoch']) assert.notEqual(plan.targetIdentity[key], f.component.sourceStoreIdentity[key]);
  const result = apply(f.importer, plan);
  assert.equal(result.status, 'committed'); assert.equal(result.receipt.admission, 'recovery_required');
  assert.equal(result.receipt.wholeTransferAtomic, false); assert.equal(result.receipt.activation, false);
  for (const domain of ['canonical','raw','cold','raw_history','lineage','orphan']) assert.equal(result.receipt.domains[domain].complete, true);
  assert.equal(f.backup.currentFingerprint(), sourceFingerprint);
  assert.equal(B.hashFile(path.join(f.backupRoot, f.component.file)), sourceHash);
  assert.equal(f.pins.readGeneration(f.lease), 'Later\r\n🌍');
  // The target is an independent physical copy, not a link to the source backup.
  assert.notEqual(fs.statSync(f.targetPath).ino, fs.statSync(path.join(f.backupRoot, f.component.file)).ino);
  const checked = B.inspectWmBackupFile(f.targetPath, {restored:true});
  assert.equal(checked.generations.length, 4); assert.equal(checked.inventoryDigest, f.component.inventoryDigest);
  const target = createWmStore({databasePath:f.targetPath, identity:plan.targetIdentity}); t.after(()=>target.close());
  const targetPins = createWmPins({store:target, bootId:'target-basic'}), state = target.readDatasetState();
  assert.equal(state.route.state, 'recovery_required');
  for (const generation of checked.generations) {
    assert(!f.component.generations.some(g=>g.generationId===generation.generationId));
    const content = target.readGeneration({generationId:generation.generationId});
    assert.equal(content.manifest.expectedHead.authorityId, plan.targetIdentity.authorityId);
    assert.equal(F.sha(Buffer.from(content.raw ?? '')), generation.rawSha256);
  }
  assert.equal(checked.generations.filter(g=>g.rawSha256===F.sha(Buffer.from(F.raw))).length, 1);
  assert.throws(()=>targetPins.readGeneration(f.lease));
  assert.throws(()=>target.prepare(f.input), /historical_operation_not_executable/);
  assert.throws(()=>target.publish(f.prepared), /historical_operation_not_executable/);
  assert.throws(()=>target.initializeScope(F.initialization('scope-new','post-import',state.writerEpoch,state.route.routeGeneration)), /restore_recovery_required/);
  assert.equal(target.status({operationId:f.input.operationId,requestFingerprint:f.input.requestFingerprint}).receipt.executionAuthority, false);
  // Target re-export is a valid component with rebased authority and inert provenance.
  const exported = B.createWmBackup({store:target,pins:targetPins,outputDir:path.join(f.root,'target-backup')});
  const component = exported.capture({backupId:'rebased-backup'});
  assert.equal(exported.verify(component).ok, true);
  assert.equal(component.sourceStoreIdentity.authorityId, plan.targetIdentity.authorityId);
  assert.equal(component.inventoryDigest, f.component.inventoryDigest);
});

test('same-ID durable retry and publication acknowledgement reconciliation keep the exact target identity', t => {
  const f = fixture(t), plan = f.importer.prepare(f.request), first = apply(f.importer, plan);
  const importer = B.createWmBackupImport({targetPath:f.targetPath,importEnabled:true});
  assert.deepEqual(importer.prepare(f.request), plan);
  assert.deepEqual(apply(importer, plan), first);
  assert.deepEqual(importer.status({planId:plan.planId,operationId:plan.operationId,requestFingerprint:plan.requestFingerprint}), first);
  assert.throws(()=>importer.prepare({...f.request,operationId:'replacement-operation'}), /import_operation_identity_conflict/);
  assert.throws(()=>apply(importer,{...plan,confirmation:'WRONG'}), /import_confirmation_mismatch/);
  // Focused basic saved-phase reconciliation, not a simulated process/power crash.
  const file=f.targetPath+'.import-plan.json', record=JSON.parse(fs.readFileSync(file));
  record.phase='publishing'; delete record.result; fs.writeFileSync(file,JSON.stringify(record));
  assert.deepEqual(apply(importer, plan), first);
  assert.equal(JSON.parse(fs.readFileSync(file)).plan.incarnation, plan.incarnation);
});

test('unsupported schemas, missing closure, default provider and existing targets fail before target publication', t => {
  const f = fixture(t);
  assert.throws(()=>B.createWmBackupImport({targetPath:f.targetPath}).prepare(f.request), /import_provider_unqualified/);
  assert.throws(()=>f.importer.prepare({...f.request,component:{...f.component,schema:'wm.backup-component.v99'}}), /backup_component_invalid/);
  assert.equal(fs.existsSync(f.targetPath), false); assert.equal(fs.existsSync(f.targetPath+'.import-plan.json'), false);
  const badRoot=path.join(f.root,'bad-closure'); fs.mkdirSync(badRoot);
  const badFile=path.join(badRoot,f.component.file);fs.copyFileSync(path.join(f.backupRoot,f.component.file),badFile);
  F.sqliteMutate(badFile,db=>{db.exec('DROP TRIGGER generation_items_immutable_delete');db.prepare('DELETE FROM generation_items WHERE ordinal=0').run();db.exec("CREATE TRIGGER generation_items_immutable_delete BEFORE DELETE ON generation_items BEGIN SELECT RAISE(ABORT,'wm_immutable'); END;");});
  const bad={...f.component,bytes:fs.statSync(badFile).size,sha256:B.hashFile(badFile)};
  assert.throws(()=>f.importer.prepare({...f.request,component:bad,backupRoot:badRoot}), /backup_generation_closure/);
  assert.equal(fs.existsSync(f.targetPath), false); assert.equal(fs.existsSync(f.targetPath+'.import-plan.json'), false);
  fs.mkdirSync(path.dirname(f.targetPath)); fs.writeFileSync(f.targetPath,'unrelated existing target');
  assert.throws(()=>f.importer.prepare(f.request), /import_target_not_empty/);
  assert.equal(fs.readFileSync(f.targetPath,'utf8'),'unrelated existing target');
  // Old restore still has its own exact same-physical identity boundary.
  assert.throws(()=>B.stageWmRestoreFile({component:f.component,backupRoot:f.backupRoot,stagePath:path.join(f.root,'not-created'),expectedStoreIdentity:{authorityId:'foreign',storeId:'foreign',datasetId:'foreign',backendId:'foreign'},operationId:'old-restore',planId:'old-plan'}), /restore_cross_physical_identity_unsupported/);
});

test('cross-store import retains independently materialized handoff chunks as inert verified evidence', async t => {
  const {fixture:handoffFixture} = require('../wm/tools/wm-handoff-fixture.cjs');
  const f = await handoffFixture(t), prepared = await f.prepare('cross-store-handoff');
  assert.equal((await f.adopt(prepared)).usable, true);
  const backupRoot=path.join(f.dataDir,'cross-store-component');
  const component=f.service.captureBackup({backupId:'cross-store-handoff',outputDir:backupRoot});
  const targetPath=path.join(f.dataDir,'independent-import','wm.sqlite');
  const importer=B.createWmBackupImport({targetPath,importEnabled:true});
  const plan=importer.prepare({operationId:'handoff-import',component,backupRoot,targetDatasetId:'independent-dataset',targetBackendId:'independent-server'});
  const result=apply(importer,plan);
  assert.equal(result.status,'committed');
  assert(F.sqliteRead(targetPath,"SELECT count(*) n FROM metadata WHERE key LIKE 'handoff-copy:%'")[0].n>0);
  assert.equal(F.sqliteRead(targetPath,"SELECT count(*) n FROM metadata WHERE key LIKE 'handoff-target:%' OR key LIKE 'migration-stage:%'")[0].n,0);
  const source=F.sqliteRead(path.join(backupRoot,component.file),"SELECT key,value FROM metadata WHERE key LIKE 'handoff-copy:%' ORDER BY key");
  assert.deepEqual(F.sqliteRead(targetPath,"SELECT key,value FROM metadata WHERE key LIKE 'handoff-copy:%' ORDER BY key"),source);
  assert.equal(B.inspectWmBackupFile(targetPath,{restored:true}).inventoryDigest,component.inventoryDigest);
});
