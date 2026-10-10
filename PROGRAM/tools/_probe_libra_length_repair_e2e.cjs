'use strict';
// Does the length-correction pass ACCEPT an answer whose JSON never closed?
//
// MEASURED (2026-09-20, real Gemma-4, /tmp/gemma_libra_length_ab_result.json): both attempts hit the
// 8,192-token budget (`doneReason: 'length'`) with more than the 3,000-char minimum already written,
// and both were discarded because the object never closed. The content was there; the brackets were not.
//
// This runs the runtime's OWN pass (runSgaFinalLengthCorrection, exposed through the fixture exactly as
// _dump_libra_length_prompt.cjs does it) and answers it with a controlled provider response. The
// question is whether the pass adopts a recovered draft — and whether it still refuses a genuinely
// half-written one, which is the failure the recovery must never cause.
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const OUT = process.env.LIBRA_LENGTH_REPAIR_OUT || '/tmp/libra_length_repair_e2e.json';

const instrument = source => {
  const anchor = '      debugNormalizeSgaPatchResult: ';
  const publicAnchor = "    debugSgaPatchOperations(draft = '', edits = [])";
  for (const [name, value] of [['length anchor', anchor], ['public anchor', publicAnchor]]) {
    if (source.split(value).length !== 2) throw new Error(`the ${name} must be unique`);
  }
  return source
    .replace(anchor,
      '      _captureSgaLengthCorrection: (options = {}) => runSgaFinalLengthCorrection(options),\n' + anchor)
    .replace(publicAnchor,
      "    _captureSgaLengthCorrection(options = {}) { return LibraMemoryCore._captureSgaLengthCorrection(options); },\n" + publicAnchor);
};

const KOREAN = i => `문장 ${i}입니다. 준호는 잠시 멈칫하며 당신의 말을 곱씹었다. 서재의 등불이 낮게 흔들렸고, `
  + `민아가 들은 암호의 무게가 두 사람 사이를 짓누르고 있었다. 그는 천천히 고개를 끄덕였다.`;

const draftOf = chars => {
  let s = '';
  let i = 1;
  while (s.length < chars) { s += KOREAN(i++) + '\n\n'; }
  return s.slice(0, chars);
};

(async () => {
  const f = await fixture({ transformSource: instrument });
  const report = { cases: [] };
  let answer = '';

  f.control.onCall = () => ({ type: 'success', result: answer });

  try {
    await f.run();
    const api = f.r.api;
    if (typeof api._captureSgaLengthCorrection !== 'function') {
      throw new Error('the exposed length-correction accessor is unavailable on the public surface');
    }

    const run = async (label, providerAnswer, minChars, maxChars, beforeChars) => {
      const draft = draftOf(beforeChars);
      const row = { label, beforeChars: draft.length, minChars, maxChars };
      answer = providerAnswer;
      try {
        const out = await api._captureSgaLengthCorrection({
          draft,
          evidencePacket: {
            current_input: '이제 열쇠는 돌려줬어. 다음 절차를 위해 잠깐 다시 맡아줄 수 있어?',
            terminal_scene: '서재에서 준호가 열쇠를 건넸다.'
          },
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
        row.resultOk = out?.result?.ok;
        row.resultReason = String(out?.result?.reason || out?.record?.reason || '').slice(0, 200);
      } catch (error) {
        row.error = `${error?.name}: ${String(error?.message || error).slice(0, 240)}`;
      }
      report.cases.push(row);
    };

    const full = draftOf(3200);
    const envelope = JSON.stringify({ schema: 'libra.sga_length_correction.v2', ok: true, draft: full });

    // A. content complete, only the closing brace missing -> the fix must recover it.
    await run('complete_draft_missing_final_brace', envelope.slice(0, -1), 3000, 5000, 900);
    // A2. the measured real shape: the draft ran PAST the maximum before the budget stopped it.
    const longDraft = draftOf(4700);
    const longEnvelope = JSON.stringify({ schema: 'libra.sga_length_correction.v2', ok: true, draft: longDraft });
    await run('over_length_draft_cut_before_brace', longEnvelope.slice(0, -1), 3000, 5000, 900);
    // B. the model stopped inside the draft string -> must STILL be refused.
    await run('truncated_inside_draft_string', envelope.slice(0, Math.floor(envelope.length * 0.6)), 3000, 5000, 900);
    // C. control: a well-formed answer must be adopted exactly as before.
    await run('complete_answer_control', envelope, 3000, 5000, 900);
    // D. the measured real shape: the object closed and one period followed it.
    await run('complete_answer_with_trailing_period', envelope + '.', 3000, 5000, 900);
    // E. and it must still refuse a half-written draft.
    await run('answer_cut_inside_draft', envelope.slice(0, Math.floor(envelope.length * 0.55)), 3000, 5000, 900);
  } catch (error) {
    report.error = `${error?.name}: ${String(error?.message || error).slice(0, 300)}`;
  } finally {
    await f.cleanup?.();
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  process.stdout.write(JSON.stringify({
    out: OUT,
    error: report.error || null,
    cases: report.cases.map(r => ({
      label: r.label, requested: r.requested, accepted: r.accepted,
      beforeState: r.beforeState, afterState: r.afterState, afterChars: r.afterChars,
      draftChanged: r.draftChanged, resultOk: r.resultOk, reason: r.resultReason, error: r.error
    }))
  }, null, 1) + '\n');
  process.exit(0);
})().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exit(1); });
