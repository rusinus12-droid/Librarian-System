'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { readDataInstanceIdentity, contract: physicalDataIdentityContract } = require('../server/core/data-instance-identity.cjs');

const programDir = path.resolve(__dirname, '..');
const packageRoot = path.resolve(programDir, '..');
const defaultDataDir = path.join(packageRoot, 'DATA');
const SERVER_NAME = 'Librarian System Data Server';
const LEGACY_SERVER_NAMES = new Set(['Memory Suite Data Server']);
const PROTOCOL_MAJOR = 1;
const DEFAULT_CONFIG = Object.freeze({
  schema: 'memory-suite.server-config.v1',
  host: '127.0.0.1',
  port: 47630,
  autoBackup: true,
  computeEnabled: true,
  computeWorkers: 0
});
const BACKGROUND_START_TIMEOUT_MS = 12000;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function parseArgs(argv = process.argv.slice(2)) {
  const result = { command: String(argv[0] || 'serve').toLowerCase(), dataDir: defaultDataDir };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--data-dir') {
      if (!argv[index + 1] || String(argv[index + 1]).startsWith('--')) throw new Error('launcher_data_dir_value_required');
      result.dataDir = path.resolve(argv[++index]);
    } else if (result.command === 'set-remote-access' && ['--enable', '--disable', '--rotate', '--show'].includes(argv[index])) {
      if (result.remoteAction) throw new Error('launcher_remote_action_conflict');
      result.remoteAction = argv[index].slice(2);
    } else if (argv[index] === '--port' && result.command === 'set-port') {
      if (argv[index + 1] === undefined) throw new Error('launcher_port_value_required');
      result.port = String(argv[++index]);
    } else throw new Error(`unknown_launcher_argument:${argv[index]}`);
  }
  if (!['serve', 'background', 'status', 'stop', 'integrity', 'prepare', 'set-port', 'set-remote-access'].includes(result.command)) {
    throw new Error(`unknown_launcher_command:${result.command}`);
  }
  if (result.command === 'set-port' && result.port === undefined) throw new Error('launcher_port_value_required');
  if (result.command === 'set-remote-access' && !result.remoteAction) result.remoteAction = 'show';
  return result;
}

const MIN_SERVER_PORT = 1024, MAX_SERVER_PORT = 65535;
const launcherFailure = (code, message, exitCode) => Object.assign(new Error(message), { code, exitCode });

function portAvailable(host, port, allowIPv4Fallback = false) {
  return new Promise(resolve => {
    const probe = require('node:net').createServer();
    probe.once('error', error => resolve(allowIPv4Fallback && ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)
      ? portAvailable('0.0.0.0', port) : false));
    probe.listen({ host, port, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

// Server configuration changes wait for a finished update and a stopped server, and replace files whole.
function assertNoPendingUpdate(code, subject) {
  const journal = path.join(packageRoot, 'UPDATER', 'update-state.json');
  if (!fs.existsSync(journal)) return;
  let state = null;
  try { state = JSON.parse(fs.readFileSync(journal, 'utf8')); } catch (_) {}
  if (!['complete', 'rolled_back', 'aborted'].includes(String(state?.status || ''))) {
    throw launcherFailure(code, `미완료 업데이트가 있어 ${subject} 바꾸지 않았습니다. 서버를 한 번 실행해 업데이트 복구를 끝낸 뒤 다시 시도하세요.`, 5);
  }
}
async function assertServerStopped(config, code) {
  try {
    await health(config.url, 2000);
  } catch (error) {
    if (error?.code === 'SERVER_UNAVAILABLE') return;
    throw launcherFailure(code, `현재 포트 ${config.port}에서 응답하는 프로그램이 있어 서버가 꺼졌는지 확인하지 못했습니다. 서버를 끈 뒤 다시 시도하세요.`, 3);
  }
  throw launcherFailure(code, `서버가 현재 포트 ${config.port}에서 실행 중입니다. 먼저 2_서버_종료로 서버를 끈 뒤 다시 시도하세요.`, 3);
}
function writeFileAtomically(filePath, text) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  try { fs.renameSync(temporary, filePath); }
  catch (error) { try { fs.rmSync(temporary, { force: true }); } catch (_) {} throw error; }
}

// The server port lives only in DATA/config/server-config.json; every launcher, admin tool and
// the updater read it from there. It is changed only while the server is stopped, so a running
// server never loses the port its plugins are using, and only to a port nothing else holds.
async function setServerPort(dataDir, requested, options = {}) {
  const write = options.write || (text => process.stdout.write(text));
  const textValue = String(requested ?? '').trim();
  const port = Number(textValue);
  if (!/^\d+$/.test(textValue) || !Number.isInteger(port) || port < MIN_SERVER_PORT || port > MAX_SERVER_PORT) {
    throw launcherFailure('SERVER_PORT_INVALID', `포트는 ${MIN_SERVER_PORT}~${MAX_SERVER_PORT} 사이의 숫자여야 합니다. 입력값: ${textValue || '(비어 있음)'}`, 2);
  }
  assertNoPendingUpdate('SERVER_PORT_UPDATE_PENDING', '포트를');
  if (options.prepare !== false) prepareData(dataDir);
  const config = readConfig(dataDir);
  if (config.port === port) {
    write(`[Librarian System] 서버 포트는 이미 ${port}입니다. 바꾸지 않았습니다.\n서버 주소: ${config.url}\n`);
    return { changed: false, port, url: config.url };
  }
  await assertServerStopped(config, 'SERVER_PORT_SERVER_RUNNING');
  const bindHost = config.remoteAccess ? '::' : config.host === 'localhost' ? '127.0.0.1' : config.host;
  if (!(await portAvailable(bindHost, port, config.remoteAccess && config.host !== '::1'))) {
    throw launcherFailure('SERVER_PORT_IN_USE', `포트 ${port}는 다른 프로그램이 사용 중입니다. 다른 포트를 고르세요.`, 4);
  }
  writeFileAtomically(config.configPath, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(config.configPath, 'utf8')), port }, null, 2)}\n`);
  const saved = readConfig(dataDir);
  if (saved.port !== port) throw launcherFailure('SERVER_PORT_READBACK_FAILED', '포트를 저장했지만 다시 읽은 값이 다릅니다. 설정 파일을 확인하세요.', 6);
  write([
    `[Librarian System] 서버 포트를 ${config.port} → ${port}로 바꿨습니다.`,
    `새 서버 주소: ${saved.url}`,
    '',
    '서버를 다시 실행한 뒤, RisuAI의 각 플러그인에서 서버 주소를 새 주소로 바꿔 주세요.',
    '플러그인마다 주소를 따로 저장하므로 한 곳만 바꾸면 나머지는 예전 포트에 남습니다.',
    '업데이트 직후라면 포트를 바꾸기 전에 기존 주소에서 서버 단독 플러그인이 한 번 정상 연결되도록 해 주세요. DATA 식별값은 자동으로 저장됩니다.',
    '  - LIBRA · HAYAKU · Flashback: 서버 연결 설정 → 서버 주소',
    '  - GRADIA: 소스 탭 → 서버 주소',
    '  - RE:TRACE: 서버 관리 → 연결 진단 → 서버 주소',
    '  LIA는 서버를 쓰지 않으므로 바꾸지 않아도 됩니다.',
    '',
    `설정 파일: ${saved.configPath}`,
    ''
  ].join('\n'));
  return { changed: true, previousPort: config.port, port, url: saved.url };
}

// Remote access (Docker and other hosts): the server then listens on every interface, and a client
// that is not on this machine receives a token only with the key in DATA/config/remote-access-key.txt.
// Requests from this machine keep working without the key.
const REMOTE_ACCESS_ACTIONS = Object.freeze(['enable', 'disable', 'rotate', 'show']);
async function setRemoteAccess(dataDir, action, options = {}) {
  const write = options.write || (text => process.stdout.write(text));
  if (!REMOTE_ACCESS_ACTIONS.includes(action)) throw launcherFailure('SERVER_REMOTE_ACTION_INVALID', `알 수 없는 동작입니다: ${action || '(비어 있음)'}. enable · disable · rotate · show 중 하나를 고르세요.`, 2);
  if (options.prepare !== false) prepareData(dataDir);
  const config = readConfig(dataDir);
  const keyPath = path.join(dataDir, 'config', 'remote-access-key.txt');
  const readKey = () => { try { const key = fs.readFileSync(keyPath, 'utf8').trim(); return /^[A-Za-z0-9_-]{32,256}$/.test(key) ? key : ''; } catch (_) { return ''; } };
  const keyLines = key => [
    `접근 키: ${key}`,
    '',
    '이 키는 이 DATA에 접속할 수 있는 열쇠입니다. 믿을 수 있는 곳에만 입력하세요.',
    '내부 네트워크 바깥(인터넷 · VPN)에서 연결하는 플러그인만 서버 연결 설정의 "접근 키"에 이 값을 넣으세요.',
    '  - LIBRA · HAYAKU · Flashback: 서버 연결 설정 → 접근 키',
    '  - RE:TRACE: 서버 관리 → 연결 진단 → 접근 키',
    '  - GRADIA는 LIBRA에 저장한 접근 키를 함께 씁니다.',
    '이 PC, 같은 내부 네트워크(사설 IP), 이 PC의 Docker 컨테이너에서 오는 연결은 키가 없어도 됩니다.'
  ];
  if (action === 'show') {
    const key = readKey();
    write([`[Librarian System] 외부 접속: ${config.remoteAccess ? '켜짐' : '꺼짐'}`, ...(config.remoteAccess && key ? ['', ...keyLines(key)] : []), ''].join('\n'));
    return { enabled: config.remoteAccess, keyPresent: !!key };
  }
  assertNoPendingUpdate('SERVER_REMOTE_UPDATE_PENDING', '외부 접속 설정을');
  await assertServerStopped(config, 'SERVER_REMOTE_SERVER_RUNNING');
  let key = readKey();
  if (action === 'rotate' || (action === 'enable' && !key)) {
    key = crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    writeFileAtomically(keyPath, `${key}\n`);
    if (readKey() !== key) throw launcherFailure('SERVER_REMOTE_KEY_READBACK_FAILED', '접근 키를 저장했지만 다시 읽은 값이 다릅니다.', 6);
  }
  const enabled = action === 'disable' ? false : action === 'enable' ? true : config.remoteAccess;
  if (enabled !== config.remoteAccess) {
    const raw = JSON.parse(fs.readFileSync(config.configPath, 'utf8'));
    writeFileAtomically(config.configPath, `${JSON.stringify({ ...raw, remoteAccess: { enabled } }, null, 2)}\n`);
    if (readConfig(dataDir).remoteAccess !== enabled) throw launcherFailure('SERVER_REMOTE_READBACK_FAILED', '외부 접속 설정을 저장했지만 다시 읽은 값이 다릅니다.', 6);
  }
  const lines = action === 'disable'
    ? ['[Librarian System] 외부 접속을 껐습니다. 서버는 다시 이 PC(127.0.0.1)에서만 연결을 받습니다.', '접근 키 파일은 남겨 두었습니다. 다시 켜면 같은 키를 씁니다.']
    : [action === 'rotate' ? '[Librarian System] 접근 키를 새로 만들었습니다. 예전 키로는 더 이상 새 연결을 받지 않습니다.' : '[Librarian System] 외부 접속을 켰습니다.',
      ...(enabled ? [`서버를 다시 실행하면 모든 네트워크 주소의 포트 ${config.port}에서 연결을 받습니다.`] : ['외부 접속은 꺼져 있습니다. 켜면 이 키를 씁니다.']),
      '', ...keyLines(key)];
  write(`${lines.join('\n')}\n`);
  return { enabled, rotated: action === 'rotate', keyPath };
}

function runChecked(script, args = [], options = {}) {
  const timeout = Math.max(0, Number(options.timeoutMs || 0) || 0);
  const result = spawnSync(process.execPath, ['--no-warnings', script, ...args], {
    cwd: programDir,
    encoding: 'utf8',
    stdio: options.capture === true ? 'pipe' : 'inherit',
    ...(timeout ? { timeout, killSignal: 'SIGTERM' } : {})
  });
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      const error = new Error(`launcher_child_timeout:${path.basename(script)}:${timeout}ms`);
      error.code = 'LAUNCHER_CHILD_TIMEOUT';
      error.exitCode = 124;
      throw error;
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    const error = new Error(detail || `launcher_child_failed:${path.basename(script)}:${result.status}`);
    error.exitCode = Number(result.status || 1);
    throw error;
  }
  return result;
}

function assertNodeRuntime() {
  runChecked(path.join(programDir, 'tools', 'check_node.cjs'), [], { capture: true, timeoutMs: 5000 });
}

function canonicalizePotentialPath(value) {
  const resolved = path.resolve(value);
  const suffix = [];
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  let canonicalBase = existing;
  try { canonicalBase = fs.realpathSync.native(existing); } catch (_) {}
  return path.resolve(canonicalBase, ...suffix);
}

function isTermuxRuntime(environment = process.env, platform = process.platform) {
  return platform === 'android'
    || !!String(environment.TERMUX_VERSION || '').trim()
    || /(?:^|\/)com\.termux(?:\/|$)/i.test(String(environment.PREFIX || ''));
}

function assertSafeDataDir(dataDir, environment = process.env, platform = process.platform) {
  const raw = String(dataDir || '');
  const simulatedPosix = process.platform === 'win32'
    && platform !== 'win32'
    && /^\//.test(raw.replace(/\\/g, '/'));
  const canonical = simulatedPosix ? path.posix.resolve(raw.replace(/\\/g, '/')) : canonicalizePotentialPath(raw);
  if (!isTermuxRuntime(environment, platform)) return canonical;
  const normalized = canonical.replace(/\\/g, '/').toLowerCase();
  if (/^\/(?:sdcard|storage|mnt\/media_rw|mnt\/runtime|mnt\/user|data\/media)(?:\/|$)/.test(normalized)) {
    const error = new Error(`android_shared_storage_data_dir_blocked:${canonical}`);
    error.code = 'ANDROID_SHARED_STORAGE_DATA_DIR_BLOCKED';
    error.exitCode = 3;
    throw error;
  }
  return canonical;
}


function recoverPendingUpdaterStateBeforeServerStart() {
  if (String(process.env.LIBRARIAN_UPDATER_INTERNAL || '') === '1') return;
  const updater = path.join(packageRoot, 'UPDATER', 'updater.cjs');
  const journal = path.join(packageRoot, 'UPDATER', 'update-state.json');
  if (!fs.existsSync(updater) || !fs.existsSync(journal)) return;
  let state = null;
  try { state = JSON.parse(fs.readFileSync(journal, 'utf8')); } catch (_) {
    throw new Error('updater_recovery_journal_unreadable');
  }
  if (['complete','rolled_back','aborted'].includes(String(state?.status || ''))) return;
  process.stderr.write('[LIBRARIAN SYSTEM] 미완료 업데이트가 발견되어 안전 복구를 먼저 수행합니다.\n');
  const result = spawnSync(process.execPath, ['--no-warnings', updater, '--recover'], {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    env: { ...process.env, LIBRARIAN_UPDATER_INTERNAL: '1' },
    timeout: 180000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`updater_recovery_failed:${result.status}`);
}

function prepareData(dataDir) {
  return runChecked(path.join(programDir, 'tools', 'prepare_data.cjs'), [
    '--program-dir', programDir,
    '--data-dir', dataDir
  ], { capture: true });
}

function readConfig(dataDir, options = {}) {
  const configPath = path.join(dataDir, 'config', 'server-config.json');
  let config = null;
  if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  else if (options.allowMissing === true) config = { ...DEFAULT_CONFIG };
  else throw new Error(`server_config_missing:${configPath}`);
  if (config.schema !== DEFAULT_CONFIG.schema) throw new Error('invalid_server_config_schema');
  const host = String(config.host || '').trim().toLowerCase();
  const port = Number(config.port);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('server_config_host_must_be_loopback');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('server_config_port_invalid');
  // Server Compute is retired: computeEnabled/computeWorkers in an existing config are accepted
  // and ignored, whatever their value.
  const urlHost = host === '::1' ? '[::1]' : host;
  return {
    host,
    port,
    autoBackup: config.autoBackup !== false,
    // Opt-in: the server then listens on every interface and keys non-loopback /bootstrap requests.
    remoteAccess: config.remoteAccess?.enabled === true,
    url: `http://${urlHost}:${port}`,
    configPath
  };
}

function dataInstanceIdForToken(token) {
  const normalized = String(token || '').trim();
  if (normalized.length < 32) throw new Error('runtime_token_is_invalid');
  return crypto.createHmac('sha256', normalized)
    .update('memory-suite.data-instance.v1', 'utf8')
    .digest('base64url')
    .slice(0, 24);
}

function readLocalDataInstanceId(dataDir, options = {}) {
  const tokenPath = path.join(dataDir, 'runtime-token.txt');
  if (!fs.existsSync(tokenPath)) {
    if (options.required === true) throw new Error(`runtime_token_is_unavailable:${tokenPath}`);
    return '';
  }
  return dataInstanceIdForToken(fs.readFileSync(tokenPath, 'utf8'));
}

async function health(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    let response;
    try { response = await fetch(`${url}/health`, { signal: controller.signal }); }
    catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        const timeoutError = new Error(`server_health_timeout:${url}:${timeoutMs}ms`);
        timeoutError.code = 'SERVER_HEALTH_TIMEOUT';
        throw timeoutError;
      }
      const causeCode = String(error?.cause?.code || error?.code || '');
      if (['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND'].includes(causeCode)) {
        const unavailable = new Error(`server_unavailable:${url}:${causeCode}`);
        unavailable.code = 'SERVER_UNAVAILABLE';
        throw unavailable;
      }
      const probeError = new Error(`server_health_probe_failed:${url}:${String(error?.message || error)}`);
      probeError.code = 'SERVER_HEALTH_PROBE_FAILED';
      throw probeError;
    }
    const raw = await response.text();
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : null; }
    catch (_) {
      const error = new Error(`server_health_invalid_json:${url}:${raw.slice(0, 200)}`);
      error.code = 'SERVER_HEALTH_INVALID';
      throw error;
    }
    if (!response.ok || payload?.ok !== true) {
      const error = new Error(payload?.error || `server_health_http_${response.status}`);
      error.code = 'SERVER_HEALTH_INVALID';
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function validateServerIdentity(payload, dataDir, options = {}) {
  const actualName = String(payload?.name || '');
  if (actualName !== SERVER_NAME && !LEGACY_SERVER_NAMES.has(actualName)) {
    const error = new Error(`server_identity_mismatch:expected=${SERVER_NAME}:actual=${String(payload?.name || 'unknown')}`);
    error.code = 'SERVER_IDENTITY_MISMATCH';
    throw error;
  }
  if (Number(payload?.protocol?.major) !== PROTOCOL_MAJOR) {
    const error = new Error(`server_protocol_mismatch:expected=${PROTOCOL_MAJOR}:actual=${String(payload?.protocol?.major ?? 'unknown')}`);
    error.code = 'SERVER_PROTOCOL_MISMATCH';
    throw error;
  }
  const expected = payload?.dataIdentityContract===physicalDataIdentityContract
    ? readDataInstanceIdentity(dataDir).dataInstanceId
    : readLocalDataInstanceId(dataDir, { required: options.requireDataInstance === true });
  if (expected && String(payload?.dataInstanceId || '') !== expected) {
    const error = new Error('server_data_instance_mismatch:the_port_is_used_by_a_different_MEMORY_SUITE_DATA');
    error.code = 'SERVER_DATA_INSTANCE_MISMATCH';
    throw error;
  }
  return payload;
}

async function inspectExistingServer(config, dataDir, options = {}) {
  try {
    const payload = await health(config.url, options.timeoutMs || 800);
    return validateServerIdentity(payload, dataDir, { requireDataInstance: options.requireDataInstance !== false });
  } catch (error) {
    if (error?.code === 'SERVER_UNAVAILABLE') return null;
    throw error;
  }
}

function serverArguments(config, dataDir) {
  return [
    '--no-warnings', path.join(programDir, 'server', 'server.cjs'), 'serve',
    '--host', config.host,
    '--port', String(config.port),
    '--data-dir', dataDir,
    // The child resolves these preferences only after its own restore recovery.
    '--portable-settings-from-data'
  ];
}

function admin(command, config, dataDir) {
  const requestTimeoutMs = command === 'stop' ? 5000 : 120000;
  return runChecked(path.join(programDir, 'server', 'admin.cjs'), [
    command, '--url', config.url, '--data-dir', dataDir,
    '--timeout-ms', String(requestTimeoutMs)
  ], { timeoutMs: requestTimeoutMs + 3000 });
}

async function verifiedAdmin(command, config, dataDir) {
  const payload = await inspectExistingServer(config, dataDir, { timeoutMs: 2000 });
  if (!payload) {
    const error = new Error(`server_unavailable:${config.url}`);
    error.code = 'SERVER_UNAVAILABLE';
    throw error;
  }
  return admin(command, config, dataDir);
}

function logTail(logPath, maxBytes = 8192) {
  try {
    if (!fs.existsSync(logPath)) return '';
    const stat = fs.statSync(logPath);
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    const fd = fs.openSync(logPath, 'r');
    try { fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size)); }
    finally { fs.closeSync(fd); }
    return buffer.toString('utf8')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, '$1[REDACTED]')
      .trim();
  } catch (_) { return ''; }
}

async function terminateLaunchedChild(child) {
  if (!child || child.exitCode != null || child.signalCode) return;
  try { child.kill('SIGTERM'); } catch (_) { return; }
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]);
  if (child.exitCode == null && !child.signalCode) {
    try { child.kill('SIGKILL'); } catch (_) {}
  }
}

async function serveForeground(config, dataDir) {
  const existing = await inspectExistingServer(config, dataDir, { timeoutMs: 800 });
  if (existing) {
    process.stdout.write(`[LIBRARIAN SYSTEM] Already running at ${config.url} · v${existing.version || 'unknown'} · DATA ${existing.dataInstanceId}\n`);
    process.stdout.write('This is a launcher window. Closing it leaves the existing server running. Use the stop launcher to stop the server.\n');
    return;
  }
  process.stdout.write(`[LIBRARIAN SYSTEM] Starting foreground server at ${config.url}\n`);
  process.stdout.write(`[LIBRARIAN SYSTEM] DATA: ${dataDir}\n`);
  process.stdout.write('[LIBRARIAN SYSTEM] This window hosts the foreground server. Closing it stops that server. For a safe shutdown, use the stop launcher.\n');
  const child = spawn(process.execPath, serverArguments(config, dataDir), { cwd: programDir, stdio: 'inherit' });
  const forward = signal => { try { if (!child.killed) child.kill(signal); } catch (_) {} };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0 && result.code != null) throw Object.assign(new Error(`server_exit:${result.code}`), { exitCode: result.code });
}

async function serveBackground(config, dataDir) {
  const existing = await inspectExistingServer(config, dataDir, { timeoutMs: 800 });
  if (existing) {
    process.stdout.write(`[LIBRARIAN SYSTEM] Already running at ${config.url} · v${existing.version || 'unknown'} · DATA ${existing.dataInstanceId}\n`);
    process.stdout.write('This is a launcher window. Closing it leaves the existing server running. Use the stop launcher to stop the server.\n');
    return;
  }
  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, 'server.log');
  const logFd = fs.openSync(logPath, 'a');
  let child = null;
  let childFailure = null;
  try {
    child = spawn(process.execPath, serverArguments(config, dataDir), {
      cwd: programDir,
      detached: true,
      stdio: ['ignore', logFd, logFd]
    });
    child.once('error', error => { childFailure = error; });
    child.once('exit', (code, signal) => {
      childFailure = new Error(`background_server_exit_before_ready:code=${code}:signal=${signal || ''}`);
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }
  const deadline = Date.now() + BACKGROUND_START_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      if (childFailure) throw childFailure;
      await delay(150);
      if (childFailure) throw childFailure;
      try {
        const payload = await inspectExistingServer(config, dataDir, { timeoutMs: 500 });
        if (payload) {
          process.stdout.write(`[LIBRARIAN SYSTEM] Background server ready at ${config.url} · v${payload.version || 'unknown'} · DATA ${payload.dataInstanceId}\n`);
          process.stdout.write(`[LIBRARIAN SYSTEM] Log: ${logPath}\n`);
          process.stdout.write('This is a launcher window. Closing it leaves the background server running. Use the stop launcher to stop the server.\n');
          return;
        }
      } catch (error) {
        if (error?.code === 'SERVER_HEALTH_TIMEOUT') continue;
        throw error;
      }
    }
    throw new Error(`background_server_start_timeout:${BACKGROUND_START_TIMEOUT_MS}ms:pid=${child?.pid || 0}`);
  } catch (error) {
    await terminateLaunchedChild(child);
    const tail = logTail(logPath);
    if (tail) error.message = `${error.message}\n--- server.log tail ---\n${tail}`;
    throw error;
  }
}

async function main() {
  const args = parseArgs();
  assertNodeRuntime();
  args.dataDir = assertSafeDataDir(args.dataDir);
  if (args.command === 'prepare') {
    prepareData(args.dataDir);
    process.stdout.write(`[LIBRARIAN SYSTEM] DATA ready: ${args.dataDir}\n`);
    return;
  }
  if (args.command === 'set-port') return await setServerPort(args.dataDir, args.port);
  if (args.command === 'set-remote-access') return await setRemoteAccess(args.dataDir, args.remoteAction);
  if (args.command === 'serve' || args.command === 'background') {
    recoverPendingUpdaterStateBeforeServerStart();
    prepareData(args.dataDir);
    const config = readConfig(args.dataDir);
    if (args.command === 'serve') return await serveForeground(config, args.dataDir);
    return await serveBackground(config, args.dataDir);
  }
  const config = readConfig(args.dataDir, { allowMissing: true });
  if (args.command === 'status') {
    const payload = await inspectExistingServer(config, args.dataDir, { timeoutMs: 2000 });
    if (!payload) throw Object.assign(new Error(`server_unavailable:${config.url}`), { code: 'SERVER_UNAVAILABLE' });
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.stderr.write("This is a status window. Closing it does not stop the server.\n");
    return;
  }
  if (args.command === 'stop') return await verifiedAdmin('stop', config, args.dataDir);
  if (args.command === 'integrity') return await verifiedAdmin('integrity', config, args.dataDir);
}

if (require.main === module) {
  main().catch(error => {
    // A refused port change is the user's answer, not a crash: show the guidance without a stack.
    if (/^SERVER_(?:PORT|REMOTE)_/.test(String(error?.code || ''))) process.stderr.write(`[Librarian System] ${error.message}\n`);
    else process.stderr.write(`[LIBRARIAN SYSTEM LAUNCHER] ${String(error?.stack || error)}\n`);
    process.exitCode = Number(error?.exitCode || 1);
  });
}

module.exports = {
  parseArgs,
  readConfig,
  serverArguments,
  health,
  dataInstanceIdForToken,
  readLocalDataInstanceId,
  validateServerIdentity,
  inspectExistingServer,
  canonicalizePotentialPath,
  isTermuxRuntime,
  assertSafeDataDir,
  setServerPort,
  setRemoteAccess
};
