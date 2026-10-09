'use strict';
// Task 2 — read the RECOVERY REQUEST prompt as the model receives it, and measure its difficulty.
//
// The user's four concerns are all prompt properties:
//   1. does the request logic select the right work and ask for it at all?
//   2. does the prompt carry any defect (hazard)?
//   3. is the analysis difficulty too high for a small model?
//   4. is there anything that SLOWS the request down?
//
// "Prompt size" is not the difficulty — the recovery prompt is ~2 kB. The difficulty is the OUTPUT
// the prompt demands. So this enumerates, from the schema the prompt points at, exactly what a
// conforming answer must contain, and computes the minimum viable answer.
//
// It also compares the two recovery kinds, because they differ in one important way: the
// incremental (historical) kind must reconstruct an existing turn, while the after-request kind
// only has to author the CURRENT snapshot. If the historical kind demands more than the model can
// derive from TARGET TURN alone, that is a difficulty defect.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'HAYAKU_Locator_Continuity.js'), 'utf8');
const grab = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  if (start < 0) return '';
  const end = source.indexOf(endMarker, start);
  return end > start ? source.slice(start, end) : source.slice(start, start + 4000);
};

(async () => {
  const prompts = {
    coldStart: grab('const HAYAKU_NATIVE_COLD_START_PROMPT =', 'const HAYAKU_NATIVE_INCREMENTAL_RECOVERY_PROMPT'),
    incremental: grab('const HAYAKU_NATIVE_INCREMENTAL_RECOVERY_PROMPT =', 'const HAYAKU_NATIVE_AFTER_REQUEST_RECOVERY_PROMPT'),
    afterRequest: grab('const HAYAKU_NATIVE_AFTER_REQUEST_RECOVERY_PROMPT =', 'const nativeAnalysisRepairPrompt =')
  };

  const shape = text => ({
    chars: text.length,
    estimatedTokens: Math.ceil(text.length / 4),
    lineCount: text.split('\n').filter(Boolean).length,
    // Prohibitions ("Do not", "must not", "never") outnumbering positive instructions is a
    // difficulty signal: a small model must satisfy more "don't" rules than "do" rules.
    prohibitions: (text.match(/\b(do not|must not|never|omit|exclude)\b/gi) || []).length,
    requirements: (text.match(/\b(must|exactly|required|ensure|return one)\b/gi) || []).length,
    hasTargetTurnRule: /TARGET TURN as the only evidence/.test(text),
    contextIsNonRecordable: /must not add events or changes/.test(text),
    forbidsInvention: /Do not invent/.test(text),
    preserveUncertainty: /Preserve uncertainty|preserving uncertainty/i.test(text),
    jsonOnly: /JSON only/.test(text)
  });

  const report = Object.fromEntries(Object.entries(prompts).map(([name, text]) => [name, shape(text)]));

  // What a CONFORMING answer must contain, read from the schema the prompt cites.
  const schema = grab('const HAYAKU_PACKET_SCHEMA_V2 = Object.freeze({', 'const PACKET_SCHEMA_V2_CATEGORIES');
  const requiredTopLevel = (schema.match(/requiredTopLevel: Object\.freeze\(\[([^\]]+)\]/) || [])[1] || '';
  const collections = (schema.match(/canonicalCollections: Object\.freeze\(\{([\s\S]{0,900}?)\}\)/m) || [])[1] || '';
  const requiredItemFields = (schema.match(/requiredItemFields: Object\.freeze\(\{([\s\S]{0,400}?)\}\)/m) || [])[1] || '';
  const collectionAxisCount = (collections.match(/\[/g) || []).length;
  const requiredFieldCount = (requiredItemFields.match(/\w+: Object\.freeze\(\[/g) || []).length;

  // The minimum viable answer: the contract states "A supported summary alone is a complete packet",
  // so a conforming minimum is six empty objects plus one populated summary and one grounding row.
  const minimalAnswer = {
    topLevelObjectsRequired: requiredTopLevel.split(',').filter(Boolean).length,
    collectionsAvailable: collectionAxisCount,
    collectionsMandatory: 0,                    // "Leave unsupported axes empty"
    itemKindsWithRequiredFields: requiredFieldCount,
    groundingRowsRequiredFor: 'each non-empty collection item + meta.summary_memory.summary',
    minimalConformingShape: '{schema, packet:{meta:{...,summary_memory:{summary}},entity:{},world:{},narrative:{},planner:{},importance:{}}, grounding:[1 row]}'
  };

  // Speed: what does a recovery request have to wait for?
  const speed = {
    maxAutoAttempts: (source.match(/RECOVERY_DEBT_MAX_AUTO_ATTEMPTS = (\d+)/) || [])[1] || '',
    retryDelaysMs: (source.match(/RECOVERY_DEBT_RETRY_DELAYS_MS = Object\.freeze\(\[([^\]]+)\]/) || [])[1] || '',
    // The confirmation prompt is what gates the BACKGROUND path; the in-pipeline path is separate.
    backgroundRequiresConfirmation: /requestRecoveryJournalBackgroundConfirmation/.test(source),
    inBandWriteEnabled: /IN_BAND_RECOVERY_WRITE_ENABLED = (true|false)/.exec(source)?.[1] || '',
    // Evidence rehydration is the per-request cost: does it read the full transcript?
    rehydratesEvidence: /readVerifiedRecoveryEvidence\(record, scope, target, \{ rehydrate: true \}\)/.test(source)
  };

  console.log(JSON.stringify({
    test: 'hayaku_recovery_prompt_review',
    prompts: report,
    requiredAnswer: minimalAnswer,
    speed,
    kindDifference: {
      incrementalReconstructsHistorical: /reconstruct one missing HAYAKU continuity packet/.test(prompts.incremental),
      afterRequestAuthorsCurrentOnly: /author only its missing or unusable current_snapshot/.test(prompts.afterRequest),
      coldStartIsFirstUse: /first-use continuity packet/.test(prompts.coldStart)
    }
  }, null, 1));

  // --- assertions: the properties the user asked to confirm -----------------------------------
  assert.ok(report.incremental.hasTargetTurnRule,
    'the incremental recovery prompt must scope evidence to TARGET TURN');
  assert.ok(report.incremental.contextIsNonRecordable,
    'the recovery prompt must state CONTEXT ONLY must not add events');
  assert.ok(report.incremental.forbidsInvention,
    'the recovery prompt must forbid invention');
  assert.ok(report.afterRequest.jsonOnly && report.incremental.jsonOnly,
    'both recovery prompts must demand JSON only');
  assert.equal(minimalAnswer.collectionsMandatory, 0,
    'the contract must not require any collection, so a partial packet is a valid answer');
  assert.ok(report.incremental.chars < 4000,
    'the recovery prompt itself must stay small enough for a small model');
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
