'use strict';
// E2E lock: the real Gemma-4's answer is ACCEPTED by the real pipeline after the envelope fix.
//
// HISTORY, because it explains what this file asserts
//
// The real model (hf.co/unsloth/gemma-4-12B-it-qat-GGUF UD-Q4_K_XL, ollama 0.34.1) was driven with
// the real authoring prompt extracted from the plugin. Before the fix it returned a correct packet
// BODY with no envelope on 3 of 3 attempts — fed into the pipeline that answer was rejected
// (validCount 0). After the fix the same prompt produced a valid envelope on the first attempt and
// the pipeline ACCEPTED it (validCount 1, attached, visible response preserved).
//
// WHAT IS ASSERTED
//
//   1. The real model's answer (read from the run dump) carries the envelope and the pipeline
//      accepts it. When the dump is absent the test says so instead of inventing a payload.
//   2. The control still passes: a correctly wrapped envelope is accepted, so acceptance in (1) is
//      attributable to the envelope and not to a weakened validator.
//   3. The validator is STILL strict — a bare packet body is rejected. Without this, a fix that
//      loosened validation would look identical to a fix that made the model produce the right
//      shape.
//   4. The recovery instruction states the envelope keys, names the nested paths, and carries an
//      explicit schema assignment, with the one-line contradiction gone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createHayakuRuntime
} = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data, time: Date.now() });
const GEMMA_DUMP = '/tmp/gemma_packet_result.json';

// The real answer, taken verbatim from the model run.
const loadGemmaAnswer = () => {
  if (!fs.existsSync(GEMMA_DUMP)) return null;
  const dump = JSON.parse(fs.readFileSync(GEMMA_DUMP, 'utf8'));
  const attempt = (dump.attempts || []).find(row =>
    row.valid === true && typeof row.rawHead === 'string' && row.rawHead.trim().startsWith('{'));
  return attempt ? attempt.rawHead : null;
};

(async () => {
  const observed = {};

  const registerTurn = async runtime => {
    const scope = await runtime.hayaku._test.currentChatScope();
    const snapshot = runtime.hayaku._test.authoritativeChatSnapshot(scope.chatMessages, scope);
    const base = runtime.hayaku._test.requestLineageFor(scope.chatMessages, snapshot, scope, { nodes: [] });
    const lineage = runtime.hayaku._test.issueRequestGenerationIdentity(scope, base);
    runtime.hayaku._test.registerPendingCapture(scope, lineage, 'model', snapshot);
    return { scope, snapshot, lineage };
  };

  const runWith = async (answer, label) => {
    const runtime = await createHayakuRuntime({
      afterRequestAutoRepair: true,
      backgroundAutoRepair: false,
      messages: [user(`${label}-u1`, 'I turn the brass valve and listen for the pipes.')]
    });
    try {
      const { lineage } = await registerTurn(runtime);
      if (typeof answer === 'function') runtime.setLlmResponder(async () => ({ type: 'success', result: answer(lineage) }));
      else runtime.setLlmResponder(async () => ({ type: 'success', result: answer }));

      const assistantText = 'Steam began flowing through the blue pipe and the gauge climbed to the red mark.';
      runtime.chat.message.push({ role: 'assistant', chatId: `${label}-a1`, id: `${label}-a1`, data: assistantText, time: Date.now() });
      runtime.chat.messages = runtime.chat.message;

      const returned = await runtime.hayaku._test.repairCurrentPacketInsideAfterRequest(assistantText, 'model');
      const inspection = runtime.hayaku._test.packetCaptureInspectionFromText(returned);
      return {
        llmCalls: runtime.llmCalls.length,
        validPackets: inspection?.validCount ?? 0,
        packetAttached: /HAYAKU_STATE_PACKET_START/.test(String(returned)),
        responsePreserved: String(returned).startsWith(assistantText)
      };
    } finally {
      await runtime.dispose?.();
    }
  };

  // ------------------------------------------------------------------------------------
  // 1. The REAL model answer, verbatim, through the real pipeline.
  // ------------------------------------------------------------------------------------
  const gemmaAnswer = loadGemmaAnswer();
  observed.gemmaAnswerAvailable = Boolean(gemmaAnswer);
  if (gemmaAnswer) {
    observed.gemmaResponse = {
      chars: gemmaAnswer.length,
      envelopePresent: /"schema"\s*:/.test(gemmaAnswer)
        && /"packet"\s*:/.test(gemmaAnswer)
        && /"grounding"\s*:/.test(gemmaAnswer),
      schemaValue: (gemmaAnswer.match(/"schema"\s*:\s*"([^"]+)"/) || [])[1] || ''
    };
    observed.realModelResult = await runWith(gemmaAnswer, 'gemma');
  }

  // ------------------------------------------------------------------------------------
  // 2. Control: a correctly wrapped envelope is accepted.
  // ------------------------------------------------------------------------------------
  observed.controlWrappedEnvelope = await runWith(lineage => JSON.stringify({
    schema: 'hayaku.native_repair_output.v1',
    packet: {
      meta: {
        packet_type: 'current_snapshot',
        lineage: {
          parent_turn_node_id: lineage.parentTurnNodeId || '',
          logical_turn_id: lineage.logicalTurnId,
          request_nonce: lineage.requestNonce,
          identity_version: 2,
          lineage_schema: lineage.lineageSchema,
          turn_owner_key: lineage.turnOwnerKey,
          generation_attempt_id: lineage.generationAttemptId
        },
        summary_memory: { summary: 'Steam began flowing through the blue pipe.', recallAnchors: [], recallAliases: {}, canonicalAnchors: [], mentionedEntityNames: [], confidence: 0.7 }
      },
      entity: {}, world: {}, narrative: {}, planner: {},
      importance: { overall: 0.4, reason: ['Established state'] }
    },
    grounding: [{ path: 'meta.summary_memory.summary', source: 'target', evidence: ['Steam began flowing through the blue pipe and the gauge climbed to the red mark.'] }]
  }), 'control');

  // ------------------------------------------------------------------------------------
  // 3. The validator must STILL reject a bare packet body — prompt-side fix, not a loosening.
  // ------------------------------------------------------------------------------------
  observed.bareBodyRejected = await runWith(lineage => JSON.stringify({
    meta: { packet_type: 'current_snapshot', lineage: { logical_turn_id: lineage.logicalTurnId, request_nonce: lineage.requestNonce } },
    entity: {}, world: {}, narrative: {}, planner: {}, importance: { overall: 0.3, reason: ['x'] }
  }), 'bare');

  // ------------------------------------------------------------------------------------
  // 4. The recovery instruction: envelope keys, nested paths, explicit schema assignment, and no
  //    prefix-free competing sentence.
  // ------------------------------------------------------------------------------------
  const runtime = await createHayakuRuntime({ messages: [] });
  try {
    const build = runtime.hayaku._test.packetSchemaV2WriteInstruction;
    const nested = build({}, { envelope: true }).join('\n');
    observed.recoveryInstruction = {
      hasEnvelopeKeys: /schema[\s\S]{0,120}packet[\s\S]{0,120}grounding/.test(nested),
      hasExplicitSchemaAssignment: /schema\s*=\s*"hayaku\.native_repair_output\.v1"/.test(nested),
      namesNestedKeys: nested.includes('packet.meta') && nested.includes('packet.entity'),
      competingPrefixFreeSentence: /exactly six object-valued keys: meta, entity/.test(nested)
    };
  } finally {
    await runtime.dispose?.();
  }

  console.log(JSON.stringify({ test: 'gemma4_packet_envelope_e2e', observed }, null, 1));

  // --- assertions ---------------------------------------------------------------------------
  assert.ok(observed.recoveryInstruction.hasEnvelopeKeys,
    'the recovery instruction must name the envelope keys');
  assert.ok(observed.recoveryInstruction.hasExplicitSchemaAssignment,
    'the recovery instruction must state the envelope schema as an explicit assignment');
  assert.ok(observed.recoveryInstruction.namesNestedKeys,
    'the recovery instruction must name packet.meta / packet.entity');
  assert.equal(observed.recoveryInstruction.competingPrefixFreeSentence, false,
    'the prefix-free six-key sentence must be gone from the nested shape');
  assert.equal(observed.controlWrappedEnvelope.validPackets, 1,
    'a correctly wrapped envelope must be accepted');
  assert.equal(observed.bareBodyRejected.validPackets, 0,
    'a bare packet body must STILL be rejected — the fix must not weaken validation');
  if (observed.gemmaAnswerAvailable) {
    assert.equal(observed.gemmaResponse.envelopePresent, true,
      'the captured Gemma-4 answer must carry the three envelope keys');
    assert.equal(observed.gemmaResponse.schemaValue, 'hayaku.native_repair_output.v1',
      'the captured Gemma-4 answer must use the envelope schema value');
    assert.equal(observed.realModelResult.validPackets, 1,
      'the real Gemma-4 answer must be ACCEPTED by the pipeline');
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
