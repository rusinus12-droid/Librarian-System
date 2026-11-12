'use strict';

// Opens the server to the owner's other devices through `tailscale serve`, closes it, and reports it.
// The server keeps listening on loopback only; Tailscale's own background service forwards
// https://<this machine>.<tailnet>.ts.net (port 443) to http://127.0.0.1:<server port>. Only our own
// 443 entry is ever touched: another serve entry is reported, never replaced or removed.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HTTPS_PORT = 443;
const MIN_VERSION = [1, 52, 0];
const SERVE_TIMEOUT_MS = 300000;

const failure = (code, message, exitCode = 2) => Object.assign(new Error(message), { code, exitCode });
const DOCKER_DEFAULT_PORT = 47630;
// A Docker server's DATA lives in its volume, not on this PC: its mode is fixed (remote) and its
// port is the one compose.yaml publishes (--port when it was changed).
const serverConfig = context => context.docker
  ? { port: Number(context.port || DOCKER_DEFAULT_PORT), remoteAccess: true }
  : { ...context.readConfig(context.dataDir), ...(context.port ? { port: Number(context.port) } : {}) };

function tailscaleCandidates(env = process.env, platform = process.platform) {
  const list = [];
  if (env.LIBRARIAN_TAILSCALE) list.push(env.LIBRARIAN_TAILSCALE);
  list.push('tailscale');
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean)) {
      list.push(path.join(base, 'Tailscale', 'tailscale.exe'));
    }
  }
  if (platform === 'darwin') list.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale');
  return [...new Set(list)];
}

function systemRunner(env = process.env, platform = process.platform) {
  let binary = null;
  const exec = (bin, args, options = {}) => spawnSync(bin, args, {
    encoding: 'utf8', windowsHide: true, timeout: options.timeoutMs || 20000,
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']
  });
  return (args, options = {}) => {
    if (!binary) {
      for (const candidate of tailscaleCandidates(env, platform)) {
        if (candidate !== 'tailscale' && !fs.existsSync(candidate)) continue;
        const probe = exec(candidate, ['version']);
        if (!probe.error && probe.status === 0) { binary = candidate; break; }
      }
      if (!binary) return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('tailscale_not_found'), { code: 'ENOENT' }) };
    }
    return exec(binary, args, options);
  };
}

const versionAtLeast = (text, minimum) => {
  const match = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
};

// Tailscale installed, recent enough, and logged in. Returns this machine's ts.net name.
function inspectTailscale(run) {
  const version = run(['version']);
  if (version.error || version.status !== 0) {
    throw failure('TUNNEL_TAILSCALE_MISSING', 'Tailscale을 찾지 못했습니다. https://tailscale.com/download 에서 설치하고 로그인한 뒤 다시 실행하세요.\n이 PC와 접속할 기기(폰 포함)에 모두 설치하고 같은 계정으로 로그인해야 합니다.', 3);
  }
  if (!versionAtLeast(version.stdout, MIN_VERSION)) {
    throw failure('TUNNEL_TAILSCALE_OLD', `Tailscale ${String(version.stdout).split(/\r?\n/)[0].trim()}은(는) 너무 오래되었습니다. ${MIN_VERSION.join('.')} 이상으로 업데이트한 뒤 다시 실행하세요.`, 3);
  }
  const statusResult = run(['status', '--json']);
  let status = null;
  try { status = JSON.parse(statusResult.stdout || ''); } catch (_) {}
  if (!status || status.BackendState !== 'Running') {
    throw failure('TUNNEL_TAILSCALE_LOGIN', `Tailscale에 로그인되어 있지 않거나 연결이 꺼져 있습니다${status?.BackendState ? ` (${status.BackendState})` : ''}. Tailscale 앱에서 로그인하고 연결을 켠 뒤 다시 실행하세요.`, 3);
  }
  const dnsName = String(status.Self?.DNSName || '').replace(/\.$/, '');
  if (!dnsName) throw failure('TUNNEL_TAILSCALE_NO_NAME', 'Tailscale이 이 PC의 이름(ts.net 주소)을 알려 주지 않았습니다. Tailscale 관리 화면에서 MagicDNS를 켠 뒤 다시 실행하세요.', 3);
  return { dnsName, url: `https://${dnsName}` };
}

const ourProxy = port => new RegExp(`^http://(?:127\\.0\\.0\\.1|localhost):${Number(port)}/?$`);

// What the 443 entry of this machine forwards to: ours (this server's port), someone else's, or nothing.
function readServe(run, dnsName, port) {
  const result = run(['serve', 'status', '--json']);
  if (result.error || result.status !== 0) {
    throw failure('TUNNEL_SERVE_STATUS_FAILED', `tailscale serve 상태를 읽지 못했습니다: ${String(result.stderr || result.error?.message || '').trim() || '알 수 없는 오류'}`, 4);
  }
  let config = {};
  const text = String(result.stdout || '').trim();
  if (text) { try { config = JSON.parse(text); } catch (_) { throw failure('TUNNEL_SERVE_STATUS_FAILED', 'tailscale serve 상태를 해석하지 못했습니다.', 4); } }
  const web = config?.Web || {};
  const key = Object.keys(web).find(name => name.toLowerCase() === `${dnsName}:${HTTPS_PORT}`.toLowerCase());
  const handlers = key ? web[key]?.Handlers || {} : {};
  const tcp = config?.TCP?.[String(HTTPS_PORT)];
  const proxy = String(handlers['/']?.Proxy || '');
  const ours = !!proxy && ourProxy(port).test(proxy) && Object.keys(handlers).length === 1;
  const occupied = !!tcp || Object.keys(handlers).length > 0;
  const funnel = !!(key && config?.AllowFunnel?.[key]);
  return { ours, other: occupied && !ours, proxy, funnel };
}

const describe = (serve, url, port) => serve.ours
  ? `열림 · ${url} → http://127.0.0.1:${port}${serve.funnel ? ' · 경고: Funnel이 켜져 있어 인터넷 전체에 공개됨' : ''}`
  : serve.other ? `다른 항목이 443을 쓰는 중 (${serve.proxy || 'TCP 전달'}) · 이 도구는 건드리지 않습니다` : '닫힘';

async function openTunnel(context) {
  const { run, write, confirm, setRemoteAccess, dataDir, docker, termux, container } = context;
  if (container) throw failure('TUNNEL_IN_CONTAINER', '컨테이너 안에서는 열 수 없습니다. Docker 서버를 실행한 PC에서 서버_원격접속_열기를 Docker 서버용(--docker)으로 실행하세요.', 2);
  if (termux) throw failure('TUNNEL_TERMUX_UNSUPPORTED', '안드로이드(Termux)에서는 tailscale serve를 쓸 수 없습니다. 원격 접속 모드는 쓸 수 있지만, 다른 기기가 이 폰의 서버에 붙게 하는 기능은 지원하지 않습니다.', 2);
  const tailnet = inspectTailscale(run);
  const config = serverConfig(context);
  const port = config.port;
  let switched = false;
  if (!docker && !config.remoteAccess) {
    write('[Librarian System] 지금은 내부 접속 모드입니다. 다른 기기를 받으려면 원격 접속 모드가 필요합니다.\n원격 접속 모드에서는 이 PC의 플러그인도 접근 키를 넣어야 합니다.\n');
    if (!(await confirm('원격 접속 모드로 바꿀까요? (y/N) '))) {
      throw failure('TUNNEL_REMOTE_MODE_DECLINED', '원격 접속 모드가 꺼져 있어 열지 않았습니다. 터널만 열면 다른 기기가 키 없이 들어오므로 열 수 없습니다.', 5);
    }
    await setRemoteAccess(dataDir, 'remote', { write });
    switched = true;
  }
  const before = readServe(run, tailnet.dnsName, port);
  if (before.other) {
    throw failure('TUNNEL_PORT_OCCUPIED', `이 PC의 Tailscale 443 포트를 다른 항목이 쓰고 있습니다 (${before.proxy || 'TCP 전달'}).\n이 도구는 다른 항목을 바꾸지 않습니다. 직접 정리한 뒤 다시 실행하세요. 확인: tailscale serve status`, 4);
  }
  if (!before.ours) {
    write(`[Librarian System] tailscale serve로 ${tailnet.url} → http://127.0.0.1:${port} 를 엽니다.\n처음이면 HTTPS 인증서를 켜라는 안내와 링크가 나올 수 있습니다. 링크를 열어 켜면 이어서 진행됩니다.\n\n`);
    const opened = run(['serve', '--bg', `--https=${HTTPS_PORT}`, `http://127.0.0.1:${port}`], { inherit: true, timeoutMs: SERVE_TIMEOUT_MS });
    if (opened.error || opened.status !== 0) {
      throw failure('TUNNEL_SERVE_FAILED', `tailscale serve가 실패했습니다${opened.error?.code === 'ETIMEDOUT' ? ' (시간 초과: HTTPS 인증서를 켰는지 확인하세요)' : ''}. 위의 메시지를 확인한 뒤 다시 실행하세요.`, 4);
    }
  }
  const after = readServe(run, tailnet.dnsName, port);
  if (!after.ours) throw failure('TUNNEL_SERVE_UNVERIFIED', 'tailscale serve를 실행했지만 이 서버로 연결되는 항목을 확인하지 못했습니다. tailscale serve status로 확인하세요.', 4);
  const key = docker ? '' : (() => { try { return fs.readFileSync(path.join(dataDir, 'config', 'remote-access-key.txt'), 'utf8').trim(); } catch (_) { return ''; } })();
  write([
    '',
    `[Librarian System] ${before.ours ? '이미 열려 있습니다.' : '열었습니다.'}`,
    `다른 기기의 플러그인에 넣을 서버 주소: ${tailnet.url}`,
    docker ? '접근 키: docker compose -f PROGRAM/docker/compose.yaml run --rm librarian set-remote-access --show 로 확인하세요.' : `접근 키: ${key || '(없음: 서버_외부접속_설정 show로 확인)'}`,
    '',
    '- 같은 Tailscale 계정에 로그인한 기기에서만 접속할 수 있습니다.',
    '- 창을 닫거나 PC를 재부팅해도 닫기 전까지 열려 있습니다. Tailscale 서비스가 연결을 넘겨 줍니다.',
    `- 닫기: 서버_원격접속_열기의 "닫기", 또는 tailscale serve --https=${HTTPS_PORT} off`,
    ...(switched ? ['- 방금 원격 접속 모드로 바꿨습니다. 서버를 다시 실행해야 반영되고, 이 PC의 플러그인에도 접근 키를 넣어야 합니다.'] : []),
    ...(docker ? ['- Docker 서버는 compose.yaml이 이 PC의 127.0.0.1:' + port + '에 연 포트로 연결됩니다.'] : ['- 서버가 원격 접속 모드로 실행 중이어야 연결됩니다.']),
    ...(after.funnel ? ['- 경고: 이 주소에 Funnel이 켜져 있어 인터넷 전체에 공개됩니다. tailscale funnel --https=443 off 로 끄세요.'] : []),
    ''
  ].join('\n'));
  return { opened: !before.ours, url: tailnet.url, port, switched };
}

function closeTunnel(context) {
  const { run, write } = context;
  const tailnet = inspectTailscale(run);
  const port = serverConfig(context).port;
  const serve = readServe(run, tailnet.dnsName, port);
  if (serve.other) {
    write(`[Librarian System] 443 포트는 이 서버가 아닌 다른 항목(${serve.proxy || 'TCP 전달'})이 쓰고 있어 건드리지 않았습니다.\n`);
    return { closed: false, reason: 'other' };
  }
  if (!serve.ours) {
    write('[Librarian System] 이 서버로 열린 tailscale serve가 없습니다. 이미 닫혀 있습니다.\n');
    return { closed: false, reason: 'not_open' };
  }
  const off = run(['serve', `--https=${HTTPS_PORT}`, 'off']);
  if (off.error || off.status !== 0) throw failure('TUNNEL_CLOSE_FAILED', `tailscale serve를 닫지 못했습니다: ${String(off.stderr || off.error?.message || '').trim() || '알 수 없는 오류'}`, 4);
  if (readServe(run, tailnet.dnsName, port).ours) throw failure('TUNNEL_CLOSE_UNVERIFIED', '닫기 명령은 성공했지만 항목이 남아 있습니다. tailscale serve status로 확인하세요.', 4);
  write(`[Librarian System] 닫았습니다. ${tailnet.url} 로는 더 이상 연결되지 않습니다.\n`);
  return { closed: true };
}

function tunnelStatus(context) {
  const { run, write, docker, container } = context;
  const config = serverConfig(context);
  const port = config.port;
  const mode = docker || container ? '원격 접속 모드 (Docker 고정)' : config.remoteAccess ? '원격 접속 모드' : '내부 접속 모드';
  let tailnet = null, serve = null, problem = '';
  try { tailnet = inspectTailscale(run); serve = readServe(run, tailnet.dnsName, port); }
  catch (error) { problem = error.message; }
  write([
    `[Librarian System] 서버 접속 모드: ${mode} · 포트 ${port}`,
    `Tailscale: ${problem || `로그인됨 · ${tailnet.url}`}`,
    ...(serve ? [`원격 접속 터널: ${describe(serve, tailnet.url, port)}`] : []),
    ...(serve?.ours && !docker && !config.remoteAccess ? ['경고: 내부 접속 모드인데 터널이 열려 있어 다른 기기가 키 없이 들어올 수 있습니다. 닫거나 원격 접속 모드로 바꾸세요.'] : []),
    ''
  ].join('\n'));
  return { mode, port, url: tailnet?.url || '', open: !!serve?.ours, other: !!serve?.other, problem };
}

// Used when the server goes back to local mode: our serve entry would let other devices in without a key.
async function closeTunnelForLocalMode(context) {
  const { run, write, confirm } = context;
  let tailnet, serve;
  try { tailnet = inspectTailscale(run); serve = readServe(run, tailnet.dnsName, serverConfig(context).port); }
  catch (_) { return { checked: false }; }
  if (!serve.ours) return { checked: true, open: false };
  write(`\n[Librarian System] tailscale serve가 아직 이 서버로 열려 있습니다 (${tailnet.url}).\n내부 접속 모드에서 열어 두면 다른 기기가 키 없이 들어올 수 있습니다.\n`);
  if (!(await confirm('지금 닫을까요? (Y/n) ', true))) {
    write(`닫지 않았습니다. 꼭 닫으세요: tailscale serve --https=${HTTPS_PORT} off\n`);
    return { checked: true, open: true, closed: false };
  }
  const result = closeTunnel(context);
  return { checked: true, open: true, closed: result.closed };
}

// y/N prompt on an interactive terminal; anything else answers with the default.
function terminalConfirm(question, defaultYes = false) {
  if (!process.stdin.isTTY) return Promise.resolve(defaultYes);
  return new Promise(resolve => {
    const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      const value = String(answer || '').trim().toLowerCase();
      resolve(value ? ['y', 'yes', 'ㅛ', '예', '네'].includes(value) : defaultYes);
    });
  });
}

module.exports = {
  HTTPS_PORT, MIN_VERSION, tailscaleCandidates, systemRunner, inspectTailscale, readServe,
  openTunnel, closeTunnel, tunnelStatus, closeTunnelForLocalMode, terminalConfirm, versionAtLeast
};
