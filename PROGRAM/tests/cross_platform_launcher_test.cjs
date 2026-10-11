'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const programDir = path.resolve(__dirname, '..');
const launcher = path.join(programDir, 'tools', 'platform_launcher.cjs');
const scripts = [
  'memory-suite.sh',
  '1_서버_실행.sh',
  '서버_백그라운드_실행.sh',
  '2_서버_종료.sh',
  '서버_상태_확인.sh',
  '관리도구/데이터_무결성_검사.sh',
  '관리도구/전체_자동시험.sh',
  'macOS_서버_실행.command',
  '안드로이드_Termux_준비.sh',
  '배포본_만들기.sh'
];

const run = (args, options = {}) => spawnSync(process.execPath, ['--no-warnings', launcher, ...args], {
  cwd: programDir,
  encoding: 'utf8',
  timeout: options.timeout || 20000
});

const runOperation = (command, dataDir, options = {}) => {
  if (process.platform === 'win32') return run([command, '--data-dir', dataDir], options);
  const scriptsByCommand = {
    background: '서버_백그라운드_실행.sh',
    status: '서버_상태_확인.sh',
    integrity: '관리도구/데이터_무결성_검사.sh',
    stop: '2_서버_종료.sh'
  };
  return spawnSync('sh', [path.join(programDir, scriptsByCommand[command]), '--data-dir', dataDir], {
    cwd: programDir,
    encoding: 'utf8',
    timeout: options.timeout || 20000
  });
};

const freePort = () => new Promise((resolve, reject) => {
  const server = http.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(error => error ? reject(error) : resolve(port));
  });
});

const waitForOffline = async url => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { await fetch(`${url}/health`); }
    catch (_) { return true; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
};

async function main() {
  assert.ok(fs.existsSync(launcher), 'platform launcher must be packaged');
  assert.equal(spawnSync(process.execPath, ['--check', launcher], { encoding: 'utf8' }).status, 0);
  for (const relative of scripts) {
    const filePath = path.join(programDir, relative);
    assert.ok(fs.existsSync(filePath), `missing cross-platform script: ${relative}`);
    const source = fs.readFileSync(filePath, 'utf8');
    assert.ok(source.startsWith('#!'), `${relative} must have a shebang`);
    assert.doesNotMatch(source, /\r\n/, `${relative} must use POSIX LF endings`);
    assert.match(source, /"\$PROGRAM_DIR|"\$TOOL_DIR|Termux/, `${relative} must quote paths or be the Termux setup entry`);
    if (process.platform !== 'win32') {
      const syntax = spawnSync('sh', ['-n', filePath], { encoding: 'utf8' });
      assert.equal(syntax.status, 0, `${relative}: ${syntax.stderr || syntax.stdout}`);
    }
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory suite (cross-platform) '));
  const dataDir = path.join(tempRoot, 'portable DATA (shared)');
  let serverRunning = false;
  try {
    const prepared = run(['prepare', '--data-dir', dataDir]);
    assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
    const configPath = path.join(dataDir, 'config', 'server-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.port = await freePort();
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const url = `http://127.0.0.1:${config.port}`;

    const started = runOperation('background', dataDir);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    assert.match(started.stdout, /Background server ready/);
    serverRunning = true;

    const layoutPath = path.join(dataDir, 'data-layout.json');
    const layoutBeforeReadOnlyCommands = fs.readFileSync(layoutPath);
    const status = runOperation('status', dataDir);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal(JSON.parse(status.stdout).ok, true, status.stdout);
    assert.match(status.stderr, /status window/, 'status keeps its launcher notice off the machine-readable stream');
    assert.deepEqual(fs.readFileSync(layoutPath), layoutBeforeReadOnlyCommands, 'status must not mutate DATA layout');

    const integrity = runOperation('integrity', dataDir);
    assert.equal(integrity.status, 0, integrity.stderr || integrity.stdout);
    assert.deepEqual(fs.readFileSync(layoutPath), layoutBeforeReadOnlyCommands, 'integrity must not mutate DATA layout');

    const stopped = runOperation('stop', dataDir);
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
    assert.equal(await waitForOffline(url), true, 'stop command must close the portable server');
    serverRunning = false;
    assert.deepEqual(fs.readFileSync(layoutPath), layoutBeforeReadOnlyCommands, 'stop must not mutate DATA layout');

    const offlineStatus = runOperation('status', dataDir);
    assert.notEqual(offlineStatus.status, 0, 'offline status must fail without preparing DATA');
    assert.deepEqual(fs.readFileSync(layoutPath), layoutBeforeReadOnlyCommands, 'offline status must remain read-only');

    for (const namespace of ['flashback', 'hayaku', 'libra']) {
      assert.ok(fs.existsSync(path.join(dataDir, 'stores', namespace, `${namespace}.sqlite`)), `${namespace} SQLite remains in portable DATA`);
    }
    for (const namespace of ['lia', 'retrace']) {
      assert.equal(fs.existsSync(path.join(dataDir, 'stores', namespace, `${namespace}.sqlite`)), false, `${namespace} fresh live SQLite must remain absent`);
    }
    process.stdout.write('cross_platform_launcher_test: PASS\n');
  } finally {
    // A failed assertion must not leak the detached portable server: its open
    // SQLite handles are what makes the temporary DATA directory unremovable.
    if (serverRunning) { try { runOperation('stop', dataDir); } catch (_) {} }
    // Cleanup is hygiene, never the contract under test, and must not mask the
    // real assertion error by throwing out of this finally block.
    try { fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (error) { process.stderr.write(`cross_platform_launcher_test: temporary_cleanup_skipped ${String(error?.code || error)} ${tempRoot}\n`); }
  }
}

main().catch(error => {
  process.stderr.write(`cross_platform_launcher_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
