'use strict';
// 서버_원격접속_열기 (launcher remote-tunnel): opens, closes and reports this server's `tailscale serve`
// entry. A fake tailscale stands in for the real one: it keeps a serve config and records every call.
// The tool refuses to open a tunnel to a local-mode server unless the user switches to remote mode,
// never touches another 443 entry, and offers to close ours when the server goes back to local mode.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const launcher = require('../tools/platform_launcher.cjs');
const tailscale = require('../tools/tailscale_serve.cjs');

const DNS = 'my-pc.tail1234.ts.net';
function fakeTailscale({ installed = true, version = '1.76.1', state = 'Running', web = null, serveFails = false } = {}) {
  const calls = [];
  let config = web ? { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: web } } } } } : {};
  const run = (args, options = {}) => {
    calls.push({ args, inherit: options.inherit === true });
    if (!installed) return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' }) };
    const ok = stdout => ({ status: 0, stdout, stderr: '' });
    if (args[0] === 'version') return ok(`${version}\n  tailscale commit: x\n`);
    if (args.join(' ') === 'status --json') return ok(JSON.stringify({ BackendState: state, Self: { DNSName: `${DNS}.` } }));
    if (args.join(' ') === 'serve status --json') return ok(Object.keys(config).length ? JSON.stringify(config) : '{}');
    if (args[0] === 'serve' && args.includes('--bg')) {
      if (serveFails) return { status: 1, stdout: '', stderr: 'serve failed' };
      const target = args[args.length - 1];
      config = { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: target } } } } };
      return ok('');
    }
    if (args.join(' ') === 'serve --https=443 off') { config = {}; return ok(''); }
    return { status: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
  };
  return { run, calls, opened: () => calls.filter(c => c.args[0] === 'serve' && c.args.includes('--bg')), closed: () => calls.filter(c => c.args.join(' ') === 'serve --https=443 off') };
}
function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-tunnel-'));
  return { root, data: path.join(root, 'DATA'), close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
const collect = () => { const out = []; return { write: text => out.push(text), text: () => out.join('') }; };
const tunnel = (data, action, fake, extra = {}) => {
  const out = collect();
  return { out, result: launcher.remoteTunnel(data, action, { run: fake.run, write: out.write, confirm: async () => false, termux: false, container: false, ...extra }) };
};
const keyOf = data => fs.readFileSync(path.join(data, 'config', 'remote-access-key.txt'), 'utf8').trim();

test('parseArgs: remote-tunnel actions, --docker and --port', () => {
  assert.deepEqual(['open', 'close', 'status'].map(a => launcher.parseArgs(['remote-tunnel', `--${a}`]).tunnelAction), ['open', 'close', 'status']);
  assert.equal(launcher.parseArgs(['remote-tunnel']).tunnelAction, 'status');
  const docker = launcher.parseArgs(['remote-tunnel', '--open', '--docker', '--port', '48000']);
  assert.deepEqual([docker.docker, docker.port], [true, '48000']);
  assert.throws(() => launcher.parseArgs(['remote-tunnel', '--open', '--close']), /launcher_tunnel_action_conflict/);
  assert.throws(() => launcher.parseArgs(['remote-tunnel', '--port', 'x']), /launcher_port_value_invalid/);
  assert.throws(() => launcher.parseArgs(['set-remote-access', '--docker']), /unknown_launcher_argument/);
});

test('Tailscale missing, too old or logged out: clear guidance, nothing opened', async () => {
  const t = temp(); try {
    for (const [fake, code] of [[fakeTailscale({ installed: false }), 'TUNNEL_TAILSCALE_MISSING'], [fakeTailscale({ version: '1.50.0' }), 'TUNNEL_TAILSCALE_OLD'], [fakeTailscale({ state: 'NeedsLogin' }), 'TUNNEL_TAILSCALE_LOGIN']]) {
      await assert.rejects(() => tunnel(t.data, 'open', fake).result, error => error.code === code, code);
      assert.equal(fake.opened().length, 0);
    }
    assert.equal(tailscale.versionAtLeast('1.52.0', tailscale.MIN_VERSION), true);
    assert.equal(tailscale.versionAtLeast('1.9.99', tailscale.MIN_VERSION), false);
  } finally { t.close(); }
});

test('local mode: declining remote mode opens nothing; accepting switches and opens to this port', async () => {
  const t = temp(); try {
    const declined = fakeTailscale();
    await assert.rejects(() => tunnel(t.data, 'open', declined).result, error => error.code === 'TUNNEL_REMOTE_MODE_DECLINED');
    assert.equal(declined.opened().length, 0, 'a tunnel never opens to a key-less local-mode server');
    assert.equal(launcher.readConfig(t.data).remoteAccess, false);

    const fake = fakeTailscale();
    const run = tunnel(t.data, 'open', fake, { confirm: async () => true });
    const result = await run.result;
    const port = launcher.readConfig(t.data).port;
    assert.equal(launcher.readConfig(t.data).remoteAccess, true, 'the user agreed: remote mode is on');
    assert.deepEqual(fake.opened().map(c => c.args), [['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]]);
    assert.equal(fake.opened()[0].inherit, true, 'serve output (an HTTPS consent link) reaches the user');
    assert.deepEqual([result.url, result.switched, result.opened], [`https://${DNS}`, true, true]);
    assert.match(run.out.text(), new RegExp(`https://${DNS.replace(/\./g, '\\.')}`));
    assert.match(run.out.text(), new RegExp(`접근 키: ${keyOf(t.data)}`), 'the plugin address and the key are shown together');
    assert.match(run.out.text(), /다시 실행해야 반영/);

    const again = tunnel(t.data, 'open', fake);
    assert.equal((await again.result).opened, false);
    assert.equal(fake.opened().length, 1, 'already open: no second serve call');
    assert.match(again.out.text(), /이미 열려 있습니다/);
  } finally { t.close(); }
});

test('another 443 entry is never replaced or removed', async () => {
  const t = temp(); try {
    await launcher.setRemoteAccess(t.data, 'remote', { write: () => {} });
    const fake = fakeTailscale({ web: 'http://127.0.0.1:3000' });
    await assert.rejects(() => tunnel(t.data, 'open', fake).result, error => error.code === 'TUNNEL_PORT_OCCUPIED');
    assert.equal(fake.opened().length, 0);
    const close = tunnel(t.data, 'close', fake);
    assert.deepEqual(await close.result, { closed: false, reason: 'other' });
    assert.equal(fake.closed().length, 0);
    const status = tunnel(t.data, 'status', fake);
    assert.equal((await status.result).other, true);
    assert.match(status.out.text(), /건드리지 않습니다/);
  } finally { t.close(); }
});

test('close removes only our entry; status reports it', async () => {
  const t = temp(); try {
    await launcher.setRemoteAccess(t.data, 'remote', { write: () => {} });
    const port = launcher.readConfig(t.data).port;
    const fake = fakeTailscale({ web: `http://127.0.0.1:${port}` });
    assert.equal((await tunnel(t.data, 'status', fake).result).open, true);
    assert.deepEqual(await tunnel(t.data, 'close', fake).result, { closed: true });
    assert.equal(fake.closed().length, 1);
    assert.deepEqual(await tunnel(t.data, 'close', fake).result, { closed: false, reason: 'not_open' });
    assert.equal((await tunnel(t.data, 'status', fake).result).open, false);
  } finally { t.close(); }
});

test('going back to local mode offers to close our tunnel', async () => {
  const t = temp(); try {
    await launcher.setRemoteAccess(t.data, 'remote', { write: () => {} });
    const port = launcher.readConfig(t.data).port;
    const kept = fakeTailscale({ web: `http://127.0.0.1:${port}` });
    const out = collect();
    const first = await launcher.setRemoteAccess(t.data, 'local', { write: out.write, run: kept.run, confirm: async () => false, termux: false, container: false });
    assert.deepEqual(first.tunnel, { checked: true, open: true, closed: false });
    assert.equal(kept.closed().length, 0);
    assert.match(out.text(), /tailscale serve --https=443 off/, 'declining still tells how to close it');

    await launcher.setRemoteAccess(t.data, 'remote', { write: () => {} });
    const fake = fakeTailscale({ web: `http://127.0.0.1:${port}` });
    const second = await launcher.setRemoteAccess(t.data, 'local', { write: () => {}, run: fake.run, confirm: async () => true, termux: false, container: false });
    assert.deepEqual(second.tunnel, { checked: true, open: true, closed: true });
    assert.equal(fake.closed().length, 1);
    const absent = await launcher.setRemoteAccess(t.data, 'remote', { write: () => {} });
    assert.equal(absent.enabled, true);
    const noTailscale = await launcher.setRemoteAccess(t.data, 'local', { write: () => {}, run: fakeTailscale({ installed: false }).run, confirm: async () => true });
    assert.deepEqual(noTailscale.tunnel, { checked: false }, 'no Tailscale: local mode still switches');
  } finally { t.close(); }
});

test('Docker server: no PC-side DATA or mode change, the published port is used', async () => {
  const t = temp(); try {
    const fake = fakeTailscale();
    const run = tunnel(t.data, 'open', fake, { docker: true, port: '48000' });
    const result = await run.result;
    assert.deepEqual(fake.opened().map(c => c.args.at(-1)), ['http://127.0.0.1:48000']);
    assert.equal(result.switched, false);
    assert.equal(fs.existsSync(t.data), false, 'the PC-side DATA is not created for a Docker server');
    assert.match(run.out.text(), /set-remote-access --show/, 'the key lives in the container volume');
  } finally { t.close(); }
});

test('Termux and the container itself are refused', async () => {
  const t = temp(); try {
    await assert.rejects(() => tunnel(t.data, 'open', fakeTailscale(), { termux: true }).result, error => error.code === 'TUNNEL_TERMUX_UNSUPPORTED');
    await assert.rejects(() => tunnel(t.data, 'open', fakeTailscale(), { container: true }).result, error => error.code === 'TUNNEL_IN_CONTAINER');
  } finally { t.close(); }
});

test('a failing serve call is reported, and nothing is claimed open', async () => {
  const t = temp(); try {
    await launcher.setRemoteAccess(t.data, 'remote', { write: () => {} });
    await assert.rejects(() => tunnel(t.data, 'open', fakeTailscale({ serveFails: true })).result, error => error.code === 'TUNNEL_SERVE_FAILED');
  } finally { t.close(); }
});
