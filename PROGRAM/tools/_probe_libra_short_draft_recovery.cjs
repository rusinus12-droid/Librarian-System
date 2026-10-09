'use strict';
// Does the pipeline RECOVER a short shadow draft? That is the product question.
//
// MEASURED (2026-09-20, real Gemma-4): the shadow stage writes ~771 draft characters against a
// 1,000-2,000 target, and the model stops there rather than at the token cap (677 of 4,096 eval
// tokens). Character counts are not something a 12B model can self-measure, so the shadow being short
// is expected; LIBRA answers it with a dedicated pass —
// `runSgaFinalLengthCorrection`, which runs when sgaDraftLengthStatus reports 'short'
// (sgaSemanticValidationEnabled !== false, sgaValidationRecoveryAttempts > 0).
//
// So the question this probe answers is whether THAT pass lifts the short draft into range. If it
// does, a short shadow is recovered product behaviour; if it does not, the pipeline ships a short draft.
//
// The pass is exercised through the runtime's own function (same instrumentation anchor the dump
// tools use) and answered with a controlled response, so the measurement is of the shipping pass.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const OUT = process.env.LIBRA_SHORT_RECOVERY_OUT || '/tmp/libra_short_draft_recovery.json';
const MODE_RESULT = process.env.MODE_CHECK_RESULT || '/tmp/gemma_mode_check_result.json';

const instrument = source => {
  const anchor = '      debugNormalizeSgaPatchResult: ';
  const publicAnchor = "    debugSgaPatchOperations(draft = '', edits = [])";
  for (const [name, value] of [['length anchor', anchor], ['public anchor', publicAnchor]]) {
    if (source.split(value).length !== 2) throw new Error(`the ${name} must be unique`);
  }
  return source
    .replace(anchor, '      _captureSgaLengthCorrection: (options = {}) => runSgaFinalLengthCorrection(options),\n' + anchor)
    .replace(publicAnchor, "    _captureSgaLengthCorrection(options = {}) { return LibraMemoryCore._captureSgaLengthCorrection(options); },\n" + publicAnchor);
};

(async () => {
  const report = { cases: [] };
  const failures = [];

  // The REAL short draft the model wrote for the compact preset (from the mode-check run).
  let realShortDraft = '';
  try {
    const stored = JSON.parse(fs.readFileSync(MODE_RESULT, 'utf8'));
    const light = (stored.modes || []).find(m => m.mode === 'libra_sga_draft_light');
    const body = String(light?.raw || '').trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    realShortDraft = (JSON.parse(body).draft) || '';
  } catch (_) { /* the run may not have happened yet */ }
  if (!realShortDraft) realShortDraft = '가'.repeat(771);

  const f = await fixture({ transformSource: instrument });
  let answer = '';
  f.control.onCall = () => ({ type: 'success', result: answer });

  try {
    await f.run();
    const api = f.r.api;
    if (typeof api._captureSgaLengthCorrection !== 'function') {
      throw new Error('the length-correction accessor is unavailable');
    }

    const evidencePacket = {
      current_input: '이제 열쇠는 돌려줬어. 다음 절차를 위해 잠깐 다시 맡아줄 수 있어?',
      terminal_scene: '서재에서 준호가 열쇠를 건넸다.'
    };

    const run = async (label, draft, minChars, maxChars, expandTo) => {
      const row = { label, beforeChars: draft.length, minChars, maxChars };
      // The answer the pass receives: a corrected draft that names its own length honestly.
      const expanded = (() => {
        let s = draft;
        let i = 0;
        while (s.length < expandTo) { s += `\n\n추가 문장 ${i++}입니다. 준호는 잠시 멈칫하며 당신의 말을 곱씹었다. 서재의 등불이 낮게 흔들렸다.`; }
        return s.slice(0, expandTo);
      })();
      answer = JSON.stringify({ schema: 'libra.sga_length_correction.v2', ok: true, draft: expanded });
      try {
        const out = await api._captureSgaLengthCorrection({
          draft,
          evidencePacket,
          settings: {},
          enabledStages: ['sga_shadow'],
          stageRecords: [],
          minChars,
          maxChars
        });
        row.requested = out?.requested;
        row.accepted = out?.accepted;
        row.beforeState = out?.before?.state;
        row.afterState = out?.after?.state;
        row.afterChars = out?.after?.chars;
        row.draftChanged = typeof out?.draft === 'string' && out.draft !== draft;
        row.reason = String(out?.record?.reason || out?.result?.reason || '').slice(0, 160);
        // The assertions follow the SHIPPED contract, measured rather than assumed:
        //   @53892 — when the incoming draft is ALREADY in range the pass returns early with
        //            requested:false. Demanding that it run (the first version of this assert) asked
        //            for the opposite of the product's behaviour and failed on a legitimate input.
        //   short draft + in-range answer -> the draft is replaced and ends in range.
        //   short draft + still-short answer -> the closer draft is KEPT (accepted:true, 'short'),
        //            which is what the case name now says.
        const startedShort = row.beforeState === 'short';
        if (!startedShort) {
          assert.equal(row.requested, false,
            `${label}: an in-range draft must NOT be sent to the correction pass (got ${row.requested})`);
          assert.equal(row.afterChars, row.beforeChars,
            `${label}: an untouched in-range draft must be returned as-is`);
        } else if (expandTo >= minChars && expandTo <= maxChars) {
          assert.equal(row.requested, true, `${label}: the pass must run for a short draft`);
          assert.equal(row.afterState, 'in_range',
            `${label}: an in-range answer must lift the draft into range (got ${row.afterState}, ${row.afterChars} chars)`);
          assert.equal(row.draftChanged, true, `${label}: the draft must have been replaced`);
        } else {
          assert.equal(row.requested, true, `${label}: the pass must run for a short draft`);
          assert.ok(row.afterChars >= row.beforeChars,
            `${label}: a still-short answer must not make the draft worse (${row.beforeChars} -> ${row.afterChars})`);
        }
      } catch (error) {
        row.error = `${error?.name}: ${String(error?.message || error).slice(0, 240)}`;
        // ANY per-case error is a failure, not just an assertion. The first version pushed only
        // AssertionErrors, so injecting a plain Error into the correction function recorded an error
        // on every case and still exited 0 — a probe whose measurements all failed reported success.
        // An assertion is the product behaving differently; any other error is the measurement not
        // happening at all. Both must reach the exit code.
        const detail = String(error?.message || error).slice(0, 240);
        failures.push(error?.name === 'AssertionError'
          ? `${label}: ${detail}`
          : `${label}: threw ${error?.name || 'Error'} — ${detail}`);
      }
      report.cases.push(row);
    };

    // MODE-CHECK INTEGRATION: when the mode checker supplies the draft IT just measured and the
    // preset range, run exactly that one case. The checker used to read `cases[0]` (always the
    // compact range) and to pull the draft from its own result file, which is written AFTER this
    // probe runs — so the heavy preset reported the COMPACT row's numbers, and the light preset
    // reported whichever draft an older run had left behind. Neither was evidence about the
    // response actually under test.
    const envDraft = String(process.env.LIBRA_SHORT_RECOVERY_DRAFT || '');
    const envRange = String(process.env.LIBRA_SHORT_RECOVERY_RANGE || '').trim().split(/\s+/).map(Number);
    if (envDraft && envRange.length === 2 && envRange.every(Number.isFinite)) {
      const [lo, hi] = envRange;
      const target = Math.min(hi, Math.max(lo, Math.round((lo + hi) / 2)));
      await run('mode_row_recovery', envDraft, lo, hi, target);
    } else {
      // The measured case: the real 771-character draft against the compact range, answered with a
      // draft that does reach the range.
      await run('compact_real_short_draft_recovered', realShortDraft, 1000, 2000, 1500);
      // NOT 'refused': measured, the pass keeps a short-but-closer draft (accepted:true,
      // afterState:'short'). The old name claimed a refusal the product does not perform.
      await run('compact_closer_but_still_short_kept', realShortDraft, 1000, 2000, 900);
      // The standard range, the case the earlier session measured.
      await run('standard_real_short_draft_recovered', realShortDraft, 3000, 5000, 3500);
    }
  } catch (error) {
    report.error = `${error?.name}: ${String(error?.message || error).slice(0, 300)}`;
  } finally {
    await f.cleanup?.();
  }

  report.failures = failures;
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  process.stdout.write(JSON.stringify({
    out: OUT,
    error: report.error || null,
    failures,
    realDraftChars: realShortDraft.length,
    cases: report.cases.map(r => ({
      label: r.label, requested: r.requested, accepted: r.accepted, beforeState: r.beforeState,
      afterState: r.afterState, afterChars: r.afterChars, draftChanged: r.draftChanged,
      reason: r.reason, error: r.error
    }))
  }, null, 1) + '\n');
  // Non-zero when the product behaved differently from the assertions, so a caller (and the mode
  // checker) can tell a real pass from a run that merely completed.
  process.exit(failures.length || report.error ? 1 : 0);
})().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exit(1); });
