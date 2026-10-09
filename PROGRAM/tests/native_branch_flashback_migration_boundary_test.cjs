'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const { clone, parent, branch } = require('./fixtures/native_branch_fixture.cjs');

// Hold the real migration after mode preparation, before it enters the writer.
// The fixture source seam adds no hook to shipped product code.
const plugin = fs.readFileSync(path.join(__dirname, '../plugins/Flashback_Memory.js'), 'utf8');
const seam = '    // Retirement and migration still commit the same manifest revision under';
assert.equal(plugin.split(seam).length - 1, 1);
const source = plugin.replace(seam, '    if (globalThis.__fixturePrepared) await globalThis.__fixturePrepared(prepared);\n' + seam);

(async () => {
  let passed = 0;
  for (const change of ['route', 'chat', 'lineage']) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-migration-boundary-'));
    const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
    const address = await app.listen();
    const f = await createFixture({ source, exposeStorageBridge: true,
      arguments: { memory_suite_server_url: `http://127.0.0.1:${address.port}` }, nativeFetch: fetch });
    try {
      const bridge = f.context.__fixtureStorageBridge, t = f.api._test;
      const p = parent('boundary-parent', 4);
      Object.assign(f.currentChat, p); f.character.chats = [f.currentChat];
      const snapshot = () => ({ character: clone(f.character), chat: clone(f.currentChat),
        db: { personas: [], selectedPersona: '' }, chatInfo: { characterIndex: 0, chatIndex: 0 } });
      const from = t.resolveScopeFromSnapshot(snapshot());
      const cfg = t.normalizeSettings({ embeddingProvider: 'hash', hashDimensions: 8, shardSize: 50 });
      const records = [1, 2, 3, 4].map(i => t.cleanRecordForMemory({
        id: 'record-' + i, sourceType: 'response', sourceId: `${p.id}:turn:${i}`,
        text: `User:\nUser ${i}\n\n---\n\nAssistant:\nAssistant ${i}`, title: 'Turn ' + i,
        scopeKey: from.scopeKey, pairIndex: i, turnIndex: i, tags: [], tokenCount: 8, tokens: 8,
        vector: [1, 0, 0, 0, 0, 0, 0, 0], dim: 8, provider: 'hash', model: 'hash-8',
        embeddingProvider: 'hash', embeddingModel: 'hash-8', embeddingDimensions: 8,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        lifecycleStatus: 'active', sourceHash: 'turn-' + i
      }, from, { authoritativeSource: true }).record);
      await t.saveAllRecords(records, cfg, from);
      const parentSnapshot = clone(f.currentChat);
      Object.assign(f.currentChat, branch(parentSnapshot, 2, 'boundary-child'));
      f.character.chats = [f.currentChat, parentSnapshot];
      const to = t.resolveScopeFromSnapshot(snapshot());
      const storageScope = scope => ({ scopeId: scope.scopeKey, scopeKey: scope.scopeKey,
        characterId: scope.characterId, chatId: scope.chatId,
        aliases: [scope.scopeKey, scope.storageHash, scope.chatId].filter(Boolean) });
      assert.equal((await t.cloneScopeStorage(from, to, cfg, { mode: 'chat_copy_live' })).ok, true);
      await bridge.setScopeMode(storageScope(from), 'server_only');
      let reached = false;
      f.context.__fixturePrepared = async prepared => {
        reached = true;
        assert.equal(prepared.targetMode, 'server_only', 'real route preparation completed');
        f.context.__fixturePrepared = null;
        if (change === 'route') await bridge.setScopeMode(storageScope(to), 'plugin_only');
        if (change === 'chat') {
          f.currentChat.id = 'other-active-chat'; f.currentChat.chatId = 'other-active-chat';
        }
        if (change === 'lineage') {
          f.currentChat.message[0].data = 'edited branch prefix';
          f.currentChat.messages = f.currentChat.message;
        }
      };
      const ready = await t.ensureScopeStorageReady(to, cfg);
      assert.equal(reached, true, change + ': preparation seam exercised');
      assert.equal(ready.storagePolicy?.reason, 'storage_policy_boundary_changed',
        change + ': stale preparation must not commit a binding after the boundary changes');
      if (change === 'route') {
        assert.equal((await bridge.getScopeMode(storageScope(to))).mode, 'plugin_only', 'explicit newer mode preserved');
        const stored = await t.loadScopeManifest(to);
        assert.notEqual(stored.nativeBranchCopy?.storageBinding?.targetModeOrigin, 'migrated', 'no stale migration binding');
      }
      passed++;
    } finally { await f.dispose(); await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify({ test: 'native_branch_flashback_migration_boundary', passed, liveRisuAI: 'NOT_RUN' }));
})().catch(error => { console.error(error); process.exitCode = 1; });
