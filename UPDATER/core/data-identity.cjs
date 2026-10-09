'use strict';
// Standalone recovery cannot depend on a working PROGRAM. Keep this producer
// byte-for-byte compatible in meaning with server/core/data-instance-identity.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const schema = 'memory-suite.data-instance-seed.v1';
const contract = 'memory-suite.physical-data-identity.v1';
const engineRevision = 5;
const identityPath = data => path.join(path.resolve(data), 'config', 'data-instance.json');
const failure = (message, code) => Object.assign(new Error(message), {code});
const invalid = () => failure('data_instance_identity_invalid', 'DATA_INSTANCE_IDENTITY_INVALID');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const normalize = root => process.platform === 'win32' ? root.toLowerCase() : root;
function parts(data) {
  let seed, bytes;
  try {
    const file = identityPath(data), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 4096) throw invalid();
    bytes = fs.readFileSync(file); seed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw failure('data_instance_identity_unavailable', 'DATA_INSTANCE_IDENTITY_UNAVAILABLE');
    throw invalid();
  }
  if (seed?.schema !== schema || typeof seed.nonce !== 'string' || !/^[-_A-Za-z0-9]{43}$/.test(seed.nonce)
      || typeof seed.createdAt !== 'string' || !Number.isFinite(Date.parse(seed.createdAt))) throw invalid();
  const root = normalize(fs.realpathSync.native(path.resolve(data)));
  const physical = fs.statSync(root, {bigint:true});
  if (!physical.isDirectory()) throw invalid();
  return {root, nonce:seed.nonce, seedSha256:digest(bytes), dev:String(physical.dev), ino:String(physical.ino)};
}
function binding(value, root = value.root) {
  const dataInstanceId = crypto.createHash('sha256')
    .update(contract+'\0'+value.nonce+'\0'+root+'\0'+value.dev+'\0'+value.ino, 'utf8').digest('base64url').slice(0,32);
  return {dataInstanceId, dataIdentityContract:contract, rootSha256:digest(root), dev:value.dev, ino:value.ino, seedSha256:value.seedSha256};
}
function readDataInstanceIdentity(data) {
  const result = binding(parts(data));
  return {dataInstanceId:result.dataInstanceId, dataIdentityContract:contract};
}
function ensureDataInstanceIdentity(data) {
  const file = identityPath(data); fs.mkdirSync(path.dirname(file), {recursive:true});
  if (!fs.existsSync(file)) {
    const bytes = Buffer.from(JSON.stringify({schema, nonce:crypto.randomBytes(32).toString('base64url'), createdAt:new Date().toISOString()})+'\n');
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); let offset=0; while(offset<bytes.length) offset+=fs.writeSync(fd,bytes,offset,bytes.length-offset); fs.fsyncSync(fd); }
    catch(error) {
      // Only remove a seed created by this attempt; preserve pre-existing identities.
      if(fd!==undefined) { fs.closeSync(fd); fd=undefined; fs.rmSync(file,{force:true}); }
      if(error.code!=='EEXIST') throw error;
    }
    finally { if(fd!==undefined) fs.closeSync(fd); }
  }
  return readDataInstanceIdentity(data);
}
function capture(data) { return binding(parts(data)); }
function validBinding(value) {
  return value?.dataIdentityContract === contract && /^[-_A-Za-z0-9]{32}$/.test(value.dataInstanceId || '')
    && /^[a-f0-9]{64}$/.test(value.rootSha256 || '') && /^[a-f0-9]{64}$/.test(value.seedSha256 || '')
    && /^\d+$/.test(value.dev || '') && /^\d+$/.test(value.ino || '');
}
function assertBinding(data, expected) {
  if (!validBinding(expected)) throw failure('updater_data_identity_binding_invalid', 'UPDATER_DATA_IDENTITY_JOURNAL_INVALID');
  const actual = capture(data);
  if (Object.keys(actual).some(key => actual[key] !== expected[key])) throw failure('updater_physical_data_identity_mismatch', 'UPDATER_PHYSICAL_DATA_IDENTITY_MISMATCH');
  return actual;
}
function assertOneOf(data, expected) {
  const actual = capture(data);
  if (!expected.some(value => validBinding(value) && Object.keys(actual).every(key => actual[key] === value[key])))
    throw failure('updater_physical_data_identity_mismatch', 'UPDATER_PHYSICAL_DATA_IDENTITY_MISMATCH');
  return actual;
}
function futureRoot(destination) {
  let parent = path.resolve(destination), tail = [];
  while(!fs.existsSync(parent)) { const next=path.dirname(parent); if(next===parent) throw invalid(); tail.unshift(path.basename(parent)); parent=next; }
  // If DATA exists it names the directory being replaced, not a symlink target.
  if (fs.lstatSync(parent).isSymbolicLink()) throw failure('updater_data_move_symlink_rejected', 'UPDATER_PHYSICAL_DATA_IDENTITY_MISMATCH');
  return normalize(path.join(fs.realpathSync.native(parent), ...tail));
}
function planMove(source, destination) {
  const value = parts(source);
  return {source:binding(value), target:binding(value, futureRoot(destination))};
}
function assertJournal(journal) {
  if (!journal || Number(journal.engineRevision) < engineRevision || !journal.dataIdentityContract
      || /^[-_A-Za-z0-9]{24}$/.test(String(journal.dataInstanceId || ''))) {
    throw failure('legacy_data_identity_requires_manual_review: pending token24 journal is preserved; restore with its original reviewed updater or review physical DATA before recovery', 'UPDATER_LEGACY_DATA_IDENTITY_REVIEW_REQUIRED');
  }
  if (journal.engineRevision !== engineRevision || journal.dataIdentityContract !== contract || !validBinding(journal.dataIdentity)
      || journal.dataIdentity.dataInstanceId !== journal.dataInstanceId) throw failure('updater_data_identity_journal_invalid', 'UPDATER_DATA_IDENTITY_JOURNAL_INVALID');
  if ((journal.policy === 'migration_required' && !validBinding(journal.sourceDataIdentity))
      || (journal.policy === 'program_only' && journal.flags?.checkpointCreated && !validBinding(journal.checkpointDataIdentity)))
    throw failure('updater_data_identity_journal_invalid', 'UPDATER_DATA_IDENTITY_JOURNAL_INVALID');
  for (const value of [journal.sourceDataIdentity, journal.checkpointDataIdentity, journal.nextDataIdentity]) {
    if(value && !validBinding(value)) throw failure('updater_data_identity_journal_invalid', 'UPDATER_DATA_IDENTITY_JOURNAL_INVALID');
  }
  for (const move of Object.values(journal.dataMoves || {})) {
    if(!validBinding(move?.source) || !validBinding(move?.target)
       || ['dev','ino','seedSha256'].some(key=>move.source[key]!==move.target[key])) throw failure('updater_data_move_intent_invalid', 'UPDATER_DATA_IDENTITY_JOURNAL_INVALID');
  }
}
function assertHealth(health, expected, version, verifyMode) {
  if (String(health?.version || '') !== String(version) || health?.dataIdentityContract !== contract
      || health?.dataInstanceId !== expected.dataInstanceId || health?.maintenanceMode !== verifyMode)
    throw failure('updater_server_physical_identity_or_mode_mismatch', 'UPDATER_SERVER_PHYSICAL_IDENTITY_MISMATCH');
}
module.exports = {contract, engineRevision, identityPath, readDataInstanceIdentity, ensureDataInstanceIdentity, capture, assertBinding, assertOneOf, planMove, assertJournal, assertHealth};
