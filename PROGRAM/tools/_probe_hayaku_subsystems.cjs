'use strict';
// HAYAKU subsystems: source-edit review, cold start, and re-analysis — driven, not inspected.
//
// The earlier pass called these with empty/loosely-typed arguments and produced three misleading
// results: 'SOURCE_RULES_INVALID', 'SOURCE_TRACKING_MODE_INVALID', and a cold start that skipped with
// `cold_start_historical_evidence_unavailable`. Each was my argument, not the plugin. This version
// reads what each API expects from its own status surfaces before calling it, and supplies a chat with
// completed U+A turns so cold start has historical evidence to work from.
const fs = require('node:fs');
const path = require('node:path');
const {
  createHayakuRuntime,
  waitFor
} = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'hayaku_runtime_harness.cjs'));

const OUT = process.env.HAYAKU_SUB_OUT || '/tmp/hayaku_subsystems.json';

const user = (id, data, t) => ({ role: 'user', chatId: id, id, data, time: t });
const assistant = (id, data, t) => ({ role: 'assistant', chatId: id, id, data, time: t });

// Completed U+A turns across several scenes: enough history for a cold start to summarize.
const messages = [
  user('u1', 'I unlock the observatory door and step inside.', 1),
  assistant('a1', 'Dust sheets cover three telescopes. A logbook lies open on the desk.', 2),
  user('u2', 'I read the last entry in the logbook.', 3),
  assistant('a2', 'The entry is dated eight days ago and signed by "M. Ardalen", noting a broken drive gear.', 4),
  user('u3', 'I inspect the drive gear on the largest telescope.', 5),
  assistant('a3', 'Two teeth are sheared off the brass gear. A spare sits in the crate below.', 6),
  user('u4', 'I fit the spare gear and test the mount.', 7),
  assistant('a4', 'The mount turns smoothly now. The telescope tracks the horizon without a shudder.', 8),
  user('u5', 'I write my own entry in the logbook and lock up.', 9),
  assistant('a5', 'You sign the entry and close the log. The observatory settles into silence behind you.', 10)
];

const attempt = async (fn, label) => {
  try { return { ok: true, value: await fn() }; }
  catch (error) { return { ok: false, error: `${error?.name}: ${String(error?.message || error).slice(0, 300)}`, label }; }
};
const brief = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return String(text ?? 'null').slice(0, 700);
};
const parseMaybe = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return value; } };

(async () => {
  const out = { capturedAt: new Date().toISOString(), messageCount: messages.length };
  const runtime = await createHayakuRuntime({ messages });
  try {
    const api = runtime.hayaku;

    // 1. SOURCE-EDIT REVIEW — read the rules surface first, then write in the shape it wants.
    const rulesBefore = parseMaybe(await (async () => { try { return await api.getSourceEditRules(); } catch (e) { return { error: String(e?.message || e).slice(0, 200) }; } })());
    out.sourceEdit = { rulesBefore: brief(rulesBefore) };

    // The rules object carries version/ignoredTags/unwrapTags/sourceTags/controls. Write it back with
    // one added rule rather than an array (which the first attempt did, and got SOURCE_RULES_INVALID).
    const shape = rulesBefore && typeof rulesBefore === 'object' ? rulesBefore : {};
    const writeAttempts = [
      ['object with sourceTags', { ...shape, sourceTags: [...(shape.sourceTags || []), { id: 'obs', pattern: 'observatory', replacement: 'observatory' }] }],
      ['object unchanged', { ...shape }]
    ];
    out.sourceEdit.writes = [];
    for (const [label, value] of writeAttempts) {
      const run = await attempt(() => api.setSourceEditRules(value), `setSourceEditRules:${label}`);
      out.sourceEdit.writes.push({ label, ok: run.ok, result: run.ok ? brief(run.value) : run.error });
    }

    // Tracking mode: discover the accepted values from the status surface.
    const syncBefore = parseMaybe(await (async () => { try { return await api.getSourceEditSyncStatus(); } catch (e) { return { error: String(e?.message || e).slice(0, 200) }; } })());
    out.sourceEdit.syncBefore = brief(syncBefore);
    out.sourceEdit.trackingAttempts = [];
    for (const mode of ['notify', 'track', 'apply', 'off', 'auto']) {
      const run = await attempt(() => api.setSourceEditTrackingMode(mode), `tracking:${mode}`);
      out.sourceEdit.trackingAttempts.push({ mode, ok: run.ok, result: run.ok ? brief(run.value) : run.error });
    }
    const review = await attempt(() => api.reviewSourceEdits(), 'reviewSourceEdits');
    out.sourceEdit.review = review.ok ? { returned: brief(review.value) } : { error: review.error };

    // 2. COLD START — with completed turns present, this should produce work rather than skip.
    const recovery = api.recovery || {};
    const coldStatusBefore = await attempt(() => recovery.coldStartStatus?.(), 'coldStartStatus');
    out.coldStart = { statusBefore: coldStatusBefore.ok ? brief(coldStatusBefore.value) : coldStatusBefore.error };
    const cold = await attempt(() => recovery.coldStart?.({}), 'recovery.coldStart');
    out.coldStart.run = cold.ok ? { returned: brief(cold.value) } : { error: cold.error };
    // Give any deferred authoring a bounded window, then re-read.
    try { await waitFor(() => (runtime.llmCalls || []).length > 0, 'a cold-start model call', 20000); } catch (_) {}
    out.coldStart.modelCalls = (runtime.llmCalls || []).length;
    out.coldStart.statusAfter = await (async () => { try { return brief(await recovery.coldStartStatus?.()); } catch (e) { return String(e?.message || e).slice(0, 200); } })();
    out.coldStart.storedKeys = Array.from(runtime.pluginStorage.values.keys()).map(k => k.slice(0, 70));

    // 3. RE-ANALYSIS — repair/regenerate surfaces.
    out.reAnalysis = {};
    for (const name of ['repairNow', 'repairSelected', 'regenerateTurns', 'resolveRegenerationChoice', 'failedAnalysis']) {
      if (typeof recovery[name] !== 'function') { out.reAnalysis[name] = { missing: true }; continue; }
      const run = await attempt(() => recovery[name]({}), name);
      out.reAnalysis[name] = run.ok ? { returned: brief(run.value) } : { error: run.error };
    }
    const jobStatus = await attempt(() => recovery.jobStatus?.(), 'jobStatus');
    out.reAnalysis.jobStatus = jobStatus.ok ? brief(jobStatus.value) : jobStatus.error;

    // 4. The ledger surface: does it hold a real record of the chat?
    const ledger = api.ledger || {};
    const inspect = await attempt(() => ledger.inspect?.(), 'ledger.inspect');
    out.ledger = inspect.ok ? { returned: brief(inspect.value) } : { error: inspect.error };
    const coldLedger = await attempt(() => ledger.coldStartStatus?.(), 'ledger.coldStartStatus');
    out.ledger.coldStartStatus = coldLedger.ok ? brief(coldLedger.value) : coldLedger.error;

    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ ok: true, out: OUT, ...out }, null, 1));
  } finally {
    await runtime.dispose();
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
