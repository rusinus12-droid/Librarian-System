'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');

const urlHost = host => host.includes(':') ? `[${host}]` : host;
const request = (url, headers = {}) => new Promise((resolve, reject) => {
  const req = http.get(url, { headers }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({
      status: Number(response.statusCode || 0),
      text: Buffer.concat(chunks).toString('utf8')
    }));
  });
  req.on('error', reject);
});

async function verifyHost(host) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `memory-suite-host-${host.replace(/[^a-z0-9]/gi, '_')}-`));
  const app = createMemorySuiteServer({ host, port: 0, dataDir, autoBackup: false });
  try {
    const address = await app.listen();
    const configuredUrl = `http://${urlHost(host)}:${address.port}`;
    const health = await request(`${configuredUrl}/health`);
    assert.equal(health.status, 200, `${host} health`);
    const bootstrap = await request(`${configuredUrl}/bootstrap`, {
      'X-Memory-Suite-Plugin': 'libra',
      'X-Memory-Suite-Plugin-Version': '1.0.98'
    });
    const payload = JSON.parse(bootstrap.text);
    assert.equal(bootstrap.status, 200, `${host} bootstrap ${JSON.stringify(payload)}`);
    assert.doesNotThrow(() => new URL(payload.url));
    if (String(address.address).includes(':')) assert.match(payload.url, /^http:\/\/\[[^\]]+\]:\d+$/);
    const publishedHealth = await request(`${payload.url}/health`);
    assert.equal(publishedHealth.status, 200, `${host} published bootstrap URL`);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const canListenIPv6Loopback = () => new Promise(resolve => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, '::1', () => probe.close(() => resolve(true)));
});

(async () => {
  if (await canListenIPv6Loopback()) await verifyHost('::1');
  else process.stdout.write('SKIP: IPv6 loopback (::1) is not available in this environment; verifying IPv4 and localhost only\n');
  await verifyHost('127.0.0.1');
  await verifyHost('localhost');
  process.stdout.write('loopback_host_compatibility_test: PASS\n');
})().catch(error => {
  process.stderr.write(`loopback_host_compatibility_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
