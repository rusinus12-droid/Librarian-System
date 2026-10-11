'use strict';
// FB-R3 — recall parity through the PUBLIC path: capture → fresh runtime → selection → injection.
//
// The reviewer rejected the previous version (COMBINED_REVIEW_20260922 §4) for three reasons, all fixed
// here:
//
//   1. The injection assertion was `assert.ok(injectedModes.length >= 0)` — always true, so an empty
//      `beforeRequest` return passed. It is now a per-mode assertion on the returned payload's CONTENT.
//   2. Selection was satisfied by ONE mode and by ID *or* text, not both. Both are required, per mode.
//   3. The seed went through `_test.saveAllRecords`, which is NOT the public capture path. Measured why
//      that matters: `beforeRequest` runs `synchronizeFlashbackTurnWorldline`, which retires stored
//      records the live worldline does not account for — so a hand-seeded record is deleted mid-request
//      and the injection comes back empty (`storedRecords:0`). The seed now comes from the real capture
//      chain, and that is why the earlier version could never see an injection.
//
// The public chain, per storage mode:
//   ingestLiveChatColdStart → beforeRequest(user turn) → afterRequest(assistant reply)   [capture]
//   → dispose → re-create on the SAME storage                                            [fresh runtime]
//   → beforeRequest(new turn)                                                            [select + inject]
//
// Run: node Librarian-System/PROGRAM/tests/flashback_recall_parity_public_path_test.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const PROGRAM = path.resolve(__dirname, '..');
const { createFixture } = require(path.join(PROGRAM, 'tests', 'fixtures', 'flashback_native_runtime_fixture.cjs'));

const { syntheticFetch, configure, readyForRecall } = require('./helpers/unload_recall_contract_fixture.cjs');
const results = [];
const check = (name, fn) => { try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: String(e.message).slice(0, 400) }); } };
const plain = value => JSON.parse(JSON.stringify(value ?? null));

// The corpus. SEED_PHRASE appears only in the assistant reply, so a wrong or missing selection is visible
// in the rendered evidence text.
const SEED_USER = 'I check the gauge and step back.';
const SEED_REPLY = 'The needle holds at the red mark and the spare valve hangs on the north wall hook.';
const SEED_PHRASE = 'needle holds at the red mark';
const QUERY = 'What did the gauge show, and where is the spare valve?';
const PROBE = 'Remind me about the gauge reading and the spare valve.';
const CAP_CHARS = 14000;

// The capture entry point DIFFERS by backend, and using the wrong one silently stores nothing:
//   chatOutput  → processRisuChatOutputEvent (the host's chat-output event)
//   afterRequest → the afterRequest selection hook
// Measured on this fixture: with `chatOutput`, calling `afterRequest` returned a capture result that
// stored 0 records, so the whole suite failed at the readback step for that mode alone. Driving each
// backend through its own path is what the reviewer meant by capture-backend parity.
const captureOnce = async (fixture, mode, { userText, replyText }) => {
  const sel = fixture.api._selectionTest;
  const t = fixture.api._test;
  await sel.beforeRequest([{ role: 'user', chatId: 'u1', content: userText }], 'model');
  await new Promise(resolve => setTimeout(resolve, 50));
  if (mode === 'chatOutput') {
    fixture.currentChat.message = [
      { role: 'user', chatId: 'u1', data: userText },
      { role: 'assistant', chatId: 'a1', data: replyText }
    ];
    fixture.currentChat.messages = fixture.currentChat.message;
    return await t.processRisuChatOutputEvent({
      char: fixture.character, chat: fixture.currentChat, characterIndex: 0, chatIndex: 0,
      messageIndex: fixture.currentChat.message.length - 1
    });
  }
  fixture.currentChat.message = [
    { role: 'user', chatId: 'u1', data: userText },
    { role: 'assistant', chatId: 'a1', data: replyText }
  ];
  fixture.currentChat.messages = fixture.currentChat.message;
  return await sel.afterRequest(replyText, 'model');
};

(async () => {
  const modeReports = [];

  for (const mode of ['chatOutput', 'afterRequest']) {
    let fixture = await createFixture({ captureBackend: mode });
    const storage = fixture.pluginStorage;
    const host = fixture.host;
    // Snapshot the live chat AFTER the capture, not before it. The restart stands in for a plugin reload
    // in a running app, where the on-screen chat already contains the captured turn; a pre-capture
    // snapshot leaves the fresh runtime's turn worldline empty (measured: revision 0, nodes 0) and its
    // sync cannot run, so recall finds nothing. Both the chat and the character are carried because the
    // scope identity is derived from the two together.
    let chat = null;
    let character = null;
    let captureInfo = null;
    let readback = null;
    let selection = null;
    let injection = null;

    try {
      const api = fixture.api;
      fixture.host.nativeFetch = (url, init) => syntheticFetch(url, init);
      await configure(fixture, 'configured');
      const cfg = await api.loadSettings();
      await api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
      const capture = await captureOnce(fixture, mode, { userText: SEED_USER, replyText: SEED_REPLY });
      captureInfo = { result: plain(capture) };
      await readyForRecall(fixture, 'configured', SEED_PHRASE);
      chat = plain(fixture.currentChat);
      character = plain(fixture.character);
    } finally {
      await fixture.dispose();
    }

    // ---- FRESH RUNTIME on the same storage ---------------------------------------------------------
    fixture = await createFixture({ pluginStorage: storage, safeLocalStorage: host.safeLocalStorage, chat, character, captureBackend: mode });
    try {
      const api = fixture.api;
      const t = api._test;
      const sel = api._selectionTest;
      fixture.host.nativeFetch = (url, init) => syntheticFetch(url, init);
      await configure(fixture, 'configured');
      const cfg = await api.loadSettings();
      const scope = await api.resolveCurrentScope();

      const stored = await t.loadScopeRecords(scope.scopeKey);
      const records = stored?.records || [];
      readback = {
        count: records.length,
        ids: records.map(r => r.id),
        carriesSeed: records.some(r => String(r.text || '').includes(SEED_PHRASE))
      };

      // ---- INJECTION: the real beforeRequest return ----------------------------------------------
      //
      // TWO turns, because that is what the product does. Measured: a `beforeRequest` right after a
      // capture first RECONCILES the pending journal and synchronizes the turn worldline (revision 0 -> 1
      // for chatOutput, whose capture entry point does not sync it itself), and recall in that same call
      // still sees the pre-sync worldline. From the NEXT turn the evidence is delivered — which is also
      // the real ordering: a turn never recalls the record it is itself capturing.
      const warmup = await sel.beforeRequest([{ role: 'user', chatId: 'u8', content: PROBE }], 'model')
        .catch(error => ({ __error: String(error?.message || error) }));
      let returned;
      let threw = '';
      try { returned = await sel.beforeRequest([{ role: 'user', chatId: 'u9', content: PROBE }], 'model'); } catch (e) { threw = String(e?.message || e); }
      const warmupDelivered = JSON.stringify(warmup ?? null).includes(SEED_PHRASE);
      const flat = JSON.stringify(returned ?? null);
      const lr = plain(t.pendingCaptureRuntimeSnapshot?.().lastRecall || {});
      injection = {
        returnedArrayLen: Array.isArray(returned) ? returned.length : null,
        threw,
        carriesSeedPhrase: flat.includes(SEED_PHRASE),
        carriesContinuityBlock: flat.includes('ACTIVE CONTINUITY EVIDENCE'),
        lastRecallStored: lr.storedRecords,
        lastRecallCandidates: lr.candidates,
        lastRecallDelivered: lr.delivery?.delivered,
        warmupDelivered
      };
      // ---- SELECTION: the public chain, with the real capChars argument --------------------------
      // `capChars` is an ARGUMENT, not a setting: omitting it passes 0 and every choice is discarded
      // (`discarded:[1]`, `capChars:0` — measured).
      const recall = await sel.prepareFlashbackRecall(QUERY, cfg, scope, {});
      const units = (sel.prepareFlashbackEvidenceUnits(recall, cfg)?.units || []);
      const plan = await Promise.resolve(sel.selectFlashbackEvidencePlan(recall, cfg, CAP_CHARS));
      const renderedText = String(plan?.text || '');
      selection = {
        // `prepareFlashbackRecall` exposes `loadedTotal` and `records`; there is no `storedRecords` key on
        // its return (measured: `'storedRecords' in recall === false`). Reading the wrong field made a
        // healthy recall look empty.
        loadedTotal: recall?.loadedTotal,
        recordCount: Array.isArray(recall?.records) ? recall.records.length : null,
        candidates: recall?.candidates,
        units: units.length,
        deliveredIds: Array.isArray(plan?.deliveredIds) ? plan.deliveredIds.map(String) : [],
        renderedChars: renderedText.length,
        renderedCarriesSeed: renderedText.includes(SEED_PHRASE),
        renderedCarriesWrong: renderedText.includes('festival banners') || renderedText.includes('unrelated')
      };

    } finally {
      await fixture.dispose();
    }

    modeReports.push({ mode, captureInfo, readback, selection, injection });
  }

  // Every assertion applies to EVERY mode, and the failing mode is named. A single healthy mode cannot
  // carry the suite: the reviewer's complaint was exactly that one mode was enough.
  const perMode = (label, fn) => check(label, () => {
    for (const row of modeReports) {
      try { fn(row); } catch (e) { throw new Error(`${row.mode}: ${e.message}`); }
    }
  });

  perMode('every mode: the captured reply survives a fresh runtime', row => {
    assert.ok(row.readback.count > 0, `no records after restart — ${JSON.stringify(row.readback)}`);
    assert.ok(row.readback.carriesSeed, `the captured reply is not in the stored corpus — ${JSON.stringify(row.readback)}`);
  });

  perMode('every mode: the public recall SELECTS the stored record (id AND text)', row => {
    assert.ok(row.selection.loadedTotal > 0, `the runtime must load the stored corpus — ${JSON.stringify(row.selection)}`);
    assert.ok(row.selection.recordCount > 0, `the recall must carry records — ${JSON.stringify(row.selection)}`);
    assert.ok(row.selection.units > 0, `no evidence units were built — ${JSON.stringify(row.selection)}`);
    assert.ok(row.selection.deliveredIds.length > 0, `nothing was selected — ${JSON.stringify(row.selection)}`);
    assert.ok(row.selection.deliveredIds.some(id => row.readback.ids.includes(id)),
      `a delivered id must be one of the stored ids — delivered=${JSON.stringify(row.selection.deliveredIds)} stored=${JSON.stringify(row.readback.ids)}`);
    assert.ok(row.selection.renderedCarriesSeed,
      `the rendered evidence must carry the stored text — ${JSON.stringify(row.selection)}`);
    assert.equal(row.selection.renderedCarriesWrong, false,
      `a wrong record reached the plan — ${JSON.stringify(row.selection)}`);
  });

  perMode('every mode: beforeRequest INJECTS the selected evidence', row => {
    assert.equal(row.injection.threw, '', `beforeRequest threw: ${row.injection.threw}`);
    assert.ok(row.injection.returnedArrayLen !== null, `beforeRequest must return a message array — ${JSON.stringify(row.injection)}`);
    assert.ok(row.injection.returnedArrayLen >= 2, `the injected list must contain more than the request — ${JSON.stringify(row.injection)}`);
    // The requirement the previous version skipped: the payload must carry the record's own text. An
    // empty or evidence-free return is a FAILURE, not something to record.
    assert.ok(row.injection.carriesSeedPhrase,
      `the injected messages must carry the stored evidence — ${JSON.stringify(row.injection)}`);
    assert.ok(row.injection.carriesContinuityBlock,
      `the injected messages must carry the evidence block — ${JSON.stringify(row.injection)}`);
  });

  const passed = results.filter(r => r.ok).length;
  console.log(`flashback_recall_parity_public_path_test: ${passed}/${results.length} PASS`);
  for (const r of results) console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n       ${r.error}`}`);
  console.log(JSON.stringify({
    modes: modeReports.map(r => ({
      mode: r.mode, stored: r.readback?.count, delivered: r.selection?.deliveredIds,
      rendered: r.selection?.renderedChars, injected: r.injection?.carriesSeedPhrase,
      injectedLen: r.injection?.returnedArrayLen
    }))
  }, null, 1));
  process.exit(passed === results.length ? 0 : 1);
})().catch(error => { console.error(error); process.exit(1); });
