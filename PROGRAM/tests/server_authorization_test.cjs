'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const raw = await response.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch (_) { throw new Error(`invalid_json:${response.status}:${raw.slice(0, 200)}`); }
  return { response, payload };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-auth-test-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(Object.hasOwn(app, 'pluginBootstrapKeysPath'), false, 'server must not expose a manual bootstrap-key workflow');
    assert.equal(fs.existsSync(path.join(dataDir, 'config', 'plugin-bootstrap-keys.json')), false, 'server must not generate bootstrap-key files');
    const bootstrap = async (pluginId, version = 'test') => await jsonFetch(`${baseUrl}/bootstrap`, {
      headers: {
        ...(pluginId ? { 'X-Memory-Suite-Plugin': pluginId } : {}),
        'X-Memory-Suite-Plugin-Version': version
      }
    });
    const request = async (token, pluginId, method, route, body, extraHeaders = {}) => await jsonFetch(`${baseUrl}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(pluginId ? { 'X-Memory-Suite-Plugin': pluginId } : {}),
        ...extraHeaders,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

    const unknown = await bootstrap('server-integration-test');
    assert.equal(unknown.response.status, 403, 'unknown plugin IDs must not receive a capability token');
    const adminBootstrap = await jsonFetch(`${baseUrl}/bootstrap`, { headers: { 'X-Memory-Suite-Admin': '1' } });
    assert.equal(adminBootstrap.response.status, 403, 'admin master token must never be exposed through bootstrap');

    const libra = await bootstrap('libra', '1.0.98');
    const flashback = await bootstrap('flashback_memory', '0.11.23');
    const retrace = await bootstrap('flashback_hayaku_bridge', '1.9.45');
    const peer = await bootstrap('flashback_hayaku_bridge:peer:flashback_memory', '1.9.45');
    for (const result of [libra, flashback, retrace, peer]) assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.notEqual(libra.payload.token, flashback.payload.token);
    assert.notEqual(libra.payload.token, app.token);
    assert.deepEqual(libra.payload.authorization.writeNamespaces, ['libra']);
    assert.deepEqual(peer.payload.authorization.writeNamespaces, []);

    const flashSet = await request(flashback.payload.token, 'flashback_memory', 'POST', '/v1/kv/set', {
      namespace: 'flashback', space: 'plugin', key: 'vector_rag_memory:auth:test',
      operationId: 'auth_flashback_set_0001', value: { owner: 'flashback' }, expectedRevision: 0
    });
    assert.equal(flashSet.response.status, 200, JSON.stringify(flashSet.payload));

    const libraSet = await request(libra.payload.token, 'libra', 'POST', '/v1/kv/set', {
      namespace: 'libra', space: 'plugin', key: 'libra:v1:auth:test',
      operationId: 'auth_libra_set_0001', value: { owner: 'libra' }, expectedRevision: 0
    });
    assert.equal(libraSet.response.status, 200, JSON.stringify(libraSet.payload));

    const crossWrite = await request(libra.payload.token, 'libra', 'POST', '/v1/kv/set', {
      namespace: 'flashback', space: 'plugin', key: 'vector_rag_memory:auth:forbidden',
      operationId: 'auth_cross_write_0001', value: { forbidden: true }, expectedRevision: 0
    });
    assert.equal(crossWrite.response.status, 403);
    assert.match(crossWrite.payload.error, /namespace_write_forbidden/);

    const switchedIdentity = await request(libra.payload.token, 'flashback_hayaku_bridge', 'GET', '/v1/manager/scopes');
    assert.equal(switchedIdentity.response.status, 403, 'a token must remain bound to its bootstrap plugin ID');
    const assertedManager = await request(libra.payload.token, 'libra', 'GET', '/v1/manager/scopes', undefined, {
      'X-Memory-Suite-Manager': 'retrace'
    });
    assert.equal(assertedManager.response.status, 403, 'manager headers must not elevate an owner token');
    const assertedAdmin = await request(libra.payload.token, 'libra', 'GET', '/v1/clients', undefined, {
      'X-Memory-Suite-Admin': '1'
    });
    assert.equal(assertedAdmin.response.status, 403, 'admin headers must not elevate an owner token');

    const managerRead = await request(retrace.payload.token, 'flashback_hayaku_bridge', 'GET', '/v1/kv/get?namespace=flashback&space=plugin&key=vector_rag_memory%3Aauth%3Atest');
    assert.equal(managerRead.response.status, 200);
    assert.deepEqual(managerRead.payload.result.value, { owner: 'flashback' });
    const managerCrossWrite = await request(retrace.payload.token, 'flashback_hayaku_bridge', 'POST', '/v1/kv/set', {
      namespace: 'flashback', space: 'plugin', key: 'vector_rag_memory:auth:manager-write',
      operationId: 'auth_manager_cross_write_0001', value: { forbidden: true }, expectedRevision: 0
    }, { 'X-Memory-Suite-Manager': 'retrace' });
    assert.equal(managerCrossWrite.response.status, 403, 'RE:TRACE manager access to peer stores must remain read-only');

    const peerRead = await request(peer.payload.token, 'flashback_hayaku_bridge:peer:flashback_memory', 'GET', '/v1/kv/get?namespace=flashback&space=plugin&key=vector_rag_memory%3Aauth%3Atest');
    assert.equal(peerRead.response.status, 200);
    const peerWrite = await request(peer.payload.token, 'flashback_hayaku_bridge:peer:flashback_memory', 'POST', '/v1/kv/set', {
      namespace: 'flashback', space: 'plugin', key: 'vector_rag_memory:auth:peer-write',
      operationId: 'auth_peer_write_0001', value: { forbidden: true }, expectedRevision: 0
    });
    assert.equal(peerWrite.response.status, 403);
    const peerCrossRead = await request(peer.payload.token, 'flashback_hayaku_bridge:peer:flashback_memory', 'GET', '/v1/integrity?namespace=libra');
    assert.equal(peerCrossRead.response.status, 403);

    const masterWithoutAdminHeader = await request(app.token, '', 'GET', '/v1/clients');
    assert.equal(masterWithoutAdminHeader.response.status, 403);
    const admin = await request(app.token, '', 'GET', '/v1/clients', undefined, { 'X-Memory-Suite-Admin': '1' });
    assert.equal(admin.response.status, 200, JSON.stringify(admin.payload));

    const tampered = `${libra.payload.token.slice(0, -1)}${libra.payload.token.endsWith('a') ? 'b' : 'a'}`;
    const tamperedResult = await request(tampered, 'libra', 'GET', '/v1/integrity?namespace=libra');
    assert.equal(tamperedResult.response.status, 403);

    process.stdout.write('server_authorization_test: PASS\n');
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`server_authorization_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
