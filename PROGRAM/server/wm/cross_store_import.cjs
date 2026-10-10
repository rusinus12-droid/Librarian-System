'use strict';
// Explicit offline fresh-target import. Never redirects an existing server store,
// revives source authority, merges data, activates a route, or uses live DATA.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const B = require('./backup.cjs');
const C = require('../../sdk/WmStorageContracts.source.js');
const SCHEMA = 'wm.cross-store-import.v1';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = B.stable, clone = v => JSON.parse(JSON.stringify(v));
const equal = (a, b) => stable(a) === stable(b);
const fail = reason => { throw Object.assign(Error(reason), {code:'WM_' + reason, statusCode:409}); };
const token = v => typeof v === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(v);
const fresh = prefix => prefix + '-' + crypto.randomUUID();
const without = (v, key) => Object.fromEntries(Object.entries(v).filter(([k]) => k !== key));
const hashObject = v => sha(Buffer.from(stable(v)));
function exact(v, keys) {
  B.assertPlainData(v);
  if (!v || Array.isArray(v) || Object.keys(v).length !== keys.length || !keys.every(k => Object.hasOwn(v, k))) fail('import_unknown_field');
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncFile(file) {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function regularPath(file, allowMissing = false) {
  let cursor = path.parse(file).root;
  for (const bit of file.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, bit);
    try {
      const st = fs.lstatSync(cursor);
      if (st.isSymbolicLink() || (cursor === file ? !st.isFile() : !st.isDirectory())) fail('import_path_unsafe');
    } catch (e) { if (e.code !== 'ENOENT' || !allowMissing) throw e; }
  }
}
function targetAbsent(targetPath) {
  regularPath(targetPath, true);
  for (const suffix of ['', '-wal', '-shm', '-journal', '.restore-journal.json']) {
    if (fs.existsSync(targetPath + suffix)) fail('import_target_not_empty');
  }
}
function rebaseToken(plan, kind, original) {
  return kind + '-' + hashObject({authority:plan.targetIdentity.authorityId, kind, original}).slice(0, 56);
}
function rebaseHead(plan, head) {
  return {...head, authorityId:plan.targetIdentity.authorityId, storeId:plan.targetIdentity.storeId,
    epoch:plan.targetIdentity.writerEpoch, generationId:rebaseToken(plan, 'generation', head.generationId),
    revision:rebaseToken(plan, 'revision', head.generationId)};
}
function readMeta(db, key) { return db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value; }
function importEvidenceKey(plan) { return 'backup-evidence:cross-store-import:' + plan.planId; }

// Rebase only the independently copied, unpublished file. All original immutable
// bytes remain in the source component. Triggers are restored inside the same
// target-only transaction before the file is eligible for publication.
function rebaseStage(stagePath, plan, component) {
  if(component.schema==='wm.backup-component.v2')return require('./backup_rebase.cjs').rebaseStage(stagePath,plan,component);
  const db = new DatabaseSync(stagePath);
  try {
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    const put = db.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('generations','generation_items')").all();
    for (const trigger of triggers) db.exec('DROP TRIGGER "' + trigger.name + '"');
    const mappings = [];
    // Read immutable source rows before changing their primary keys.
    const rows = db.prepare('SELECT * FROM generations ORDER BY generation_id').all();
    for (const row of rows) {
      const oldIntent = JSON.parse(row.input_json), oldPrepared = JSON.parse(row.prepared_json);
      const expectedHead = rebaseHead(plan, oldIntent.expectedHead), head = rebaseHead(plan, oldPrepared.head);
      const operationId = rebaseToken(plan, 'import-op', oldIntent.operationId);
      const manifest = {...JSON.parse(row.manifest_json), generationId:head.generationId, expectedHead, operationId,
        routeGeneration:plan.targetIdentity.routeGeneration, writerEpoch:plan.targetIdentity.writerEpoch};
      manifest.manifestDigest = hashObject(without(manifest, 'manifestDigest'));
      const intent = {...oldIntent, operationId, expectedHead, manifest,
        routeGeneration:plan.targetIdentity.routeGeneration, writerEpoch:plan.targetIdentity.writerEpoch};
      intent.requestFingerprint = hashObject(intent.operation === 'initialize'
        ? {scope:intent.scope, operationId, routeGeneration:intent.routeGeneration, writerEpoch:intent.writerEpoch, expectedEmpty:true}
        : without(intent, 'requestFingerprint'));
      const prepared = {...oldPrepared, preparedId:rebaseToken(plan, 'prepared', oldPrepared.preparedId),
        operationId, expectedHead, head, requestFingerprint:intent.requestFingerprint};
      if (!C.validateManifest(manifest).ok || intent.operation !== 'initialize' && !C.validateOperation(intent).ok) fail('import_rebased_generation_invalid');
      const inputJson = stable(intent), preparedJson = stable(prepared);
      db.prepare('UPDATE generations SET generation_id=?,manifest_json=?,manifest_digest=?,input_json=?,input_sha256=?,prepared_json=?,prepared_sha256=? WHERE generation_id=?')
        .run(head.generationId, stable(manifest), manifest.manifestDigest, inputJson, sha(Buffer.from(inputJson)), preparedJson, sha(Buffer.from(preparedJson)), row.generation_id);
      db.prepare('UPDATE generation_items SET generation_id=? WHERE generation_id=?').run(head.generationId, row.generation_id);
      put.run('restore-historical-operation:' + sha(Buffer.from(operationId)), '1');
      mappings.push({sourceGenerationId:row.generation_id, targetGenerationId:head.generationId,
        sourceManifestDigest:row.manifest_digest, targetManifestDigest:manifest.manifestDigest,
        sourceInputDigest:row.input_sha256, sourcePreparedDigest:row.prepared_sha256,
        sourceOperationId:oldIntent.operationId, targetOperationId:operationId,
        scope:row.scope, rawSha256:row.raw_sha256});
    }
    for (const row of db.prepare('SELECT * FROM heads ORDER BY scope').all()) {
      const head = rebaseHead(plan, JSON.parse(row.head_json)), json = stable(head);
      db.prepare('UPDATE heads SET generation_id=?,head_json=?,head_sha256=? WHERE scope=?').run(head.generationId, json, sha(Buffer.from(json)), row.scope);
    }
    for (const row of db.prepare("SELECT key,value FROM metadata WHERE key LIKE 'migration-canonical:%' OR key LIKE 'migration-empty:%'").all()) {
      const value = JSON.parse(row.value);
      put.run(row.key, stable(row.key.startsWith('migration-empty:') ? rebaseHead(plan, value) : {...value, head:rebaseHead(plan, value.head)}));
    }
    // Historical operations/receipts are evidence only. Generated import IDs are
    // blocked too; synthetic Prepared objects cannot become executable later.
    for (const row of db.prepare('SELECT operation_id FROM operations').iterate()) put.run('restore-historical-operation:' + sha(Buffer.from(row.operation_id)), '1');
    const identity = plan.targetIdentity;
    const route = {schema:C.ROUTE_SCHEMA, mode:'server_only', datasetId:identity.datasetId, backendId:identity.backendId,
      routeGeneration:identity.routeGeneration, state:'recovery_required'};
    const routeJson = stable(route);
    db.prepare('UPDATE dataset_route SET route_json=?,route_sha256=? WHERE singleton=1').run(routeJson, sha(Buffer.from(routeJson)));
    put.run('identity', stable(identity));
    put.run('writer_epoch', identity.writerEpoch);
    put.run('restore-historical-operation:' + sha(Buffer.from(plan.operationId)), '1');
    put.run('inventory_revision', rebaseToken(plan, 'inventory', component.inventoryDigest));
    put.run('pin_boot_generation', rebaseToken(plan, 'boot', plan.planId));
    for (const value of Object.values(identity)) put.run('used:' + value, '1');
    const cut = JSON.parse(readMeta(db, 'backup-cut'));
    const sourceHeadsDigest = hashObject(cut.heads);
    cut.sourceStoreIdentity = clone(identity);
    cut.snapshot = {...cut.snapshot, snapshotId:rebaseToken(plan, 'snapshot', component.snapshotId), routeGeneration:identity.routeGeneration};
    cut.heads = cut.heads.map(head => rebaseHead(plan, head));
    put.run('backup-cut', stable(cut));
    const evidence = {schema:'wm.import-rebase-evidence.v1', planId:plan.planId, operationId:plan.operationId,
      sourceComponentSha256:component.sha256, sourceStoreIdentity:component.sourceStoreIdentity,
      sourceSnapshotId:component.snapshotId, sourceHeadsDigest, targetIdentity:identity,
      inventoryDigest:component.inventoryDigest, mappings, historical:true, executionAuthority:false};
    put.run(importEvidenceKey(plan), stable(evidence));
    put.run('restore-admission', stable({schema:'wm.restore-admission.v1', operationId:plan.operationId, planId:plan.planId,
      incarnation:plan.incarnation, state:'recovery_required', historicalAuthority:false,
      sourceSnapshotId:component.snapshotId, inventoryDigest:component.inventoryDigest,
      importSchema:SCHEMA, sourceComponentSha256:component.sha256, rebaseEvidenceDigest:hashObject(evidence)}));
    for (const trigger of triggers) db.exec(trigger.sql);
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
  syncFile(stagePath);
}

function verifyImportedFile(file, plan, component, expectedFileHash) {
  regularPath(file);
  if(component.schema==='wm.backup-component.v2')return require('./backup_rebase.cjs').verifyImportedFile(file,plan,component,expectedFileHash);
  if (expectedFileHash && B.hashFile(file) !== expectedFileHash) fail('import_target_digest_changed');
  const checked = B.inspectWmBackupFile(file, {restored:true});
  const db = new DatabaseSync(file, {readOnly:true});
  try {
    const identity = JSON.parse(readMeta(db, 'identity'));
    const evidence = JSON.parse(readMeta(db, importEvidenceKey(plan)) || 'null');
    const route = JSON.parse(db.prepare('SELECT route_json FROM dataset_route WHERE singleton=1').get().route_json);
    const a = checked.admission;
    if (!equal(identity, plan.targetIdentity) || !equal(checked.sourceStoreIdentity, identity) ||
        route.state !== 'recovery_required' || route.routeGeneration !== identity.routeGeneration ||
        route.datasetId !== identity.datasetId || route.backendId !== identity.backendId ||
        readMeta(db, 'writer_epoch') !== identity.writerEpoch || !a || a.importSchema !== SCHEMA ||
        a.operationId !== plan.operationId || a.planId !== plan.planId || a.incarnation !== plan.incarnation ||
        a.state !== 'recovery_required' || a.historicalAuthority !== false || a.sourceComponentSha256 !== component.sha256 ||
        a.inventoryDigest !== component.inventoryDigest ||
        checked.inventoryDigest !== component.inventoryDigest || !evidence || evidence.schema !== 'wm.import-rebase-evidence.v1' ||
        evidence.executionAuthority !== false || evidence.historical !== true || evidence.planId !== plan.planId ||
        evidence.operationId !== plan.operationId || evidence.sourceComponentSha256 !== component.sha256 ||
        !equal(evidence.sourceStoreIdentity, component.sourceStoreIdentity) || !equal(evidence.targetIdentity, identity) ||
        hashObject(evidence) !== a.rebaseEvidenceDigest || evidence.mappings.length !== component.generations.length ||
        checked.generations.length !== component.generations.length || !equal(checked.rawInventory, component.rawInventory) ||
        !equal(checked.operationHistory, component.operationHistory) || !equal(checked.manual??null, component.manual??null)) fail('import_target_binding_invalid');
    const targetGenerations = new Map(checked.generations.map(g => [g.generationId, g]));
    const mapped = new Set();
    for (let i = 0; i < component.generations.length; i++) {
      const source = component.generations[i], mapping = evidence.mappings[i], target = targetGenerations.get(mapping.targetGenerationId);
      if (mapping.sourceGenerationId !== source.generationId || mapping.sourceManifestDigest !== source.manifestDigest ||
          mapping.targetGenerationId !== rebaseToken(plan, 'generation', source.generationId) || mapped.has(mapping.targetGenerationId) ||
          mapping.targetOperationId !== rebaseToken(plan, 'import-op', mapping.sourceOperationId) || !target ||
          target.scope !== source.scope || target.rawSha256 !== source.rawSha256 || target.utf8Bytes !== source.utf8Bytes ||
          target.manifestDigest !== mapping.targetManifestDigest || !readMeta(db, 'restore-historical-operation:' + sha(Buffer.from(mapping.targetOperationId)))) fail('import_generation_mapping_invalid');
      mapped.add(mapping.targetGenerationId);
    }
    for (const row of db.prepare('SELECT operation_id FROM operations').iterate()) {
      if (!readMeta(db, 'restore-historical-operation:' + sha(Buffer.from(row.operation_id)))) fail('import_source_operation_authority');
    }
    return checked;
  } finally { db.close(); }
}

/**
 * Explicit target is a never-created SQLite file, selected by trusted offline
 * configuration. Source v1 component and directory are passed at prepare time.
 * importEnabled is provider qualification/configuration, not request JSON.
 */
function componentGenerationCount(value){return Array.isArray(value)?value.length:value.count;}
function createWmBackupImport({targetPath, importEnabled=false}={}) {
  if (typeof targetPath !== 'string' || !targetPath || typeof importEnabled !== 'boolean') fail('import_options_invalid');
  targetPath = path.resolve(targetPath);
  const recordPath = targetPath + '.import-plan.json', lockPath = targetPath + '.import-lock', recoveryLockPath = targetPath + '.import-recovery-lock';
  function enabled() { if (!importEnabled) fail('import_provider_unqualified'); }
  function load(planId) {
    if (!token(planId) || !fs.existsSync(recordPath)) fail('import_plan_unknown');
    regularPath(recordPath);
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    if (record.schema !== 'wm.import-plan-record.v1' || record.plan?.schema !== 'wm.import-plan.v1' ||
        record.plan.planId !== planId || record.plan.targetPath !== targetPath || record.planDigest !== hashObject(record.plan) ||
        record.requestFingerprint !== record.plan.requestFingerprint) fail('import_plan_record_invalid');
    B.validComponent(record.component);
    const p = record.plan;
    if (!Number.isSafeInteger(record.stageAttempt ?? 0) || (record.stageAttempt ?? 0) < 0 || record.stagePath !== targetPath + '.import-stage-' + p.planId + (record.stageAttempt ? '-retry-' + record.stageAttempt : '') || typeof record.backupRoot !== 'string' ||
        path.resolve(record.backupRoot) !== record.backupRoot || p.expectedTarget !== 'absent' ||
        p.admission !== 'recovery_required' || p.activation !== false || p.componentSha256 !== record.component.sha256 ||
        p.inventoryDigest !== record.component.inventoryDigest || !equal(p.sourceStoreIdentity, record.component.sourceStoreIdentity) ||
        !['prepared','staging','staged','publishing','committed'].includes(record.phase) ||
        !Object.values(p.targetIdentity).every(token) ||
        ['authorityId','storeId','routeGeneration','writerEpoch'].some(k=>p.targetIdentity[k]===record.component.sourceStoreIdentity[k]) ||
        hashObject({operationId:p.operationId, component:record.component, backupRoot:record.backupRoot,
          targetDatasetId:p.targetIdentity.datasetId, targetBackendId:p.targetIdentity.backendId, targetPath}) !== record.requestFingerprint ||
        ['staged','publishing','committed'].includes(record.phase) && !/^[a-f0-9]{64}$/.test(record.stageSha256 || '')) fail('import_plan_record_invalid');
    if (record.phase === 'committed' && hashObject(record.result) !== record.resultDigest) fail('import_receipt_integrity');
    return record;
  }
  function write(record) { B.atomicJson(recordPath, record); }
  function result(record, checked) {
    const p = record.plan;
    return {status:'committed', operationId:p.operationId, requestFingerprint:p.requestFingerprint, receipt:{
      schema:'wm.import-receipt.v1', planId:p.planId, backupId:p.backupId, sourceStoreIdentity:record.component.sourceStoreIdentity,
      sourceComponentSha256:record.component.sha256, targetPath, targetIdentity:p.targetIdentity, incarnation:p.incarnation,
      inventoryDigest:checked.inventoryDigest, domains:checked.domains, generations:componentGenerationCount(checked.generations),
      ...record.component.schema==='wm.backup-component.v2'?{sourceInventoryDigest:record.component.inventoryDigest}:{},
      admission:'recovery_required', historicalAuthority:false, sourcePreserved:true, sourceMutated:false,
      sourceCompacted:false, targetPublished:true, activation:false, wholeTransferAtomic:false,
      targetFileSha256:record.stageSha256, reconnectRequired:true}};
  }
  function uncertain(record, reason) {
    return {status:'uncertain', operationId:record.plan.operationId, requestFingerprint:record.plan.requestFingerprint,
      receipt:{schema:'wm.import-pending.v1', planId:record.plan.planId, phase:record.phase, reason,
        admission:'recovery_required', activation:false, executionAuthority:false}};
  }
  function reconcile(record) {
    if (record.phase === 'committed') return clone(record.result); // Durable historical result, not current activation proof.
    if (record.phase !== 'publishing') return uncertain(record, 'import_recovery_required');
    try {
      const checked = verifyImportedFile(targetPath, record.plan, record.component, record.stageSha256);
      record.result = result(record, checked); record.resultDigest = hashObject(record.result); record.phase = 'committed'; write(record);
      return clone(record.result);
    } catch { return uncertain(record, 'import_publication_uncertain'); }
  }
  function prepare(input) {
    enabled(); exact(input, ['operationId','component','backupRoot','targetDatasetId','targetBackendId']);
    const {operationId, component, targetDatasetId, targetBackendId} = input;
    if (![operationId, targetDatasetId, targetBackendId].every(token) || typeof input.backupRoot !== 'string' || !input.backupRoot) fail('import_intent_invalid');
    B.validComponent(component);
    const backupRoot = path.resolve(input.backupRoot);
    const requestFingerprint = hashObject({...input, backupRoot, targetPath});
    if (fs.existsSync(recordPath)) {
      regularPath(recordPath);
      const first = JSON.parse(fs.readFileSync(recordPath, 'utf8')), record = load(first.plan?.planId);
      if (record.requestFingerprint !== requestFingerprint || record.plan.operationId !== operationId) fail('import_operation_identity_conflict');
      return clone(record.plan);
    }
    targetAbsent(targetPath);
    const verified = B.verifyWmBackupComponent(component, backupRoot);
    if (!verified.ok) fail(verified.reason);
    const planId = fresh('import'), targetIdentity = {authorityId:fresh('authority'), storeId:fresh('store'),
      datasetId:targetDatasetId, backendId:targetBackendId, routeGeneration:fresh('route'), writerEpoch:fresh('epoch')};
    const plan = {schema:'wm.import-plan.v1', planId, operationId, requestFingerprint, targetPath,
      expectedTarget:'absent', targetIdentity, incarnation:fresh('incarnation'), backupId:component.backupId,
      componentSha256:component.sha256, sourceStoreIdentity:clone(component.sourceStoreIdentity),
      inventoryDigest:component.inventoryDigest, confirmation:'IMPORT ' + planId, admission:'recovery_required', activation:false};
    const record = {schema:'wm.import-plan-record.v1', requestFingerprint, plan, planDigest:hashObject(plan),
      component:clone(component), backupRoot, phase:'prepared', stagePath:targetPath + '.import-stage-' + planId};
    fs.mkdirSync(path.dirname(targetPath), {recursive:true});
    regularPath(targetPath, true);
    // Exclusive reservation prevents a second operation from silently replacing
    // this target's durable identity. Atomic JSON transitions only follow it.
    const temp = recordPath + '.reservation-' + crypto.randomUUID();
    fs.writeFileSync(temp, JSON.stringify(record, null, 2) + '\n', {flag:'wx', mode:0o600}); syncFile(temp);
    try { fs.linkSync(temp, recordPath); syncDirectory(path.dirname(recordPath)); }
    finally { fs.unlinkSync(temp); }
    return clone(plan);
  }
  function apply(input) {
    enabled(); exact(input, ['planId','confirmation','requestFingerprint']);
    let record = load(input.planId); const p = record.plan;
    if (input.confirmation !== p.confirmation || input.requestFingerprint !== p.requestFingerprint) fail('import_confirmation_mismatch');
    if (record.phase === 'committed') return reconcile(record);
    if (fs.existsSync(recoveryLockPath)) return uncertain(record, 'import_recovery_busy_or_interrupted');
    if (record.phase === 'publishing') return reconcile(record);
    if (!['prepared','staged'].includes(record.phase)) return uncertain(record, 'import_recovery_required');
    if (fs.existsSync(recoveryLockPath)) return uncertain(record, 'import_recovery_busy_or_interrupted');
    try { fs.mkdirSync(lockPath,{mode:0o700}); } catch (e) { if (e.code === 'EEXIST') return uncertain(record, 'import_busy_or_interrupted'); throw e; }
    const owner = lockOwner(p);
    try {
      fs.writeFileSync(path.join(lockPath,'owner.json'), stable(owner), {flag:'wx',mode:0o600}); syncFile(path.join(lockPath,'owner.json')); syncDirectory(lockPath);
      if (fs.existsSync(recoveryLockPath)) return uncertain(record, 'import_recovery_busy_or_interrupted');
      record = load(input.planId);
      if (!['prepared','staged'].includes(record.phase)) return uncertain(record, 'import_phase_changed');
      targetAbsent(targetPath);
      if (record.phase === 'prepared') {
        const verified = B.verifyWmBackupComponent(record.component, record.backupRoot);
        if (!verified.ok) fail(verified.reason);
        if (['','-wal','-shm','-journal'].some(s=>fs.existsSync(record.stagePath+s))) return uncertain(record, 'import_stage_requires_recovery');
        record.phase = 'staging'; write(record);
        fs.copyFileSync(B.resolveFile(record.backupRoot, record.component.file), record.stagePath, fs.constants.COPYFILE_EXCL);
        if (fs.statSync(record.stagePath).size !== record.component.bytes || B.hashFile(record.stagePath) !== record.component.sha256) fail('import_copy_digest');
        rebaseStage(record.stagePath, p, record.component);
        verifyImportedFile(record.stagePath, p, record.component);
        if (B.hashFile(B.resolveFile(record.backupRoot, record.component.file)) !== record.component.sha256) fail('import_source_changed');
        record.stageSha256 = B.hashFile(record.stagePath); record.phase = 'staged'; write(record);
      }
      if(fs.statSync(record.stagePath).nlink!==1) return uncertain(record, 'import_stage_requires_recovery');
      verifyImportedFile(record.stagePath, p, record.component, record.stageSha256);
      targetAbsent(targetPath);
      record.phase = 'publishing'; write(record);
      // One-file no-clobber publication, not an atomic source-to-target transfer
      // or mixed-owner commit. Source stays live/unchanged; target is fenced.
      fs.linkSync(record.stagePath, targetPath); syncDirectory(path.dirname(targetPath));
      // Consume only our derived staging link. The source backup is never removed.
      fs.unlinkSync(record.stagePath); syncDirectory(path.dirname(targetPath));
      return reconcile(record);
    } finally { releaseOwnedLock(lockPath, owner); }
  }
  function status(input) {
    enabled(); exact(input, ['planId','operationId','requestFingerprint']);
    const record = load(input.planId);
    if (input.operationId !== record.plan.operationId || input.requestFingerprint !== record.plan.requestFingerprint) fail('import_operation_identity_conflict');
    if(record.phase!=='committed'&&fs.existsSync(recoveryLockPath))return uncertain(record,'import_recovery_busy_or_interrupted');
    return ['committed','publishing'].includes(record.phase) ? reconcile(record) : uncertain(record, 'import_not_committed');
  }
  // Local process identity is evidence, never a timeout heuristic. On unsupported
  // platforms or foreign/legacy locks recovery remains closed and preserves them.
  function processStart(pid) {
    const value=fs.readFileSync('/proc/'+pid+'/stat','utf8');
    return value.slice(value.lastIndexOf(')')+2).split(' ')[19];
  }
  function hostIdentity() {
    try {return {host:sha(fs.readFileSync('/etc/machine-id')),boot:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),pidNamespace:fs.readlinkSync('/proc/self/ns/pid'),uid:process.getuid()};}
    catch {return null;}
  }
  function lockOwner(p) {
    let start=null;try{start=processStart(process.pid);}catch{}
    return {schema:'wm.import-lock-owner.v1',planId:p.planId,operationId:p.operationId,requestFingerprint:p.requestFingerprint,
      pid:process.pid,start,host:hostIdentity(),nonce:crypto.randomUUID()};
  }
  function releaseOwnedLock(directory, owner) {
    try {
      const st=fs.lstatSync(directory);if(st.isSymbolicLink()||!st.isDirectory())return;
      const file=path.join(directory,'owner.json');regularPath(file);
      if(!equal(JSON.parse(fs.readFileSync(file,'utf8')),owner))return;
      // Only the exact lock created and still owned by this call is consumed.
      if(fs.readdirSync(directory).some(name=>name!=='owner.json'))return;
      fs.unlinkSync(file);fs.rmdirSync(directory);syncDirectory(path.dirname(directory));
    } catch {} // A remaining lock is evidence, never permission to erase it.
  }
  function inspectLock(directory,p) {
    if(!fs.existsSync(directory))return {state:'absent'};
    const st=fs.lstatSync(directory);
    if(st.isSymbolicLink()||!st.isDirectory())return {state:'unverified',reason:'import_lock_owner_unverified'};
    let owner,bytes;
    try{regularPath(path.join(directory,'owner.json'));bytes=fs.readFileSync(path.join(directory,'owner.json'));owner=JSON.parse(bytes);}
    catch{return {state:'unverified',reason:'import_lock_owner_unverified',inode:String(st.ino),device:String(st.dev)};}
    const observation={inode:String(st.ino),device:String(st.dev),ownerDigest:sha(bytes)};
    if(owner.schema!=='wm.import-lock-owner.v1'||owner.planId!==p.planId||owner.operationId!==p.operationId||
      owner.requestFingerprint!==p.requestFingerprint||!Number.isSafeInteger(owner.pid)||owner.pid<1||!owner.start||!owner.host||!equal(owner.host,hostIdentity()))
      return {...observation,state:'unverified',reason:'import_lock_owner_unverified'};
    try {
      const start=processStart(owner.pid);
      return {...observation,state:start===owner.start?'live':'abandoned',reason:start===owner.start?'import_lock_owner_live':null};
    } catch(e) {
      // Only definite absence in this same Linux host/boot qualifies. Permission,
      // reboot/foreign host, unknown owner and other I/O errors remain blocked.
      if(e.code==='ENOENT')return {...observation,state:'abandoned',reason:null};
      return {...observation,state:'unverified',reason:'import_lock_owner_unverified'};
    }
  }
  function observeFile(file) {
    if(!fs.existsSync(file))return {exists:false};regularPath(file);
    return {exists:true,bytes:fs.statSync(file).size,sha256:B.hashFile(file)};
  }
  function observation(record) {
    return {phase:record.phase,stagePath:record.stagePath,stage:observeFile(record.stagePath),
      sidecars:['-wal','-shm','-journal'].map(suffix=>({suffix,...observeFile(record.stagePath+suffix)})),
      target:observeFile(targetPath),targetSidecars:['-wal','-shm','-journal'].map(suffix=>({suffix,...observeFile(targetPath+suffix)})),
      lock:inspectLock(lockPath,record.plan),recoveryLock:inspectLock(recoveryLockPath,record.plan)};
  }
  function exactIdentity(input, keys=['planId','operationId','requestFingerprint']) {
    enabled();exact(input,keys);const r=load(input.planId);
    if(input.operationId!==r.plan.operationId||input.requestFingerprint!==r.plan.requestFingerprint)fail('import_operation_identity_conflict');return r;
  }
  function inspectRecord(record, blockedReason) {
    const observed=observation(record);
    return {schema:'wm.import-inspection.v1',plan:clone(record.plan),phase:record.phase,
      result:record.phase==='committed'?clone(record.result):null,activation:false,admission:'recovery_required',
      stage:observed.stage,lock:observed.lock,preservedStages:clone(record.preservedStages||[]),preservedLocks:clone(record.preservedLocks||[]),
      recovery:{confirmation:'RECOVER '+record.plan.planId,observationFingerprint:hashObject(observed),
        blockedReason:blockedReason||observed.recoveryLock.reason||observed.lock.reason||null}};
  }
  function inspect(input) {return inspectRecord(exactIdentity(input));}
  function verifyTarget(input) {
    const r=exactIdentity(input);if(r.phase!=='committed')fail('import_not_committed');
    const checked=verifyImportedFile(targetPath,r.plan,r.component);
    return {verified:true,identity:clone(r.plan.targetIdentity),incarnation:r.plan.incarnation,inventoryDigest:checked.inventoryDigest,admission:'recovery_required',activation:false};
  }
  function recover(input) {
    let r=exactIdentity(input,['planId','operationId','requestFingerprint','confirmation','observationFingerprint']);
    if(input.confirmation!=='RECOVER '+r.plan.planId)fail('import_confirmation_mismatch');
    if(hashObject(observation(r))!==input.observationFingerprint)fail('import_recovery_observation_changed');
    const priorRecovery=inspectLock(recoveryLockPath,r.plan);
    if(priorRecovery.state!=='absent')return inspectRecord(r,priorRecovery.reason||'import_recovery_lock_requires_offline_review');
    try{fs.mkdirSync(recoveryLockPath,{mode:0o700});}catch(e){if(e.code==='EEXIST')return inspectRecord(r,'import_recovery_busy_or_interrupted');throw e;}
    const owner=lockOwner(r.plan);let blockedReason=null;
    try {
      fs.writeFileSync(path.join(recoveryLockPath,'owner.json'),stable(owner),{flag:'wx',mode:0o600});syncFile(path.join(recoveryLockPath,'owner.json'));syncDirectory(recoveryLockPath);
      r=load(input.planId);
      blockedReason=(()=>{
      const locked=inspectLock(lockPath,r.plan);
      if(!['absent','abandoned'].includes(locked.state))return locked.reason;
      if(locked.state==='abandoned'){
        // Preserve the exact proved-abandoned directory. Never delete or overwrite
        // another lock; an existing preserved path is a conflict, not cleanup.
        const preserved=lockPath+'.preserved-'+crypto.randomUUID();
        if(fs.existsSync(preserved))fail('import_preserved_lock_conflict');
        fs.renameSync(lockPath,preserved);syncDirectory(path.dirname(lockPath));
        r.preservedLocks=[...(r.preservedLocks||[]),{path:preserved,...locked}];write(r);
      }
      if(r.phase==='committed')return null;
      const verified=B.verifyWmBackupComponent(r.component,r.backupRoot);if(!verified.ok)fail(verified.reason);
      if(fs.existsSync(targetPath)){
        if(r.phase!=='publishing')return 'import_target_not_empty';
        return reconcile(r).status==='committed'?null:'import_publication_uncertain';
      }
      targetAbsent(targetPath);
      if(r.phase==='publishing'&&!fs.existsSync(r.stagePath))return 'import_publication_uncertain';
      let stageVerified=false;
      const sidecars=['-wal','-shm','-journal'].filter(s=>fs.existsSync(r.stagePath+s));
      if(fs.existsSync(r.stagePath)&&!sidecars.length&&fs.statSync(r.stagePath).nlink===1){
        regularPath(r.stagePath);
        if(B.hashFile(r.stagePath)===r.component.sha256){rebaseStage(r.stagePath,r.plan,r.component);}
        try{verifyImportedFile(r.stagePath,r.plan,r.component);stageVerified=true;}catch{}
      }
      if(stageVerified){r.stageSha256=B.hashFile(r.stagePath);r.phase='staged';write(r);}
      else {
        const old=observation(r);
        if(old.stage.exists||sidecars.length){
          r.preservedStages=[...(r.preservedStages||[]),{path:r.stagePath,file:old.stage,sidecars:old.sidecars}];
          r.stageAttempt=(r.stageAttempt||0)+1;
          r.stagePath=targetPath+'.import-stage-'+r.plan.planId+'-retry-'+r.stageAttempt;
          for(const suffix of ['','-wal','-shm','-journal'])if(fs.existsSync(r.stagePath+suffix))fail('import_recovery_stage_conflict');
        }
        delete r.stageSha256;r.phase='prepared';write(r);
      }
      if(B.hashFile(B.resolveFile(r.backupRoot,r.component.file))!==r.component.sha256)fail('import_source_changed');
      return null;
      })();
    } finally {releaseOwnedLock(recoveryLockPath,owner);}
    return inspectRecord(load(input.planId),blockedReason);
  }
  return Object.freeze({capabilities:()=>({schema:SCHEMA, enabled:importEnabled, sourceComponent:B.SCHEMA, sourceComponents:[B.SCHEMA,'wm.backup-component.v2'],
    target:'fresh_sqlite_file', admission:'recovery_required', liveServerReplacement:false, nativeOwner:false, explicitRecovery:true}), prepare, apply, status, inspect, recover, verifyTarget});
}
module.exports = Object.freeze({SCHEMA, createWmBackupImport});
