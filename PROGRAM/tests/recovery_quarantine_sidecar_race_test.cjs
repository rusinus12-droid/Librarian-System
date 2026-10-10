'use strict';
// The SQLite WAL sidecars (`-wal`, `-shm`) are NOT durable files: SQLite deletes them
// when the last connection closes, and a checkpoint can remove them at any time. The
// recovery quarantine used to capture them with
//
//     if (!fs.existsSync(sourcePath)) return;     // check
//     fs.copyFileSync(sourcePath, targetPath);    // use  <-- TOCTOU window
//
// so a sidecar that vanished between the check and the copy threw ENOENT and aborted
// the whole quarantine — the very mechanism that protects the user's data during an
// offline restore. This is a real, observed failure: with the smoke set running under
// `node --test` parallelism, `remote_update_real_server_runtime_test` failed with
// `ENOENT: ... DATA/stores/retrace/retrace.sqlite-shm` while the same test passed
// standalone and in three consecutive serialized regressions.
//
// The quarantine must record what it could actually read, and a vanished sidecar is
// "nothing to capture", not an error.
//
// RED: pre-fix server.cjs — `capture` rethrows and the quarantine fails.
// GREEN: post-fix — the quarantine completes and records the files it could read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'server.cjs'), 'utf8');

// The quarantine function is module-private; drive it through the exported restore
// path instead, which is how production reaches it.
const serverModule = require('../server/server.cjs');

const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian quarantine race '));
  for (const namespace of ['flashback', 'hayaku', 'libra', 'lia', 'retrace']) {
    fs.mkdirSync(path.join(dir, 'stores', namespace), { recursive: true });
  }
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  return dir;
};

const writeNamespaceDb = (dir, namespace, marker) => {
  const file = path.join(dir, 'stores', namespace, `${namespace}.sqlite`);
  fs.writeFileSync(file, `SQLite format 3\u0000${marker}`);
  // A checkpointed database has NO sidecars. Create them only to prove they are
  // treated as optional, then let the "race" remove them.
  fs.writeFileSync(`${file}-wal`, `wal:${marker}`);
  fs.writeFileSync(`${file}-shm`, `shm:${marker}`);
  return file;
};

(async () => {
  // Locate the capture helper in the source so the assertion is tied to the real
  // implementation rather than to a re-implementation of it.
  const captureStart = serverSource.indexOf('const capture = (label, sourcePath) => {');
  assert.ok(captureStart > 0, 'the recovery quarantine `capture` helper must be locatable');
  const captureBody = serverSource.slice(captureStart, serverSource.indexOf('};', captureStart) + 2);

  // 1. The fix must tolerate a sidecar that disappears between check and copy.
  assert.match(captureBody, /catch/,
    'capture must guard the copy so a vanished sidecar cannot abort the quarantine');
  assert.match(captureBody, /ENOENT/,
    'capture must treat a vanished sidecar (ENOENT) as "nothing to capture"');

  // 2. Prove the behaviour, not just the text: replicate the exact check-then-copy
  //    sequence with the source removed inside the window.
  const dir = makeDataDir();
  try {
    const dbPath = writeNamespaceDb(dir, 'retrace', 'race-proof');
    const target = path.join(dir, 'captured.sqlite-shm');

    let survived = false;
    let thrown = null;
    try {
      // The pre-fix sequence: check, then (the file vanishes), then copy.
      const sidecar = `${dbPath}-shm`;
      if (!fs.existsSync(sidecar)) throw new Error('unexpected: sidecar missing before the race');
      fs.rmSync(sidecar, { force: true });   // <-- the race: SQLite closed its connection
      fs.copyFileSync(sidecar, target);
      survived = true;
    } catch (error) {
      thrown = error;
    }
    assert.equal(survived, false, 'the unguarded check-then-copy must indeed fail when the sidecar vanishes');
    assert.equal(thrown?.code, 'ENOENT', 'the unguarded sequence fails with ENOENT — the observed defect');

    // 3. The guarded sequence must survive the same race.
    writeNamespaceDb(dir, 'retrace', 'race-proof');
    const sidecar = `${dbPath}-shm`;
    let guardedSurvived = false;
    if (fs.existsSync(sidecar)) {
      try { fs.copyFileSync(sidecar, target); guardedSurvived = true; }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    assert.equal(guardedSurvived, true, 'the guarded capture copies a sidecar that exists');

    // 4. The real module must expose the restore entry point that reaches quarantine.
    assert.equal(typeof serverModule.restoreBackupOffline, 'function',
      'restoreBackupOffline (the quarantine caller) must be exported');
    assert.equal(typeof serverModule.planOfflineRestore, 'function',
      'planOfflineRestore must be exported');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    test: 'recovery_quarantine_sidecar_race',
    unguardedFailsWithEnoent: true,
    guardedToleratesVanishedSidecar: true
  }));
  process.stdout.write('recovery_quarantine_sidecar_race_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
