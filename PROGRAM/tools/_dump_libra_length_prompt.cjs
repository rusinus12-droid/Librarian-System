'use strict';
// Capture the REAL SGA final length-correction prompt by RUNNING the runtime's own pass.
//
// The previous attempt re-assembled the prompt by hand. That is a copy, not evidence — it can drift
// from what the plugin actually sends. This calls runSgaFinalLengthCorrection() itself and captures
// the messages it issues through runLLMModel, so the recorded text IS the request.
//
// Why it matters: the real Gemma-4 returned a 656-char SGA draft against a 3,000-5,000 target. The
// runtime state is 'short', not 'rejected' — a bounded length-correction pass runs by default
// (sgaSemanticValidationEnabled !== false, sgaValidationRecoveryAttempts > 0) and asks the same model
// to expand the complete candidate. If a small model cannot do that pass, the injected draft stays
// short, so the pass is part of the answer to "can Gemma-4 really author SGA".
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const OUT = process.env.LIBRA_LENGTH_PROMPT_OUT || '/tmp/libra_length_prompt_dump.json';
const SGA_RESULT = process.env.GEMMA_SGA_RESULT || '/tmp/gemma_libra_sga_result.json';

const liveInput = '이제 열쇠는 돌려줬어. 다음 절차를 위해 잠깐 다시 맡아줄 수 있어?';

const instrument = source => {
  const anchor = '      debugNormalizeSgaPatchResult: ';
  const publicAnchor = "    debugSgaPatchOperations(draft = '', edits = [])";
  for (const [name, value] of [['length anchor', anchor], ['public anchor', publicAnchor]]) {
    if (source.split(value).length !== 2) throw new Error(`the ${name} must be unique`);
  }
  return source
    .replace(anchor,
      '      _captureSgaLengthCorrection: (options = {}) => runSgaFinalLengthCorrection(options),\n' +
      anchor)
    // The test surface is the core IIFE object; harness.api is the separate public surface, so the
    // accessor needs exposing on both — measured, not assumed.
    .replace(publicAnchor,
      "    _captureSgaLengthCorrection(options = {}) { return LibraMemoryCore._captureSgaLengthCorrection(options); },\n" +
      publicAnchor);
};

(async () => {
  const sgaRecording = JSON.parse(fs.readFileSync(SGA_RESULT, 'utf8'));
  const sgaAttempt = (sgaRecording.results?.sga_shadow?.attempts || []).find(a => a.draft);
  const draft = String(sgaAttempt?.draft || '');

  const f = await fixture({ transformSource: instrument });
  const out = { capturedAt: new Date().toISOString(), liveInput, draftChars: draft.length };
  const sink = [];
  try {
    await f.run();
    const api = f.r.api;
    const settings = await api.getLibraMemorySettings();
    const sourceRows = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'unified_vertical_source.json')).sourceRows;
    const assistantRows = sourceRows.filter(r => /-a$/.test(r.ref));
    const evidencePacket = {
      schema: 'libra.turn_recall_evidence.v1',
      route: 'unified',
      current_input: liveInput,
      terminal_scene: assistantRows.slice(-2).map(r => r.text).join('\n'),
      query_type: 'current_input',
      layers: sourceRows.map(row => ({ ref: row.ref, text: row.text, role: row.role || '' })),
      canonical_priority: { newerThanState: { rows: [], count: 0 }, historicalAtOrBeforeState: { rows: [], count: 0 }, newerCount: 0 },
      continuity_state_authority: { current: true, authority: 'current_head', pending: false },
      response_context: { requestId: 'length-capture', contextDigest: 'length-capture' }
    };

    // Answer the pass with a compliant long correction so the run completes, and record what was sent.
    f.control.onCall = args => {
      const messages = args[0]?.messages || [];
      const system = messages.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n\n');
      const user = messages.filter(m => m.role === 'user').map(m => String(m.content || '')).join('\n\n');
      sink.push({ system, user, systemChars: system.length, userChars: user.length });
      return JSON.stringify({ schema: 'libra.sga_length_correction.v2', ok: true, draft: '가'.repeat(3200) });
    };

    const minChars = Number(settings?.targetDraftMinChars || 3000);
    const maxChars = Number(settings?.targetDraftMaxChars || 5000);
    let runError = '';
    let result = null;
    try {
      result = await api._captureSgaLengthCorrection({
        draft, evidencePacket, settings, enabledStages: ['sga_shadow'], stageRecords: [],
        minChars, maxChars, continuityLocks: [], userAgencyLocks: [], doNotReveal: [], runGuard: null
      });
    } catch (error) {
      runError = `${error?.name}: ${String(error?.message || error).slice(0, 300)}`;
    }
    f.control.onCall = null;

    out.requested = sink.length > 0;
    out.minChars = minChars;
    out.maxChars = maxChars;
    out.runError = runError;
    out.resultShape = result && typeof result === 'object'
      ? {
          keys: Object.keys(result), ok: result.ok === true, accepted: result.accepted === true,
          beforeState: result.before?.state, beforeChars: result.before?.chars,
          afterState: result.after?.state, afterChars: result.after?.chars,
          draftChars: String(result.draft || '').length
        }
      : String(typeof result);
    if (sink[0]) { out.system = sink[0].system; out.user = sink[0].user; out.calls = sink.slice(0, 2); }

    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    process.stdout.write(JSON.stringify({
      ok: true, out: OUT,
      draftChars: out.draftChars,
      requested: out.requested,
      minChars, maxChars,
      runError: out.runError,
      resultShape: out.resultShape,
      systemChars: (out.system || '').length,
      userChars: (out.user || '').length,
      hasSchema: /libra\.sga_length_correction/.test(out.system || ''),
      asksToExpand: /Expand relevant description/.test(out.system || '')
    }, null, 1) + '\n');
  } finally {
    await f.r.cleanup();
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
