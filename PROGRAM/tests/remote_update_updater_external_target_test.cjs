'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const packageRoot = path.resolve(__dirname, '..', '..');
const updater = path.join(packageRoot, 'UPDATER', 'updater.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian external updater target '));
const target = path.join(temp, 'legacy target');
try {
  fs.mkdirSync(path.join(target, 'UPDATER', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(target, 'UPDATER', 'updater.cjs'), 'OLD-UPDATER\n');
  fs.writeFileSync(path.join(target, 'UPDATER', 'update-state.json'), JSON.stringify({
    schema: 'librarian.update-state.v1', status: 'complete', policy: 'program_only'
  }));
  fs.writeFileSync(path.join(target, 'UPDATER', 'logs', 'latest.log'), 'legacy-log\n');

  const result = spawnSync(process.execPath, [
    '--no-warnings', updater,
    '--target-root', target,
    '--recover', '--install-updater'
  ], { encoding: 'utf8', cwd: packageRoot });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    fs.readFileSync(path.join(target, 'UPDATER', 'updater.cjs'), 'utf8'),
    fs.readFileSync(updater, 'utf8')
  );
  assert.ok(fs.existsSync(path.join(target, 'UPDATER', 'core', 'updater-bootstrap.cjs')));
  assert.ok(fs.existsSync(path.join(target, 'UPDATER', 'operation-lock.sqlite')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'UPDATER', 'update-state.json'), 'utf8')).status, 'complete');
  const log = fs.readFileSync(path.join(target, 'UPDATER', 'logs', 'latest.log'), 'utf8');
  assert.match(log, /legacy-log/);
  assert.match(log, /복구할 미완료 업데이트가 없습니다/);
  const rollbacks = fs.readdirSync(path.join(target, '.rollback')).filter(name => name.startsWith('updater-bootstrap-'));
  assert.equal(rollbacks.length, 1);
  assert.equal(
    fs.readFileSync(path.join(target, '.rollback', rollbacks[0], 'UPDATER', 'updater.cjs'), 'utf8'),
    'OLD-UPDATER\n'
  );
  console.log('remote_update_updater_external_target_test: PASS');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
