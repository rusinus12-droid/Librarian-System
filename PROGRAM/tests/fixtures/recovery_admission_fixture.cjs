'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createMemorySuiteServer } = require('../../server/server.cjs');
const { assertLegacyAuthorityUnavailable } = require('../../server/authority/legacy-admission.cjs');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const dbFile = dataDir => path.join(dataDir, 'stores', 'libra', 'libra.sqlite');
function tree(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).sort().flatMap(name => {
    const file = path.join(root, name);
    return fs.statSync(file).isDirectory() ? tree(file).map(row => ({ ...row, path:name+'/'+row.path }))
      : [{path:name, sha256:sha256(fs.readFileSync(file))}];
  });
}
function protectedSnapshot(dataDir) {
  return Object.fromEntries(['stores','config','backups','migrations'].map(name => [name,tree(path.join(dataDir,name))]));
}
async function prepare(dataDir, key) {
  const app = createMemorySuiteServer({host:'127.0.0.1', port:0, dataDir, autoBackup:false, computeEnabled:false});
  try {
    await app.listen();
    app.repositories.libra.mutate({kind:'set',space:'plugin',key,value:{state:'backup'},operationId:'recovery_fixture_source_0001',expectedRevision:0});
    const backup = await app.createBackup('manual','recovery-admission-source');
    const row = app.listBackups().find(row => row.id === backup.result.id);
    return {id:backup.result.id, path:row.path, bytes:tree(row.path)};
  } finally { await app.close(); }
}
function corruptDataPage(dataDir) {
  const file = dbFile(dataDir);
  assert.equal(fs.existsSync(file+'-wal'), false, 'corrupt only a closed, checkpointed synthetic database');
  const db = new DatabaseSync(file,{readOnly:true});
  let page, size;
  try {
    page = db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='kv'").get().rootpage;
    size = db.prepare('PRAGMA page_size').get().page_size;
  } finally { db.close(); }
  assert.ok(page > 1, 'the data page must be separate from SQLite schema and header');
  const bytes = fs.readFileSync(file);
  bytes[(page-1)*size] = 255; // Invalid b-tree page kind: real integrity failure, intact authority catalog.
  fs.writeFileSync(file, bytes);
  assert.doesNotThrow(() => assertLegacyAuthorityUnavailable({dataDir}), 'readable catalog and version prove absence of authority');
  return sha256(bytes);
}
function assertQuarantine(dataDir, receipt, corruptedSha) {
  const dir = path.join(dataDir,'backups','recovery-quarantine',receipt.quarantineId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
  assert.deepEqual(manifest.namespaces, ['libra']);
  const file = manifest.files['libra.sqlite'];
  assert.equal(file.sha256, corruptedSha);
  assert.equal(sha256(fs.readFileSync(path.join(dir,file.file))), corruptedSha, 'corrupt source bytes preserved for recovery review');
}
module.exports = { prepare, corruptDataPage, assertQuarantine, protectedSnapshot, tree, dbFile, sha256 };
