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

// The embedded SGA parser was removed. Retain helper closure coverage and
// exercise the current Canonical parser's own repair/duplicate wiring below.
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');

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


for(const row of rows)for(const c of row.cases || []) assert.equal(c.ok ?? c.preserved,true,JSON.stringify(c));
assert.equal(rows[1].result.preserved,true);
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
(async()=>{
 const h=await createLibraVmHarness({enable_gui:'false'});
 try {
  const parse=value=>h.api.debugParseCanonicalArtifact(value);
  for(const c of [...smartQuoteClosureCases,...smartEscapedQuoteSgaCases]){
   assert.equal(relaxedJsonParse(c.raw).draft,c.expectedDraft,c.label+' shared closure');
   assert.equal(parse(c.raw).draft,c.expectedDraft,c.label+' current Canonical parser');
  }
  for(const body of bodies.concat(['literal } brace','don’t close } this string','ascii "quote" preserved'])){
   const raw=JSON.stringify({schema:'libra.canonical_artifact.v4',draft:body,meta:{}}).replace(/}$/,',}');
   assert.equal(parse(raw).draft,body,'current product parser preserves content during syntax repair');
  }
  for(const raw of ['{"facts":[],"facts":[1]}','{facts:[],facts:[1]}',"{'facts':[],'facts':[1]}",'{“ok”:false,“ok”:true}', '{"o\\u006b":false,“ok”:true}'])
   assert.throws(()=>parse(raw),/canonical_artifact_duplicate_key/,'duplicates rejected through current product parser');
  for(const raw of ['{"a":{"k":1},"b":{"k":2}}','{facts:[],notes:[1]}',"{'facts':[],'notes':[1]}",'{“draft”:“literal } brace”}'])assert.equal(typeof parse(raw),'object');
  // Canonical framing requires a closing delimiter; nested complete values can
  // still use the shared repair ladder. This
  // differs from SGA acceptance of a trailing primitive with no closing brace.
  assert.equal(parse('{"ok":true,"meta":{}').ok,true);
  for(const raw of ['{“ok”:false,“ok”:true,"meta":{}','{"ok":true,"body":"CUT','{"ok":true,'])assert.throws(()=>parse(raw),/canonical_artifact_|typed_response_incomplete_object/);
  assert.throws(()=>parse('[1,2]'),/canonical_artifact_not_one_json_object|typed_response_/);
  assert.equal(parse('```json\n{"ok":true}\n```').ok,true);
 }finally{await h.cleanup();}
 console.log(JSON.stringify({test:'libra_json_repair_content_and_duplicate',helperCases:rows.reduce((n,r)=>n+(r.cases?.length||1),0),canonicalParser:true,retiredGap:'SGA-specific schema/stage and missing-brace parser acceptance'}));
 console.log('libra_json_repair_content_and_duplicate_test: PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
