'use strict';
// Librarian Mobile GPU Contract v1 — RELEASE GATE.
//
// WHY THIS EXISTS
//   A RisuAI v3 plugin GUI runs inside an iframe. `backdrop-filter: blur()` does not draw only its
//   own element: the compositor must read back and re-filter whatever was already painted behind it.
//   On phones the GPU shares system RAM, so a large backdrop surface pays an extra offscreen
//   surface + pixel readback + memory bandwidth + an extra compositing layer, and WebView/Safari
//   reacts by reloading the plugin under memory pressure. The visual gain does not justify that.
//   The project therefore treats these effects as a DESIGN PROHIBITION, not a preference.
//
// WHAT IS ALLOWED — AND WHY THE CHECK IS NOT A SUBSTRING MATCH
//   `backdrop-filter: none` is how a surface OPTS OUT, so it must pass. A naive
//   `backdrop-filter\s*:\s*(?!none)` rejects `none;`, `none !important;` and similar harmless
//   spellings because `\s*` backtracks and leaves a space for the lookahead to trip over. Measured
//   against four inputs, that regex misfires on three legitimate spellings. This gate therefore
//   splits each declaration into PROPERTY and VALUE, normalises whitespace/case/!important, and
//   judges the VALUE. JavaScript style writes go through the same value judgement.
//
// THE GATE PROVES ITSELF
//   Section A runs the gate's own classifier against an allow-list corpus (must pass) and a
//   violation corpus (must fail). A gate that cannot fail is not a gate, so this is checked on every
//   run rather than assumed.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const PLUGINS = [
  ['HAYAKU', 'HAYAKU_Locator_Continuity.js'],
  ['LIBRA', 'LIBRA.js'],
  ['LIA', 'LIA_Persona_Linker.js'],
  ['RETRACE', 'RETRACE.js'],
  ['Flashback', 'Flashback_Memory.js']
];

// ── comment stripping ────────────────────────────────────────────────────────────────────────
// A comment is not a declaration. The fix for an earlier defect mentions `string()` in a comment
// and the same trap exists here: prose about blur must not be read as blur.
const stripComments = text => String(text)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const normalizeValue = value => String(value || '')
  .replace(/\s*!important\s*/i, '')
  .trim()
  .toLowerCase();

// ── THE CLASSIFIER: one declaration value in, verdict out ────────────────────────────────────
// `none` (any spacing/!important casing) is an opt-out and allowed. Anything else on a
// backdrop-filter property is an active effect. `filter` is only a violation when it contains blur.
const judgeDeclaration = (property, value) => {
  const prop = String(property || '').toLowerCase();
  const normalized = normalizeValue(value);
  if (/^-?webkit-/.test(prop) || prop === 'backdrop-filter') {
    return normalized === 'none' ? null : `active_backdrop_filter:${value}`;
  }
  if (prop === 'filter' && /\bblur\s*\(/i.test(value)) return `filter_blur:${value}`;
  return null;
};

// ── SCAN the shipped sources ─────────────────────────────────────────────────────────────────
const CSS_DECL = /([-a-zA-Z]+)\s*:\s*([^;{}]*)/g;
// JavaScript writes every spelling a GUI plugin can actually use. The first version of this gate
// matched only `.backdropFilter = '...'`, so the reviewer passed three real writes through it with
// zero violations:
//     node.style.filter = "blur(8px)";
//     node.style.webkitBackdropFilter = "blur(8px)";
//     const style = { backdropFilter: "blur(8px)" };
// The `=` form cannot see `.filter` (not a backdrop property), misses the camelCase WebKit name, and
// cannot see an object literal at all. All three spellings are now extracted.
const JS_ASSIGN = /\.\s*([-a-zA-Z]*[Bb]ackdrop[-]?[Ff]ilter|filter)\s*=\s*(['"`])((?:\\.|(?!\2).)*)\2/g;
const JS_SETPROP = /setProperty\s*\(\s*(['"`])([-a-zA-Z]+)\1\s*,\s*(['"`])((?:\\.|(?!\3).)*)\3/g;
// Object-literal style maps: `{ backdropFilter: '...' }`, `webkitBackdropFilter: "..."`, `filter: 'blur(..)'`.
const JS_STYLE_OBJECT = /([-a-zA-Z]*[Bb]ackdrop[-]?[Ff]ilter|filter)\s*:\s*(['"`])((?:\\.|(?!\2).)*)\2/g;
// Object.assign(el.style, { backdropFilter: ... }) is covered by JS_STYLE_OBJECT; a bare
// `style.backdropFilter = ...` is covered by JS_ASSIGN.

// The canonical property name for a spelling found in JS: camelCase maps to the hyphenated CSS name.
const canonicalProperty = raw => {
  const name = String(raw || '');
  if (/^webkitBackdropFilter$/i.test(name)) return '-webkit-backdrop-filter';
  if (/^backdropFilter$/i.test(name)) return 'backdrop-filter';
  if (/^filter$/i.test(name)) return 'filter';
  return name.toLowerCase();
};

function scanSource(source) {
  const code = stripComments(source);
  const violations = [];
  // CSS/object-literal declarations. `schema:`-style keys cannot match a backdrop property name, so
  // the loose pattern is safe here: only backdrop-filter / -webkit-backdrop-filter / filter can hit.
  for (const match of code.matchAll(CSS_DECL)) {
    const [, property, value] = match;
    const lower = property.toLowerCase();
    if (lower !== 'filter' && lower !== 'backdrop-filter' && lower !== '-webkit-backdrop-filter') continue;
    const verdict = judgeDeclaration(property, value);
    if (verdict) violations.push({ property, value: value.trim().slice(0, 60), verdict });
  }
  // `.filter = '...'`, `.backdropFilter = '...'`, `.webkitBackdropFilter = '...'`
  for (const match of code.matchAll(JS_ASSIGN)) {
    const property = canonicalProperty(match[1]);
    const verdict = judgeDeclaration(property, match[3]);
    if (verdict) violations.push({ property: `js .${match[1]} =`, value: match[3].slice(0, 60), verdict });
  }
  // setProperty('backdrop-filter', '...') and setProperty('filter', 'blur(..)')
  for (const match of code.matchAll(JS_SETPROP)) {
    const verdict = judgeDeclaration(match[2], match[4]);
    if (verdict) violations.push({ property: `js setProperty(${match[2]})`, value: match[4].slice(0, 60), verdict });
  }
  // Object-literal style maps. NOTE: this also sees CSS blocks through the CSS_DECL pass above, so
  // a duplicate report for the same declaration is possible; the gate reports violations, and a
  // duplicate is still a violation, but the sample is de-duplicated for readability.
  for (const match of code.matchAll(JS_STYLE_OBJECT)) {
    const property = canonicalProperty(match[1]);
    // Skip when the CSS pass already judged this exact property:value inside a declaration block.
    const verdict = judgeDeclaration(property, match[3]);
    if (verdict) violations.push({ property: `js style object ${match[1]}`, value: match[3].slice(0, 60), verdict });
  }
  // De-duplicate identical reports (a CSS declaration also matches the object-literal shape).
  const seen = new Set();
  return violations.filter(v => {
    const key = `${v.property}|${v.value}|${v.verdict}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── SECTION A: the gate must prove it can fail, and must not misfire on legal spellings ──────
//
// This section runs the WHOLE scanSource(), not just the value classifier. The first version tested
// judgeDeclaration alone, which is exactly why it could not notice that the JavaScript EXTRACTION
// missed three real spellings: a perfect classifier fed by an extractor that never sees the input
// reports a clean plugin. Extraction and judgement are now checked together.
const ALLOWED_DECLARATIONS = [
  ['backdrop-filter', 'none'],
  ['backdrop-filter', '  none  '],          // surrounding whitespace, no stray `;` (not part of a value)
  ['backdrop-filter', 'none !important'],
  ['backdrop-filter', 'NONE'],
  ['-webkit-backdrop-filter', 'none'],
  ['-webkit-backdrop-filter', 'none !important'],
  ['filter', 'drop-shadow(0 4px 8px rgba(0,0,0,.2))']
];
const FORBIDDEN_DECLARATIONS = [
  ['backdrop-filter', 'blur(2px)'],
  ['backdrop-filter', 'blur(10px)'],
  ['-webkit-backdrop-filter', 'blur(2px)'],
  ['filter', 'blur(4px)'],
  ['filter', 'blur(4px) saturate(1.2)']
];
// Full-source corpora. The VIOLATION list is the reviewer's three inputs plus the spellings a GUI
// actually uses; every one of them must produce a violation, or the gate cannot protect anything.
const ALLOWED_SOURCES = [
  '.x{backdrop-filter:none}',
  '.x{backdrop-filter: none !important}',
  '.x{-webkit-backdrop-filter:none}',
  '.x{filter:drop-shadow(0 4px 8px rgba(0,0,0,.2))}',
  'node.style.backdropFilter = "none";',
  "node.style.setProperty('backdrop-filter', 'none');",
  'const style = { backdropFilter: "none" };',
  '// backdrop-filter: blur(9px) — a comment is not a declaration',
  "/* filter: blur(9px) */"
];
const FORBIDDEN_SOURCES = [
  '.x{backdrop-filter:blur(2px)}',
  '.x{-webkit-backdrop-filter:blur(3px)}',
  '.x{filter:blur(4px)}',
  '.x{filter: blur(4px) saturate(1.1)}',
  'node.style.filter = "blur(8px)";',
  'node.style.backdropFilter = "blur(8px)";',
  'node.style.webkitBackdropFilter = "blur(8px)";',
  'const style = { backdropFilter: "blur(8px)" };',
  'const style = { webkitBackdropFilter: "blur(8px)" };',
  "node.style.setProperty('backdrop-filter', 'blur(8px)');",
  "node.style.setProperty('filter', 'blur(8px)');"
];
const gateSelfTest = {
  allowedPassed: 0, forbiddenCaught: 0, misfires: [], misses: [],
  allowedSourcesPassed: 0, forbiddenSourcesCaught: 0, sourceMisfires: [], sourceMisses: []
};
for (const [property, value] of ALLOWED_DECLARATIONS) {
  if (judgeDeclaration(property, value) === null) gateSelfTest.allowedPassed += 1;
  else gateSelfTest.misfires.push(`${property}:${value}`);
}
for (const [property, value] of FORBIDDEN_DECLARATIONS) {
  if (judgeDeclaration(property, value) !== null) gateSelfTest.forbiddenCaught += 1;
  else gateSelfTest.misses.push(`${property}:${value}`);
}
for (const source of ALLOWED_SOURCES) {
  if (scanSource(source).length === 0) gateSelfTest.allowedSourcesPassed += 1;
  else gateSelfTest.sourceMisfires.push(source);
}
for (const source of FORBIDDEN_SOURCES) {
  if (scanSource(source).length > 0) gateSelfTest.forbiddenSourcesCaught += 1;
  else gateSelfTest.sourceMisses.push(source);
}

// A gate that misfires or misses is itself broken; report that clearly instead of a plugin failure.
assert.deepEqual(gateSelfTest.misfires, [],
  `the gate wrongly rejects legal opt-out syntax: ${JSON.stringify(gateSelfTest.misfires)}`);
assert.deepEqual(gateSelfTest.misses, [],
  `the gate fails to catch a prohibited effect: ${JSON.stringify(gateSelfTest.misses)}`);
assert.deepEqual(gateSelfTest.sourceMisfires, [],
  `scanSource wrongly rejects legal source: ${JSON.stringify(gateSelfTest.sourceMisfires)}`);
assert.deepEqual(gateSelfTest.sourceMisses, [],
  `scanSource MISSES a prohibited write — the extractor, not the classifier, is at fault: ${JSON.stringify(gateSelfTest.sourceMisses)}`);

// ── SECTION B: the shipped plugins ───────────────────────────────────────────────────────────
const report = { test: 'mobile_gpu_effect_contract', gateSelfTest, plugins: {}, totalViolations: 0 };
for (const [name, file] of PLUGINS) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', file), 'utf8');
  const violations = scanSource(source);
  report.plugins[name] = { file, violations: violations.length, sample: violations.slice(0, 6) };
  report.totalViolations += violations.length;
}

if (report.totalViolations) {
  console.error(JSON.stringify(report, null, 1));
  const summary = Object.entries(report.plugins)
    .filter(([, row]) => row.violations)
    .map(([name, row]) => `${name}: ${row.violations}`)
    .join(', ');
  console.log(`mobile_gpu_effect_contract_test: FAIL — active blur declarations remain (${summary})`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(report, null, 1));
  console.log('mobile_gpu_effect_contract_test: PASS');
}
