'use strict';
// Dump the REAL HAYAKU packet-authoring prompt (system + user) exactly as the model receives it,
// so an actual model can be driven with it instead of a hand-written approximation.
//
// Method: drive the plugin's own entry point through the runtime harness with a responder that
// captures the messages, then write them to a file the model runner can read.
const fs = require('node:fs');
const path = require('node:path');
const { createHayakuRuntime, createValidPacket } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'hayaku_runtime_harness.cjs'));

const user = (id, data) => ({ role: 'user', chatId: id, id, data, time: Date.now() });
const OUT = process.env.HAYAKU_PROMPT_OUT || '/tmp/hayaku_prompt_dump.json';

(async () => {
  const captured = [];
  const runtime = await createHayakuRuntime({
    afterRequestAutoRepair: true,
    backgroundAutoRepair: false,
    messages: [user('u1', 'I turn the brass valve and listen for the pipes.')]
  });

  try {
    const scope = await runtime.hayaku._test.currentChatScope();
    const snapshot = runtime.hayaku._test.authoritativeChatSnapshot(scope.chatMessages, scope);
    const base = runtime.hayaku._test.requestLineageFor(scope.chatMessages, snapshot, scope, { nodes: [] });
    const lineage = runtime.hayaku._test.issueRequestGenerationIdentity(scope, base);
    runtime.hayaku._test.registerPendingCapture(scope, lineage, 'model', snapshot);

    runtime.setLlmResponder(async callOptions => {
      captured.push({
        messages: (callOptions?.messages || []).map(m => ({ role: m.role, content: String(m.content || '') })),
        other: Object.fromEntries(Object.entries(callOptions || {}).filter(([k]) => k !== 'messages'))
      });
      // Return an unusable answer so the pipeline records the failure and leaves the request shape
      // intact for us to inspect; the prompt is what we are after, not the outcome.
      return { type: 'success', result: 'noop' };
    });

    const assistantText = 'Steam began flowing through the blue pipe and the gauge climbed to the red mark.';
    runtime.chat.message.push({ role: 'assistant', chatId: 'a1', id: 'a1', data: assistantText, time: Date.now() });
    runtime.chat.messages = runtime.chat.message;
    await runtime.hayaku._test.repairCurrentPacketInsideAfterRequest(assistantText, 'model');

    fs.writeFileSync(OUT, JSON.stringify({
      capturedAt: new Date().toISOString(),
      callCount: captured.length,
      calls: captured.map(call => {
        const system = call.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
        const userMsg = call.messages.filter(m => m.role === 'user').map(m => m.content).join('\n\n');
        return {
          systemChars: system.length,
          userChars: userMsg.length,
          totalChars: system.length + userMsg.length,
          system,
          user: userMsg,
          other: call.other
        };
      })
    }, null, 1));
    process.stdout.write(JSON.stringify({ ok: true, out: OUT, calls: captured.length }, null, 1) + '\n');
  } finally {
    await runtime.dispose?.();
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
