'use strict';
// Feature inspection for LIBRA's three response modes, run through the plugin's real overlay
// renderers rather than by scanning source text.
//
// THE QUESTION THIS ANSWERS
//
// LIBRA offers three modes on the response path, and the user-facing promise for each is different:
//
//   classic (사서 모드)  — exact recall excerpts, chronological, no reprocessing. 0 extra LLM calls.
//   planner (플래너 모드) — long-term memory / relationships / state / world constraints turned into
//                          a natural-language reaction BRIEF for the current input. 1 extra call.
//   sga     (초안 작성)  — a completed same-turn response candidate built from recall + input.
//
// The property that matters most is the LAST hop: what does the final response model actually
// receive? It must be natural language a human could read and verify — not raw JSON, not schema
// echoes, not machine sidecar metadata, not internal ids. LIBRA builds these blocks in
// renderClassicBlock / renderPlannerBlock / renderSgaBlock, and exposes planner + sga overlays
// through the runtime API (`debugPlannerFinalOverlay`, `debugSgaFinalOverlay`). This test drives
// those real renderers and inspects the produced block.
//
// WHAT IS ASSERTED
//
//   For each mode that can be rendered offline:
//     1. The block opens with its own injection marker (so the three modes cannot be confused and
//        the request-path re-entry guard in beforeRequest recognises an already-injected request).
//     2. The block carries an authority contract that keeps the current user input above the brief.
//     3. The block is NATURAL LANGUAGE: it is not a JSON document, does not echo the planner/SGA
//        schema, and does not leak internal request-actor/object ids.
//     4. The block is delimited, so the model can tell injected material from conversation.
//     5. A degenerate input (schema echo / placeholder) is REJECTED rather than injected — the
//        planner gate must not pass a machine-shaped or empty brief through to the final model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const PLUGIN = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

// The four markers the request path uses to recognise an already-injected request.
const MARKERS = {
  classic: '[LIBRA CLASSIC RECALL — CURRENT TURN ONLY]',
  planner: '[LIBRA TURN PLANNER — CURRENT TURN ONLY]',
  sga: '[LIBRA SGA DRAFT — CURRENT TURN ONLY]',
  memory: '[LIBRA 장기기억 — 관련 기억만 시간순으로 제공됨]'
};

// A brief written the way a model should write one: natural language, grounded in the scene.
const NATURAL_BRIEF = [
  '민준은 아카이브 문 앞에서 기록보관소의 파란 리본을 먼저 확인하려 한다.',
  '지난 세션에서 리본이 사라진 뒤 그를 의심했기 때문에, 이번에는 결론을 서두르지 않고 상황을 살핀다.',
  '그는 상대가 먼저 말을 꺼내기를 기다리며 시선만 문 안쪽으로 보낸다.'
].join('\n');

const plannerRun = (brief, overrides = {}) => ({
  ok: true,
  brief,
  plan: null,
  gate: { accepted: true, failureCode: '' },
  plannerFinalLanguage: 'korean',
  ...overrides
});

const sgaRun = (draft, overrides = {}) => ({
  ok: true,
  draft,
  continuityLocks: ['문 앞을 떠나지 않는다'],
  userAgencyLocks: ['민준의 대사를 새로 쓰지 않는다'],
  doNotReveal: ['리본의 소재'],
  narrativeDynamics: null,
  ...overrides
});

// What the final response model must NOT receive as the PAYLOAD it is asked to reproduce.
//
// The three modes differ in how much machine structure surrounds the human-readable product:
//
//   classic  — exact recall excerpts, chronological, NO reprocessing. The payload IS the evidence.
//   planner  — ONE natural-language brief (`<LIBRA_CURRENT_TURN_BRIEF>`), and the renderer states
//              explicitly that raw evidence and sidecar metadata are withheld. So for planner the
//              payload itself must be natural language and contain no JSON at all.
//   sga      — a completed same-turn CANDIDATE in natural language, wrapped in an envelope that
//              deliberately carries machine-visible sidecars (locks, agency ledger, kernel id).
//              Those sidecars are declared advisory/diagnostic and the block instructs the model
//              not to expose them. The CANDIDATE must still be natural language.
//
// So the assertion is per mode: the part the model is told to reproduce/read as the product must
// be human-readable prose, and the block must instruct the model not to expose the sidecars.
const assertNaturalLanguage = (block, label, options = {}) => {
  const body = String(block || '');
  assert.ok(body.length > 0, `${label}: the block must not be empty`);

  // The payload delimited by the mode's own product tag — this is what the model reproduces.
  const payloadPattern = options.payloadTag
    ? new RegExp(`<${options.payloadTag}>\\n?([\\s\\S]*?)\\n?</${options.payloadTag}>`)
    : null;
  const payloadMatch = payloadPattern ? body.match(payloadPattern) : null;
  if (options.payloadTag) {
    assert.ok(payloadMatch, `${label}: the block must delimit its product with <${options.payloadTag}>`);
    const payload = payloadMatch[1].trim();
    assert.ok(payload.length > 0, `${label}: the product payload must not be empty`);
    assert.ok(!/^\s*[{[]/.test(payload) || options.allowSourceLabels === true,
      `${label}: the product payload must be prose, not a JSON document`);
    if (options.allowSourceLabels !== true) {
      assert.ok(!/^\s*(?:##|\[)/.test(payload),
        `${label}: the product payload must be prose, not a heading or a machine tag`);
    }
    // Even when provenance labels are allowed, the payload must not BE a JSON document: a leading
    // bracket label is a source citation, not the whole payload.
    if (options.allowSourceLabels === true) {
      const withoutLabels = payload.replace(/^\[[^\]]*\]\s*/gm, '').trim();
      assert.ok(withoutLabels.length > 0,
        `${label}: stripping provenance labels must leave the actual product text`);
      assert.ok(!/^\s*[{[]/.test(withoutLabels),
        `${label}: the product text must be prose once provenance labels are stripped`);
    }
  }

  // The block must never echo the planner/SGA machine schema AS the product. Sidecars are allowed
  // in sga by design, but a schema echo means the model was handed machine output to paraphrase.
  if (!options.allowSidecars) {
    for (const schemaName of ['input_contract', 'scene_anchor', 'character_plan', 'world_plan',
      'narrative_plan', 'director_brief', 'libra.turn_planner', 'REQUIRED JSON SHAPE']) {
      assert.ok(!body.includes(schemaName),
        `${label}: the injected payload must not echo the machine schema (${schemaName})`);
    }
  }

  // Internal request actor/object identifiers are never legitimate.
  for (const leak of ['request_actor_id', 'request_object_id', '"actorId"', '"objectId"']) {
    assert.ok(!body.includes(leak), `${label}: must not leak internal ids (${leak})`);
  }

  // The model must be told not to surface the plumbing.
  assert.match(body, /Do not mention|do not expose|Do not expose/,
    `${label}: the block must instruct the model not to surface the injected machinery`);
};

(async () => {
  const harness = await createLibraVmHarness({}, {}, {
    // `renderClassicBlock` is not part of the runtime API, but it is the only renderer for the
    // 사서 (classic) block. Expose it in memory for this inspection — the shipped file is untouched.
    transformSource: source => {
      // The classic (사서) renderer has no runtime-API wrapper, so expose it at both layers the
      // shipped debug wrappers use: the core internals and the flattened runtime API.
      const coreAnchor = '      debugRenderPlannerBlock: runValue => renderPlannerBlock(runValue),';
      assert.ok(source.includes(coreAnchor), 'the planner core anchor must exist in the shipped source');
      let out = source.replace(coreAnchor,
        coreAnchor
        + '\n      debugRenderClassicBlock: (packetValue, deliveryValue = {}) => renderClassicBlock(packetValue, deliveryValue),');
      const apiAnchor = '    debugPlannerFinalOverlay(run = {}) { return LibraMemoryCore.debugRenderPlannerBlock(run); },';
      assert.ok(out.includes(apiAnchor), 'the planner overlay anchor must exist in the shipped source');
      out = out.replace(apiAnchor,
        apiAnchor
        + '\n    debugClassicFinalOverlay(packet = {}, delivery = {}) { return LibraMemoryCore.debugRenderClassicBlock(packet, delivery); },');
      return out;
    }
  });
  try {
    const api = harness.api;

    // ========================================================================================
    // 0. The four injection markers must exist as the request-path guard depends on them.
    // ========================================================================================
    for (const [mode, marker] of Object.entries(MARKERS)) {
      assert.ok(PLUGIN.includes(marker),
        `the ${mode} injection marker must exist (the request path uses it as a re-entry guard)`);
    }

    // ========================================================================================
    // 0b. CLASSIC (사서) MODE: exact recall excerpts, chronological, NO reprocessing. The payload
    //     is the evidence itself — so it must be the quoted canonical text, not a summary, and it
    //     must be time-ordered.
    // ========================================================================================
    assert.equal(typeof api.debugClassicFinalOverlay, 'function',
      'the classic renderer must be reachable for this inspection');
    const classicRows = [
      { selectedText: '첫 번째 장면: 민준이 복도에 도착했다.', sessionEpoch: 1, turnRange: { start: 3, end: 4 }, order: 2 },
      { selectedText: '나중 장면: 민준이 문을 열었다.', sessionEpoch: 1, turnRange: { start: 8, end: 9 }, order: 5 }
    ];
    const classicDelivery = { rows: classicRows };
    const classicBlock = api.debugClassicFinalOverlay({}, classicDelivery);
    assertNaturalLanguage(classicBlock, 'classic', { payloadTag: 'LIBRA_CLASSIC_RECALL', allowSourceLabels: true });

    assert.ok(classicBlock.startsWith(MARKERS.classic),
      'classic: the block must open with the classic marker');
    assert.ok(classicBlock.includes('<LIBRA_CLASSIC_RECALL>')
      && classicBlock.includes('</LIBRA_CLASSIC_RECALL>'),
      'classic: the excerpts must be delimited');
    // The exact quoted text must survive — classic must NOT reprocess the evidence.
    for (const row of classicRows) {
      assert.ok(classicBlock.includes(row.selectedText),
        `classic: the exact excerpt must be preserved verbatim (${row.selectedText.slice(0, 20)}...)`);
    }
    // Chronological: earlier turn range must appear before the later one.
    assert.ok(classicBlock.indexOf(classicRows[0].selectedText) < classicBlock.indexOf(classicRows[1].selectedText),
      'classic: excerpts must be delivered in chronological order');
    // No excerpts means no injection at all.
    assert.equal(api.debugClassicFinalOverlay({}, { rows: [] }), '',
      'classic: an empty evidence set must produce no injection block');

    // ========================================================================================
    // 1. PLANNER MODE: a natural-language brief, presented as guidance with the current input
    //    above it, and NOT the raw evidence or machine metadata.
    // ========================================================================================
    assert.equal(typeof api.debugPlannerFinalOverlay, 'function',
      'the planner overlay renderer must be reachable through the runtime API');
    const plannerBlock = api.debugPlannerFinalOverlay(plannerRun(NATURAL_BRIEF));
    assertNaturalLanguage(plannerBlock, 'planner', { payloadTag: 'LIBRA_CURRENT_TURN_BRIEF' });

    assert.ok(plannerBlock.startsWith(MARKERS.planner),
      'planner: the block must open with the planner marker so the request guard can recognise it');
    assert.ok(plannerBlock.includes('<LIBRA_CURRENT_TURN_BRIEF>')
      && plannerBlock.includes('</LIBRA_CURRENT_TURN_BRIEF>'),
      'planner: the brief must be delimited so the model can separate it from conversation');
    assert.ok(plannerBlock.includes(NATURAL_BRIEF),
      'planner: the natural-language brief body must survive into the block verbatim');
    assert.match(plannerBlock, /outrank this brief/i,
      'planner: the block must state that current input outranks the brief');
    assert.match(plannerBlock, /[Ww]ithheld|withheld from the final response model/,
      'planner: the block must state that raw evidence and sidecar metadata are withheld');

    // The brief itself is what a human reads; the block is the envelope around it.
    assert.ok(plannerBlock.includes('민준은 아카이브 문 앞에서'),
      'planner: the Korean brief text must be present as written');

    // ========================================================================================
    // 2. SGA (DRAFT) MODE: a completed same-turn candidate, plus the locks that bound repair.
    //    The candidate is the product; the locks/ledger are declared advisory sidecars.
    // ========================================================================================
    assert.equal(typeof api.debugSgaFinalOverlay, 'function',
      'the SGA overlay renderer must be reachable through the runtime API');
    const draftText = '민준은 문 안쪽을 살폈다. "여기 있었어?" 그가 낮게 물었다.';
    const sgaBlock = api.debugSgaFinalOverlay(sgaRun(draftText), {}, {
      current_input: '민준이 문을 연다.', terminal_scene: '복도에 불이 켜져 있다.'
    });
    assertNaturalLanguage(sgaBlock, 'sga', {
      payloadTag: 'LIBRA_SGA_SAME_TURN_CANDIDATE', allowSidecars: true
    });
    // The sidecars that ARE present must be framed as rules for the model, not as story text.
    assert.match(sgaBlock, /Do not mention|do not expose|Do not expose/,
      'sga: the block must instruct the model not to surface the injected machinery');
    assert.ok(sgaBlock.includes('[CANDIDATE END — HARD RESPONSE BOUNDARY]'),
      'sga: the candidate must be closed by a hard response boundary');

    // Historical `draft_and_analysis` values must now behave as draft-only in both pipelines.
    const analysedBlock = api.debugSgaFinalOverlay(
      {
        ...sgaRun(draftText),
        stages: [{
          stage: 'sga_shadow', ok: true,
          privateAnalysis: { summary: 'PRIVATE_ANALYSIS_ONLY_SENTINEL' }, analysis: {}
        }]
      },
      { multiPipelineMode: 'heavyweight', informationTransferMode: 'draft_and_analysis' }, {});
    assert.doesNotMatch(analysedBlock, /PRIVATE_ANALYSIS_ONLY_SENTINEL|PRIVATE ANALYSIS MATERIAL USED FOR THIS SAME-TURN CANDIDATE/,
      'sga: heavyweight legacy setting must not forward private analysis');
    // The default mode also excludes private analysis.
    assert.ok(!sgaBlock.includes('[PRIVATE ANALYSIS MATERIAL USED FOR THIS SAME-TURN CANDIDATE'),
      'sga: draft_only must not transfer private analysis material');
    // The lightweight pipeline is also draft-only.
    const lightweightBlock = api.debugSgaFinalOverlay(
      {
        ...sgaRun(draftText),
        stages: [{ stage: 'sga_shadow', ok: true, privateAnalysis: { summary: 'PRIVATE_ANALYSIS_ONLY_SENTINEL' }, analysis: {} }]
      },
      { multiPipelineMode: 'lightweight', informationTransferMode: 'draft_and_analysis' }, {});
    assert.ok(!lightweightBlock.includes('[PRIVATE ANALYSIS MATERIAL USED FOR THIS SAME-TURN CANDIDATE'),
      'sga: the lightweight pipeline must never transfer private analysis material');

    assert.ok(sgaBlock.startsWith(MARKERS.sga),
      'sga: the block must open with the SGA marker');
    assert.ok(sgaBlock.includes(draftText),
      'sga: the same-turn candidate draft must be present in the block');
    assert.ok(sgaBlock.includes('[AUTHORITY ORDER]'),
      'sga: the block must carry an explicit authority order');
    assert.match(sgaBlock, /Current User Input/,
      'sga: the authority order must name the current user input as the top tier');
    assert.ok(sgaBlock.includes('<LIBRA_SGA_USER_AGENCY_LEDGER>'),
      'sga: the user-agency ledger must be delimited');

    // A failed or incomplete draft must NOT be injected at all.
    assert.equal(api.debugSgaFinalOverlay(sgaRun('', { ok: false }), {}, {}), '',
      'sga: a failed run must produce no injection block');
    assert.equal(api.debugSgaFinalOverlay(sgaRun(''), {}, {}), '',
      'sga: an empty draft must produce no injection block');

    // ========================================================================================
    // 3. THE PLANNER GATE must reject machine-shaped and empty briefs rather than passing them on.
    //    This is the difference between "refined into natural language" and "raw model output".
    // ========================================================================================
    const gate = typeof api.debugPlannerReactionBriefGate === 'function'
      ? api.debugPlannerReactionBriefGate
      : null;
    assert.ok(gate, 'the planner reaction-brief gate must be reachable — it is the barrier that keeps '
      + 'machine-shaped output away from the final response model');
    if (gate) {
      const evidence = { current_input: '민준이 아카이브 문을 연다.' };
      const schemaEcho = gate(JSON.stringify({
        schema: 'libra.turn_planner.v2', input_contract: {}, scene_anchor: {}
      }), evidence);
      assert.equal(schemaEcho.accepted, false,
        'the planner gate must reject a schema echo instead of injecting machine output');
      assert.equal(schemaEcho.failureCode, 'brief_schema_echo',
        `the rejection must name the schema echo (got ${schemaEcho.failureCode})`);

      const placeholder = gate('없음', evidence);
      assert.equal(placeholder.accepted, false,
        'the planner gate must reject a placeholder-only brief');
      assert.equal(placeholder.failureCode, 'brief_placeholder',
        `the rejection must name the placeholder (got ${placeholder.failureCode})`);

      const empty = gate('', evidence);
      assert.equal(empty.accepted, false, 'the planner gate must reject an empty brief');
      assert.equal(empty.failureCode, 'brief_empty',
        `the rejection must name emptiness (got ${empty.failureCode})`);

      const good = gate(NATURAL_BRIEF, evidence);
      assert.equal(good.accepted, true,
        `a grounded natural-language brief must be accepted (got ${good.failureCode})`);

      // A rejected run must not be rendered into an injection block. In the production path a gate
      // rejection sets `ok` to false and blanks the brief (brief = result.ok && gate.accepted ?
      // clean : ''), so a rejected run can only arrive at the renderer as `ok: false`.
      assert.equal(api.debugPlannerFinalOverlay(plannerRun('', { ok: false })), '',
        'planner: a rejected run must not reach the final response model');
      assert.equal(api.debugPlannerFinalOverlay({ ok: false, reason: 'brief_schema_echo' }), '',
        'planner: a failed run must not reach the final response model');
    }

    console.log(JSON.stringify({
      test: 'libra_three_mode_feature_inspection',
      markers: Object.keys(MARKERS),
      planner: {
        rendered: plannerBlock.length,
        startsWithMarker: plannerBlock.startsWith(MARKERS.planner),
        delimited: plannerBlock.includes('<LIBRA_CURRENT_TURN_BRIEF>'),
        naturalLanguage: true
      },
      sga: {
        rendered: sgaBlock.length,
        startsWithMarker: sgaBlock.startsWith(MARKERS.sga),
        authorityOrder: sgaBlock.includes('[AUTHORITY ORDER]'),
        failedRunInjectsNothing: true,
        emptyDraftInjectsNothing: true
      },
      gate: {
        rejectsSchemaEcho: true, rejectsPlaceholder: true, rejectsEmpty: true, acceptsNatural: true
      }
    }, null, 1));
    process.stdout.write('libra_three_mode_feature_inspection_test: PASS\n');
  } finally {
    await harness.cleanup?.();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
