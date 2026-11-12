'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { PAYLOAD, refreshUpdater } = require('../tools/updater-refresh.cjs');
const { listStaticFiles } = require('../../UPDATER/core/updater-bootstrap.cjs');

const guide = '서버 업데이트 장해 대처법.txt';
const sourceUpdater = path.resolve(__dirname, '../../UPDATER');
const sourceWorker = path.resolve(__dirname, '../tools/updater-refresh.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-refresh-'));
  const program = path.join(root, 'PROGRAM');
  const updater = path.join(root, 'UPDATER');
  const payload = path.join(program, PAYLOAD);
  const worker = path.join(program, 'tools', 'updater-refresh.cjs');
  fs.mkdirSync(payload, { recursive: true });
  fs.copyFileSync(sourceWorker, worker);
  const files = {};
  for (const file of listStaticFiles(sourceUpdater)) {
    const bytes = fs.readFileSync(path.join(sourceUpdater, file));
    for (const destination of [payload, updater]) {
      if (destination === updater && file === guide) continue;
      const target = path.join(destination, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
    files[`${PAYLOAD}/${file}`] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }
  fs.appendFileSync(path.join(updater, 'core', 'program-only.cjs'), '\n// installed updater version\n');
  fs.writeFileSync(path.join(updater, 'logs', 'latest.log'), 'keep the existing log');
  fs.writeFileSync(path.join(program, 'VERSION.txt'), '1.0.1\n');
  fs.writeFileSync(path.join(program, 'program-manifest.json'), JSON.stringify({ packageVersion: '1.0.1', files }));
  const journalPath = path.join(updater, 'update-state.json');
  const write = (status, decision) => fs.writeFileSync(journalPath, JSON.stringify({
    schema: 'librarian.update-state.v1', policy: 'program_only', fromVersion: '1.0.0', toVersion: '1.0.1',
    operationId: 'test-update', status, decision, flags: { candidateVerified: true }, dataInstanceId: 'unchanged'
  }));
  return { root, updater, payload, worker, journalPath, write };
}

test('the released worker waits for the old updater to finish and preserves its runtime state', async () => {
  const f = fixture();
  let child;
  try {
    const { withUpdateLock } = require(path.join(f.updater, 'core', 'lock.cjs'));
    const exit = await withUpdateLock(f.root, async () => {
      f.write('running');
      child = spawn(process.execPath, ['--no-warnings', f.worker, 'test-update'], { stdio: 'ignore', windowsHide: true });
      const exited = once(child, 'exit');
      await delay(650);
      assert.equal(fs.existsSync(path.join(f.updater, guide)), false);
      f.write('complete', 'commit');
      await delay(650);
      assert.equal(fs.existsSync(path.join(f.updater, guide)), false, 'the old updater still holds the lock');
      return { exited };
    });
    assert.deepEqual(await exit.exited, [0, null]);
    assert.deepEqual(fs.readFileSync(path.join(f.updater, guide)), fs.readFileSync(path.join(f.payload, guide)));
    assert.deepEqual(fs.readFileSync(path.join(f.updater, 'core/program-only.cjs')), fs.readFileSync(path.join(f.payload, 'core/program-only.cjs')));
    assert.equal(fs.readFileSync(path.join(f.updater, 'logs/latest.log'), 'utf8'), 'keep the existing log');
    const journal = JSON.parse(fs.readFileSync(f.journalPath, 'utf8'));
    assert.equal(journal.dataInstanceId, 'unchanged');
    assert.ok(journal.updaterRefreshedAt);
    assert.equal(await refreshUpdater(f.root, 'test-update'), false, 'already refreshed');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('rollback, unrelated operations, and altered updater payloads cannot replace updater files', async () => {
  const f = fixture();
  try {
    f.write('rolled_back');
    assert.equal(await refreshUpdater(f.root, 'test-update'), false);
    f.write('complete', 'commit');
    assert.equal(await refreshUpdater(f.root, 'different-update'), false);
    fs.appendFileSync(path.join(f.payload, guide), '\nmodified');
    await assert.rejects(refreshUpdater(f.root, 'test-update'), /updater_refresh_payload_mismatch/);
    assert.equal(fs.existsSync(path.join(f.updater, guide)), false);
    assert.equal(JSON.parse(fs.readFileSync(f.journalPath, 'utf8')).updaterRefreshedAt, undefined);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
