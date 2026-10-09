'use strict';
// Flashback subsystems WITH a real chat: cold start, re-analysis, and state recovery.
//
// The earlier probe called these with an empty chat, so rebuildCurrentChatMemory correctly refused with
// "현재 채팅에서 완성된 유저+AI 응답 턴을 찾지 못해" — that was the fixture, not the plugin. This probe
// supplies completed U+A turns so the rebuild paths have something to rebuild.
//
// State recovery is the part specific to Flashback, so it is checked for an observable effect: what the
// handoff adoption and restore validation report, and whether anything is written to storage.
const fs = require('node:fs');
const path = require('node:path');
const { createFixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'flashback_native_runtime_fixture.cjs'));

const OUT = process.env.FLASHBACK_SUB_OUT || '/tmp/flashback_subsystem.json';

// Completed U+A turns: a rebuild cannot proceed without them.
const messages = [
  { role: 'user', chatId: 'fb-u1', id: 'fb-u1', data: 'I open the iron gate and step into the greenhouse.', time: 1 },
  { role: 'assistant', chatId: 'fb-a1', id: 'fb-a1', data: 'Humid air wraps around you. Rows of orchids line the glass wall.', time: 2 },
  { role: 'user', chatId: 'fb-u2', id: 'fb-u2', data: 'I check the irrigation valve near the third row.', time: 3 },
  { role: 'assistant', chatId: 'fb-a2', id: 'fb-a2', data: 'The valve is seized. A thin crack runs along the copper housing.', time: 4 },
  { role: 'user', chatId: 'fb-u3', id: 'fb-u3', data: 'I fetch the wrench from the tool shed and come back.', time: 5 },
  { role: 'assistant', chatId: 'fb-a3', id: 'fb-a3', data: 'The wrench fits. Rust flakes off as you turn the housing a quarter turn.', time: 6 },
  { role: 'user', chatId: 'fb-u4', id: 'fb-u4', data: 'I open the valve fully and watch the gauge.', time: 7 },
  { role: 'assistant', chatId: 'fb-a4', id: 'fb-a4', data: 'Pressure climbs to 2.1 bar and holds. Water hisses along the third row channels.', time: 8 }
];

const attempt = async (fn, label) => {
  try { return { ok: true, value: await fn() }; }
  catch (error) { return { ok: false, error: `${error?.name}: ${String(error?.message || error).slice(0, 300)}`, label }; }
};
const brief = value => (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 500);

(async () => {
  const out = { capturedAt: new Date().toISOString(), messageCount: messages.length };
  const f = await createFixture({ chat: { message: messages, messages } });
  const cleanup = f.dispose || f.cleanup || (() => {});
  try {
    const api = f.api;
    const keysBefore = Array.from(f.pluginStorage.values.keys());

    out.initialStorage = keysBefore.map(k => k.slice(0, 70));

    // 1. Cold start — should ingest the live chat into memory.
    const cold = await attempt(() => api.ingestLiveChatColdStart(), 'ingestLiveChatColdStart');
    out.coldStart = cold.ok ? { returned: brief(cold.value) } : { error: cold.error };
    out.afterColdStartKeys = Array.from(f.pluginStorage.values.keys()).map(k => k.slice(0, 70));
    out.afterColdStartKeysAdded = out.afterColdStartKeys.filter(k => !keysBefore.includes(k)).length;

    // 2. Re-analysis — the rebuild paths, now with completed turns present.
    const rebuild = await attempt(() => api.rebuildCurrentChatMemory(), 'rebuildCurrentChatMemory');
    out.rebuildCurrentChatMemory = rebuild.ok ? { returned: brief(rebuild.value) } : { error: rebuild.error };
    const episode = await attempt(() => api.rebuildEpisodeIndex(), 'rebuildEpisodeIndex');
    out.rebuildEpisodeIndex = episode.ok ? { returned: brief(episode.value) } : { error: episode.error };
    out.afterRebuildKeysAdded = Array.from(f.pluginStorage.values.keys())
      .filter(k => !out.afterColdStartKeys.includes(k)).length;

    // 3. STATE RECOVERY — the Flashback-specific surface.
    const handoff = await attempt(() => api.adoptSessionHandoff(), 'adoptSessionHandoff');
    out.stateRecovery = {
      adoptSessionHandoff: handoff.ok ? { returned: brief(handoff.value) } : { error: handoff.error }
    };
    const restore = await attempt(() => api.validatePluginStorageRestore(), 'validatePluginStorageRestore');
    out.stateRecovery.validatePluginStorageRestore = restore.ok ? { returned: brief(restore.value) } : { error: restore.error };
    const legacy = await attempt(() => api.restoreLegacyCompactedSource(), 'restoreLegacyCompactedSource');
    out.stateRecovery.restoreLegacyCompactedSource = legacy.ok ? { returned: brief(legacy.value) } : { error: legacy.error };

    // Does recovery actually read back what was stored? A validator that never sees records proves
    // nothing, so the metrics it reports are the interesting part.
    const state = await attempt(() => api.debugState(), 'debugState');
    if (state.ok) {
      const parsed = typeof state.value === 'string' ? (() => { try { return JSON.parse(state.value); } catch { return null; } })() : state.value;
      out.stateRecovery.debugStateSummary = parsed ? {
        plugin: parsed.plugin?.version || null,
        topKeys: Object.keys(parsed).slice(0, 14),
        hasRecords: JSON.stringify(parsed).length
      } : { raw: brief(state.value) };
    } else {
      out.stateRecovery.debugStateSummary = { error: state.error };
    }

    // 4. The manual editor surface, which is the human-facing repair path.
    const manual = await attempt(() => api.listManualEditorRecords(), 'listManualEditorRecords');
    out.manualEditor = manual.ok
      ? { entries: Array.isArray(manual.value) ? manual.value.length : Object.keys(manual.value || {}).length, sample: brief(manual.value) }
      : { error: manual.error };

    // 5. Capture backend health — the live-observation path.
    const backend = await attempt(() => api.getCaptureBackendState(), 'getCaptureBackendState');
    out.captureBackend = backend.ok ? { returned: brief(backend.value) } : { error: backend.error };

    out.finalStorageKeys = Array.from(f.pluginStorage.values.keys()).map(k => k.slice(0, 70));

    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ ok: true, out: OUT, ...out }, null, 1));
  } finally {
    await cleanup();
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
