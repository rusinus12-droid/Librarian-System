'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { hashManifest } = require('./checkpoint.cjs');
const { readJournal, writeJournal, isTerminal, syncDirectory } = require('./journal.cjs');
const { withUpdateLock } = require('./lock.cjs');
const identity = require('./data-identity.cjs');
const {
  dataInstanceId,
  assertFreshDataInputs,
  prepareFreshDataIdentity,
  pendingIdentityPreflight,
  authoritativeJournal,
  journalPathForRoot,
  fetchHealth,
  stopServerIfRunning,
  startServer,
  runIntegrity,
  renameRetry
} = require('./program-only.cjs');

function versionFromProgram(programDir) {
  return fs.readFileSync(path.join(programDir, 'VERSION.txt'), 'utf8').trim().replace(/^v/i, '');
}

function assertDirectory(dir, code) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(code);
}

function assertMigrationReceipt(rootDir, receipt) {
  const root = path.resolve(rootDir);
  if (String(receipt?.updatePolicy || '') !== 'migration_required') throw new Error(`migration_required_policy_required:${receipt?.updatePolicy || 'missing'}`);
  const programNext = path.resolve(String(receipt?.programNext || ''));
  const dataTemplate = path.resolve(String(receipt?.releaseDataTemplate || ''));
  if (programNext !== path.join(root, '.update', 'PROGRAM.next')) throw new Error('migration_program_next_path_invalid');
  if (!dataTemplate.startsWith(path.join(root, '.update') + path.sep)) throw new Error('migration_release_data_template_path_invalid');
  assertDirectory(programNext, 'migration_program_next_missing');
  assertDirectory(dataTemplate, 'migration_release_data_template_missing');
  const targetVersion = String(receipt?.targetVersion || versionFromProgram(programNext));
  if (versionFromProgram(programNext) !== targetVersion) throw new Error('migration_program_next_version_mismatch');
  return { root, programNext, dataTemplate, targetVersion };
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}


async function copyIdentityAndEndpoint(sourceData, dataNext) {
  const tokenSource = path.join(sourceData, 'runtime-token.txt');
  if (!fs.existsSync(tokenSource)) throw new Error('migration_runtime_token_missing');
  const token = fs.readFileSync(tokenSource, 'utf8').trim();
  if (token.length < 32) throw new Error('migration_runtime_token_invalid');
  await fsp.writeFile(path.join(dataNext, 'runtime-token.txt'), `${token}\n`, { mode: 0o600 });

  await fsp.mkdir(path.join(dataNext, 'config'), { recursive: true, mode: 0o700 });
  // A migrated copy retains logical seed continuity, but receives its own
  // physical authority at DATA.next and again at the promoted DATA path.
  identity.readDataInstanceIdentity(sourceData);
  await fsp.copyFile(identity.identityPath(sourceData), identity.identityPath(dataNext));
  for (const name of ['compute-signing-key.txt', 'compute-pairing-key.txt']) {
    const source = path.join(sourceData, 'config', name);
    if (!fs.existsSync(source)) continue;
    const value = fs.readFileSync(source, 'utf8').trim();
    if (value.length < 32) throw new Error(`migration_identity_invalid:${name}`);
    await fsp.writeFile(path.join(dataNext, 'config', name), `${value}\n`, { mode: 0o600 });
  }

  const sourceConfig = readJson(path.join(sourceData, 'config', 'server-config.json'), {});
  const templateConfigPath = path.join(dataNext, 'config', 'server-config.json');
  const templateConfig = readJson(templateConfigPath, { schema: 'memory-suite.server-config.v1', host: '127.0.0.1', port: 47630, autoBackup: true, computeEnabled: true, computeWorkers: 0 });
  const sourceHost = ['127.0.0.1', 'localhost', '::1'].includes(String(sourceConfig.host || '')) ? String(sourceConfig.host) : String(templateConfig.host || '127.0.0.1');
  const sourcePort = Number(sourceConfig.port);
  const port = Number.isInteger(sourcePort) && sourcePort >= 1024 && sourcePort <= 65535 ? sourcePort : Number(templateConfig.port || 47630);
  const nextConfig = { ...templateConfig, schema: 'memory-suite.server-config.v1', host: sourceHost, port };
  await fsp.writeFile(templateConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, { mode: 0o600 });
  return { token, host: sourceHost, port };
}

function readDatabaseSchemaVersion(programDir) {
  const manifest = readJson(path.join(programDir, 'program-manifest.json'), null);
  const value = Number(manifest?.server?.databaseSchemaVersion);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('migration_target_database_schema_invalid');
  return value;
}

async function buildMigratedDataNext({ rootDir, receipt, logger = () => {} }) {
  const { root, programNext, dataTemplate, targetVersion } = assertMigrationReceipt(rootDir, receipt);
  const program = path.join(root, 'PROGRAM');
  const data = path.join(root, 'DATA');
  const updateRoot = path.join(root, '.update');
  const dataNext = path.join(updateRoot, 'DATA.next');
  assertDirectory(program, 'migration_source_program_missing');
  assertDirectory(data, 'migration_source_data_missing');


  const before = await hashManifest(data);
  const operationId = `migration-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const work = path.join(updateRoot, 'migration-work', operationId);
  const archivePath = path.join(work, 'source-migration.zip');
  const stagingRoot = path.join(work, 'import-staging');
  await fsp.rm(dataNext, { recursive: true, force: true });
  await fsp.rm(work, { recursive: true, force: true });
  await fsp.mkdir(work, { recursive: true, mode: 0o700 });

  try {
    logger('[migration 1/5] Release DATA template -> DATA.next');
    await fsp.cp(dataTemplate, dataNext, { recursive: true, force: false, errorOnExist: true });
    const endpointIdentity = await copyIdentityAndEndpoint(data, dataNext);

    logger('[migration 2/5] Candidate PROGRAM logical export of stopped legacy DATA');
    // The target release owns the migration-format reader for every source
    // version allowed by minimumSourceVersion. Do not execute an older
    // PROGRAM's exporter here: it may not recognize benign runtime entries
    // created by a newer server/updater contract and cannot be patched by the
    // release that is trying to migrate it.
    const sourceExporter = require(path.join(programNext, 'tools', 'portable_export_stopped.cjs'));
    const exported = await sourceExporter.exportStopped({ source: data, output: archivePath, version: versionFromProgram(program) });

    logger('[migration 3/5] New PROGRAM logical import');
    const logical = require(path.join(programNext, 'server', 'portable', 'logical_migration.cjs'));
    const expectedDatabaseSchemaVersion = readDatabaseSchemaVersion(programNext);
    const imported = await logical.importLogicalMigration({
      archivePath,
      backupRootManual: path.join(dataNext, 'backups', 'manual'),
      stagingRoot,
      expectedDatabaseSchemaVersion,
      requiredNamespaces: logical.NAMESPACES,
      expectedArchiveSha256: exported.sha256,
      serverVersion: targetVersion
    });

    logger('[migration 4/5] Offline restore into DATA.next');
    const nextServer = require(path.join(programNext, 'server', 'server.cjs'));
    const restored = nextServer.restoreBackupOffline({
      dataDir: dataNext,
      backupDir: path.join(dataNext, 'backups'),
      backupId: imported.backupId,
      namespaces: logical.NAMESPACES,
      reason: 'updater-migration-required'
    });
    if (!restored?.ok) throw new Error('migration_data_next_restore_failed');

    logger('[migration 5/5] DATA.next identity / source immutability verification');
    const nextId = dataInstanceId(dataNext);
    const sourceIdentity = identity.capture(data), nextIdentity = identity.capture(dataNext);
    if (nextId === sourceIdentity.dataInstanceId || nextIdentity.seedSha256 !== sourceIdentity.seedSha256) throw new Error('migration_data_identity_continuity_invalid');
    const after = await hashManifest(data);
    if (before.treeSha256 !== after.treeSha256 || before.fileCount !== after.fileCount || before.totalBytes !== after.totalBytes) {
      throw new Error('migration_source_data_changed');
    }
    const nextConfig = readJson(path.join(dataNext, 'config', 'server-config.json'), null);
    if (!nextConfig || nextConfig.host !== endpointIdentity.host || Number(nextConfig.port) !== endpointIdentity.port) throw new Error('migration_endpoint_identity_changed');

    return {
      operationId,
      dataNext,
      dataInstanceId: nextId,
      sourceTreeSha256: before.treeSha256,
      archivePath,
      archiveSha256: exported.sha256,
      importedBackupId: imported.backupId,
      migration: restored.result?.migration || null,
      targetDatabaseSchemaVersion: expectedDatabaseSchemaVersion
    };
  } catch (error) {
    await fsp.rm(dataNext, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

function relativeToRoot(root, filePath) {
  const rel = path.relative(root, filePath).split(path.sep).join('/');
  if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) throw new Error(`updater_path_outside_root:${filePath}`);
  return rel;
}

function absoluteFromRoot(root, relative) {
  const resolved = path.resolve(root, ...String(relative || '').split('/'));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('updater_journal_path_escape');
  return resolved;
}

function triggerFailpoint(name, env = process.env) {
  if (String(env.LIBRARIAN_UPDATER_FAILPOINT || '') === name) {
    const error = new Error(`updater_failpoint:${name}`);
    error.code = 'UPDATER_FAILPOINT';
    throw error;
  }
}

async function quarantineIfExists(source, destination) {
  if (!fs.existsSync(source)) return false;
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (fs.existsSync(destination)) throw new Error(`quarantine_destination_exists:${destination}`);
  await renameRetry(source, destination);
  return true;
}

async function assertProgramTree(programDir, version, expectedTree) {
  assertDirectory(programDir, 'migration_expected_program_missing');
  if (versionFromProgram(programDir) !== String(version)) throw new Error(`migration_program_version_mismatch:${versionFromProgram(programDir)}!=${version}`);
  if (expectedTree) {
    const actual = await hashManifest(programDir);
    if (actual.treeSha256 !== expectedTree) throw new Error('migration_program_tree_mismatch');
  }
}

async function assertDataTree(dataDir, expectedTree, expectedInstanceId) {
  assertDirectory(dataDir, 'migration_expected_data_missing');
  if (dataInstanceId(dataDir) !== String(expectedInstanceId)) throw new Error('migration_data_instance_mismatch');
  if (expectedTree) {
    const actual = await hashManifest(dataDir);
    if (actual.treeSha256 !== expectedTree) throw new Error('migration_data_tree_mismatch');
  }
}

function migrationPaths(root, journal) {
  const p = journal.paths || {};
  const id=String(journal.operationId||'');
  if(!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('updater_operation_id_invalid');
  const expected={rollbackRoot:`.rollback/${id}`,rollbackProgram:`.rollback/${id}/PROGRAM`,rollbackData:`.rollback/${id}/DATA`,
    failedRoot:`.update/failed-${id}`,programNext:'.update/PROGRAM.next',dataNext:'.update/DATA.next'};
  for(const [key,rel] of Object.entries(expected)){
    if(p[key]!==undefined&&p[key]!==rel) throw new Error(`updater_journal_path_invalid:${key}`);
    let current=root;
    for(const segment of rel.split('/')){current=path.join(current,segment);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw new Error('updater_journal_symlink_rejected');}
  }
  for(const name of ['PROGRAM','DATA','UPDATER']){const dir=path.join(root,name);if(fs.existsSync(dir)&&fs.lstatSync(dir).isSymbolicLink())throw new Error('updater_active_symlink_rejected');}
  return {
    program: path.join(root, 'PROGRAM'),
    data: path.join(root, 'DATA'),
    programNext: absoluteFromRoot(root, p.programNext || '.update/PROGRAM.next'),
    dataNext: absoluteFromRoot(root, p.dataNext || '.update/DATA.next'),
    rollbackRoot: absoluteFromRoot(root, p.rollbackRoot || expected.rollbackRoot),
    rollbackProgram: absoluteFromRoot(root, p.rollbackProgram || expected.rollbackProgram),
    rollbackData: absoluteFromRoot(root, p.rollbackData || expected.rollbackData),
    failedRoot: absoluteFromRoot(root, p.failedRoot || `.update/failed-${journal.operationId}`)
  };
}

function isCommitted(journal) {
  return !!journal?.committedAt || journal?.status === 'committed' || journal?.decision === 'commit';
}

function assertMigrationAuthorities(paths,journal) {
  if (!journal.sourceDataIdentity) throw new Error('migration_source_identity_binding_missing');
  if (isCommitted(journal) || journal.rollbackRestoredAt) return identity.assertBinding(paths.data,journal.dataIdentity);
  if(fs.existsSync(paths.data)) identity.assertOneOf(paths.data,[journal.sourceDataIdentity,journal.dataMoves?.promote?.target,journal.dataMoves?.restore?.target]);
  if(fs.existsSync(paths.rollbackData)) identity.assertBinding(paths.rollbackData,journal.dataMoves?.old?.target);
  if(!fs.existsSync(paths.data)&&!fs.existsSync(paths.rollbackData)) throw new Error('migration_source_data_missing');
  if(fs.existsSync(paths.dataNext)&&journal.nextDataIdentity) identity.assertBinding(paths.dataNext,journal.nextDataIdentity);
  const failedData=path.join(paths.failedRoot,'DATA');
  if(fs.existsSync(failedData)) identity.assertBinding(failedData,journal.dataMoves?.quarantine?.target);
}

async function finalizeMigrationDecision({ root, journalPath, journal, hooks = {}, logger = () => {} }) {
  identity.assertJournal(journal);
  const { program, data } = migrationPaths(root, journal);
  const health = hooks.fetchHealth || fetchHealth;
  const start = hooks.startServer || startServer;
  if (isCommitted(journal)) {
    await assertProgramTree(program, journal.toVersion, null);
    identity.assertBinding(data, journal.dataIdentity);
    if (journal.serverWasRunning) {
      const current = await health(data).catch(() => null) || await start(program, data, { verifyMode: false });
      identity.assertHealth(current,journal.dataIdentity,journal.toVersion,false);
    }
    const done = await writeJournal(journalPath, journal, { status: 'complete', phase: 'complete', completedAt: new Date().toISOString() });
    logger('migration_required 업데이트 완료');
    return done;
  }
  if (journal.rollbackRestoredAt) {
    await assertProgramTree(program, journal.fromVersion, null);
    identity.assertBinding(data, journal.dataIdentity);
    if (journal.serverWasRunning) {
      const current = await health(data).catch(() => null) || await start(program, data, { verifyMode: false });
      identity.assertHealth(current,journal.dataIdentity,journal.fromVersion,false);
    }
    const done = await writeJournal(journalPath, journal, { status: 'rolled_back', phase: 'rolled_back', rollbackOk: true, rolledBackAt: new Date().toISOString() });
    logger('migration_required 롤백 완료');
    return done;
  }
  throw new Error('migration_finalize_without_durable_decision');
}

async function rollbackMigrationRequired({ rootDir, journalPath = null, journal: supplied = null, logger = () => {}, failpointEnv = process.env, hooks = {} }) {
  const root = path.resolve(rootDir);
  const statePath = journalPathForRoot(root,journalPath);
  let journal = authoritativeJournal(statePath,supplied);
  if (!journal) throw new Error('migration_rollback_journal_missing');
  if (isTerminal(journal)) return journal;
  identity.assertJournal(journal);
  if (journal.policy !== 'migration_required') throw new Error(`migration_rollback_policy_invalid:${journal.policy}`);
  if (isCommitted(journal) || journal.rollbackRestoredAt) return finalizeMigrationDecision({ root, journalPath: statePath, journal, hooks, logger });
  const paths = migrationPaths(root, journal);
  assertMigrationAuthorities(paths, journal);
  const stop = hooks.stopServer || stopServerIfRunning;
  const controlData = fs.existsSync(paths.data) ? paths.data : (fs.existsSync(paths.rollbackData) ? paths.rollbackData : paths.dataNext);
  const stopProgram = fs.existsSync(paths.program) ? paths.program : (fs.existsSync(paths.rollbackProgram) ? paths.rollbackProgram : null);
  const before = await (hooks.fetchHealth || fetchHealth)(controlData).catch(()=>null);
  if(before && stopProgram) identity.assertHealth(before,identity.capture(controlData),versionFromProgram(stopProgram),before.maintenanceMode===true);
  if (stopProgram && fs.existsSync(controlData)) await stop(stopProgram, controlData);

  try {
    await fsp.mkdir(paths.failedRoot, { recursive: true, mode: 0o700 });
    if (fs.existsSync(paths.rollbackProgram)) {
      journal = await writeJournal(statePath, journal, { status: 'rollback', phase: 'intent_rollback_program_restore' });
      if (fs.existsSync(paths.program)) await quarantineIfExists(paths.program, path.join(paths.failedRoot, 'PROGRAM'));
      await renameRetry(paths.rollbackProgram, paths.program);
      triggerFailpoint('after_migration_rollback_program_restore', failpointEnv);
      journal = await writeJournal(statePath, journal, { phase: 'rollback_program_restored' });
    } else {
      await assertProgramTree(paths.program, journal.fromVersion, journal.fromProgramTreeSha256);
    }

    if (fs.existsSync(paths.rollbackData)) {
      if (!journal.dataMoves?.restore) {
        identity.assertBinding(paths.rollbackData, journal.dataMoves?.old?.target);
        const dataMoves = {...journal.dataMoves, restore:identity.planMove(paths.rollbackData, paths.data)};
        if(fs.existsSync(paths.data)) dataMoves.quarantine = identity.planMove(paths.data, path.join(paths.failedRoot,'DATA'));
        journal = await writeJournal(statePath, journal, { phase: 'intent_rollback_data_restore', dataMoves });
      }
      identity.assertBinding(paths.rollbackData, journal.dataMoves.restore.source);
      if(fs.existsSync(paths.data)) identity.assertBinding(paths.data, journal.dataMoves.quarantine.source);
      if (fs.existsSync(paths.data)) await quarantineIfExists(paths.data, path.join(paths.failedRoot, 'DATA'));
      await renameRetry(paths.rollbackData, paths.data);
      identity.assertBinding(paths.data, journal.dataMoves.restore.target);
      triggerFailpoint('after_migration_rollback_data_restore', failpointEnv);
      journal = await writeJournal(statePath, journal, { phase: 'rollback_data_restored', dataIdentity:journal.dataMoves.restore.target, dataInstanceId:journal.dataMoves.restore.target.dataInstanceId });
    } else {
      identity.assertBinding(paths.data, journal.sourceDataIdentity);
      journal = await writeJournal(statePath, journal, {dataIdentity:journal.sourceDataIdentity, dataInstanceId:journal.sourceDataIdentity.dataInstanceId});
      await assertDataTree(paths.data, journal.fromDataTreeSha256, journal.dataInstanceId);
    }

    await assertProgramTree(paths.program, journal.fromVersion, journal.fromProgramTreeSha256);
    await assertDataTree(paths.data, journal.fromDataTreeSha256, journal.dataInstanceId);
    await fsp.rm(paths.programNext, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(paths.dataNext, { recursive: true, force: true }).catch(() => {});
    journal = await writeJournal(statePath, journal, {
      status: 'rollback_restored', phase: 'rollback_restored', decision: 'rollback', rollbackRestoredAt: new Date().toISOString()
    });
    triggerFailpoint('after_migration_rollback_restored_decision', failpointEnv);
    return finalizeMigrationDecision({ root, journalPath: statePath, journal, hooks, logger });
  } catch (error) {
    await writeJournal(statePath, journal, { status: 'rollback_failed', phase: 'rollback_failed', rollbackOk: false, rollbackError: String(error?.message || error) }).catch(() => {});
    throw error;
  }
}

async function applyMigrationRequiredUnlocked({ rootDir, receipt, logger = () => {}, failpointEnv = process.env, hooks = {} }) {
  const { root, programNext, targetVersion } = assertMigrationReceipt(rootDir, receipt);
  const program = path.join(root, 'PROGRAM');
  const data = path.join(root, 'DATA');
  const updaterDir = path.join(root, 'UPDATER');
  const journalPath = path.join(updaterDir, 'update-state.json');
  const existing = readJournal(journalPath);
  if (existing && !isTerminal(existing)) throw new Error('unfinished_update_recovery_required');
  const dataIdentity = prepareFreshDataIdentity(data);
  const fromVersion = versionFromProgram(program);
  const operationId = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const rollbackRoot = path.join(root, '.rollback', operationId);
  const rollbackProgram = path.join(rollbackRoot, 'PROGRAM');
  const rollbackData = path.join(rollbackRoot, 'DATA');
  const failedRoot = path.join(root, '.update', `failed-${operationId}`);
  const dataNext = path.join(root, '.update', 'DATA.next');
  await fsp.mkdir(rollbackRoot, { recursive: true, mode: 0o700 });
  await syncDirectory(path.dirname(rollbackRoot));

  const fromProgram = await hashManifest(program);
  let journal = {
    schema: 'librarian.update-state.v1', engineRevision: identity.engineRevision, dataIdentityContract:identity.contract, dataIdentity, sourceDataIdentity:dataIdentity, operationId,
    status: 'running', phase: 'init', policy: 'migration_required', fromVersion, toVersion: targetVersion,
    startedAt: new Date().toISOString(), serverWasRunning: false, dataInstanceId: dataInstanceId(data),
    fromProgramTreeSha256: fromProgram.treeSha256, fromDataTreeSha256: null,
    flags: { migrationBuilt: false, programOldRenamed: false, dataOldRenamed: false, programNewActivated: false, dataNewActivated: false, candidateServerAttempted: false, candidateServerStarted: false, candidateVerified: false },
    paths: {
      rollbackRoot: relativeToRoot(root, rollbackRoot), rollbackProgram: relativeToRoot(root, rollbackProgram), rollbackData: relativeToRoot(root, rollbackData),
      failedRoot: relativeToRoot(root, failedRoot), programNext: relativeToRoot(root, programNext), dataNext: relativeToRoot(root, dataNext)
    }
  };
  const health = hooks.fetchHealth || fetchHealth;
  const stop = hooks.stopServer || stopServerIfRunning;
  const build = hooks.buildDataNext || buildMigratedDataNext;
  const start = hooks.startServer || startServer;
  const integrity = hooks.integrity || runIntegrity;
  const initialHealth = await health(data).catch(() => null);
  if(initialHealth) identity.assertHealth(initialHealth,dataIdentity,fromVersion,false);
  journal.serverWasRunning = !!initialHealth;
  journal = await writeJournal(journalPath, null, journal);

  try {
    logger('[1/9] 기존 서버 정지');
    const stopped = await stop(program, data);
    const stoppedData = await hashManifest(data);
    journal = await writeJournal(journalPath, journal, {
      phase: 'server_stopped',
      serverWasRunning: journal.serverWasRunning || stopped?.wasRunning === true,
      fromDataTreeSha256: stoppedData.treeSha256
    });
    triggerFailpoint('after_migration_server_stop', failpointEnv);

    logger('[2/9] DATA.next 논리 마이그레이션 생성');
    journal = await writeJournal(journalPath, journal, { phase: 'migration_building' });
    const built = await build({ rootDir: root, receipt, logger });
    if (path.resolve(built.dataNext || dataNext) !== dataNext) throw new Error('migration_data_next_result_path_invalid');
    const nextDataIdentity = identity.capture(dataNext);
    if (String(built.dataInstanceId || '') !== nextDataIdentity.dataInstanceId || nextDataIdentity.seedSha256 !== journal.sourceDataIdentity.seedSha256) throw new Error('migration_built_data_identity_mismatch');
    journal.flags.migrationBuilt = true;
    journal = await writeJournal(journalPath, journal, { phase: 'migration_built', nextDataIdentity, flags: journal.flags, migrationReceipt: { archiveSha256: built.archiveSha256 || null, importedBackupId: built.importedBackupId || null, targetDatabaseSchemaVersion: built.targetDatabaseSchemaVersion || null } });
    triggerFailpoint('after_migration_data_next', failpointEnv);


    logger('[3/9] 기존 PROGRAM 보관');
    journal = await writeJournal(journalPath, journal, { phase: 'intent_program_old_rename' });
    await renameRetry(program, rollbackProgram);
    journal.flags.programOldRenamed = true;
    journal = await writeJournal(journalPath, journal, { phase: 'program_old_renamed', flags: journal.flags });
    triggerFailpoint('after_migration_program_old_rename', failpointEnv);

    logger('[4/9] 기존 DATA 보관');
    identity.assertBinding(data, journal.sourceDataIdentity);
    journal = await writeJournal(journalPath, journal, { phase: 'intent_data_old_rename', dataMoves:{...journal.dataMoves, old:identity.planMove(data, rollbackData)} });
    await renameRetry(data, rollbackData);
    identity.assertBinding(rollbackData, journal.dataMoves.old.target);
    journal.flags.dataOldRenamed = true;
    journal = await writeJournal(journalPath, journal, { phase: 'data_old_renamed', flags: journal.flags });
    triggerFailpoint('after_migration_data_old_rename', failpointEnv);

    logger('[5/9] 새 PROGRAM 활성화');
    journal = await writeJournal(journalPath, journal, { phase: 'intent_program_new_activate' });
    await renameRetry(programNext, program);
    journal.flags.programNewActivated = true;
    journal = await writeJournal(journalPath, journal, { phase: 'program_new_activated', flags: journal.flags });
    triggerFailpoint('after_migration_program_new_activate', failpointEnv);

    logger('[6/9] 새 DATA 활성화');
    identity.assertBinding(dataNext, journal.nextDataIdentity);
    journal = await writeJournal(journalPath, journal, { phase: 'intent_data_new_activate', dataMoves:{...journal.dataMoves, promote:identity.planMove(dataNext, data)} });
    await renameRetry(dataNext, data);
    identity.assertBinding(data, journal.dataMoves.promote.target);
    journal.flags.dataNewActivated = true;
    journal = await writeJournal(journalPath, journal, { phase: 'data_new_activated', flags: journal.flags, dataIdentity:journal.dataMoves.promote.target, dataInstanceId:journal.dataMoves.promote.target.dataInstanceId });
    triggerFailpoint('after_migration_data_new_activate', failpointEnv);

    logger('[7/9] 새 PROGRAM/DATA 쌍 검증 서버 기동');
    journal.flags.candidateServerAttempted = true;
    journal = await writeJournal(journalPath, journal, { phase: 'intent_candidate_start', flags: journal.flags });
    const candidate = await start(program, data, { verifyMode: true });
    journal.flags.candidateServerStarted = true;
    journal = await writeJournal(journalPath, journal, { phase: 'candidate_started', flags: journal.flags });
    if (String(candidate?.version || '') !== String(targetVersion)) throw new Error(`candidate_version_mismatch:${candidate?.version}!=${targetVersion}`);
    if (String(candidate?.dataInstanceId || '') !== String(journal.dataInstanceId)) throw new Error('candidate_data_identity_mismatch');
    if (candidate?.maintenanceMode !== true) throw new Error('candidate_verify_mode_not_active');
    identity.assertHealth(candidate,journal.dataIdentity,targetVersion,true);
    triggerFailpoint('after_migration_candidate_start', failpointEnv);

    logger('[8/9] 새 DATA integrity/readback 확인');
    await integrity(program, data);
    journal.flags.candidateVerified = true;
    journal = await writeJournal(journalPath, journal, { phase: 'candidate_verified', flags: journal.flags });
    triggerFailpoint('after_migration_candidate_verify', failpointEnv);
    await stop(program, data);

    logger('[9/9] PROGRAM/DATA pair commit');
    journal = await writeJournal(journalPath, journal, { status: 'committed', phase: 'committed', decision: 'commit', committedAt: new Date().toISOString(), flags: journal.flags });
    triggerFailpoint('after_migration_commit', failpointEnv);
    return finalizeMigrationDecision({ root, journalPath, journal, hooks, logger });
  } catch (error) {
    logger(`migration_required 업데이트 실패: ${String(error?.message || error)}`);
    journal = readJournal(journalPath) || journal;
    if (isCommitted(journal)) throw error;
    try { await rollbackMigrationRequired({ rootDir: root, journalPath, journal, logger, failpointEnv, hooks }); }
    catch (rollbackError) {
      const aggregate = new Error(`migration_update_failed_and_rollback_failed:${String(error?.message || error)} | ${String(rollbackError?.message || rollbackError)}`);
      aggregate.cause = rollbackError;
      throw aggregate;
    }
    throw error;
  }
}

async function recoverInterruptedMigrationRequiredUnlocked({ rootDir, logger = () => {}, hooks = {} }) {
  const root = path.resolve(rootDir);
  const journalPath = path.join(root, 'UPDATER', 'update-state.json');
  const journal = readJournal(journalPath);
  if (!journal || isTerminal(journal)) return { recovered: false, reason: 'no_pending_update', journal };
  identity.assertJournal(journal);
  if (journal.policy !== 'migration_required') throw new Error(`unsupported_recovery_policy:${journal.policy}`);
  const result = isCommitted(journal) || journal.rollbackRestoredAt
    ? await finalizeMigrationDecision({ root, journalPath, journal, hooks, logger })
    : await rollbackMigrationRequired({ rootDir: root, journalPath, journal, hooks, logger });
  return { recovered: true, journal: result };
}

module.exports = {
  assertMigrationReceipt,
  buildMigratedDataNext,
  readDatabaseSchemaVersion,
  copyIdentityAndEndpoint,
  applyMigrationRequired: async options => { const j=pendingIdentityPreflight(options.rootDir); if(j&&!isTerminal(j)) throw new Error('unfinished_update_recovery_required'); assertFreshDataInputs(path.join(path.resolve(options.rootDir),'DATA')); return withUpdateLock(options.rootDir, () => applyMigrationRequiredUnlocked(options)); },
  rollbackMigrationRequired: async options => { journalPathForRoot(options.rootDir,options.journalPath); const j=pendingIdentityPreflight(options.rootDir,options.journal); if(j&&isTerminal(j)) return j; if(j) assertMigrationAuthorities(migrationPaths(path.resolve(options.rootDir),j),j); return withUpdateLock(options.rootDir, () => rollbackMigrationRequired(options)); },
  recoverInterruptedMigrationRequired: async options => { const j=pendingIdentityPreflight(options.rootDir); if(!j||isTerminal(j)) return {recovered:false,reason:'no_pending_update',journal:j}; assertMigrationAuthorities(migrationPaths(path.resolve(options.rootDir),j),j); return withUpdateLock(options.rootDir, () => recoverInterruptedMigrationRequiredUnlocked(options)); },
  isCommitted
};
