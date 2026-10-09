'use strict';
// Drive the REAL HAYAKU pipeline through its REAL hooks.
//
// Why this exists: the LIBRA work showed a prompt built by an internal accessor is not evidence the
// product runs. The question here is the same one asked of LIBRA — does the pipeline actually run, and
// what does it ask the model for?
//
// The fixture had to be fixed to answer it: addRisuReplacer() used to return true and DISCARD the
// handler, so the plugin registered its hooks into nothing and no test could reach them. It now keeps
// them (runtime.replacers) and exposes callBeforeRequest/callAfterRequest, which call the real hooks
// the way RisuAI does.
const fs = require('node:fs');
const path = require('node:path');
const {
  createHayakuRuntime,
  createValidPacket,
  waitFor
} = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'hayaku_runtime_harness.cjs'));

const OUT = process.env.HAYAKU_LIVE_OUT || '/tmp/hayaku_live_pipeline.json';
const user = (id, data) => ({ role: 'user', chatId: id, id, data, time: Date.now() });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data, time: Date.now() });

// What HAYAKU asks the model for, answered from the prompt itself so the pipeline can complete.
// The normal-turn answer carries the visible text plus the packet between the BARE markers — showing
// the model an `<!--` decoration is what broke it before, so none is added here either.
const answerFor = (system, text) => {
  const packet = createValidPacket({ turn: 2, summary: 'Alice closed the valve and read the gauge at 4.2 bar.' });
  if (/hayaku\.native_repair_output\.v1/.test(system + text)) {
    return JSON.stringify({
      schema: 'hayaku.native_repair_output.v1',
      packet,
      grounding: { evidence: ['Alice closed the valve.', 'The gauge read 4.2 bar.'], confidence: 0.8 }
    });
  }
  if (/HAYAKU_STATE_PACKET_START/.test(system)) {
    return `The needle settles at 4.2 bar and the leak thins to a hiss.\n\nHAYAKU_STATE_PACKET_START\n${JSON.stringify(packet)}\nHAYAKU_STATE_PACKET_END`;
  }
  return 'The needle settles at 4.2 bar.';
};

(async () => {
  const out = { capturedAt: new Date().toISOString(), calls: [] };
  const runtime = await createHayakuRuntime({
    afterRequestAutoRepair: true,
    backgroundAutoRepair: false,
    messages: [
      user('u1', 'I turn the brass valve on the blue pipe.'),
      assistant('a1', 'Steam hisses through the joint. The gauge climbs.'),
      user('u2', 'I close it again and check the pressure reading.')
    ]
  });

  try {
    const { replacers, pluginStorage, llmCalls } = runtime;
    out.registeredModes = Array.from(replacers.keys());
    out.hookTypes = Object.fromEntries(Array.from(replacers.entries()).map(([k, v]) => [k, typeof v]));
    if (replacers.size === 0) {
      fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
      console.log(JSON.stringify({ ok: false, reason: 'the plugin registered no replacers', out: OUT }, null, 1));
      return;
    }

    runtime.setLlmResponder((system, text) => {
      const s = String(system || '');
      const u = String(text || '');
      const kind = /hayaku\.native_repair_output\.v1/.test(s + u) ? 'repair_envelope'
        : /HAYAKU_STATE_PACKET_START/.test(s) ? 'normal_turn_packet'
        : /authoring_profile|native_packet_authoring/i.test(s + u) ? 'authoring'
        : /HAYAKU_CONTINUITY_EVIDENCE|continuity context/i.test(s + u) ? 'evidence'
        : 'other';
      out.calls.push({
        kind, systemChars: s.length, userChars: u.length,
        hasStartMarker: /HAYAKU_STATE_PACKET_START/.test(s + u),
        showsHtmlCommentDecoration: /<!--\s*HAYAKU_STATE_PACKET_START/.test(s),
        hasEnvelopeSchema: /hayaku\.native_repair_output\.v1/.test(s + u)
      });
      return answerFor(s, u);
    });

    // Drive the REAL hooks, in the order RisuAI drives them.
    let beforeError = ''; let beforeOutcome = '';
    try {
      const result = await runtime.callBeforeRequest(runtime.chat.messages, 'model');
      beforeOutcome = Array.isArray(result) ? `array(${result.length})` : typeof result;
    } catch (error) { beforeError = `${error?.name}: ${String(error?.message || error).slice(0, 400)}`; }
    out.beforeOutcome = beforeOutcome;
    out.beforeError = beforeError;

    let afterError = '';
    try {
      await runtime.callAfterRequest('The needle settles at 4.2 bar and the leak thins to a hiss.', 'model');
    } catch (error) { afterError = `${error?.name}: ${String(error?.message || error).slice(0, 400)}`; }
    out.afterError = afterError;

    // Let deferred work land, then read what the plugin stored.
    try { await waitFor(() => llmCalls.length > 0, 'a model call', 25000); } catch (_) {}
    try { await waitFor(() => pluginStorage.values.size > 1, 'stored state', 12000); } catch (_) {}

    out.llmCallCount = llmCalls.length;
    out.storedKeys = Array.from(pluginStorage.values.keys());
    out.storedCount = out.storedKeys.length;
    out.packetStored = out.storedKeys.some(k => /packet/i.test(k));
    out.ledgerStored = out.storedKeys.some(k => /ledger/i.test(k));

    // Read the stored packet back, so "stored" is not just a key that exists.
    let storedPacket = null;
    for (const key of out.storedKeys) {
      if (!/packet/i.test(key)) continue;
      try {
        const raw = pluginStorage.values.get(key);
        const parsed = JSON.parse(raw);
        storedPacket = { key, schema: parsed?.schema || parsed?.meta?.schema || null, type: typeof parsed };
        break;
      } catch (_) {}
    }
    out.storedPacket = storedPacket;

    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(JSON.stringify({
      ok: true, out: OUT,
      registeredModes: out.registeredModes,
      beforeOutcome: out.beforeOutcome, beforeError: out.beforeError,
      afterError: out.afterError,
      modelCalls: out.calls,
      llmCallCount: out.llmCallCount,
      storedCount: out.storedCount, packetStored: out.packetStored, ledgerStored: out.ledgerStored,
      storedKeys: out.storedKeys.slice(0, 14),
      storedPacket: out.storedPacket
    }, null, 1));
  } finally {
    if (typeof runtime.dispose === 'function') await runtime.dispose();
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
