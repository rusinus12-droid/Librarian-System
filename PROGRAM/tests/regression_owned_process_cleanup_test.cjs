'use strict';
// Verifies, through the actual copied runner, that POSIX cleanup reaches detached descendants
// (setsid / detached spawn in their own process group), both after a normal test exit and on
// Ctrl-C (SIGINT) of the runner. A process-group kill alone does not reach those processes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

if (process.platform === 'win32') {
  console.log('SKIP: POSIX owned-process cleanup (Windows uses the owned job object)');
  process.exit(0);
}
const python = process.env.PYTHON || ['python3', 'python'].find(command =>
  spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0);
assert.ok(python, 'the regression runner requires Python; set PYTHON when invoking this suite directly');

function alive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try { // a zombie has exited and only awaits reaping by its (re)parent
    const state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[0];
    return state !== 'Z';
  } catch { return true; }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (predicate()) return; await sleep(100); }
  assert.fail(label);
}

const DETACHED_SERVER = `const {spawn}=require('node:child_process');const fs=require('node:fs');
const server=spawn(process.execPath,['-e','require("node:http").createServer(()=>{}).listen(0);setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
server.unref();fs.writeFileSync(process.env.PROBE_PID_FILE,String(server.pid));`;

function makeRunnerTree(testBody) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-owned-cleanup-'));
  fs.mkdirSync(path.join(temp, 'tests'));
  fs.copyFileSync(path.join(__dirname, '..', 'run_regression_batch.py'), path.join(temp, 'run_regression_batch.py'));
  fs.writeFileSync(path.join(temp, 'VERSION.txt'), '0.0.0\n');
  fs.writeFileSync(path.join(temp, 'program-manifest.json'), '{"plugins":{}}');
  fs.writeFileSync(path.join(temp, 'tests', 'probe_test.cjs'), testBody);
  return temp;
}

(async () => {
  const leaked = [];
  try {
    // 1. Normal exit leaves a detached server behind: the runner terminates it and records it.
    {
      const temp = makeRunnerTree(DETACHED_SERVER + '\nconsole.log("probe done");\n');
      const pidFile = path.join(temp, 'server.pid'), log = path.join(temp, 'run.log');
      const result = spawnSync(python, [path.join(temp, 'run_regression_batch.py')], {
        cwd: temp, encoding: 'utf8', timeout: 60000,
        env: { ...process.env, PROBE_PID_FILE: pidFile, MEMORY_SUITE_REGRESSION_LOG: log } });
      const pid = Number(fs.readFileSync(pidFile, 'utf8')); leaked.push(pid);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      await waitFor(() => !alive(pid), 5000, `detached server ${pid} survived a normal test exit`);
      assert.match(fs.readFileSync(log, 'utf8'), /probe_test\.cjs: PASS .*posix_owned_leftovers_terminated:1/,
        'the log records that an owned leftover was terminated');
      fs.rmSync(temp, { recursive: true, force: true });
    }
    // 2/3. Ctrl-C (SIGINT) and a termination request (SIGTERM) while the test is still running:
    //      the detached server must not outlive the runner.
    for (const sig of ['SIGINT', 'SIGTERM']) {
      const temp = makeRunnerTree(DETACHED_SERVER + '\nsetInterval(()=>{},1000);\n');
      const pidFile = path.join(temp, 'server.pid'), log = path.join(temp, 'run.log');
      const runner = spawn(python, [path.join(temp, 'run_regression_batch.py')], {
        cwd: temp, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PROBE_PID_FILE: pidFile, MEMORY_SUITE_REGRESSION_LOG: log } });
      let stderr = ''; runner.stderr.on('data', chunk => { stderr += chunk; });
      const exited = new Promise(resolve => runner.on('exit', code => resolve(code)));
      await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0, 20000, 'probe did not start its server');
      const pid = Number(fs.readFileSync(pidFile, 'utf8')); leaked.push(pid);
      assert.ok(alive(pid), 'server is running before the interrupt');
      runner.kill(sig);
      const code = await exited;
      assert.notEqual(code, 0, `a run stopped by ${sig} must not report success`);
      await waitFor(() => !alive(pid), 5000, `detached server ${pid} survived ${sig} of the runner`);
      assert.match(stderr, /interrupted: probe_test\.cjs; terminated [1-9]\d* owned process/, stderr);
      fs.rmSync(temp, { recursive: true, force: true });
    }
    console.log('regression_owned_process_cleanup_test: PASS (detached descendants are terminated after normal exit, on SIGINT and on SIGTERM)');
  } finally {
    for (const pid of leaked) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
})().catch(error => { console.error('regression_owned_process_cleanup_test: FAIL'); console.error(error); process.exit(1); });
