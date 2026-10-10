'use strict';
// Assemble the NORMAL-TURN prompt for a real model, then let the plugin judge the answer.
//
// The normal turn is a SIDE-WRITE: no separate model call. The response model receives the packet
// contract appended to its generation prompt and must append exactly one packet between the
// HAYAKU_STATE_PACKET_START/END markers after its visible answer. So the faithful test is:
//
//   1. build the contract + completion seal the plugin actually ships (both are dumped by
//      tools/_dump_hayaku_normal_prompt.cjs from the real builders);
//   2. give a real model a normal RP generation prompt with that contract appended;
//   3. take the model's full output and run it through the plugin's OWN capture inspection
//      (`packetCaptureInspectionFromText`) — the same check the live pipeline uses;
//   4. report whether a valid current_snapshot came out, and if not, exactly why.
//
// The prompt is written to a file so the model runner is a pure transport.
const fs = require('node:fs');
const path = require('node:path');
const { createHayakuRuntime, createValidPacket } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'hayaku_runtime_harness.cjs'));

const user = (id, data) => ({ role: 'user', chatId: id, id, data, time: Date.now() });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data, time: Date.now() });
const OUT = process.env.HAYAKU_NORMAL_PROMPT_OUT || '/tmp/hayaku_normal_model_prompt.json';

(async () => {
  const runtime = await createHayakuRuntime({
    messages: [
      user('u1', 'I turn the brass valve and listen for the pipes.'),
      assistant('a1', 'The valve resists, then gives. Steam hisses through the blue pipe and the gauge needle climbs to the red mark.')
    ]
  });

  try {
    const t = runtime.hayaku._test;
    const settings = { memoryLanguage: 'source' };

    // What the model in the live chat would receive.
    const contract = t.buildPacketCoreStaticWriteInstruction(settings);
    const seal = t.buildPacketTerminalCompletionSeal(settings);

    // The lineage the packet must copy — the plugin issues it per request.
    const scope = await t.currentChatScope();
    const snapshot = t.authoritativeChatSnapshot(scope.chatMessages, scope);
    const base = t.requestLineageFor(scope.chatMessages, snapshot, scope, { nodes: [] });
    const lineage = t.issueRequestGenerationIdentity(scope, base);

    // A realistic generation prompt: the story so far, then the hidden contract and the seal.
    const system = [
      'You are the narrator of a first-person interactive story. Continue the scene as the assistant,',
      'writing the visible response the user will read. Then follow the hidden continuity contract below.',
      '',
      '[VISIBLE OUTPUT]',
      'Write the next assistant turn in 1-3 sentences. Plain narration, no headings, no lists.',
      '',
      contract,
      '',
      seal
    ].join('\n');

    const userTurn = [
      '[RECENT CONVERSATION]',
      'user: I turn the brass valve and listen for the pipes.',
      'assistant: The valve resists, then gives. Steam hisses through the blue pipe and the gauge needle climbs to the red mark.',
      '',
      '[CURRENT USER MESSAGE]',
      'I check the gauge and step back from the pipe.',
      '',
      '[REQUIRED META.LINEAGE — copy exactly]',
      JSON.stringify({
        parent_turn_node_id: lineage.parentTurnNodeId || '',
        logical_turn_id: lineage.logicalTurnId,
        request_nonce: lineage.requestNonce,
        identity_version: 2,
        lineage_schema: lineage.lineageSchema,
        turn_owner_key: lineage.turnOwnerKey,
        generation_attempt_id: lineage.generationAttemptId
      })
    ].join('\n');

    fs.writeFileSync(OUT, JSON.stringify({
      capturedAt: new Date().toISOString(),
      kind: 'normal_turn_side_write',
      system,
      user: userTurn,
      sizes: { system: system.length, user: userTurn.length, contract: contract.length, seal: seal.length },
      // What the plugin will require of the answer.
      requirements: {
        startMarker: 'HAYAKU_STATE_PACKET_START',
        endMarker: 'HAYAKU_STATE_PACKET_END',
        packetType: 'current_snapshot',
        lineage
      }
    }, null, 1));

    process.stdout.write(JSON.stringify({
      ok: true,
      out: OUT,
      sizes: { system: system.length, user: userTurn.length },
      lineageIssued: Boolean(lineage?.requestNonce)
    }, null, 1) + '\n');
  } finally {
    await runtime.dispose?.();
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
