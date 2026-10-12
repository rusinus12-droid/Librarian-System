'use strict';
// Alternative replacement for the unavailable historical test. This is a new
// implementation and does not claim to restore the original test bytes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

if (process.platform !== 'linux') {
  console.log('SKIP: Linux subreaper/process-table cleanup probe; non-Linux behavior is unverified here');
  process.exit(0);
}

const python = process.env.PYTHON || ['python3', 'python'].find(command =>
  spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0);
assert.ok(python, 'the cleanup probe requires Python');
const recoveredRunner = path.resolve(__dirname, '..', 'run_regression_batch.py');
const evidenceDir = process.env.CLEANUP_EVIDENCE_DIR || '';
const ownerKey = 'LIBRARIAN_REGRESSION_OWNER';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function statFor(pid) {
  try {
    const raw = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], start: fields[19] };
  } catch {
    return null;
  }
}
function exactState(record) {
  const stat = statFor(record.pid);
  if (!stat || stat.start !== String(record.start)) return 'gone';
  if (stat.state === 'Z') return 'zombie';
  try {
    const cmdline = fs.readFileSync('/proc/' + record.pid + '/cmdline');
    if (cmdline.includes(Buffer.from('CLEANUP_PID_FILE'))) return 'live';
  } catch {}
  return 'gone';
}
function recordsAt(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await pause(50);
  }
  assert.fail(label);
}
function pidfdKill(record) {
  const code = [
    'import os, signal, sys',
    'pid=int(sys.argv[1]); start=sys.argv[2]',
    'if not hasattr(os,"pidfd_open") or not hasattr(signal,"pidfd_send_signal"): sys.exit(4)',
    'try: fd=os.pidfd_open(pid,0)',
    'except ProcessLookupError: sys.exit(0)',
    'try:',
    '  raw=open("/proc/%d/stat"%pid,"rb").read()',
    '  fields=raw[raw.rindex(b")")+2:].split()',
    '  cmd=open("/proc/%d/cmdline"%pid,"rb").read()',
    '  if fields[0]==b"Z" or fields[19].decode()!=start or b"CLEANUP_PID_FILE" not in cmd: sys.exit(0)',
    '  signal.pidfd_send_signal(fd,signal.SIGKILL)',
    'finally: os.close(fd)'
  ].join('\n');
  const result = spawnSync(python, ['-c', code, String(record.pid), String(record.start)],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, 'pidfd cleanup must target only a verified owned process: ' + result.stderr);
}
async function cleanOwned(records, allowZombie = false) {
  for (const record of records) {
    if (exactState(record) === 'live') pidfdKill(record);
  }
  await waitFor(() => records.every(record => exactState(record) === 'gone' || (allowZombie && exactState(record) === 'zombie')),
    5000, 'an owned process remained after targeted cleanup');
}
function runnerExit(child, buffers) {
  return new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => buffers.stdout.push(chunk));
    child.stderr.on('data', chunk => buffers.stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
function writeScenarioEvidence(id, data, files) {
  if (!evidenceDir) return;
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, id + '.json'), JSON.stringify(data, null, 2) + '\n');
  for (const [suffix, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(evidenceDir, id + '.' + suffix), value);
  }
}

const workerSource = [
  "'use strict';",
  "const fs=require('node:fs'),cp=require('node:child_process');",
  "function start(){const raw=fs.readFileSync('/proc/self/stat','utf8');return raw.slice(raw.lastIndexOf(')')+2).split(' ')[19];}",
  "const depth=Number(process.env.CLEANUP_DEPTH||1);",
  "fs.appendFileSync(process.env.CLEANUP_PID_FILE,JSON.stringify({pid:process.pid,start:start(),depth:depth,role:process.env.CLEANUP_ROLE})+'\\n');",
  "const kind=process.env.CLEANUP_KIND;",
  "let next=depth<3;",
  "if(kind==='no_token_child')next=false;",
  "if(kind==='env_replaced_grandchild'&&depth>=2)next=false;",
  "if(kind==='orphan_parent_exits'&&depth>=2)next=false;",
  "if(next){const env={...process.env,CLEANUP_DEPTH:String(depth+1),CLEANUP_ROLE:'level'+(depth+1)};",
  "if((kind==='env_replaced_grandchild'||kind==='orphan_parent_exits')&&depth===1)delete env.LIBRARIAN_REGRESSION_OWNER;",
  "const child=cp.spawn(process.execPath,['-e',process.env.CLEANUP_WORKER_SOURCE],{env,detached:true,stdio:'ignore'});child.unref();}",
  "if(kind==='orphan_parent_exits'&&depth===1)process.exit(0);",
  "setInterval(()=>{},1000);"
].join('\n');

function makeProbeBody(kind, mode, expected) {
  const lines = [
    "'use strict';",
    "const fs=require('node:fs'),cp=require('node:child_process');",
    "const worker=" + JSON.stringify(workerSource) + ";",
    "const env={...process.env,CLEANUP_DEPTH:'1',CLEANUP_ROLE:'level1',CLEANUP_WORKER_SOURCE:worker};",
    "if(process.env.CLEANUP_KIND==='no_token_child')delete env.LIBRARIAN_REGRESSION_OWNER;",
    "const child=cp.spawn(process.execPath,['-e',worker],{env,detached:true,stdio:'ignore'});child.unref();",
    "const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));",
    "(async()=>{const until=Date.now()+15000;while(Date.now()<until){let n=0;try{n=fs.readFileSync(process.env.CLEANUP_PID_FILE,'utf8').split('\\n').filter(Boolean).length}catch{}",
    "if(n>=" + expected + ")break;await pause(25)}",
    "let n=0;try{n=fs.readFileSync(process.env.CLEANUP_PID_FILE,'utf8').split('\\n').filter(Boolean).length}catch{}",
    "if(n<" + expected + "){console.error('probe descendants did not start');process.exit(71)}",
    "if(process.env.CLEANUP_MODE==='normal')process.exit(0);setInterval(()=>{},1000)})().catch(e=>{console.error(e);process.exit(72)});"
  ];
  return lines.join('\n');
}
function makeRunnerTree(sourceRunner, kind, mode, nonce, expected, body) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-cleanup-alternative-'));
  fs.mkdirSync(path.join(temp, 'tests'));
  fs.copyFileSync(sourceRunner, path.join(temp, 'run_regression_batch.py'));
  fs.writeFileSync(path.join(temp, 'VERSION.txt'), 'cleanup-probe\n');
  fs.writeFileSync(path.join(temp, 'program-manifest.json'), '{"plugins":{}}\n');
  fs.writeFileSync(path.join(temp, 'tests', 'probe_test.cjs'), body || makeProbeBody(kind, mode, expected));
  const pidFile = path.join(temp, 'owned-pids.jsonl');
  const logFile = path.join(temp, 'runner.log');
  return { temp, pidFile, logFile, kind, mode, nonce };
}
function controlProgram() {
  return "const fs=require('node:fs');const raw=fs.readFileSync('/proc/self/stat','utf8');" +
    "const start=raw.slice(raw.lastIndexOf(')')+2).split(' ')[19];" +
    "fs.writeFileSync(process.env.CONTROL_FILE,JSON.stringify({pid:process.pid,start:start}));" +
    "setInterval(()=>{},1000);";
}
async function startControl(temp, nonce) {
  const file = path.join(temp, 'control.json');
  const child = spawn(process.execPath, ['-e', controlProgram()], {
    detached: true, stdio: 'ignore',
    env: { PATH: process.env.PATH || '', CONTROL_FILE: file, CONTROL_NONCE: nonce }
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  await waitFor(() => fs.existsSync(file), 5000, 'unrelated control process did not start');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { child, exited, record, nonce };
}
function controlIsAlive(control) {
  if (control.child.exitCode !== null || control.child.signalCode !== null) return false;
  const stat = statFor(control.record.pid);
  return Boolean(stat && stat.start === String(control.record.start) && stat.state !== 'Z');
}
async function stopControl(control) {
  if (control.child.exitCode === null && control.child.signalCode === null) {
    control.child.kill('SIGTERM');
    await Promise.race([control.exited, pause(2000)]);
  }
  assert.ok(!controlIsAlive(control), 'the exact control child should exit after targeted SIGTERM');
}

async function runScenario(kind, mode, sourceRunner, expectedLeak) {
  const expected = kind === 'no_token_child' ? 1 : kind === 'three_generation' ? 3 : 2;
  const nonce = crypto.randomUUID();
  const id = kind + '-' + mode + (expectedLeak ? '-baseline' : '');
  const tree = makeRunnerTree(sourceRunner, kind, mode, nonce, expected);
  const control = await startControl(tree.temp, crypto.randomUUID());
  const pids = [];
  const buffers = { stdout: [], stderr: [] };
  let runner, outcome, elapsed;
  const started = Date.now();
  try {
    const env = {
      ...process.env, CLEANUP_KIND: kind, CLEANUP_MODE: mode,
      CLEANUP_PID_FILE: tree.pidFile, CLEANUP_PROBE_NONCE: nonce,
      CLEANUP_EVIDENCE_DIR: evidenceDir,
      MEMORY_SUITE_REGRESSION_LOG: tree.logFile
    };
    runner = spawn(python, [path.join(tree.temp, 'run_regression_batch.py'), '--match', 'probe_test.cjs'], {
      cwd: tree.temp, env, stdio: ['ignore', 'pipe', 'pipe']
    });
    const exited = runnerExit(runner, buffers);
    await waitFor(() => recordsAt(tree.pidFile).length >= expected, 20000,
      'expected owned descendant markers were not written for ' + id);
    if (mode === 'SIGINT' || mode === 'SIGTERM') runner.kill(mode);
    const limit = mode === 'timeout' ? 75000 : 20000;
    outcome = await Promise.race([
      exited,
      pause(limit).then(() => { throw new Error('runner exceeded bounded wait for ' + id); })
    ]);
    elapsed = Date.now() - started;
    pids.push(...recordsAt(tree.pidFile));
    assert.equal(pids.length, expected, 'all expected descendants must be recorded for ' + id);
    assert.ok(controlIsAlive(control), 'unrelated process was affected by runner cleanup for ' + id);
    if (expectedLeak) {
      assert.equal(outcome.code, 0, 'baseline negative-control root should finish normally');
      assert.ok(pids.some(record => exactState(record) === 'live'),
        'baseline negative control must leave the environment-replacing orphan alive');
    } else {
      if (mode === 'normal') assert.equal(outcome.code, 0, 'normal probe runner should pass');
      else assert.notEqual(outcome.code, 0, mode + ' must not report runner success');
      if (mode === 'SIGINT' || mode === 'SIGTERM') {
        assert.match(Buffer.concat(buffers.stderr).toString('utf8'), /interrupted: probe_test\.cjs; terminated [1-9]\d* owned process/,
          'signal cleanup must report targeted owned-process termination');
      }
      await waitFor(() => pids.every(record => exactState(record) === 'gone'), 7000,
        'owned descendants were not terminated and reaped for ' + id);
      if (mode === 'normal') {
        assert.match(fs.readFileSync(tree.logFile, 'utf8'), /probe_test\.cjs: PASS .*posix_owned_leftovers_terminated:[1-9]\d*/,
          'normal cleanup must be recorded in runner log');
      }
      if (mode === 'timeout') {
        assert.match(fs.readFileSync(tree.logFile, 'utf8'), /probe_test\.cjs: TIMEOUT .*posix_owned_tree_terminated/,
          'timeout cleanup must be recorded in runner log');
      }
    }
    writeScenarioEvidence(id, {
      id, kind, mode, expectedOwnedDescendants: expected, elapsed_ms: elapsed,
      runner_exit_code: outcome.code, runner_signal: outcome.signal,
      control_survived_cleanup: true, owned_process_markers: pids,
      expected_baseline_leak: Boolean(expectedLeak), result: 'assertions_passed'
    }, {
      'runner.log': fs.readFileSync(tree.logFile, 'utf8'),
      'runner.stdout.log': Buffer.concat(buffers.stdout),
      'runner.stderr.log': Buffer.concat(buffers.stderr)
    });
    console.log(id + ': PASS ' + elapsed + 'ms; control=alive; owned=' + expected);
  } finally {
    if (runner && runner.exitCode === null && runner.signalCode === null) {
      runner.kill('SIGKILL');
      await Promise.race([new Promise(resolve => runner.once('exit', resolve)), pause(2000)]);
    }
    const known = recordsAt(tree.pidFile);
    try {
      await cleanOwned(known, true);
    } finally {
      try { await stopControl(control); }
      finally { fs.rmSync(tree.temp, { recursive: true, force: true }); }
    }
  }
}

async function runExitStatusProbe() {
  const nonce = crypto.randomUUID();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-cleanup-exit-status-'));
  fs.mkdirSync(path.join(temp, 'tests'));
  fs.copyFileSync(recoveredRunner, path.join(temp, 'run_regression_batch.py'));
  fs.writeFileSync(path.join(temp, 'VERSION.txt'), 'cleanup-exit-status\n');
  fs.writeFileSync(path.join(temp, 'program-manifest.json'), '{"plugins":{}}\n');
  fs.writeFileSync(path.join(temp, 'tests', 'probe_test.cjs'), "process.exit(23);\n");
  const logFile = path.join(temp, 'runner.log');
  const buffers = { stdout: [], stderr: [] };
  const runner = spawn(python, [path.join(temp, 'run_regression_batch.py'), '--match', 'probe_test.cjs'], {
    cwd: temp,
    env: { ...process.env, CLEANUP_PROBE_NONCE: nonce, MEMORY_SUITE_REGRESSION_LOG: logFile },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const outcome = await Promise.race([
      runnerExit(runner, buffers),
      pause(15000).then(() => { throw new Error('exit-status runner exceeded bounded wait'); })
    ]);
    assert.equal(outcome.code, 1, 'nonzero Popen test status must make the runner fail');
    const log = fs.readFileSync(logFile, 'utf8');
    assert.match(log, /probe_test\.cjs: FAIL/, 'runner must preserve and report the nonzero test status');
    writeScenarioEvidence('popen-root-exit-code', {
      scenario: 'Popen root exit-code preservation', expected_test_exit_code: 23,
      runner_exit_code: outcome.code, runner_signal: outcome.signal, result: 'assertions_passed'
    }, {
      'runner.log': log,
      'runner.stdout.log': Buffer.concat(buffers.stdout),
      'runner.stderr.log': Buffer.concat(buffers.stderr)
    });
    console.log('popen-root-exit-code: PASS; exit=23 preserved as runner FAIL');
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) {
      runner.kill('SIGKILL');
      await Promise.race([new Promise(resolve => runner.once('exit', resolve)), pause(2000)]);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

(async () => {
  const baselineMode = process.env.CLEANUP_NEGATIVE_CONTROL === '1';
  if (baselineMode) {
    const baselineRunner = path.resolve(process.env.BASELINE_RUNNER || '');
    assert.ok(fs.existsSync(baselineRunner), 'BASELINE_RUNNER must point to the preserved baseline executor');
    await runScenario('orphan_parent_exits', 'normal', baselineRunner, true);
    console.log('negative control: PASS (baseline executor leaked the expected orphan; exact owned PID was reaped by the test harness)');
    return;
  }
  const cases = ['no_token_child', 'env_replaced_grandchild', 'three_generation', 'orphan_parent_exits'];
  const modes = ['normal', 'SIGINT', 'SIGTERM', 'timeout'];
  for (const kind of cases) for (const mode of modes) {
    await runScenario(kind, mode, recoveredRunner, false);
  }
  await runExitStatusProbe();
  console.log('regression_owned_process_cleanup_test: PASS (16 Linux cleanup conditions; unrelated-process protection; Popen exit-status preservation)');
})().catch(error => {
  console.error('regression_owned_process_cleanup_test: FAIL');
  console.error(error);
  process.exitCode = 1;
});
