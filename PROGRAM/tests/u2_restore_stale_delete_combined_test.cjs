'use strict';
// U2 — restore and a stale delete-plan retry, COMBINED. Reviewer contract (supervisor_decisions.md):
//
//   "닫힘 조건: 임시 서버에서 삭제 plan을 준비한 뒤 실제 restore를 실행하고 기존 plan 재시도를 거부하는지
//    확인한다. restore된 서버 정본과 owner local/plugin_only 보존본이 변하지 않는지 읽고, 새 유효 plan의
//    정상 대조군을 함께 둔다."
//
// This file's Flashback local fixture is an isolation control only: it does not share storage with the
// backend. `u2_restore_stale_delete_owner_client_test.cjs` separately covers the connected owner-client
// reset/reload boundary. Neither test alone claims a reset-era RETRACE coordinator end-to-end completion.
//
// The reviewer accepts the INDIVIDUAL protections already measured (B13 blocks a stale plan with 409 after
// a reset; B03 shows the restore epoch rising and fencing old clients) but states the COMBINED scenario —
// prepare a delete plan, then really restore, then retry that plan — has not been executed. This runs
// exactly that against a real localhost HTTP server with a real SQLite store and a real backup/restore.
//
// The mechanism it exercises, read from server/server.cjs:
//   * `prepareScopeDeletePlan` records `plan.generation = deletionGeneration(namespace)`
//   * `executeScopeDeletePlan` re-checks it and throws `scope_delete_generation_changed` (409) when it moved
//   * `deletionGeneration` hashes `{epoch, restore}` where `restore` is the content of
//     `migrations/scope-delete-generation.json`, which the restore writes
// So a plan prepared BEFORE the restore must be refused AFTER it, and a plan prepared after the restore
// must still execute — the control that shows the refusal comes from the restore, not from delete being
// broken.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

// The scope belongs to FLASHBACK, so its rows are seeded with FLASHBACK's token: RE:TRACE is the control
// plane and `namespace_write_forbidden:flashback` is the correct answer for a coordinator writing an
// owner's namespace. The coordinator's own token is used for the manager plan/execute calls.
const OWNER_PLUGIN = 'flashback_memory';
const CONTROL_PLUGIN = 'flashback_hayaku_bridge';
const NAMESPACE = 'flashback';
const results = [];

const jsonFetch = async (url, options = {}) => {
  const response = await fetch(url, options);
  let body = null;
  try { body = await response.json(); } catch (_) { body = null; }
  return { status: response.status, ok: response.ok, body };
};

// This is deliberately an owner read, not a direct inspection of the fixture Map.  The record goes through
// Flashback's own writer and every comparison goes through Flashback's own reader, so a server-only row
// cannot stand in for plugin-only preservation.
const ownerRecordSnapshot = async (fixture, scopeKey) => {
  const loaded = await fixture.api._test.loadScopeRecords(scopeKey);
  return JSON.stringify((loaded.records || []).map(record => ({
    id: record.id, hash: record.hash, text: record.text, vector: record.vector
  })).sort((left, right) => String(left.id).localeCompare(String(right.id))));
};

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2-combined-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  let ownerFixture = null;
  let ownerReopened = null;
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  let passed = 0;
  try {
    // Every control-plane call goes through RE:TRACE, the only principal the server grants the `manager`
    // role: `manager = pluginId === RETRACE_PLUGIN_ID`, read from `principalForPlugin`.
    const controlBoot = await jsonFetch(`${base}/bootstrap`, { headers: { 'X-Memory-Suite-Plugin': CONTROL_PLUGIN } });
    assert.equal(controlBoot.status, 200, 'the control plugin must bootstrap');
    const controlToken = String(controlBoot.body?.token || '');
    assert.ok(controlToken, 'the bootstrap must return a token');
    const managerHeaders = { Authorization: `Bearer ${controlToken}`, 'X-Memory-Suite-Plugin': CONTROL_PLUGIN, 'Content-Type': 'application/json' };
    // Backup/restore are ADMIN routes: the server's own token plus the admin marker, as the existing
    // backup/restore e2e suite uses.
    const adminHeaders = { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json', 'X-Memory-Suite-Admin': '1' };

    // A real owner-local/plugin-only corpus is established before the server transaction.  The backend
    // cannot read this fixture store; preservation must therefore be demonstrated by the owner's reader.
    ownerFixture = await createFixture({
      arguments: { memory_suite_server_mode: 'plugin_only' },
      chat: { id: 'u2-owner-local-chat', chatId: 'u2-owner-local-chat', message: [], messages: [] },
    });
    const ownerScope = await ownerFixture.api.resolveCurrentScope(false);
    await ownerFixture.api._test.saveAllRecords([{
      id: 'u2-owner-local-record', hash: 'u2-owner-local-record', type: 'response', sourceType: 'response',
      text: 'Owner-local plugin-only corpus must survive backend restore and delete retries.', dim: 4,
      vector: [0.25, 0.5, -0.25, 0.75]
    }], null, ownerScope);
    const ownerBefore = await ownerRecordSnapshot(ownerFixture, ownerScope.scopeKey);
    assert.ok(ownerBefore.includes('u2-owner-local-record'), 'the owner reader must see its seeded plugin-only corpus');
    results.push({ step: 'owner_local_before', reader: 'Flashback._test.loadScopeRecords', scopeKey: ownerScope.scopeKey });
    passed += 1;

    // ── setup: seed the scope through the server's OWN repository, as the existing scope-delete suite
    // does, then INDEX it — the delete plan refuses an unindexed scope
    // (`scope_delete_scope_not_indexed`), which is a real precondition rather than a fixture detail. ────
    const repo = app.repositories[NAMESPACE];
    const scopeId = 'u2-combined-scope';
    const seeded = [];
    for (const suffix of ['a', 'b']) {
      const key = `vector_rag_memory:${scopeId}:${suffix}`;
      repo.mutate({ kind: 'set', space: 'plugin', key, value: { marker: 'u2-canonical', suffix }, expectedRevision: 0, operationId: `seed_u2_${suffix}` });
      seeded.push(key);
    }
    const scopes = [{
      namespace: NAMESPACE, scopeId, scopeKey: scopeId, kind: 'chat_scope',
      baseClassification: 'active', coverageComplete: true,
      members: seeded.map(key => ({ space: 'plugin', key })),
    }];
    const indexed = await jsonFetch(`${base}/v1/manager/scopes/index`, {
      method: 'POST', headers: managerHeaders, body: JSON.stringify({ namespace: NAMESPACE, scopes }),
    });
    assert.equal(indexed.status, 200, `the scope must index (got ${indexed.status}: ${JSON.stringify(indexed.body)?.slice(0, 160)})`);
    // The plan is built from the rows that actually exist, with their revisions and digests.
    const mutations = seeded.map(key => {
      const row = repo.get('plugin', key);
      return {
        kind: 'remove', space: 'plugin', key,
        expectedRevision: Number(row.revision), expectedDigest: String(row.digest || ''),
        expectedExists: true, expectedTombstone: false,
      };
    });
    results.push({ step: 'seeded', scopeId, rows: seeded.length, indexed: indexed.body?.result?.indexed ?? null });
    passed += 1;

    // ── step 1: prepare a delete plan ────────────────────────────────────────────────────────────────
    const planResponse = await jsonFetch(`${base}/v1/manager/scope-delete/plan`, {
      method: 'POST', headers: managerHeaders,
      body: JSON.stringify({
        namespace: NAMESPACE, scopeId, mutations,
        modeProof: { verified: true, modeAfter: 'plugin_only', namespace: NAMESPACE, scopeId },
      }),
    });
    assert.equal(planResponse.status, 200,
      `the delete plan must prepare (got ${planResponse.status}: ${JSON.stringify(planResponse.body)?.slice(0, 200)})`);
    const plan = planResponse.body?.result || planResponse.body;
    const planId = String(plan?.planId || '');
    const planFingerprint = String(plan?.mutationFingerprint || '');
    assert.ok(planId && planFingerprint, 'the prepared plan carries a planId and mutationFingerprint');
    const preparedGeneration = String(plan.generation || '');
    results.push({ step: 'plan_prepared', planId: planId.slice(0, 12), preparedGeneration: preparedGeneration.slice(0, 20) });
    passed += 1;

    // ── step 2: really restore ──────────────────────────────────────────────────────────────────────
    const backup = await jsonFetch(`${base}/v1/admin/backups/create`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ kind: 'manual', label: 'u2-combined' }),
    });
    assert.ok([200, 201].includes(backup.status), `the backup must be created (got ${backup.status})`);
    const backupId = String((backup.body?.result || backup.body)?.id || (backup.body?.result || backup.body)?.backupId || '');
    assert.ok(backupId, 'the backup must carry an id');
    const restore = await jsonFetch(`${base}/v1/admin/restore`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ backupId, namespaces: [NAMESPACE] }),
    });
    const generationFile = path.join(dataDir, 'migrations', 'scope-delete-generation.json');
    const generationJournal = fs.existsSync(generationFile)
      ? JSON.parse(fs.readFileSync(generationFile, 'utf8')) : null;
    results.push({
      step: 'restore_executed', backupStatus: backup.status, restoreStatus: restore.status,
      restoreError: restore.body?.error || null, generationJournal,
    });
    assert.ok([200, 201, 202].includes(restore.status),
      `the restore must execute (got ${restore.status}: ${JSON.stringify(restore.body)?.slice(0, 200)})`);
    passed += 1;

    // The restore rebuilds the databases, so any repository handle taken before it is stale
    // ("statement has been finalized"). Every read after this point must re-acquire it.
    const repoAfterRestore = () => app.repositories[NAMESPACE];

    // ── step 3: retry the STALE plan — it must be refused ────────────────────────────────────────────
    const staleRetry = await jsonFetch(`${base}/v1/manager/scope-delete/execute`, {
      method: 'POST', headers: managerHeaders, body: JSON.stringify({ planId, mutationFingerprint: planFingerprint }),
    });
    results.push({
      step: 'stale_plan_retry', status: staleRetry.status, error: staleRetry.body?.error || null,
      preparedGeneration: preparedGeneration.slice(0, 20),
    });
    assert.equal(staleRetry.status, 409,
      `a plan prepared before the restore must be refused after it (got ${staleRetry.status}: ${JSON.stringify(staleRetry.body)?.slice(0, 200)})`);
    assert.equal(staleRetry.body?.error, 'scope_delete_generation_changed',
      `the refusal must name the generation change (got ${staleRetry.body?.error})`);
    passed += 1;

    const ownerAfterStale409 = await ownerRecordSnapshot(ownerFixture, ownerScope.scopeKey);
    assert.equal(ownerAfterStale409, ownerBefore,
      'the owner-local/plugin-only corpus must be identical after backend restore and the refused stale retry');
    results.push({ step: 'owner_local_after_stale_409', preserved: true });
    passed += 1;

    // ── step 4: the restored canonical content is unchanged by the refused retry ────────────────────
    const afterRefusal = {};
    for (const key of seeded) {
      const row = repoAfterRestore().get('plugin', key);
      afterRefusal[key] = row ? { exists: row.exists === true, marker: row.value?.marker ?? null, digest: String(row.digest || '') } : null;
    }
    const restoredIntact = seeded.every(key => afterRefusal[key] && afterRefusal[key].exists && afterRefusal[key].marker === 'u2-canonical');
    results.push({ step: 'canonical_after_refusal', afterRefusal, intact: restoredIntact });
    assert.equal(restoredIntact, true,
      `the restored canonical rows must still be present after a refused stale retry (${JSON.stringify(afterRefusal).slice(0, 200)})`);
    passed += 1;

    // ── step 5: CONTROL — a NEW plan, prepared after the restore, must execute ──────────────────────
    const freshMutations = seeded.map(key => {
      const row = repoAfterRestore().get('plugin', key);
      return {
        kind: 'remove', space: 'plugin', key,
        expectedRevision: Number(row?.revision || 0), expectedDigest: String(row?.digest || ''),
        expectedExists: true, expectedTombstone: false,
      };
    });
    const freshPlanResponse = await jsonFetch(`${base}/v1/manager/scope-delete/plan`, {
      method: 'POST', headers: managerHeaders,
      body: JSON.stringify({
        namespace: NAMESPACE, scopeId, mutations: freshMutations,
        modeProof: { verified: true, modeAfter: 'plugin_only', namespace: NAMESPACE, scopeId },
      }),
    });
    assert.equal(freshPlanResponse.status, 200, `a plan prepared after the restore must prepare (got ${freshPlanResponse.status})`);
    const freshPlan = freshPlanResponse.body?.result || freshPlanResponse.body;
    const freshGeneration = String(freshPlan?.generation || '');
    results.push({
      step: 'control_fresh_plan', freshGeneration: freshGeneration.slice(0, 20),
      generationChangedByRestore: freshGeneration !== preparedGeneration,
    });
    assert.notEqual(freshGeneration, preparedGeneration,
      'the restore must change the delete generation, which is what invalidated the stale plan');
    const freshExecute = await jsonFetch(`${base}/v1/manager/scope-delete/execute`, {
      method: 'POST', headers: managerHeaders,
      body: JSON.stringify({ planId: String(freshPlan?.planId || ''), mutationFingerprint: String(freshPlan?.mutationFingerprint || '') }),
    });
    results.push({ step: 'control_fresh_execute', status: freshExecute.status, error: freshExecute.body?.error || null });
    assert.equal(freshExecute.status, 200,
      `a fresh plan carrying the current generation must execute (got ${freshExecute.status}: ${freshExecute.body?.error})`);
    passed += 1;

    const ownerAfterFresh200 = await ownerRecordSnapshot(ownerFixture, ownerScope.scopeKey);
    assert.equal(ownerAfterFresh200, ownerBefore,
      'the owner-local/plugin-only corpus must be identical after the fresh backend retry too');
    // Reopen on the same owner stores and use the reader again; this checks durable local preservation,
    // not merely an in-memory object surviving while the server transaction ran.
    const ownerChat = structuredClone(ownerFixture.currentChat);
    ownerReopened = await createFixture({
      pluginStorage: ownerFixture.pluginStorage,
      safeLocalStorage: ownerFixture.host.safeLocalStorage,
      arguments: { memory_suite_server_mode: 'plugin_only' }, chat: ownerChat,
    });
    const reopenedScope = await ownerReopened.api.resolveCurrentScope(false);
    const ownerAfterReopen = await ownerRecordSnapshot(ownerReopened, reopenedScope.scopeKey);
    assert.equal(ownerAfterReopen, ownerBefore,
      'a fresh Flashback owner reader must recover the unchanged plugin-only corpus after the backend sequence');
    results.push({ step: 'owner_local_after_fresh_200_and_reopen', preserved: true, reader: 'Flashback._test.loadScopeRecords' });
    passed += 1;

    console.log(`u2_restore_stale_delete_combined_test: PASS (${passed} checks)`);
    console.log(JSON.stringify({ test: 'u2_restore_stale_delete_combined', results }, null, 1));
  } finally {
    await ownerReopened?.dispose?.().catch(() => null);
    await ownerFixture?.dispose?.().catch(() => null);
    await app.close().catch(() => null);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
