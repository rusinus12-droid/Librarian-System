'use strict';
// Memory lens records on the Librarian System server: in server-only and mirror modes the lens keys
// reach the real server (SQLite), and the plugin-wide storage-mode discovery classifies them as
// chat-scope records instead of blocking the switch as unresolved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const results = [];

const discoveryAdapter = () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
  const start = source.indexOf('// BEGIN LIBRA GLOBAL DISCOVERY ADAPTER');
  const end = source.indexOf('// END LIBRA GLOBAL DISCOVERY ADAPTER', start);
  const hash32 = value => { let h = 0x811c9dc5; for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193); return h >>> 0; };
  const keyHash = value => hash32(value).toString(36);
  const sandbox = { TextEncoder, TextDecoder, Response, DecompressionStream, atob, Uint8Array, keyHash, stableHash: keyHash };
  vm.createContext(sandbox);
  return vm.runInContext(`${source.slice(start, end)}\nmemorySuiteLibraDiscoverGlobalScopes`, sandbox);
};

(async () => {
  for (const mode of ['server_only', 'mirror']) {
    const s = await serverFixture({ mode });
    try {
      const f = s.f;
      f.control.onCall = async args => JSON.stringify(args).includes('LIBRA LENS ANALYZER')
        ? { type: 'success', result: JSON.stringify({ items: [{ label: '약속', text: '열쇠를 오늘 돌려주기로 했다.', refs: ['t2-a'], quote: '오늘 돌려주겠다고 약속했다' }] }) }
        : { type: 'success', result: JSON.stringify(f.control.artifact) };
      const lens = await f.r.api.createLens({ name: '약속', instruction: { goal: '약속을 기록하라.' } });
      assert.equal((await f.r.core.runLensForRange(lens.lensId, { startTurn: 1, endTurn: 5 })).status, 'succeeded');
      const serverKeys = s.storedRows().map(row => row.key).filter(key => key.includes(':lens:'));
      for (const suffix of ['records', 'runs', 'raw']) assert.ok(serverKeys.some(key => key.endsWith(`:lens:${lens.lensId}:${suffix}`)), `${mode}: ${suffix} reach the server`);
      assert.ok(serverKeys.some(key => key.endsWith(':lens:head')), `${mode}: the lens head reaches the server`);
      const localKeys = [...s.local.keys()].filter(key => key.includes(':lens:'));
      assert.equal(localKeys.length > 0, mode === 'mirror', `${mode}: local copies follow the storage mode`);
      await f.r.api.trashLens(lens.lensId);
      await f.r.api.purgeLens(lens.lensId);
      assert.equal(s.storedRows().filter(row => row.key.includes(`:lens:${lens.lensId}:`)).length, 0, `${mode}: permanent delete removes the server copies`);
      results.push(`${mode}: lens records are stored on and removed from the server`);
    } finally {
      await s.cleanup();
    }
  }

  const discover = discoveryAdapter();
  const row = (key, value) => ({ location: 'plugin', space: 'plugin', key, logicalKey: key, deleted: false, value: JSON.stringify(value), revision: 1, digest: 'fixture' });
  const scopeKey = 'legacy_index_1';
  const result = await discover({
    hostScopes: [{ characterId: 'character_1', chatId: 'chat_1', characterName: 'C', chatTitle: 'T', characterIndex: 1, chatIndex: 0 }],
    registries: [],
    records: [
      row(`libra:v1:scope:${scopeKey}:manifest`, { schema: 'libra.manifest.v1', scopeKey, characterId: 'character_1', chatId: 'chat_1', memories: {}, inheritedMemories: [] }),
      row(`libra:v1:scope:${scopeKey}:lens:head`, { schema: 'libra.lens_scope_head.v1', scopeKey, lenses: {} }),
      row(`libra:v1:scope:${scopeKey}:lens:lens_abc:records`, { schema: 'libra.lens_record_store.v1', records: {} })
    ]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.blockers)), [], 'lens keys do not block the plugin-wide storage mode switch');
  assert.deepEqual(JSON.parse(JSON.stringify(result.records.map(record => record.classification))), ['scope', 'scope', 'scope']);
  results.push('storage-mode discovery classifies lens keys as chat-scope records');

  console.log(JSON.stringify({ test: 'libra_custom_memory_lens_server_runtime', passed: results.length, results }));
})().catch(error => { console.error(error); process.exitCode = 1; });
