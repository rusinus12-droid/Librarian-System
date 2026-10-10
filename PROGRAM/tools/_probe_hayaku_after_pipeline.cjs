'use strict';
// Drive the REAL HAYAKU packet-authoring pipeline through its REAL afterRequest hook.
//
// Where the model work actually happens: beforeRequest only injects recall context and returns the
// messages (measured: it issues no model call). The packet — the thing HAYAKU exists to write — is
// authored in afterRequest, from the assistant reply that just completed. So this drives afterRequest
// with a realistic assistant turn and captures what the plugin asks the model for.
//
// The fixture had to be fixed first: addRisuReplacer() returned true and DISCARDED the handler, so the
// plugin registered its hooks into nothing and no test could reach them. It now keeps them and exposes
// callBeforeRequest/callAfterRequest.
const fs = require('node:fs');
const path = require('node:path');
const {
  createHayakuRuntime,
  createValidPacket,
  waitFor
} = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'hayaku_runtime_harness.cjs'));

const OUT = process.env.HAYAKU_AFTER_OUT || '/tmp/hayaku_after_pipeline.json';
const user = (id, data) => ({ role: 'user', chatId: id, id, data, time: Date.now() });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data, time: Date.now() });

const assistantReply = 'The needle settles at 4.2 bar. Alice wipes her hands and notes the reading in the log.';

(async () => {
  const out = { capturedAt: new Date().toISOString(), calls: [] };
  const runtime = await createHayakuRuntime({
    afterRequestAutoRepair: true,
    backgroundAutoRepair: false,
    messages: [
      user('u1', 'I turn the brass valve on the blue pipe.'),
      assistant('a1', 'Steam hisses through the joint. The gauge climbs past 3.8.'),
      user('u2', 'I close it again and check the pressure reading.')
    ]
  });

  try {
    out.registeredModes = Array.from(runtime.replacers.keys());
    if (!runtime.replacers.has('afterRequest')) {
      fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
      console.log(JSON.stringify({ ok: false, reason: 'no afterRequest replacer', out: OUT }, null, 1));
      return;
    }

    runtime.setLlmResponder(callOptions => {
      // callOptions carries the prompt; the fixture's own default responder returns a bare packet.
      const messages = Array.isArray(callOptions?.messages) ? callOptions.messages : [];
      const system = messages.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n\n');
      const text = messages.filter(m => m.role !== 'system').map(m => String(m.content || '')).join('\n\n')
        || String(callOptions?.prompt || '');
      const both = `${system}\n${text}`;
      const kind = /hayaku\.native_repair_output\.v1/.test(both) ? 'repair_envelope'
        : /HAYAKU_STATE_PACKET_START/.test(both) ? 'normal_turn_packet'
        : /authoring_profile|native_packet_authoring/.test(both) ? 'authoring'
        : 'other';
      out.calls.push({
        kind,
        systemChars: system.length, userChars: text.length,
        promptChars: String(callOptions?.prompt || '').length,
        messageCount: messages.length,
        hasStartMarker: /HAYAKU_STATE_PACKET_START/.test(both),
        hasEndMarker: /HAYAKU_STATE_PACKET_END/.test(both),
        // A decoration the parser does NOT require must never be shown: the model mirrors `<!--` onto
        // the closing marker and the packet then fails to parse.
        showsHtmlCommentDecoration: /<!--\s*HAYAKU_STATE_PACKET_START/.test(both),
        hasEnvelopeSchema: /hayaku\.native_repair_output\.v1/.test(both),
        head: both.slice(0, 400)
      });

      const packet = createValidPacket({ turn: 2, summary: 'Alice closed the valve and logged a reading of 4.2 bar.' });
      if (kind === 'repair_envelope') {
        return {
          type: 'success',
          result: JSON.stringify({
            schema: 'hayaku.native_repair_output.v1',
            packet,
            grounding: { evidence: ['Alice closed the valve.', 'The gauge read 4.2 bar.'], confidence: 0.8 }
          })
        };
      }
      if (kind === 'normal_turn_packet') {
        return {
          type: 'success',
          result: `${assistantReply}\n\nHAYAKU_STATE_PACKET_START\n${JSON.stringify(packet)}\nHAYAKU_STATE_PACKET_END`
        };
      }
      return { type: 'success', result: JSON.stringify(packet) };
    });

    let afterError = '';
    try {
      await runtime.callAfterRequest(assistantReply, 'model');
    } catch (error) { afterError = `${error?.name}: ${String(error?.message || error).slice(0, 400)}`; }
    out.afterError = afterError;

    // Bounded wait for deferred repair work, then read what was actually written.
    try { await waitFor(() => runtime.llmCalls.length > 0, 'a model call', 25000); } catch (_) {}
    try { await waitFor(() => runtime.pluginStorage.values.size > 1, 'stored state', 15000); } catch (_) {}

    out.llmCallCount = runtime.llmCalls.length;
    out.storedKeys = Array.from(runtime.pluginStorage.values.keys());
    out.storedCount = out.storedKeys.length;

    // "Stored" must mean readable, not merely present: parse every value and report what it is.
    out.storedSchemas = [];
    for (const key of out.storedKeys) {
      try {
        const parsed = JSON.parse(runtime.pluginStorage.values.get(key));
        out.storedSchemas.push({
          key: key.slice(0, 70),
          schema: parsed?.schema || parsed?.meta?.schema || null,
          keys: Object.keys(parsed || {}).slice(0, 8)
        });
      } catch (_) { out.storedSchemas.push({ key: key.slice(0, 70), schema: null, unparsable: true }); }
    }
    out.packetWritten = out.storedSchemas.some(row => /packet/i.test(String(row.schema || '')) || /packet/i.test(row.key));

    // The plugin's own view of what happened, if it exposes one.
    try {
      out.hayakuDebug = {
        lastDebug: runtime.hayaku?.lastDebug ? JSON.stringify(runtime.hayaku.lastDebug).slice(0, 500) : null,
        packetKeys: runtime.hayaku?.packet ? Object.keys(runtime.hayaku.packet).slice(0, 10) : []
      };
    } catch (_) {}

    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(JSON.stringify({
      ok: true, out: OUT,
      registeredModes: out.registeredModes,
      afterError: out.afterError,
      modelCalls: out.calls,
      llmCallCount: out.llmCallCount,
      storedCount: out.storedCount,
      packetWritten: out.packetWritten,
      storedSchemas: out.storedSchemas.slice(0, 10)
    }, null, 1));
  } finally {
    if (typeof runtime.dispose === 'function') await runtime.dispose();
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
