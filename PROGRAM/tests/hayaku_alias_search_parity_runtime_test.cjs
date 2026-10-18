'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHayakuRuntime, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');

const fact = '서연은 은색 열쇠를 소나무 상자에 보관했다.';
const alias = 'silver key';
const packet = (summary, scene, aliases = {}) => ({
  meta: { schema: 'hayaku_packet_v1', packet_type: 'current_snapshot', packet_schema_rev: 2,
    scene_id: scene, turn_anchor: summary, summary_memory: { id: `summary-${scene}`, summary, recallAliases: aliases } },
  entity: { characters: [], relations: [], pov_memories: [], secrets: [] },
  world: { active_events: [{ id: `event-${scene}`, summary }] },
  narrative: { scene_deltas: [] }, planner: { continuity_locks: [], do_not_resolve_yet: [] }
});
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
    const capture = 'const rows=localRecallCandidates(store,query,settings,null);';
    assert.equal(original.split(capture).length, 2, 'composite recall ranks locally');
    const sourceFile = path.join(root, 'hayaku-test.js');
    fs.writeFileSync(sourceFile, original.replace(needle, "computeMode: globalThis.__aliasComputeMode || 'local',")
      .replace(capture, 'globalThis.__aliasRuntimeRows=store._recallSourceRows||store.index;\n    '+capture));
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
    // The Compute SDK is retired from HAYAKU: a server-backed storage policy ranks the same
    // alias corpus locally, so both policies inject the same evidence with no Compute call.
    for (const mode of ['local', 'prefer_server']) {
      const calls = [];
      const nativeFetch = async url => {
        // A synthetic in-memory transport; never delegate to fetch or open a socket.
        calls.push(String(url));
        throw new Error(`unexpected synthetic transport route: ${url}`);
      };
      const h = await createHayakuRuntime({ autoRepair: false, afterRequestAutoRepair: false,
        pluginSourceFile: sourceFile, messages: plain(messages), nativeFetch,
        arguments: { hayaku_debug: 'true', memory_suite_server_url: 'http://127.0.0.1:47630' } });
      try {
        h.context.__aliasComputeMode = mode;
        const output = evidence(await h.callBeforeRequest([{ role: 'system', content: 'Continue the fictional story.' }, ...messages], 'model'));
        assert.ok(output.includes(fact), `${mode}: actual registered hook injects alias-owned original evidence`);
        assert.equal(output.includes(alias), false, `${mode}: retrieval-only alias never enters final evidence`);
        assert.equal(calls.filter(url => url.includes('/v1/compute/')).length, 0, `${mode}: no Compute call`);
        assert.equal(h.llmCalls.length, 0);
        const t = h.hayaku._test, rows = h.context.__aliasRuntimeRows;
        const local = Array.from(t.localRecallRank(rows, [alias]), row => row.id);
        assert.ok(local.length, `${mode}: the alias ranks its exact source summary locally`);
        results.push({ mode, evidence: output, computeCalls: 0 });
      } finally { await h.dispose(); }
    }
    assert.equal(results[1].evidence, results[0].evidence, 'server-backed policy final evidence exactly matches plugin-only');
    console.log(JSON.stringify({ test: 'hayaku_alias_search_parity', modes: results.map(({ evidence, ...row }) => row),
      finalEvidenceBytesEqual: true, actualNetworkCalls: 0, modelCalls: 0 }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
