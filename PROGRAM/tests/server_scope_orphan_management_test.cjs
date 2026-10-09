'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const body = await response.text();
  let payload = {};
  try { payload = body ? JSON.parse(body) : {}; }
  catch (_) { throw new Error(`invalid_json:${response.status}:${body.slice(0, 200)}`); }
  return { response, payload };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-orphan-test-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const bootstrap = await jsonFetch(`${baseUrl}/bootstrap`, {
      headers: { 'X-Memory-Suite-Plugin': 'flashback_hayaku_bridge', 'X-Memory-Suite-Plugin-Version': '1.9.45' }
    });
    assert.equal(bootstrap.response.status, 200);
    assert.equal(bootstrap.payload.capabilities['orphan-scope-management.v1'], true);
    assert.equal(bootstrap.payload.capabilities['scope-pin.v1'], true);
    assert.equal(bootstrap.payload.capabilities['scope-recovery-pairing.v1'], true);
    assert.equal(bootstrap.payload.capabilities['manager-owner-gate.v1'], true);
    const token = bootstrap.payload.token;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Memory-Suite-Plugin': 'flashback_hayaku_bridge',
      'X-Memory-Suite-Plugin-Version': '1.9.45',
      'X-Memory-Suite-Manager': 'retrace'
    };
    const request = async (method, route, body) => jsonFetch(`${baseUrl}${route}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const ownerBootstrap = await jsonFetch(`${baseUrl}/bootstrap`, {
      headers: { 'X-Memory-Suite-Plugin': 'flashback_memory', 'X-Memory-Suite-Plugin-Version': '0.11.23' }
    });
    assert.equal(ownerBootstrap.response.status, 200);
    const ownerHeaders = {
      Authorization: `Bearer ${ownerBootstrap.payload.token}`,
      'Content-Type': 'application/json',
      'X-Memory-Suite-Plugin': 'flashback_memory',
      'X-Memory-Suite-Plugin-Version': '0.11.23'
    };
    const ownerRequest = async (method, route, body) => jsonFetch(`${baseUrl}${route}`, {
      method, headers: ownerHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

    const receipts = {};
    for (const id of ['source', 'target', 'orphan', 'unverified']) {
      const key = `vector_rag_memory:scope:${id}:manifest:v2`;
      const set = await ownerRequest('POST', '/v1/kv/set', {
        namespace: 'flashback', space: 'plugin', key,
        operationId: `scope_orphan_set_${id}_0001`, expectedRevision: 0,
        value: { scopeKey: `scope-${id}`, characterId: 'char-a', chatId: `chat-${id}` }
      });
      assert.equal(set.response.status, 200, JSON.stringify(set.payload));
      receipts[id] = { key, ...set.payload.result };
    }

    const scope = (id, baseClassification, links = []) => ({
      namespace: 'flashback', scopeId: id, scopeKey: `scope-${id}`, kind: 'chat_scope',
      characterId: 'char-a', chatId: `chat-${id}`, displayName: id,
      baseClassification, coverageComplete: true, inventoryObservedAt: Date.now(), links,
      members: [{ space: 'plugin', key: receipts[id].key, sharedRecord: false, valueBytes: 120 }]
    });
    const indexed = await request('POST', '/v1/manager/scopes/index', {
      namespace: 'flashback',
      scopes: [
        scope('source', 'orphan_candidate'),
        scope('target', 'active', [{ targetRef: 'scope-source', kind: 'predecessor' }]),
        scope('orphan', 'orphan_candidate'),
        scope('unverified', 'unverified')
      ]
    });
    assert.equal(indexed.response.status, 200, JSON.stringify(indexed.payload));
    assert.equal(indexed.payload.result.indexed, 4);

    let catalog = await request('GET', '/v1/manager/scopes');
    assert.equal(catalog.response.status, 200);
    const byId = Object.fromEntries(catalog.payload.result.scopes.map(item => [item.scopeId, item]));
    assert.equal(byId.source.classification, 'referenced_ancestor');
    assert.equal(byId.source.referenceCount, 1);
    assert.equal(byId.orphan.classification, 'orphan_candidate');
    assert.equal(byId.unverified.classification, 'unverified');

    const recoveryPairing = {
      schema: 'memory-suite.scope-recovery-pairing.v1',
      targetCharacterId: 'char-a', targetChatId: 'chat-target', targetTitle: 'Target',
      targetTranscriptDigest: 'target-digest-a', targetMessageCount: 18,
      sourceBaseClassification: 'orphan_candidate', evidence: ['stable_chat_inventory_twice', 'current_chat_exact_target'],
      inventoryFingerprint: 'stable-inventory-a', pairedAt: Date.now(), pairedBy: 'RE:TRACE'
    };
    const pairedOrphan = { ...scope('orphan', 'paired_recovery'), recoveryPairing, descriptor: { recoveryPairing } };
    const pairedIndex = await request('POST', '/v1/manager/scopes/index', {
      namespace: 'flashback', scopes: [scope('source', 'orphan_candidate'), scope('target', 'active', [{ targetRef: 'scope-source', kind: 'predecessor' }]), pairedOrphan, scope('unverified', 'unverified')]
    });
    assert.equal(pairedIndex.response.status, 200, JSON.stringify(pairedIndex.payload));
    catalog = await request('GET', '/v1/manager/scopes');
    let pairedReadback = catalog.payload.result.scopes.find(item => item.scopeId === 'orphan');
    assert.equal(pairedReadback.classification, 'paired_recovery');
    assert.equal(pairedReadback.recoveryPairing.targetChatId, 'chat-target');
    assert.equal(pairedReadback.recoveryPairing.targetTranscriptDigest, 'target-digest-a');

    // A routine scanner reindex that omits the pairing must preserve it.
    await request('POST', '/v1/manager/scopes/index', {
      namespace: 'flashback', scopes: [scope('source', 'orphan_candidate'), scope('target', 'active', [{ targetRef: 'scope-source', kind: 'predecessor' }]), scope('orphan', 'orphan_candidate'), scope('unverified', 'unverified')]
    });
    catalog = await request('GET', '/v1/manager/scopes');
    pairedReadback = catalog.payload.result.scopes.find(item => item.scopeId === 'orphan');
    assert.equal(pairedReadback.classification, 'orphan_candidate');
    assert.equal(pairedReadback.recoveryPairing.targetChatId, 'chat-target');

    // Explicit clear must not be mistaken for an omitted scanner field.
    const clearedOrphan = { ...scope('orphan', 'orphan_candidate'), recoveryPairing: null, recoveryPairingCleared: true, descriptor: { recoveryPairing: null, recoveryPairingCleared: true } };
    await request('POST', '/v1/manager/scopes/index', {
      namespace: 'flashback', scopes: [scope('source', 'orphan_candidate'), scope('target', 'active', [{ targetRef: 'scope-source', kind: 'predecessor' }]), clearedOrphan, scope('unverified', 'unverified')]
    });
    catalog = await request('GET', '/v1/manager/scopes');
    assert.equal(catalog.payload.result.scopes.find(item => item.scopeId === 'orphan').recoveryPairing, null);

    const mutationFor = id => [{
      kind: 'remove', space: 'plugin', key: receipts[id].key,
      expectedRevision: receipts[id].revision, expectedDigest: receipts[id].digest,
      expectedExists: true, expectedTombstone: false
    }];
    const ownerProof = id => ({
      schema: 'memory-suite.server-scope-delete-owner-receipt.v1',
      namespace: 'flashback', scopeId: id, verified: true, modeAfter: 'plugin_only'
    });
    const stableInventory = {
      hostInventoryStable: true, complete: true, characterId: 'char-a', currentChatId: 'chat-target',
      inventoryFingerprint: 'stable-inventory-a', observedAt: Date.now()
    };

    const ancestorPlan = await request('POST', '/v1/manager/scope-delete/plan', {
      namespace: 'flashback', scopeId: 'source', modeProof: ownerProof('source'), inventoryProof: stableInventory, mutations: mutationFor('source')
    });
    assert.equal(ancestorPlan.response.status, 409);
    assert.match(ancestorPlan.payload.error, /referenced_ancestor/);

    const unverifiedPlan = await request('POST', '/v1/manager/scope-delete/plan', {
      namespace: 'flashback', scopeId: 'unverified', modeProof: ownerProof('unverified'), inventoryProof: stableInventory, mutations: mutationFor('unverified')
    });
    assert.equal(unverifiedPlan.response.status, 409);
    assert.equal(unverifiedPlan.payload.error, 'scope_delete_unverified_scope_blocked');

    const missingOwnerProof = await request('POST', '/v1/manager/scope-delete/plan', {
      namespace: 'flashback', scopeId: 'orphan', inventoryProof: stableInventory, mutations: mutationFor('orphan')
    });
    assert.equal(missingOwnerProof.response.status, 409);
    assert.equal(missingOwnerProof.payload.error, 'scope_delete_plugin_only_mode_proof_required');

    const pin = await request('POST', '/v1/manager/scope-pin', { namespace: 'flashback', scopeId: 'orphan', pinned: true });
    assert.equal(pin.response.status, 200);
    assert.equal(pin.payload.result.pinned, true);
    const pinnedPlan = await request('POST', '/v1/manager/scope-delete/plan', {
      namespace: 'flashback', scopeId: 'orphan', modeProof: ownerProof('orphan'), inventoryProof: stableInventory, mutations: mutationFor('orphan')
    });
    assert.equal(pinnedPlan.response.status, 409);
    assert.equal(pinnedPlan.payload.error, 'scope_delete_pinned_scope_blocked');

    // Reindex must preserve the user's pin.
    await request('POST', '/v1/manager/scopes/index', {
      namespace: 'flashback',
      scopes: [scope('source', 'orphan_candidate'), scope('target', 'active', [{ targetRef: 'scope-source', kind: 'predecessor' }]), scope('orphan', 'orphan_candidate'), scope('unverified', 'unverified')]
    });
    catalog = await request('GET', '/v1/manager/scopes');
    assert.equal(catalog.payload.result.scopes.find(item => item.scopeId === 'orphan').pinned, true);
    await request('POST', '/v1/manager/scope-pin', { namespace: 'flashback', scopeId: 'orphan', pinned: false });

    const plan = await request('POST', '/v1/manager/scope-delete/plan', {
      namespace: 'flashback', scopeId: 'orphan',
      inventoryProof: stableInventory,
      modeProof: ownerProof('orphan'),
      mutations: mutationFor('orphan'), metadata: { test: true }
    });
    assert.equal(plan.response.status, 200, JSON.stringify(plan.payload));
    assert.ok(plan.payload.result.backupId);
    assert.equal(plan.payload.result.counts.tombstone, 1);
    const backupDir = path.join(dataDir, 'backups', 'deleted-scopes', plan.payload.result.backupId);
    assert.ok(fs.existsSync(path.join(backupDir, 'flashback.sqlite')));
    assert.ok(fs.existsSync(path.join(backupDir, 'manifest.json')));

    const executed = await request('POST', '/v1/manager/scope-delete/execute', {
      planId: plan.payload.result.planId,
      mutationFingerprint: plan.payload.result.mutationFingerprint
    });
    assert.equal(executed.response.status, 200, JSON.stringify(executed.payload));
    assert.equal(executed.payload.result.scopeId, 'orphan');
    assert.ok(fs.existsSync(path.join(backupDir, 'deletion-receipt.json')));
    const readback = await request('GET', `/v1/kv/get?namespace=flashback&space=plugin&key=${encodeURIComponent(receipts.orphan.key)}`);
    assert.equal(readback.payload.result.exists, false);
    assert.equal(readback.payload.result.tombstone, true);
    catalog = await request('GET', '/v1/manager/scopes');
    assert.equal(catalog.payload.result.scopes.some(item => item.scopeId === 'orphan'), false);

    // Shared-record rewrite: remove one scope from a shared registry while preserving a sibling scope.
    const registryKey = 'vector_rag_memory:scope_registry:v2';
    const uniqueKey = 'vector_rag_memory:scope:shared-a:manifest:v2';
    const registrySet = await ownerRequest('POST', '/v1/kv/set', {
      namespace: 'flashback', space: 'plugin', key: registryKey,
      operationId: 'shared_registry_set_0001', expectedRevision: 0,
      value: { version: 2, scopes: [{ scopeKey: 'scope-shared-a' }, { scopeKey: 'scope-shared-b' }] }
    });
    const uniqueSet = await ownerRequest('POST', '/v1/kv/set', {
      namespace: 'flashback', space: 'plugin', key: uniqueKey,
      operationId: 'shared_unique_set_0001', expectedRevision: 0,
      value: { scopeKey: 'scope-shared-a', characterId: 'char-a', chatId: 'chat-shared-a' }
    });
    assert.equal(registrySet.response.status, 200);
    assert.equal(uniqueSet.response.status, 200);
    const sharedScope = {
      namespace: 'flashback', scopeId: 'shared-a', scopeKey: 'scope-shared-a', kind: 'chat_scope',
      characterId: 'char-a', chatId: 'chat-shared-a', displayName: 'shared-a',
      baseClassification: 'orphan_candidate', coverageComplete: true, inventoryObservedAt: Date.now(), links: [],
      members: [
        { space: 'plugin', key: registryKey, sharedRecord: true, valueBytes: 120 },
        { space: 'plugin', key: uniqueKey, sharedRecord: false, valueBytes: 120 }
      ]
    };
    const sharedIndex = await request('POST', '/v1/manager/scopes/index', { namespace: 'flashback', scopes: [sharedScope] });
    assert.equal(sharedIndex.response.status, 200, JSON.stringify(sharedIndex.payload));
    const sharedPlan = await request('POST', '/v1/manager/scope-delete/plan', {
      namespace: 'flashback', scopeId: 'shared-a', modeProof: ownerProof('shared-a'), inventoryProof: stableInventory,
      mutations: [
        {
          kind: 'set', space: 'plugin', key: registryKey,
          expectedRevision: registrySet.payload.result.revision, expectedDigest: registrySet.payload.result.digest,
          expectedExists: true, expectedTombstone: false,
          value: { version: 2, scopes: [{ scopeKey: 'scope-shared-b' }] }
        },
        {
          kind: 'remove', space: 'plugin', key: uniqueKey,
          expectedRevision: uniqueSet.payload.result.revision, expectedDigest: uniqueSet.payload.result.digest,
          expectedExists: true, expectedTombstone: false
        }
      ]
    });
    assert.equal(sharedPlan.response.status, 200, JSON.stringify(sharedPlan.payload));
    const sharedExecute = await request('POST', '/v1/manager/scope-delete/execute', {
      planId: sharedPlan.payload.result.planId,
      mutationFingerprint: sharedPlan.payload.result.mutationFingerprint
    });
    assert.equal(sharedExecute.response.status, 200, JSON.stringify(sharedExecute.payload));
    const registryRead = await request('GET', `/v1/kv/get?namespace=flashback&space=plugin&key=${encodeURIComponent(registryKey)}`);
    assert.deepEqual(registryRead.payload.result.value, { version: 2, scopes: [{ scopeKey: 'scope-shared-b' }] });
    const uniqueRead = await request('GET', `/v1/kv/get?namespace=flashback&space=plugin&key=${encodeURIComponent(uniqueKey)}`);
    assert.equal(uniqueRead.payload.result.tombstone, true);

    // Pure registry shell: after the owner has verified there are no physical
    // scope/vector records, the existing backup + conditional shared rewrite
    // path can remove only the empty registry row.
    const shellCatalog = await request('POST', '/v1/manager/scopes/index', {
      namespace: 'flashback',
      scopes: [{
        namespace: 'flashback', scopeId: 'shared-b', scopeKey: 'scope-shared-b', kind: 'registry_only_shell',
        displayName: 'empty registry shell', baseClassification: 'orphan_candidate', coverageComplete: true,
        inventoryObservedAt: Date.now(), links: [],
        descriptor: { emptyRegistryShellVerified: true, emptyRegistryShellObservations: 2 },
        members: [{ space: 'plugin', key: registryKey, sharedRecord: true, valueBytes: 80 }]
      }]
    });
    assert.equal(shellCatalog.response.status, 200, JSON.stringify(shellCatalog.payload));
    const shellPlan = await request('POST', '/v1/manager/scope-delete/plan', {
      namespace: 'flashback', scopeId: 'shared-b', modeProof: ownerProof('shared-b'), inventoryProof: stableInventory,
      mutations: [{
        kind: 'set', space: 'plugin', key: registryKey,
        expectedRevision: registryRead.payload.result.revision, expectedDigest: registryRead.payload.result.digest,
        expectedExists: true, expectedTombstone: false,
        value: { version: 2, scopes: [] }
      }]
    });
    assert.equal(shellPlan.response.status, 200, JSON.stringify(shellPlan.payload));
    const shellExecute = await request('POST', '/v1/manager/scope-delete/execute', {
      planId: shellPlan.payload.result.planId,
      mutationFingerprint: shellPlan.payload.result.mutationFingerprint
    });
    assert.equal(shellExecute.response.status, 200, JSON.stringify(shellExecute.payload));
    const shellRegistryRead = await request('GET', `/v1/kv/get?namespace=flashback&space=plugin&key=${encodeURIComponent(registryKey)}`);
    assert.deepEqual(shellRegistryRead.payload.result.value, { version: 2, scopes: [] });
    catalog = await request('GET', '/v1/manager/scopes');
    assert.equal(catalog.payload.result.scopes.some(item => item.scopeId === 'shared-b'), false);

    process.stdout.write('server_scope_orphan_management_test: PASS\n');
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`server_scope_orphan_management_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
