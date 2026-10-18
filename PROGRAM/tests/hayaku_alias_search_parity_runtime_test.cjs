'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHayakuRuntime, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
const { DEFINITIONS, executeOperation } = require('../server/compute/registry.cjs');
const { digestJson } = require('../server/compute/contracts.cjs');

const fact = '서연은 은색 열쇠를 소나무 상자에 보관했다.';
const alias = 'silver key';
const operation = 'hayaku.memory-search.v1';
const packet = (summary, scene, aliases = {}) => ({
  meta: { schema: 'hayaku_packet_v1', packet_type: 'current_snapshot', packet_schema_rev: 2,
    scene_id: scene, turn_anchor: summary, summary_memory: { id: `summary-${scene}`, summary, recallAliases: aliases } },
  entity: { characters: [], relations: [], pov_memories: [], secrets: [] },
  world: { active_events: [{ id: `event-${scene}`, summary }] },
  narrative: { scene_deltas: [] }, planner: { continuity_locks: [], do_not_resolve_yet: [] }
});
const response = value => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
const plain = value => JSON.parse(JSON.stringify(value));
const evidence = result => {
  const text = result.filter(row => /^hayaku-(?:runtime-context-v3|cache-static-v1)$/.test(row.memo || ''))
    .map(row => String(row.content || row.data || '')).join('\n');
  const begin = text.indexOf('[SOURCE MEMORY RECORDS');
  const end = text.indexOf('[HAYAKU RUNTIME PACKET SHAPE]', begin);
  assert.ok(begin >= 0 && end > begin);
  return text.slice(begin, end); // Original evidence/provenance bytes; no normalization or masking.
};

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hayaku-alias-parity-'));
  try {
    const original = fs.readFileSync(process.argv[2] || path.join(__dirname, '../plugins/HAYAKU_Locator_Continuity.js'), 'utf8');
    const needle = "computeMode: serverBacked ? 'prefer_server' : 'local',";
    assert.equal(original.split(needle).length, 2, 'the existing storage-policy test seam is unique');
    const capture = 'const rows=localRecallCandidates(store,query,settings,computedRanks);';
    assert.equal(original.split(capture).length, 2, 'capture the real source-row input without replacing search results');
    const sourceFile = path.join(root, 'hayaku-test.js');
    fs.writeFileSync(sourceFile, original.replace(needle, "computeMode: globalThis.__aliasComputeMode || 'local',")
      .replace(capture, 'globalThis.__aliasRuntimeRows=store._recallSourceRows||store.index;\n    '+capture)
      // Search offload is off by default; this parity check exercises the server path.
      .replace('const offloads=kind=>offload[kind]===true;', 'const offloads=kind=>true;'));
    const history = [];
    for (let turn = 1; turn <= 12; turn++) {
      const summary = turn === 1 ? fact : `돌담 아래 벽돌이 놓였다. ${turn}`;
      history.push({ role: 'user', chatId: `u${turn}`, data: `장면 ${turn}` },
        { role: 'assistant', chatId: `a${turn}`, data: hiddenPacketMessage(summary,
          packet(summary, `scene-${turn}`, turn === 1 ? { en: [alias] } : {})) });
    }
    const query = { role: 'user', chatId: 'u13', data: alias };
    const messages = [...history, query];
    const results = [];
    for (const mode of ['local', 'server', 'fallback']) {
      const calls = [];
      let afterExecute = null;
      const nativeFetch = async (url, init = {}) => {
        // A synthetic in-memory transport; never delegate to fetch or open a socket.
        if (String(url).endsWith('/v1/compute/bootstrap')) return response({
          ok: true, schema: 'memory-suite.compute.bootstrap.v1', url: 'http://127.0.0.1:47630', token: 'synthetic-compute-token',
          authorization: { schema: 'memory-suite.compute-authorization.v1', pluginId: 'hayaku_locator_continuity', namespace: 'hayaku', roles: ['compute'] },
          capabilities: { 'compute.v1': true }, limits: { maxDeadlineMs: 5000 },
          operations: [{ operation, algorithmFingerprint: DEFINITIONS[operation].fingerprint, maxDeadlineMs: 5000 }]
        });
        if (String(url).endsWith('/v1/compute/execute')) {
          const body = JSON.parse(init.body); calls.push(body);
          assert.equal(body.operation, operation);
          assert.ok(body.input.corpus, 'immutable complete corpus is available to success and fallback');
          if (mode === 'fallback') throw new Error('synthetic_server_unavailable');
          const result = executeOperation(operation, body.input);
          if (afterExecute) { const fn = afterExecute; afterExecute = null; await fn(); }
          return response({ ok: true, schema: 'memory-suite.compute.execute-response.v1', result: {
            schema: 'memory-suite.compute.result.v1', jobId: `job-${body.operationId}`, operationId: body.operationId,
            namespace: body.namespace, operation: body.operation, algorithmFingerprint: body.algorithmFingerprint,
            inputDigest: body.inputDigest, binding: body.binding, result, resultDigest: digestJson(result), timing: { workerMs: 0 }
          } });
        }
        throw new Error(`unexpected synthetic transport route: ${url}`);
      };
      const h = await createHayakuRuntime({ autoRepair: false, afterRequestAutoRepair: false,
        pluginSourceFile: sourceFile, messages: plain(messages), nativeFetch,
        arguments: { hayaku_debug: 'true', memory_suite_server_url: 'http://127.0.0.1:47630' } });
      try {
        h.context.__aliasComputeMode = mode === 'local' ? 'local' : 'prefer_server';
        const output = evidence(await h.callBeforeRequest([{ role: 'system', content: 'Continue the fictional story.' }, ...messages], 'model'));
        assert.ok(output.includes(fact), `${mode}: actual registered hook injects alias-owned original evidence`);
        assert.equal(output.includes(alias), false, `${mode}: retrieval-only alias never enters final evidence`);
        assert.equal(calls.length, mode === 'local' ? 0 : 1, `${mode}: one remote attempt, no duplicate execute`);
        assert.equal(h.llmCalls.length, 0);
        if (calls.length) {
          const documents = calls[0].input.corpus.documents;
          const matching = documents.filter(row => row.body.includes(alias));
          assert.equal(matching.length, 1, 'server corpus gives aliases only to the exact source summary');
          assert.ok(matching[0].body.includes(fact));
          const t = h.hayaku._test, rows = h.context.__aliasRuntimeRows;
          const localIds = Array.from(t.localRecallRank(rows, [alias]), row => row.id);
          const remote = executeOperation(operation, calls[0].input).rankings[0];
          assert.deepEqual(remote.map(row => row.key.split('\u0001')[2]), localIds,
            'same prepared alias corpus preserves local/server exact rank order');
        }
        results.push({ mode, evidence: output, remoteAttempts: calls.length });

        if (mode === 'server') {
          const t = h.hayaku._test, s = { ...h.hayaku.settings(), hierarchicalEpisodeMemoryEnabled: false,
            graphClosureRecallEnabled: false, retrievalRecentContext: { topics: [] } };
          const scope = await t.currentChatScope(), snapshot = t.authoritativeChatSnapshot(scope.chatMessages, scope);
          const owner = { scope, snapshot, worldline: t.authoritativeLedgerFromSnapshot(snapshot, scope).worldline };
          const raw = JSON.stringify(packet(fact, 'stable', { en: [alias] }));
          const current = { ...t.emptyStore(), _recallSourceRows: t.localRecallRowsFromPacket({ raw, messageIndex: 1 }, 'stable-source') };
          const oldBodies = Array.from(current._recallSourceRows, row => row.publicText);
          afterExecute = () => {
            current._recallSourceRows = t.localRecallRowsFromPacket({ raw: JSON.stringify(packet(fact, 'stable', {})), messageIndex: 1 }, 'stable-source');
            assert.deepEqual(Array.from(current._recallSourceRows, row => row.publicText), oldBodies,
              'stale-corpus probe changes alias metadata only, not evidence text');
          };
          await assert.rejects(() => t.searchIndexCompositeRecall(current, alias, s, owner), /HAYAKU_SEARCH_CORPUS_STALE/,
            'remote result is rejected when aliases change during await despite unchanged public bodies');
          current._recallSourceRows = t.localRecallRowsFromPacket({ raw, messageIndex: 1 }, 'stable-source');
          afterExecute = () => {
            const summary = current._recallSourceRows.find(row => row.category === 'summary_memory');
            summary.visibility = { privacy: 'private', ownerEntityId: 'unmentioned-owner' };
          };
          await assert.rejects(() => t.searchIndexCompositeRecall(current, alias, s, owner), /HAYAKU_SEARCH_CORPUS_STALE/,
            'private visibility introduced during await cannot reuse a public alias result');
        }
      } finally { await h.dispose(); }
    }
    assert.equal(results[1].evidence, results[0].evidence, 'server success final evidence exactly matches plugin-only');
    assert.equal(results[2].evidence, results[0].evidence, 'local fallback final evidence exactly matches plugin-only');
    console.log(JSON.stringify({ test: 'hayaku_alias_search_parity', modes: results.map(({ evidence, ...row }) => row),
      finalEvidenceBytesEqual: true, staleAliasCorpusRejected: true, actualNetworkCalls: 0, modelCalls: 0 }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
