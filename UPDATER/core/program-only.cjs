'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { createDataCheckpoint, verifyDataCheckpoint, hashManifest } = require('./checkpoint.cjs');
const { readJournal, writeJournal, isTerminal, syncDirectory } = require('./journal.cjs');
const identity = require('./data-identity.cjs');

const { withUpdateLock } = require('./lock.cjs');
const { assertWmUpdateAdmission } = require('./wm-update-admission.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function versionFromProgram(programDir) {
  return fs.readFileSync(path.join(programDir, 'VERSION.txt'), 'utf8').trim().replace(/^v/i, '');
}

function dataInstanceId(dataDir) {
  return identity.readDataInstanceIdentity(dataDir).dataInstanceId;
}

function assertFreshDataInputs(data) {
  // Authentication validation precedes the explicit one-time seed bootstrap.
  // Existing partial/corrupt seeds are never repaired here.
  const token = fs.readFileSync(path.join(data, 'runtime-token.txt'), 'utf8').trim();
  if (token.length < 32) throw new Error('data_runtime_token_invalid');
  if (fs.existsSync(identity.identityPath(data))) identity.readDataInstanceIdentity(data);
}

function prepareFreshDataIdentity(data) {
  assertFreshDataInputs(data);
  identity.ensureDataInstanceIdentity(data);
  return identity.capture(data);
}

function pendingIdentityPreflight(rootDir, supplied) {
  const journal = authoritativeJournal(path.join(path.resolve(rootDir), 'UPDATER', 'update-state.json'),supplied);
  if (journal && !isTerminal(journal)) identity.assertJournal(journal);
  return journal;
}

function authoritativeJournal(journalPath,supplied) {
  const journal=readJournal(journalPath);
  if(supplied&&!journal) throw Object.assign(new Error('updater_durable_journal_required'),{code:'UPDATER_DURABLE_JOURNAL_REQUIRED'});
  if(supplied&&journal.operationId!==supplied.operationId) throw Object.assign(new Error('updater_journal_operation_conflict'),{code:'UPDATER_JOURNAL_OPERATION_CONFLICT'});
  // An in-memory snapshot never overrides a newer durable decision or legacy
  // admission boundary, even when it names the same operation and DATA inode.
  return journal;
}
function journalPathForRoot(rootDir,suppliedPath) {
  const expected=path.join(path.resolve(rootDir),'UPDATER','update-state.json');
  if(suppliedPath && path.resolve(suppliedPath)!==expected) throw Object.assign(new Error('updater_journal_path_invalid'),{code:'UPDATER_JOURNAL_PATH_INVALID'});
  return expected;
}

function readConfig(dataDir) {
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'server-config.json'), 'utf8'));
  const host = ['127.0.0.1','localhost','::1'].includes(String(config.host || '')) ? String(config.host) : '127.0.0.1';
  const renderedHost = host === '::1' ? '[::1]' : host;
  return { ...config, url: `http://${renderedHost}:${Number(config.port || 47630)}` };
}

async function fetchHealth(dataDir, timeoutMs = 1500) {
  const config = readConfig(dataDir);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
  try {
    const response = await fetch(`${config.url}/health`, { signal: controller.signal });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.ok === true ? payload : null;
  } catch (_) { return null; }
  finally { clearTimeout(timer); }
}

function runLauncher(programDir, command, dataDir, options = {}) {
  const launcher = path.join(programDir, 'tools', 'platform_launcher.cjs');
  if (!fs.existsSync(launcher)) throw new Error(`platform_launcher_missing:${launcher}`);
  const result = spawnSync(process.execPath, ['--no-warnings', launcher, command, '--data-dir', dataDir], {
    cwd: programDir,
    encoding: 'utf8',
    timeout: options.timeoutMs || 30000,
    env: { ...process.env, LIBRARIAN_UPDATER_INTERNAL: '1', ...(options.env || {}) }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(String(result.stderr || result.stdout || `launcher_${command}_failed:${result.status}`).trim());
    error.code = `UPDATER_LAUNCHER_${String(command).toUpperCase()}_FAILED`;
    error.exitCode = result.status;
    throw error;
  }
  return result;
}

async function portIsClosed(dataDir, timeoutMs = 700) {
  const config = readConfig(dataDir);
  const endpoint = new URL(config.url);
  return new Promise(resolve => {
    let settled = false;
    const socket = net.createConnection({host:endpoint.hostname.replace(/^\[|\]$/g,''),port:Number(endpoint.port)});
    const finish = closed => {if (settled) return; settled=true; socket.destroy(); resolve(closed);};
    socket.setTimeout(timeoutMs,()=>finish(false));
    socket.once('connect',()=>finish(false));
    socket.once('error',error=>finish(error.code === 'ECONNREFUSED'));
  });
}

async function waitForOffline(dataDir, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await fetchHealth(dataDir, 500)) && await portIsClosed(dataDir)) return true;
    await delay(120);
  }
  return false;
}

async function stopServerIfRunning(programDir, dataDir) {
  const before = await fetchHealth(dataDir, 1200);
  if (!before) {
    if (!(await portIsClosed(dataDir))) throw new Error('server_unhealthy_or_unverified');
    return { wasRunning: false, health: null };
  }
  identity.assertHealth(before,identity.capture(dataDir),versionFromProgram(programDir),before.maintenanceMode===true);
  runLauncher(programDir, 'stop', dataDir, { timeoutMs: 10000 });
  if (!(await waitForOffline(dataDir, 10000))) throw new Error('server_stop_not_confirmed');
  return { wasRunning: true, health: before };
}

async function startServer(programDir, dataDir, { verifyMode = false } = {}) {
  runLauncher(programDir, 'background', dataDir, {
    timeoutMs: 25000,
    env: { LIBRARIAN_UPDATER_VERIFY_MODE: verifyMode ? '1' : '0' }
  });
  const health = await fetchHealth(dataDir, 3000);
  if (!health) throw new Error('server_start_health_unavailable');
  return health;
}

function runIntegrity(programDir, dataDir) {
  return runLauncher(programDir, 'integrity', dataDir, { timeoutMs: 180000 });
}

async function renameRetry(source, destination, attempts = 12) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { await fsp.rename(source, destination); last = null; break; }
    catch (error) {
      last = error;
      if (!['EPERM','EACCES','EBUSY','ENOTEMPTY'].includes(String(error?.code || ''))) throw error;
      await delay(100 + attempt * 80);
    }
  }
  if (last) throw last;
  await syncDirectory(path.dirname(source));
  if (path.dirname(source) !== path.dirname(destination)) await syncDirectory(path.dirname(destination));
}

async function quarantineIfExists(source, destination) {
  if (!fs.existsSync(source)) return false;
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (fs.existsSync(destination)) throw new Error(`quarantine_destination_exists:${destination}`);
  await renameRetry(source, destination);
  return true;
}

function relativeToRoot(root, filePath) {
  const rel = path.relative(root, filePath).split(path.sep).join('/');
  if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) throw new Error(`updater_path_outside_root:${filePath}`);
  return rel;
}

function absoluteFromRoot(root, relative) {
  const resolved = path.resolve(root, ...String(relative || '').split('/'));
  if (resolved !== path.resolve(root) && !resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('updater_journal_path_escape');
  return resolved;
}

function triggerFailpoint(name, env = process.env) {
  if (String(env.LIBRARIAN_UPDATER_FAILPOINT || '') === name) {
    const error = new Error(`updater_failpoint:${name}`);
    error.code = 'UPDATER_FAILPOINT';
    throw error;
  }
}

function operationPaths(root, journal) {
  const id = String(journal?.operationId || '');
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('updater_operation_id_invalid');
  const expected = {rollbackRoot: `.rollback/${id}`, rollbackProgram: `.rollback/${id}/PROGRAM`,
    checkpointRoot: `.rollback/${id}/DATA-checkpoint`, programNext: '.update/PROGRAM.next'};
  for (const [key, rel] of Object.entries(expected)) {
    if (journal.paths?.[key] !== rel) throw new Error(`updater_journal_path_invalid:${key}`);
    // Reject symlinked ancestors before destructive operations.
    let current = root;
    for (const segment of rel.split('/')) {
      current = path.join(current, segment);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('updater_journal_symlink_rejected');
    }
  }
  for (const name of ['PROGRAM', 'DATA', 'UPDATER']) {
    const target = path.join(root, name);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('updater_active_symlink_rejected');
  }
  const failed = path.join(root,'.update',`failed-${id}`);
  if(fs.existsSync(failed)&&fs.lstatSync(failed).isSymbolicLink()) throw new Error('updater_journal_symlink_rejected');
  return {program:path.join(root,'PROGRAM'), data:path.join(root,'DATA'),
    failedRoot:path.join(root,'.update',`failed-${id}`),
    rollbackProgram:absoluteFromRoot(root,expected.rollbackProgram),
    checkpointRoot:absoluteFromRoot(root,expected.checkpointRoot)};
}

async function assertProgramIdentity(program, version, expectedTree = null) {
  if (!fs.existsSync(program)) throw new Error('rollback_program_copy_missing');
  if (versionFromProgram(program) !== String(version)) throw new Error('recovery_program_version_mismatch');
  if (expectedTree && (await hashManifest(program)).treeSha256 !== expectedTree) throw new Error('recovery_program_tree_mismatch');
}

function isCommitted(journal) {
  return journal?.decision === 'commit' || !!journal?.committedAt;
}

function assertProgramDataAuthorities(root, journal) {
  const {data,failedRoot,checkpointRoot} = operationPaths(root,journal);
  if (isCommitted(journal) || journal.rollbackRestoredAt) return identity.assertBinding(data,journal.dataIdentity);
  if (fs.existsSync(data)) identity.assertOneOf(data,[journal.dataIdentity,journal.dataMoves?.restore?.target]);
  else if (!journal.dataMoves?.restore) throw new Error('rollback_data_move_intent_missing');
  const checkpointData = path.join(checkpointRoot,'DATA');
  if (fs.existsSync(checkpointData) && journal.flags?.checkpointCreated) identity.assertBinding(checkpointData,journal.checkpointDataIdentity);
  const failedData = path.join(failedRoot,'DATA');
  if (fs.existsSync(failedData)) identity.assertBinding(failedData,journal.dataMoves?.quarantine?.target);
}

// These are forward-only finalization paths. They NEVER restore a checkpoint.
// A server may have accepted user writes after the durable decision, even when
// startup/health reporting or the final journal write subsequently failed.
async function finalizeDecision({root, journalPath, journal, start = startServer, logger = () => {}}) {
  identity.assertJournal(journal);
  const {program, data} = operationPaths(root, journal);
  const committed = isCommitted(journal);
  const version = committed ? journal.toVersion : journal.fromVersion;
  await assertProgramIdentity(program, version);
  identity.assertBinding(data, journal.dataIdentity);
  try {
    if (journal.serverWasRunning === true) {
      let live = await fetchHealth(data);
      if (!live) live = await start(program, data, {verifyMode:false});
      if (String(live.version || '') !== String(version)) throw new Error('final_server_version_mismatch');
      if (String(live.dataInstanceId || '') !== journal.dataInstanceId) throw new Error('final_server_data_identity_mismatch');
      if (live.maintenanceMode === true) throw new Error('final_server_still_in_maintenance');
      identity.assertHealth(live,journal.dataIdentity,version,false);
    }
    const now = new Date().toISOString();
    journal = await writeJournal(journalPath, journal, committed
      ? {status:'complete',phase:'complete',completedAt:now}
      : {status:'rolled_back',phase:'rolled_back',rolledBackAt:now,rollbackOk:true});
    logger(committed ? `업데이트 완료: ${journal.fromVersion} → ${journal.toVersion}` : '[ROLLBACK] 이전 버전 복구 완료');
    return journal;
  } catch (error) {
    await writeJournal(journalPath, journal, {
      status:committed ? 'committed_restart_failed' : 'rollback_restart_failed',
      phase:committed ? 'committed_restart_failed' : 'rollback_restart_failed',
      restartError:String(error?.message || error)
    }).catch(() => {});
    throw error;
  }
}

async function rollbackProgramOnly({ rootDir, journalPath, journal: supplied = null, logger = () => {} }) {
  const root = path.resolve(rootDir);
  journalPath=journalPathForRoot(root,journalPath);
  let journal = authoritativeJournal(journalPath,supplied);
  if (!journal || isTerminal(journal)) return journal;
  identity.assertJournal(journal);
  if (isCommitted(journal)) throw new Error('committed_update_rollback_forbidden');
  if (journal.rollbackRestoredAt) return finalizeDecision({root,journalPath,journal,logger});
  const {program,data,failedRoot,rollbackProgram,checkpointRoot} = operationPaths(root, journal);
  // Validate every extant authority before journal writes or server control.
  assertProgramDataAuthorities(root,journal);
  const failedData = path.join(failedRoot, 'DATA');
  const originalPhase = String(journal.phase || '');
  const controls = [data,path.join(checkpointRoot,'DATA'),failedData];
  const controlData = controls.find(dir=>fs.existsSync(path.join(dir,'config','server-config.json')));
  if(!controlData) throw new Error('rollback_server_control_data_missing');
  const before = await fetchHealth(controlData);
  const stopProgram = fs.existsSync(program) ? program : (fs.existsSync(rollbackProgram) ? rollbackProgram : null);
  if(before && stopProgram) identity.assertHealth(before,identity.capture(controlData),versionFromProgram(stopProgram),before.maintenanceMode===true);
  journal = await writeJournal(journalPath, journal, {status:'rollback',phase:'rollback_started',rollbackStartedAt:journal.rollbackStartedAt || new Date().toISOString()});
  logger('[ROLLBACK] journal과 실제 폴더를 대조하여 이전 PROGRAM / DATA를 복구합니다.');
  try {
    if (stopProgram) await stopServerIfRunning(stopProgram, controlData);
    if (!(await waitForOffline(controlData,4000))) throw new Error('rollback_server_still_online');

    // The backup's presence is authoritative even when the completion flag was
    // never persisted. Its absence is acceptable ONLY if the old tree is back.
    if (fs.existsSync(rollbackProgram)) await assertProgramIdentity(rollbackProgram,journal.fromVersion,journal.fromProgramTreeSha256);
    else await assertProgramIdentity(program,journal.fromVersion,journal.fromProgramTreeSha256);

    const needsData = journal.flags?.candidateServerAttempted === true || journal.flags?.candidateServerStarted === true
      || journal.flags?.programNewActivated === true || !fs.existsSync(data)
      || /candidate|program_new_activated/.test(originalPhase);
    let checkpoint = null;
    if (needsData) {
      if (fs.existsSync(path.join(checkpointRoot,'DATA'))) checkpoint = await verifyDataCheckpoint(checkpointRoot);
      else {
        // DATA rename completed but the journal write did not. Check the full
        // manifest, not merely the token, before accepting the restored tree.
        await verifyDataCheckpoint(checkpointRoot,data);
      }
    }
    await fsp.mkdir(failedRoot,{recursive:true,mode:0o700});
    if (fs.existsSync(rollbackProgram)) {
      journal = await writeJournal(journalPath,journal,{phase:'intent_rollback_program_restore'});
      if (fs.existsSync(program)) await quarantineIfExists(program,path.join(failedRoot,'PROGRAM'));
      await renameRetry(rollbackProgram,program);
      journal = await writeJournal(journalPath,journal,{phase:'rollback_program_restored'});
    }
    if (checkpoint) {
      if (!journal.dataMoves?.restore) {
        identity.assertBinding(checkpoint.dataPath, journal.checkpointDataIdentity);
        const dataMoves = {...journal.dataMoves, restore:identity.planMove(checkpoint.dataPath, data)};
        if (fs.existsSync(data)) dataMoves.quarantine = identity.planMove(data, failedData);
        journal = await writeJournal(journalPath,journal,{phase:'intent_rollback_data_restore', dataMoves});
      }
      identity.assertBinding(checkpoint.dataPath, journal.dataMoves.restore.source);
      if (fs.existsSync(data)) identity.assertBinding(data, journal.dataMoves.quarantine.source);
      if (fs.existsSync(data)) await quarantineIfExists(data,path.join(failedRoot,'DATA'));
      await renameRetry(checkpoint.dataPath,data);
      identity.assertBinding(data, journal.dataMoves.restore.target);
      await verifyDataCheckpoint(checkpointRoot,data);
      journal = await writeJournal(journalPath,journal,{phase:'rollback_data_restored', dataIdentity:journal.dataMoves.restore.target, dataInstanceId:journal.dataMoves.restore.target.dataInstanceId});
    }
    if (!checkpoint && journal.dataMoves?.restore) {
      identity.assertBinding(data, journal.dataMoves.restore.target);
      journal = await writeJournal(journalPath,journal,{dataIdentity:journal.dataMoves.restore.target, dataInstanceId:journal.dataMoves.restore.target.dataInstanceId});
    }
    await assertProgramIdentity(program,journal.fromVersion,journal.fromProgramTreeSha256);
    identity.assertBinding(data, journal.dataIdentity);
    // Must precede restarting the old writable server. Subsequent recoveries
    // resume startup, rather than re-copying an old snapshot over newer writes.
    journal = await writeJournal(journalPath,journal,{status:'rollback_restored',phase:'rollback_restored',rollbackRestoredAt:new Date().toISOString()});
  } catch (error) {
    await writeJournal(journalPath,journal,{status:'rollback_failed',phase:'rollback_failed',rollbackOk:false,rollbackError:String(error?.message||error)}).catch(()=>{});
    throw error;
  }
  return finalizeDecision({root,journalPath,journal,logger});
}

async function applyProgramOnly({ rootDir, receipt, logger = () => {}, failpointEnv = process.env, hooks = {} }) {
  const root = path.resolve(rootDir);
  const program = path.join(root, 'PROGRAM');
  const data = path.join(root, 'DATA');
  const updaterDir = path.join(root, 'UPDATER');
  const journalPath = path.join(updaterDir, 'update-state.json');
  if (readJournal(journalPath) && !isTerminal(readJournal(journalPath))) throw new Error('unfinished_update_recovery_required');
  if (String(receipt?.updatePolicy || '') !== 'program_only') throw new Error(`program_only_policy_required:${receipt?.updatePolicy || 'missing'}`);
  const programNext = path.resolve(String(receipt.programNext || ''));
  if (programNext !== path.join(root,'.update','PROGRAM.next')) throw new Error('program_next_path_invalid');
  if (!fs.existsSync(programNext) || !fs.statSync(programNext).isDirectory()) throw new Error('program_next_missing');
  const fromVersion = versionFromProgram(program);
  const toVersion = String(receipt.targetVersion || versionFromProgram(programNext));
  if (versionFromProgram(programNext) !== toVersion) throw new Error('program_next_version_mismatch');
  assertWmUpdateAdmission(data, 'program_only');
  const dataIdentity = prepareFreshDataIdentity(data);
  const operationId = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const rollbackRoot = path.join(root, '.rollback', operationId);
  const rollbackProgram = path.join(rollbackRoot, 'PROGRAM');
  const checkpointRoot = path.join(rollbackRoot, 'DATA-checkpoint');
  await fsp.mkdir(rollbackRoot, { recursive: true, mode: 0o700 });
  await syncDirectory(path.dirname(rollbackRoot));

  let journal = {
    schema: 'librarian.update-state.v1', engineRevision: identity.engineRevision, dataIdentityContract:identity.contract, dataIdentity, operationId, status: 'running', phase: 'init',
    fromVersion, toVersion, policy: 'program_only', startedAt: new Date().toISOString(),
    serverWasRunning: false, dataInstanceId: dataInstanceId(data),
    flags: { checkpointCreated: false, programOldRenamed: false, programNewActivated: false, candidateServerAttempted: false, candidateServerStarted: false, candidateVerified: false },
    paths: {
      rollbackRoot: relativeToRoot(root, rollbackRoot),
      rollbackProgram: relativeToRoot(root, rollbackProgram),
      checkpointRoot: relativeToRoot(root, checkpointRoot),
      programNext: relativeToRoot(root, programNext)
    }
  };
  operationPaths(root,journal);
  journal.fromProgramTreeSha256 = (await hashManifest(program)).treeSha256;
  const initialHealth = await fetchHealth(data);
  if (initialHealth) identity.assertHealth(initialHealth,dataIdentity,fromVersion,false);
  journal.serverWasRunning = !!initialHealth;
  journal = await writeJournal(journalPath, null, journal);

  const stop = hooks.stopServer || stopServerIfRunning;
  const checkpoint = hooks.createCheckpoint || createDataCheckpoint;
  const start = hooks.startServer || startServer;
  const integrity = hooks.integrity || runIntegrity;

  try {
    logger('[1/7] 현재 서버 정지 및 DATA write 종료 확인');
    const stopped = await stop(program, data);
    journal = await writeJournal(journalPath, journal, { phase: 'server_stopped', serverWasRunning: journal.serverWasRunning || stopped.wasRunning === true });
    assertWmUpdateAdmission(data, 'program_only');
    triggerFailpoint('after_server_stop', failpointEnv);

    logger('[2/7] DATA safety checkpoint 생성');
    await checkpoint({ dataDir: data, checkpointDir: checkpointRoot });
    journal.checkpointDataIdentity = identity.capture(path.join(checkpointRoot, 'DATA'));
    journal.flags.checkpointCreated = true;
    journal = await writeJournal(journalPath, journal, { phase: 'data_checkpointed', flags: journal.flags, checkpointDataIdentity:journal.checkpointDataIdentity });
    triggerFailpoint('after_data_checkpoint', failpointEnv);

    assertWmUpdateAdmission(data, 'program_only');
    logger('[3/7] 기존 PROGRAM rollback 사본으로 전환');
    journal = await writeJournal(journalPath, journal, { phase: 'intent_program_old_rename' });
    await renameRetry(program, rollbackProgram);
    journal.flags.programOldRenamed = true;
    journal = await writeJournal(journalPath, journal, { phase: 'program_old_renamed', flags: journal.flags });
    triggerFailpoint('after_program_old_rename', failpointEnv);

    logger('[4/7] 새 PROGRAM 활성화');
    journal = await writeJournal(journalPath, journal, { phase: 'intent_program_new_activate' });
    await renameRetry(programNext, program);
    journal.flags.programNewActivated = true;
    journal = await writeJournal(journalPath, journal, { phase: 'program_new_activated', flags: journal.flags });
    triggerFailpoint('after_program_new_activate', failpointEnv);

    logger('[5/7] 새 서버를 검증 모드로 기동');
    journal.flags.candidateServerAttempted = true;
    journal = await writeJournal(journalPath, journal, { phase: 'intent_candidate_start', flags: journal.flags });
    const candidateHealth = await start(program, data, { verifyMode: true });
    journal.flags.candidateServerStarted = true;
    journal = await writeJournal(journalPath, journal, { phase: 'candidate_started', flags: journal.flags });
    if (String(candidateHealth.version || '') !== toVersion) throw new Error(`candidate_version_mismatch:${candidateHealth.version}!=${toVersion}`);
    if (String(candidateHealth.dataInstanceId || '') !== String(journal.dataInstanceId)) throw new Error('candidate_data_identity_mismatch');
    if (candidateHealth.maintenanceMode !== true) throw new Error('candidate_verify_mode_not_active');
    identity.assertHealth(candidateHealth,journal.dataIdentity,toVersion,true);
    triggerFailpoint('after_candidate_start', failpointEnv);

    logger('[6/7] DATA integrity / readback 확인');
    await integrity(program, data);
    journal.flags.candidateVerified = true;
    journal = await writeJournal(journalPath, journal, { phase: 'candidate_verified', flags: journal.flags });
    triggerFailpoint('after_candidate_verify', failpointEnv);
    await stop(program, data);

    logger('[7/7] 업데이트 확정 및 서버 상태 복원');
    journal = await writeJournal(journalPath, journal, {
      status:'committed', phase:'committed', decision:'commit',
      committedAt:new Date().toISOString(), flags:journal.flags
    });
    return await finalizeDecision({root,journalPath,journal,start,logger});
  } catch (error) {
    logger(`업데이트 실패: ${String(error?.message || error)}`);
    journal = readJournal(journalPath) || journal;
    if (isCommitted(journal)) {
      logger('업데이트는 확정되었습니다. 새 DATA는 유지하고 서버 재기동만 재시도해야 합니다.');
      throw error;
    }
    try { await rollbackProgramOnly({ rootDir: root, journalPath, journal, logger }); }
    catch (rollbackError) {
      const aggregate = new Error(`update_failed_and_rollback_failed:${String(error?.message || error)} | ${String(rollbackError?.message || rollbackError)}`);
      aggregate.cause = rollbackError;
      throw aggregate;
    }
    throw error;
  }
}

async function recoverInterruptedProgramOnly({ rootDir, logger = () => {} }) {
  const root = path.resolve(rootDir);
  const journalPath = path.join(root, 'UPDATER', 'update-state.json');
  const journal = readJournal(journalPath);
  if (!journal || isTerminal(journal)) return { recovered: false, reason: 'no_pending_update', journal };
  identity.assertJournal(journal);
  if (journal.policy !== 'program_only') throw new Error(`unsupported_recovery_policy:${journal.policy}`);
  const rolled = isCommitted(journal) || journal.rollbackRestoredAt
    ? await finalizeDecision({root,journalPath,journal,logger})
    : await rollbackProgramOnly({ rootDir: root, journalPath, journal, logger });
  return { recovered: true, journal: rolled };
}

module.exports = {
  versionFromProgram, dataInstanceId, assertFreshDataInputs, prepareFreshDataIdentity, pendingIdentityPreflight, authoritativeJournal, journalPathForRoot, readConfig, fetchHealth, runLauncher, waitForOffline,
  stopServerIfRunning, startServer, runIntegrity, renameRetry,
  applyProgramOnly: async options => { const j=pendingIdentityPreflight(options.rootDir); if(j&&!isTerminal(j)) throw new Error('unfinished_update_recovery_required'); assertFreshDataInputs(path.join(path.resolve(options.rootDir),'DATA')); return withUpdateLock(options.rootDir, () => applyProgramOnly(options)); },
  rollbackProgramOnly: async options => { journalPathForRoot(options.rootDir,options.journalPath); const j=pendingIdentityPreflight(options.rootDir,options.journal); if(!j||isTerminal(j)) return j; if(isCommitted(j)) throw new Error('committed_update_rollback_forbidden'); assertProgramDataAuthorities(path.resolve(options.rootDir),j); return withUpdateLock(options.rootDir, () => rollbackProgramOnly(options)); },
  recoverInterruptedProgramOnly: async options => { const j=pendingIdentityPreflight(options.rootDir); if(!j||isTerminal(j)) return {recovered:false,reason:'no_pending_update',journal:j}; assertProgramDataAuthorities(path.resolve(options.rootDir),j); return withUpdateLock(options.rootDir, () => recoverInterruptedProgramOnly(options)); },
  isCommitted
};
