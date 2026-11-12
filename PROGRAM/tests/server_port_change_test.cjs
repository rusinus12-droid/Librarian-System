'use strict';
// The port tool (platform_launcher set-port, behind 서버_포트_변경.bat/.sh) with a real server:
// it refuses while the server runs and refuses a port another program holds, keeps the other
// config fields, and the server then starts on the new port.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const programDir = path.resolve(__dirname, '..');
const launcher = path.join(programDir, 'tools', 'platform_launcher.cjs');
const run = (args, timeout = 60000) => spawnSync(process.execPath, ['--no-warnings', launcher, ...args], { cwd: programDir, encoding: 'utf8', timeout });
const freePort = () => new Promise((resolve, reject) => {
  const server = http.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const holdPort = () => new Promise((resolve, reject) => {
  const server = http.createServer((_, response) => response.end('other program')); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

(async () => {
  for (const name of ['서버_포트_변경.bat', '서버_포트_변경.sh']) {
    const source = fs.readFileSync(path.join(programDir, name), 'utf8');
    assert.match(source, /platform_launcher\.cjs" set-port --port|memory-suite\.sh" set-port --port/, `${name} runs the set-port command`);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(programDir, '서버_포트_변경.sh'), 'utf8'), /\r\n/, 'POSIX launcher uses LF');
  assert.doesNotMatch(fs.readFileSync(path.join(programDir, '서버_포트_변경.bat'), 'utf8').replace(/\r\n/g, ''), /\n/, 'Windows launcher uses CRLF only');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian port change '));
  const dataDir = path.join(root, 'DATA (port)');
  const configPath = path.join(dataDir, 'config', 'server-config.json');
  let started = false, held = null;
  try {
    assert.equal(run(['prepare', '--data-dir', dataDir]).status, 0);
    const first = await freePort();
    const set = (port, extra = []) => run(['set-port', '--port', String(port), '--data-dir', dataDir, ...extra]);
    let result = set(first);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`새 서버 주소: http://127\\.0\\.0\\.1:${first}`));
    assert.match(result.stdout, /LIBRA · HAYAKU · Flashback[\s\S]*GRADIA[\s\S]*RE:TRACE/, 'the plugins to update are named');
    const before = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(before.port, first);

    for (const bad of ['80', '65536', 'abc', '', '48000; echo x']) {
      result = set(bad);
      assert.equal(result.status, 2, `${bad}: ${result.stderr}`);
      assert.match(result.stderr, /포트는 1024~65535 사이의 숫자여야 합니다/);
      assert.doesNotMatch(result.stderr, /\n\s+at /, 'a refused input shows guidance, not a stack');
    }
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).port, first, 'refused input changes nothing');

    // A running server keeps its port: the change waits until it is stopped.
    result = run(['background', '--data-dir', dataDir], 60000);
    assert.equal(result.status, 0, result.stderr || result.stdout); started = true;
    const second = await freePort();
    result = set(second);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, new RegExp(`서버가 현재 포트 ${first}에서 실행 중입니다`));
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).port, first);
    assert.equal(run(['stop', '--data-dir', dataDir], 60000).status, 0); started = false;

    // A port another program holds is refused.
    held = await holdPort();
    result = set(held.address().port);
    assert.equal(result.status, 4, result.stderr);
    assert.match(result.stderr, /다른 프로그램이 사용 중입니다/);
    await new Promise(resolve => held.close(resolve)); held = null;

    result = set(second);
    assert.equal(result.status, 0, result.stderr);
    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual({ ...after, port: before.port }, before, 'only the port changes');
    assert.equal(after.port, second);
    assert.deepEqual(fs.readdirSync(path.dirname(configPath)).filter(name => name.includes('.tmp')), [], 'no temporary file is left');

    // The server now starts on the new port.
    result = run(['background', '--data-dir', dataDir], 60000);
    assert.equal(result.status, 0, result.stderr || result.stdout); started = true;
    const health = await (await fetch(`http://127.0.0.1:${second}/health`)).json();
    assert.equal(health.ok, true);
    console.log('server_port_change_test: PASS (input checked, running server refused, held port refused, only port changed, server moved)');
  } finally {
    if (held) await new Promise(resolve => held.close(resolve));
    if (started) run(['stop', '--data-dir', dataDir], 60000);
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
