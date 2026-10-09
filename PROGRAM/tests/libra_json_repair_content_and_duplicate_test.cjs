'use strict';
// DEFECTS 3 & 4 REGRESSION — the JSON repair ladder must fix SYNTAX without rewriting CONTENT,
// and the duplicate-key contract must hold for every key spelling the ladder accepts.
//
// MEASURED DEFECTS (before this fix):
//   #3 content rewrite : {"draft":"True North / None / False / a,}"} came back as
//                        "true North / null / false / a}" — the body was silently altered.
//                        The same happened to canonical quotes, which later evidence checks drop.
//   #4 duplicate hole  : the scanner only recognised "double-quoted" keys, so
//                        {facts:[],facts:[1]} and {'facts':[],'facts':[1]} were accepted and
//                        collapsed to {"facts":[1]}; a conflicting {ok:false,ok:true} passed as ok:true.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PROGRAM = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(PROGRAM, 'plugins', 'LIBRA.js'), 'utf8');

// Extract the repair helpers verbatim so the test exercises the SHIPPED code, not a copy.
const lines = source.split('\n');
const blockOf = name => {
  for (let i = 0; i < lines.length; i += 1) {
    if (!new RegExp('^\\s*const ' + name + '\\s*=').test(lines[i])) continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    const out = [lines[i]];
    for (let j = i + 1; j < Math.min(i + 200, lines.length); j += 1) {
      const lj = lines[j];
      if (lj.trim() && (lj.length - lj.trimStart().length) <= indent && /^\s*const \w+\s*=/.test(lj)) break;
      out.push(lj);
      if (lj.trim() === '};' && (lj.length - lj.trimStart().length) === indent) break;
    }
    return out.join('\n');
  }
  throw new Error(`helper not found: ${name}`);
};

// `text` lives in an OUTER scope than the repair helpers and is not among them, but `stripCodeFence`
// calls it. Without it the sandbox raises "text is not defined" the moment a case reaches the fence
// stripper — which is why the cases below must extract it explicitly.
//
// It cannot go through `blockOf`: other scopes contain unrelated `const text = ...` lines (one at the
// top of a loop body), and matching those produced a `SyntaxError` in the sandbox. The arrow form is
// matched exactly instead.
const textBlock = (() => {
  const i = lines.findIndex(line => /^\s*const text = \(value\) => \{/.test(line));
  if (i < 0) throw new Error('helper not found: text (arrow form)');
  const indent = lines[i].length - lines[i].trimStart().length;
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length; j += 1) {
    out.push(lines[j]);
    if (lines[j].trim() === '};' && (lines[j].length - lines[j].trimStart().length) === indent) break;
  }
  return out.join('\n');
})();
// Order matters: `jsonRepairLadder` must be defined before `relaxedJsonParse` calls it.
const helperNames = ['extractJsonObjectString', 'stripCodeFence', 'extractLooseJsonObjectString',
  'escapeJsonStringControlChars', 'quoteBareJsonKeys', 'singleQuotedJsonStrings',
  'repairInvalidJsonStringEscapes', 'transformJsonOutsideStrings', 'jsonRepairCandidates',
  'unwrapRawJsonFraming', 'closeUnbalancedJsonObject', 'jsonRepairLadder', 'relaxedJsonParse'];
const helpers = [textBlock, ...helperNames.map(blockOf)].join('\n');
const sandboxSrc = `${helpers}\n({ jsonRepairCandidates, relaxedJsonParse, unwrapRawJsonFraming, closeUnbalancedJsonObject });`;
const { jsonRepairCandidates, relaxedJsonParse, unwrapRawJsonFraming, closeUnbalancedJsonObject } =
  vm.runInNewContext(sandboxSrc, { JSON, String, Set, Math, RegExp, Number });

// The duplicate scanner lives inside LibraMemoryCore, so pull just that function out too.
const dupBlock = blockOf('canonicalJsonHasDuplicateKeys');
const dupSrc = `${dupBlock}\n({ canonicalJsonHasDuplicateKeys });`;
const { canonicalJsonHasDuplicateKeys } = vm.runInNewContext(dupSrc, { JSON, String, Set, Math, RegExp, Number });

// §2 must be judged through the PRODUCT's own parser, not by re-assembling the ladder here. Measured: a
// re-assembly that called the sandbox's `closeUnbalancedJsonObject` directly kept passing when the
// product's own closure branch was disabled, because it never exercised the product's wiring. The parser
// and everything it calls are extracted verbatim instead.
// The parser calls a handful of small shared helpers; each is listed explicitly so a missing one fails
// loudly at extraction time instead of surfacing later as `is not defined` (measured: that turned two of
// the control cases into false rejections).
const sgaDeps = ['string', 'compact', 'isPlainObject', 'asArray', 'sgaArtifactStrings',
  ...helperNames.filter(n => n !== 'text')];
const sgaSrc = [
  `const SGA_ARTIFACT_MAX_CHARS = ${1_000_000};`,
  textBlock,
  dupBlock,
  sgaDeps.map(blockOf).join('\n'),
  blockOf('SGA_ARTIFACT_META_LEAK_PATTERN'),
  blockOf('closeOpenJsonDelimiters'),
  blockOf('parseStrictSgaArtifactJson'),
  '({ parseStrictSgaArtifactJson });'
].join('\n');
const { parseStrictSgaArtifactJson } = vm.runInNewContext(sgaSrc, { JSON, String, Set, Math, RegExp, Number });

const firstParsable = variants => {
  for (const v of variants) {
    try { const parsed = JSON.parse(v); if (parsed && typeof parsed === 'object') return { variant: v, parsed }; } catch (_) {}
  }
  return null;
};

const rows = [];

// ── #3: content must survive a syntax-only repair ────────────────────────────────────────
const bodies = ['True North', 'None of the above', 'False alarm', 'a,}', "it's \"quoted\""];
rows.push({
  check: 'string bodies are not rewritten by repair',
  cases: bodies.map(text => {
    const doc = JSON.stringify({ draft: text, note: 'x' });
    const withTrailingComma = doc.replace(/}$/, ',}');   // the ONLY defect
    const hit = firstParsable(jsonRepairCandidates(withTrailingComma));
    return { text, repaired: hit ? hit.parsed.draft : null, preserved: hit ? hit.parsed.draft === text : false };
  })
});

// The exact document the review used, through the SGA-shaped parser input.
rows.push({
  check: 'SGA-shaped draft body preserved',
  input: '{"schema":"libra.sga_length_correction.v2","ok":true,"draft":"True North / None / False / a,}",}',
  result: (() => {
    const hit = firstParsable(jsonRepairCandidates('{"schema":"libra.sga_length_correction.v2","ok":true,"draft":"True North / None / False / a,}",}'));
    return hit ? { draft: hit.parsed.draft, preserved: hit.parsed.draft === 'True North / None / False / a,}' } : null;
  })()
});

// ── #4: duplicate detection for every key spelling ───────────────────────────────────────
const dupCases = [
  { label: 'double-quoted (was already caught)', json: '{"facts":[],"facts":[1]}', expectDuplicate: true },
  { label: 'bare keys', json: '{facts:[],facts:[1]}', expectDuplicate: true },
  { label: 'single quotes', json: "{'facts':[],'facts':[1]}", expectDuplicate: true },
  { label: 'conflicting ok (bare)', json: '{schema:"libra.sga_length_correction.v2",ok:false,ok:true,draft:"complete"}', expectDuplicate: true },
  { label: 'CONTROL: distinct keys', json: '{facts:[],notes:[1]}', expectDuplicate: false },
  { label: 'CONTROL: same key in SIBLING objects', json: '{"a":{"k":1},"b":{"k":2}}', expectDuplicate: false },
  { label: 'CONTROL: key inside a string value', json: '{"text":"facts:[] facts:[1]"}', expectDuplicate: false },
  { label: 'smart double-quoted value with escaped ASCII quotes', json: '{“draft”:“ascii \\"quote\\" preserved”}', expectDuplicate: false },
  { label: 'smart single-quoted value with ASCII quote body', json: '{‘draft’:‘ascii "quote" preserved’}', expectDuplicate: false },
  { label: 'smart nested duplicate key', json: '{“outer”:{“k”:1,“k”:2}}', expectDuplicate: true },
  { label: 'encoded ASCII key conflicts with smart key', json: '{"o\\u006b":false,“ok”:true}', expectDuplicate: true },
  { label: 'unclosed smart value remains fail-closed', json: '{“draft”:“CUT', expectDuplicate: true }
];
rows.push({
  check: 'duplicate keys detected for every spelling',
  cases: dupCases.map(c => ({
    label: c.label,
    detected: canonicalJsonHasDuplicateKeys(c.json),
    expected: c.expectDuplicate,
    ok: canonicalJsonHasDuplicateKeys(c.json) === c.expectDuplicate
  }))
});

// ── §1 (COMBINED_REVIEW_20260922): closure repair must judge the WHOLE answer ─────────────────────
//
// The first version of the closure repair ran its coverage guard on the loose extractor's output, which
// had already been cut at the last `}`. A truncated answer therefore lost its tail BEFORE the comparison,
// and all three trims below were accepted. `relaxedJsonParse` now unwraps framing explicitly and judges
// the original text, so genuine completion is accepted and truncation is refused.
const closureCases = [
  { label: 'CONTROL complete but unclosed', raw: '{"ok":true,"meta":{}', expectParsed: true },
  { label: 'CONTROL complete but unclosed, nested', raw: '{"ok":true,"meta":{"a":{"b":1}}', expectParsed: true },
  { label: 'CONTROL fenced complete object', raw: '```json\n{"ok":true,"meta":{}}\n```', expectParsed: true },
  { label: 'CONTROL prose-wrapped complete object', raw: 'Here you go:\n{"ok":true,"meta":{}}\nDone.', expectParsed: true },
  { label: 'truncated mid-string', raw: '{"ok":true,"meta":{},"body":"CUT', expectParsed: false },
  { label: 'truncated after a comma', raw: '{"ok":true,"meta":{},', expectParsed: false },
  { label: 'truncated mid-key', raw: '{"ok":true,"meta":{},"bo', expectParsed: false },
  { label: 'truncated inside a fence', raw: '```json\n{"ok":true,"meta":{},"body":"CUT\n```', expectParsed: false }
];
rows.push({
  check: 'closure repair accepts completion and refuses truncation',
  cases: closureCases.map(c => {
    const parsed = relaxedJsonParse(c.raw);
    return { label: c.label, parsed: parsed !== null, expected: c.expectParsed, ok: (parsed !== null) === c.expectParsed };
  })
});

// ── §2 (COMBINED_REVIEW_20260922): the duplicate re-scan must walk the SAME ladder ────────────────
//
// `parseStrictSgaArtifactJson` accepts a repaired answer and then re-scans for duplicate keys, but that
// re-scan only ran the jsonRepairCandidates ladder — not the closure branch that actually produced the
// accepted value. A smart-quoted duplicate plus an unclosed brace therefore slipped through the scanner
// and parsed as `{ok:true,meta:{}}`. The closure variants are now part of the ladder that gets scanned.
// The documents below must differ ONLY in the duplicate-key property. The parser also enforces schema and
// stage, so `expectRejected` is read as "rejected for a duplicate" and any OTHER error (schema mismatch,
// missing member) is treated as an incomplete control, not as detection.
const SGA_SCHEMA = 'libra.sga_character_aide.v1';
const SGA_STAGE = 'sga_character_aide';
const sgaDoc = fields => `{${fields}}`;
const duplicateThroughLadder = [
  // The reviewer's EXACT counterexample. It carries no `schema`/`stage`, so the schema-based contract
  // would reject it before the duplicate path is reached and the case would prove nothing; it is judged
  // with an empty contract instead. Measured: at cd9238e this document was ACCEPTED as `{ok:true,meta:{}}`,
  // and it is rejected only because the closure repair's variant is now part of the duplicate re-scan —
  // removing that variant from the ladder makes the acceptance come back.
  { label: 'REVIEWER §2 counterexample (smart quotes, unclosed, no schema)', raw: '{“ok”:false,“ok”:true,"meta":{}', expectRejected: true, contract: {} },
  { label: 'CONTROL plain duplicate', raw: sgaDoc('"schema":"libra.sga_character_aide.v1","stage":"sga_character_aide","ok":false,"ok":true'), expectRejected: true },
  { label: 'CONTROL distinct keys', raw: sgaDoc('"schema":"libra.sga_character_aide.v1","stage":"sga_character_aide","ok":true'), expectRejected: false },
  { label: 'smart-quoted duplicate + unclosed', raw: '{“schema”:“libra.sga_character_aide.v1”,“stage”:“sga_character_aide”,“ok”:false,“ok”:true', expectRejected: true },
  { label: 'bare duplicate + unclosed', raw: '{schema:"libra.sga_character_aide.v1",stage:"sga_character_aide",ok:false,ok:true', expectRejected: true },
  { label: 'single-quoted duplicate + unclosed', raw: "{'schema':'libra.sga_character_aide.v1','stage':'sga_character_aide','ok':false,'ok':true", expectRejected: true },
  { label: 'CONTROL complete unclosed answer', raw: '{"schema":"libra.sga_character_aide.v1","stage":"sga_character_aide","ok":true', expectRejected: false }
];
rows.push({
  check: 'the product SGA parser refuses a duplicate key reached through the closure repair',
  cases: duplicateThroughLadder.map(c => {
    // Call the product parser exactly as the product does. A duplicate must surface as the product's own
    // error, so a disabled closure branch — which parses the same document WITHOUT the duplicate being
    // visible to the scanner — shows up here as an accepted value instead.
    let accepted = null;
    let error = '';
    try {
      accepted = parseStrictSgaArtifactJson(c.raw, c.contract || {
        schema: SGA_SCHEMA, stage: SGA_STAGE,
        allowed: ['schema', 'stage', 'ok'], required: ['schema', 'stage', 'ok']
      });
    } catch (thrown) { error = String(thrown?.message || thrown); }
    // A duplicate rejection is the product's own `sga_artifact_duplicate_key`. Anything else means the
    // document never reached the duplicate scan, so it is NOT counted as detection.
    const duplicateRejected = error.startsWith('sga_artifact_duplicate_key');
    const otherRejection = accepted === null && !duplicateRejected;
    return {
      label: c.label, accepted: accepted !== null, error,
      duplicateRejected, otherRejection,
      rejected: duplicateRejected,
      expected: c.expectRejected, ok: duplicateRejected === c.expectRejected
    };
  })
});

// A smart-quoted artifact has exactly the same closure contract as an ASCII-quoted one.
// In particular, a literal brace in its draft is content, not a structural delimiter.
const smartQuoteClosureCases = [
  {
    label: 'smart-quoted complete draft with literal closing brace and one missing outer brace',
    raw: '{“schema”:“libra.sga_character_aide.v1”,“stage”:“sga_character_aide”,“ok”:true,“draft”:“literal } brace”,“meta”:{}',
    expectedDraft: 'literal } brace'
  },
  {
    label: 'smart apostrophe remains ordinary draft content during smart-quote closure',
    raw: '{“schema”:“libra.sga_character_aide.v1”,“stage”:“sga_character_aide”,“ok”:true,“draft”:“don’t close } this string”,“meta”:{}',
    expectedDraft: 'don’t close } this string'
  },
  {
    label: 'paired smart single quotes close without counting a draft brace',
    raw: '{‘schema’:‘libra.sga_character_aide.v1’,‘stage’:‘sga_character_aide’,‘ok’:true,‘draft’:‘literal } brace’,‘meta’:{}',
    expectedDraft: 'literal } brace'
  }
];
rows.push({
  check: 'smart-quoted SGA closure preserves literal braces and typographic apostrophes',
  cases: smartQuoteClosureCases.map(c => {
    try {
      const parsed = parseStrictSgaArtifactJson(c.raw, {
        schema: SGA_SCHEMA, stage: SGA_STAGE,
        allowed: ['schema', 'stage', 'ok', 'draft', 'meta'],
        required: ['schema', 'stage', 'ok', 'draft', 'meta']
      });
      return { label: c.label, accepted: true, draft: parsed.draft, expectedDraft: c.expectedDraft, error: '' };
    } catch (error) {
      return { label: c.label, accepted: false, draft: '', expectedDraft: c.expectedDraft, error: String(error?.message || error) };
    }
  })
});

const smartEscapedQuoteSgaCases = [
  {
    label: 'smart double quotes preserve escaped ASCII quotes with a missing outer brace',
    raw: '{“schema”:“libra.sga_character_aide.v1”,“stage”:“sga_character_aide”,“ok”:true,“draft”:“ascii \\"quote\\" preserved”,“meta”:{}',
    expectedDraft: 'ascii "quote" preserved'
  },
  {
    label: 'smart double quotes preserve escaped ASCII quotes when complete',
    raw: '{“schema”:“libra.sga_character_aide.v1”,“stage”:“sga_character_aide”,“ok”:true,“draft”:“ascii \\"quote\\" preserved”,“meta”:{}}',
    expectedDraft: 'ascii "quote" preserved'
  },
  {
    label: 'smart single quotes preserve an ASCII quote body with a missing outer brace',
    raw: '{‘schema’:‘libra.sga_character_aide.v1’,‘stage’:‘sga_character_aide’,‘ok’:true,‘draft’:‘ascii "quote" preserved’,‘meta’:{}',
    expectedDraft: 'ascii "quote" preserved'
  }
];
rows.push({
  check: 'smart-quoted SGA parser accepts escaped ASCII quote bodies without false duplicates',
  cases: smartEscapedQuoteSgaCases.map(c => {
    try {
      const parsed = parseStrictSgaArtifactJson(c.raw, {
        schema: SGA_SCHEMA, stage: SGA_STAGE,
        allowed: ['schema', 'stage', 'ok', 'draft', 'meta'],
        required: ['schema', 'stage', 'ok', 'draft', 'meta']
      });
      return { label: c.label, accepted: true, draft: parsed.draft, expectedDraft: c.expectedDraft, error: '' };
    } catch (error) {
      return { label: c.label, accepted: false, draft: '', expectedDraft: c.expectedDraft, error: String(error?.message || error) };
    }
  })
});

console.log(JSON.stringify({ rows }, null, 1));

// ── Assertions ──────────────────────────────────────────────────────────────────────────
for (const c of rows[0].cases) {
  assert.equal(c.preserved, true,
    `repair must not rewrite the string body: "${c.text}" became "${c.repaired}"`);
}
assert.equal(rows[1].result.preserved, true,
  `the SGA draft body must survive repair (got "${rows[1].result.draft}")`);
for (const c of rows[2].cases) {
  assert.equal(c.ok, true,
    `${c.label}: duplicate detection returned ${c.detected}, expected ${c.expected}`);
}
for (const c of rows[3].cases) {
  assert.equal(c.ok, true,
    `closure repair: "${c.label}" parsed=${c.parsed}, expected ${c.expected}`);
}
for (const c of rows[4].cases) {
  assert.equal(c.ok, true,
    `duplicate re-scan: "${c.label}" rejected=${c.rejected}, expected ${c.expected}`);
}
for (const c of rows[5].cases) {
  assert.equal(c.accepted, true,
    `smart-quote closure: "${c.label}" rejected: ${c.error}`);
  assert.equal(c.draft, c.expectedDraft,
    `smart-quote closure: "${c.label}" rewrote draft content`);
}
for (const c of rows[6].cases) {
  assert.equal(c.accepted, true,
    `smart escaped quote: "${c.label}" rejected: ${c.error}`);
  assert.equal(c.draft, c.expectedDraft,
    `smart escaped quote: "${c.label}" rewrote draft content`);
}

process.stdout.write('libra_json_repair_content_and_duplicate_test: PASS\n');
