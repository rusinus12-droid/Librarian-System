'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const updater = require('../../UPDATER/updater.cjs');
const { pickReleaseZip, cleanPath } = require('../../UPDATER/core/file-picker.cjs');

(async () => {
  // CLI contract
  assert.equal(updater.parseArgs(['--local-update']).localUpdate, true);
  assert.deepEqual(
    [updater.parseArgs(['--local-update', '--release-zip', '/tmp/a b/Librarian-System-0.4.9.zip']).releaseZip],
    [path.resolve('/tmp/a b/Librarian-System-0.4.9.zip')]
  );

  // Picker: one native dialog per OS, cancellation is not an error, missing tools fall through
  assert.equal(cleanPath('  "C:\\Users\\a\\Librarian-System-0.4.9.zip"\r\n'), 'C:\\Users\\a\\Librarian-System-0.4.9.zip');
  const ok = (stdout, status = 0) => () => ({ status, stdout });
  const missing = () => ({ error: new Error('ENOENT'), status: null, stdout: '' });
  assert.deepEqual(pickReleaseZip({ platform: 'windows', spawn: ok('C:\\x\\Librarian-System-0.4.9.zip\r\n') }), { path: 'C:\\x\\Librarian-System-0.4.9.zip' });
  assert.deepEqual(pickReleaseZip({ platform: 'macos', spawn: ok('/Users/a/Librarian-System-0.4.9.zip\n') }), { path: '/Users/a/Librarian-System-0.4.9.zip' });
  assert.deepEqual(pickReleaseZip({ platform: 'macos', spawn: ok('', 1) }), { cancelled: true });
  const tried = [];
  const linuxSpawn = command => { tried.push(command); return command === 'kdialog' ? { status: 0, stdout: '/home/a/Librarian-System-0.4.9.zip\n' } : missing(); };
  assert.deepEqual(pickReleaseZip({ platform: 'linux', spawn: linuxSpawn, env: { DISPLAY: ':0' } }), { path: '/home/a/Librarian-System-0.4.9.zip' });
  assert.deepEqual(tried, ['zenity', 'kdialog'], 'a missing zenity must fall through to the next picker');
  assert.equal(pickReleaseZip({ platform: 'linux', spawn: missing, env: { DISPLAY: ':0' } }).unavailable, true);
  assert.equal(pickReleaseZip({ platform: 'linux', spawn: ok('/x'), env: {} }).reason, 'no_display');
  assert.equal(pickReleaseZip({ platform: 'android', spawn: ok('/x') }).unavailable, true);

  // runLocalUpdate: picked ZIP goes through prepare → apply, cancel changes nothing
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian local update '));
  try {
    for (const dir of ['PROGRAM', 'DATA', 'UPDATER']) fs.mkdirSync(path.join(temp, dir), { recursive: true });
    fs.writeFileSync(path.join(temp, 'PROGRAM', 'VERSION.txt'), '0.3.52\n');
    const calls = [];
    const messages = [];
    const deps = {
      pickReleaseZip: () => ({ path: '/tmp/Librarian-System-0.3.53.zip' }),
      prepareFromLocalZip: async ({ zipPath }) => { calls.push(['prepare', path.basename(zipPath)]); return { updatePolicy: 'migration_required', targetVersion: '0.3.53' }; },
      applyReceipt: async ({ receipt }) => { calls.push(['apply', receipt.updatePolicy]); return { status: 'complete' }; }
    };
    const done = await updater.runLocalUpdate({ rootDir: temp, logger: m => messages.push(String(m)), deps });
    assert.equal(done.applied, true);
    assert.deepEqual(calls, [['prepare', 'Librarian-System-0.3.53.zip'], ['apply', 'migration_required']]);
    assert.ok(messages.some(m => /0\.3\.52 → 0\.3\.53/.test(m)));

    calls.length = 0;
    const cancelled = await updater.runLocalUpdate({ rootDir: temp, logger: () => {}, deps: { ...deps, pickReleaseZip: () => ({ cancelled: true }) } });
    assert.equal(cancelled.cancelled, true);
    assert.deepEqual(calls, [], 'cancelling the dialog must not prepare or apply anything');

    await assert.rejects(
      updater.runLocalUpdate({ rootDir: temp, logger: () => {}, deps: { ...deps, pickReleaseZip: () => ({ unavailable: true, reason: 'no_display' }) } }),
      /release_zip_picker_unavailable:no_display/
    );
    await assert.rejects(
      updater.runLocalUpdate({ rootDir: temp, logger: () => {}, deps: { ...deps, prepareFromLocalZip: async () => ({ updatePolicy: 'manual_required', targetVersion: '0.3.53' }) } }),
      /manual_update_required/
    );
    // Explicit path (--release-zip) never opens a dialog
    calls.length = 0;
    await updater.runLocalUpdate({ rootDir: temp, logger: () => {}, zipPath: '/tmp/Librarian-System-0.3.53.zip', deps: { ...deps, pickReleaseZip: () => { throw new Error('dialog must not open'); } } });
    assert.equal(calls.length, 2);

    // A renamed download gets a message that says what to do
    await assert.rejects(updater.prepareFromLocalZip({ rootDir: temp, zipPath: path.join(temp, 'renamed.zip') }), /release_zip_not_found/);
    fs.writeFileSync(path.join(temp, 'renamed.zip'), 'x');
    await assert.rejects(updater.prepareFromLocalZip({ rootDir: temp, zipPath: path.join(temp, 'renamed.zip') }), /release_zip_filename_contract_invalid/);
    assert.match(updater.friendlyErrorMessage(new Error('release_zip_filename_contract_invalid')), /Librarian-System-버전\.zip/);
    assert.match(updater.friendlyErrorMessage(new Error('release_zip_picker_unavailable:no_display')), /직접 입력|--release-zip/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  // Launchers expose the option and forward to the same updater flags
  const bat = fs.readFileSync(path.join(root, '업데이트.bat'), 'utf8');
  assert.match(bat, /"%MENU%"=="4" goto :LOCAL_UPDATE/);
  assert.match(bat, /updater\.cjs" --local-update/);
  const sh = fs.readFileSync(path.join(root, '업데이트.sh'), 'utf8');
  assert.match(sh, /--local-update --release-zip "\$zip"/);

  if (process.platform !== 'win32') {
    const stage = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'librarian launcher local ')));
    try {
      fs.copyFileSync(path.join(root, '업데이트.sh'), path.join(stage, '업데이트.sh'));
      fs.mkdirSync(path.join(stage, 'UPDATER'));
      const argsFile = path.join(stage, 'args.json');
      fs.writeFileSync(path.join(stage, 'UPDATER', 'launch.sh'), `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.env.ARGS_FILE,JSON.stringify(process.argv.slice(1)))' -- "$@"\n`);
      const run = input => spawnSync('/bin/sh', [path.join(stage, '업데이트.sh')], { input, encoding: 'utf8', env: { ...process.env, ARGS_FILE: argsFile }, timeout: 15000 });
      let r = run('4\n"/tmp/with space/Librarian-System-0.4.9.zip"\n');
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(argsFile)), ['--local-update', '--release-zip', '/tmp/with space/Librarian-System-0.4.9.zip']);
      r = run('4\n\n');
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(argsFile)), ['--local-update']);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  console.log('updater_local_package_picker_test: PASS');
})().catch(error => { console.error(error); process.exit(1); });
