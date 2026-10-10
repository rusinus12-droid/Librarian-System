'use strict';
// Flashback STATE RECOVERY with something to recover.
//
// The earlier probe reported currentRecords: 0 because there was nothing to restore — the validator
// ran on empty storage, which proves nothing either way. This probe builds a recoverable situation:
// it lets a real cold start write records, then damages the storage the way a failed restore would
// (a missing shard, a stale manifest) and checks whether the recovery path notices and repairs.
//
// The standard applied: recovery "working" means the plugin detected the damage and the records were
// readable again afterwards — not that the API returned an object.
const fs = require('node:fs');
const path = require('node:path');
const { createFixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'flashback_native_runtime_fixture.cjs'));

const OUT = process.env.FLASHBACK_RECOVERY_OUT || '/tmp/flashback_recovery.json';

const messages = [
  { role: 'user', chatId: 'fb-u1', id: 'fb-u1', data: 'I open the iron gate and step into the greenhouse.', time: 1 },
  { role: 'assistant', chatId: 'fb-a1', id: 'fb-a1', data: 'Humid air wraps around you. Rows of orchids line the glass wall.', time: 2 },
  { role: 'user', chatId: 'fb-u2', id: 'fb-u2', data: 'I check the irrigation valve near the third row.', time: 3 },
  { role: 'assistant', chatId: 'fb-a2', id: 'fb-a2', data: 'The valve is seized. A thin crack runs along the copper housing.', time: 4 },
  { role: 'user', chatId: 'fb-u3', id: 'fb-u3', data: 'I fetch the wrench from the tool shed and come back.', time: 5 },
  { role: 'assistant', chatId: 'fb-a3', id: 'fb-a3', data: 'The wrench fits. Rust flakes off as you turn the housing a quarter turn.', time: 6 }
];

const parseMaybe = value => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
};

(async () => {
  const out = { capturedAt: new Date().toISOString() };

  // Phase 1: build a real scope with records.
  const f = await createFixture({ chat: { message: messages, messages } });
  const cleanup = f.dispose || f.cleanup || (() => {});
  try {
    const api = f.api;
    await api.ingestLiveChatColdStart();
    await api.rebuildEpisodeIndex();
    const keys = Array.from(f.pluginStorage.values.keys());
    out.prepared = {
      keys: keys.map(k => k.slice(0, 80)),
      shardKeys: keys.filter(k => /shard/i.test(k)).map(k => k.slice(0, 80)),
      manifestKeys: keys.filter(k => /manifest/i.test(k)).map(k => k.slice(0, 80)),
      recordChars: keys.filter(k => /shard/i.test(k)).reduce((sum, k) => sum + String(f.pluginStorage.values.get(k) || '').length, 0)
    };

    // What does a healthy validation say, now that records exist?
    const healthy = parseMaybe(await api.validatePluginStorageRestore());
    out.validationHealthy = {
      ok: healthy?.ok,
      warnings: healthy?.warnings,
      metrics: healthy?.metrics
    };

    // Phase 2: damage — remove a shard the manifest still references, the shape of a failed restore.
    const shardKey = out.prepared.shardKeys[0];
    let damageError = '';
    if (shardKey) {
      const saved = f.pluginStorage.values.get(shardKey);
      f.pluginStorage.values.delete(shardKey);
      out.damage = { removed: shardKey.slice(0, 80), savedChars: String(saved || '').length };

      // Does validation notice the missing shard?
      const afterDamage = parseMaybe(await api.validatePluginStorageRestore());
      out.validationAfterDamage = {
        ok: afterDamage?.ok,
        warnings: afterDamage?.warnings,
        metrics: afterDamage?.metrics
      };

      // Does the rebuild repair it? This is the recovery path that matters.
      let rebuildResult = null;
      let rebuildError = '';
      try { rebuildResult = parseMaybe(await api.rebuildCurrentChatMemory()); }
      catch (error) { rebuildError = `${error?.name}: ${String(error?.message || error).slice(0, 240)}`; }
      out.repair = {
        rebuildError,
        replacedRecords: rebuildResult?.replacedRecords ?? null,
        recoveredMissingShards: rebuildResult?.recoveredMissingShards ?? null,
        recoveredMissingShardIndexes: rebuildResult?.recoveredMissingShardIndexes ?? null,
        replacementCommitReadbackVerified: rebuildResult?.replacementCommitReadbackVerified ?? null,
        sourceCommitId: rebuildResult?.sourceCommitId ?? null,
        replacementCommitId: rebuildResult?.replacementCommitId ?? null
      };

      // Are records readable again, and is the removed key back?
      const keysAfter = Array.from(f.pluginStorage.values.keys());
      out.repair.keysAfter = keysAfter.map(k => k.slice(0, 80));
      out.repair.shardRestored = keysAfter.some(k => /shard/i.test(k));
      out.repair.shardCountBefore = out.prepared.shardKeys.length;
      out.repair.shardCountAfter = keysAfter.filter(k => /shard/i.test(k)).length;

      const validationFinal = parseMaybe(await api.validatePluginStorageRestore());
      out.repair.validationFinal = { ok: validationFinal?.ok, warnings: validationFinal?.warnings, metrics: validationFinal?.metrics };

      // And can the plugin still read its own memory?
      const state = parseMaybe(await api.debugState());
      out.repair.recordsReadable = state && typeof state === 'object' ? JSON.stringify(state.records ?? null).slice(0, 300) : null;
    } else {
      out.damage = { error: 'no shard key to remove' };
    }

    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ ok: true, out: OUT, ...out }, null, 1));
  } finally {
    await cleanup();
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
