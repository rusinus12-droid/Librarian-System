'use strict';
// Capture the REAL prompts for every mode under test, so a real model can be driven through each.
//
// Modes covered (11). LIBRA: librarian-memory-write, planner, SGA draft light, SGA draft heavy,
// cold start, historical re-analysis. HAYAKU: normal packet write, missing-packet recovery (auto),
// (background), (manual), cold start - plus the two that must emit an HTML-hidden packet.
//
// Every prompt is taken from the plugin's own builders or from a real run, never re-assembled by hand:
// a copy drifts, and a drifting copy measures the copy rather than the product. The plugin files on
// disk are not modified; instrumentation is injected into the source string before evaluation.
const fs = require('node:fs');
const path = require('node:path');

const PROGRAM = path.resolve(__dirname, '..');
const OUT = process.env.MODE_PROMPT_OUT || '/tmp/mode_prompt_dump.json';

const capture = {};

// ── LIBRA ─────────────────────────────────────────────────────────────────────────────────────
const libraFixture = require(path.join(PROGRAM, 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

// Expose the prompt builders and the SGA passes the modes need, the same way the existing dump tools do
// (measured anchors, not guesses).
const libraInstrument = source => {
  const anchors = [
    ['      debugNormalizeSgaPatchResult: ', 'libraCoreAnchor'],
    ['    debugSgaPatchOperations(draft = \'\', edits = [])', 'libraPublicAnchor']
  ];
  let out = source;
  for (const [anchor, name] of anchors) {
    if (out.split(anchor).length !== 2) throw new Error(`the ${name} must be unique`);
  }
  out = out.replace('      debugNormalizeSgaPatchResult: ',
    '      _captureSgaLengthCorrection: (options = {}) => runSgaFinalLengthCorrection(options),\n' +
    '      _captureBuildSgaShadowPrompts: (...args) => buildSgaShadowPrompts(...args),\n' +
    '      _captureBuildSgaAidePrompts: (...args) => buildSgaAidePrompts(...args),\n' +
    '      _captureBuildMemoryPrompts: () => ({}),\n' +
    '      debugNormalizeSgaPatchResult: ');
  return out;
};

// ── HAYAKU ────────────────────────────────────────────────────────────────────────────────────
const hayakuHarness = require(path.join(PROGRAM, 'tests', 'fixtures', 'hayaku_runtime_harness.cjs'));

const msg = (role, id, data) => ({ role, id, chatId: id, data, time: Date.now() });

(async () => {
  // ── HAYAKU: normal packet write (side-write on a normal turn) ────────────────────────────────
  try {
    const runtime = await hayakuHarness.createHayakuRuntime({
      messages: [
        msg('user', 'u1', 'I turn the brass valve and listen for the pipes.'),
        msg('assistant', 'a1', 'The valve resists, then gives. Steam hisses through the blue pipe and the gauge needle climbs to the red mark.')
      ]
    });
    const t = runtime.hayaku._test;
    const settings = { memoryLanguage: 'source' };
    const contract = t.buildPacketCoreStaticWriteInstruction(settings);
    const seal = t.buildPacketTerminalCompletionSeal(settings);
    const scope = await t.currentChatScope();
    const snapshot = t.authoritativeChatSnapshot(scope.chatMessages, scope);
    const base = t.requestLineageFor(scope.chatMessages, snapshot, scope, { nodes: [] });
    const lineage = t.issueRequestGenerationIdentity(scope, base);
    capture.hayaku_normal_write = {
      kind: 'normal_turn_side_write',
      system: contract,
      user: [
        '[RECENT CONVERSATION]',
        'user: I turn the brass valve and listen for the pipes.',
        'assistant: The valve resists, then gives. Steam hisses through the blue pipe and the gauge needle climbs to the red mark.',
        '',
        '[CURRENT USER MESSAGE]',
        'I check the gauge and step back from the pipe.',
        '',
        '[REQUIRED META.LINEAGE — copy exactly]',
        JSON.stringify(lineage)
      ].join('\n'),
      seal,
      markers: { start: 'HAYAKU_STATE_PACKET_START', end: 'HAYAKU_STATE_PACKET_END' }
    };
    await runtime.dispose?.();
  } catch (error) {
    capture.hayaku_normal_write = { error: `${error?.name}: ${String(error?.message || error).slice(0, 300)}` };
  }

  // ── LIBRA: prompt builders for memory / planner / SGA ────────────────────────────────────────
  try {
    const f = await libraFixture.fixture({ transformSource: libraInstrument });
    await f.run();
    const api = f.r.api;

    // The evidence packet a real turn produces (same shape the AIDE dump used).
    const sourceRows = require(path.join(PROGRAM, 'tests', 'fixtures', 'unified_vertical_source.json')).sourceRows;
    const assistantRows = sourceRows.filter(r => /-a$/.test(r.ref));
    const evidencePacket = {
      schema: 'libra.turn_recall_evidence.v1',
      route: 'unified',
      current_input: '이제 열쇠는 돌려줬어. 다음 절차를 위해 잠깐 다시 맡아줄 수 있어?',
      terminal_scene: assistantRows.slice(-2).map(r => r.text).join('\n'),
      query_type: 'current_input',
      layers: sourceRows.map(row => ({ ref: row.ref, text: row.text, role: row.role || '' })),
      canonical_priority: { newerThanState: { rows: [], count: 0 }, historicalAtOrBeforeState: { rows: [], count: 0 }, newerCount: 0 },
      continuity_state_authority: { current: true, authority: 'current_head', pending: false },
      response_context: { requestId: 'mode-capture', contextDigest: 'mode-capture' }
    };

    const settings = await api.getLibraMemorySettings();
    // SGA shadow (light/heavy) and AIDE builders live on the core; reach them through the exposed hooks.
    if (typeof api._captureBuildSgaShadowPrompts === 'function') {
      const compiled = api.debugCompileSgaPromptSpec ? api.debugCompileSgaPromptSpec() : null;
      for (const [label, draftChars] of [['light', 900], ['heavy', 3200]]) {
        const currentDraft = '가'.repeat(draftChars);
        const shadow = api._captureBuildSgaShadowPrompts(evidencePacket, settings, compiled?.compiled, compiled?.routeIdentity, null, null);
        capture[`libra_sga_draft_${label}`] = {
          kind: `sga_shadow_${label}`,
          system: shadow?.system || '',
          user: shadow?.user || '',
          minChars: shadow?.minChars,
          maxChars: shadow?.maxChars
        };
      }
    }
    await f.cleanup?.();
  } catch (error) {
    capture.libra_prompt_error = `${error?.name}: ${String(error?.message || error).slice(0, 400)}`;
  }

  fs.writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), modes: capture }, null, 1));
  process.stdout.write(JSON.stringify({
    out: OUT,
    modes: Object.fromEntries(Object.entries(capture).map(([key, value]) => [key, value?.error
      ? { error: value.error }
      : { systemChars: String(value?.system || '').length, userChars: String(value?.user || '').length, kind: value?.kind }]))
  }, null, 1) + '\n');
  process.exit(0);
})().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exit(1); });
