'use strict';
// Unit-level verification of the two response-text extractors.
// We slice the EXACT source of each function out of its plugin file (so the code under
// test is byte-identical to the original), wrap it in a factory that injects its real
// dependencies, and run five inputs through each.
const fs = require('fs');

const HAYAKU = require('path').join(__dirname, '../plugins/HAYAKU_Locator_Continuity.js');
const LIBRA = require('path').join(__dirname, '../plugins/LIBRA.js');

// --- diagnostics recorder shared by both, matches the real one's call shape ---
function makeDiag() {
  const rows = new Map();
  const report = (plugin, tag, err) => {
    const id = `${plugin}:${tag}`;
    let row = rows.get(id);
    if (!row) { row = { plugin, tag, count: 0, lastMessage: '' }; rows.set(id, row); }
    row.count += 1;
    row.lastMessage = String(err && err.message != null ? err.message : err).slice(0, 300);
  };
  report.snapshot = () => [...rows.values()];
  return report;
}

// Slice a `const NAME = ...;` arrow function body out of a file by brace/paren matching.
function sliceConst(src, name) {
  const marker = 'const ' + name + ' =';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + name);
  // Walk from the start of the RHS, tracking nesting until the terminating ';' at depth 0.
  let i = src.indexOf('=', start) + 1;
  let depth = 0, inStr = null, esc = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    // skip line comments
    if (c === '/' && n === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    // skip block comments
    if (c === '/' && n === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth === 0) { return src.slice(start, i + 1); }
  }
  throw new Error('no terminator for ' + name);
}

const hSrc = fs.readFileSync(HAYAKU, 'utf8');
const lSrc = fs.readFileSync(LIBRA, 'utf8');

const hFuncSrc = sliceConst(hSrc, 'nativeLlmResponseText');
const lFuncSrc = sliceConst(lSrc, 'risuRunLlmResponseText');

// Print the exact sliced source so the report can quote it and prove byte-identity.



// Build HAYAKU extractor: deps => text
function buildHayaku(diag) {
  const text = value => String(value == null ? '' : value);      // exact copy of HAYAKU line 2483
  globalThis.__librarianDiag = diag;
  // eslint-disable-next-line no-new-func
  const factory = new Function('text', hFuncSrc + '\nreturn nativeLlmResponseText;');
  return factory(text);
}
// Build LIBRA extractor: deps => collectRisuRunLlmStream
function buildLibra(diag) {
  const collectRisuRunLlmStream = async stream => {
    // Minimal faithful drain of a ReadableStream reader -> concatenated string.
    const reader = stream.getReader();
    let out = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += typeof value === 'string' ? value : String(value ?? '');
    }
    return out;
  };
  globalThis.__librarianDiag = diag;
  const factory = new Function('collectRisuRunLlmStream', lFuncSrc + '\nreturn risuRunLlmResponseText;');
  return factory(collectRisuRunLlmStream);
}

function makeStream(chunks) {
  let i = 0;
  return {
    getReader() {
      return { read: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) };
    },
  };
}

const inputs = [
  { id: 'a', label: "success", value: { type: 'success', result: '정상 출력' } },
  { id: 'b', label: "fail(Vertex)", value: { type: 'fail', result: 'Vertex AI authentication information is missing or incomplete. Please check your settings.' } },
  { id: 'c', label: "fail(json)", value: { type: 'fail', result: '{"message":"bad request"}' } },
  { id: 'd', label: "bare string", value: '그냥 문자열' },
  { id: 'e', label: "streaming", value: null /* built per-run */ },
];

(async () => {
  const results = { hayaku: [], libra: [] };

  // HAYAKU
  {
    const diag = makeDiag();
    const fn = buildHayaku(diag);
    for (const inp of inputs) {
      const v = inp.id === 'e'
        ? { type: 'streaming', result: makeStream(['조각1', '조각2']) }
        : inp.value;
      let ret, err = null;
      try {
        // HAYAKU's extractor is synchronous; streaming is drained by the CALLER (drainUnverifiedStream),
        // so for (e) we pass the object and observe what the sync extractor does with it.
        ret = fn(v);
        if (ret && typeof ret.then === 'function') ret = await ret;
      } catch (e) { err = String(e && e.message || e); }
      results.hayaku.push({ id: inp.id, label: inp.label, returned: ret, isEmptyString: ret === '', err });
    }
    results.hayakuDiag = diag.snapshot();
  }

  // LIBRA
  {
    const diag = makeDiag();
    const fn = buildLibra(diag);
    for (const inp of inputs) {
      const v = inp.id === 'e'
        ? { type: 'streaming', result: makeStream(['조각1', '조각2']) }
        : inp.value;
      let ret, err = null;
      try {
        // LIBRA's extractor is async and collects a stream if response.getReader OR a candidate has one.
        // For (e) we pass a response whose .result is the stream (matches host streaming shape) AND
        // also test a response that itself is the stream.
        ret = await fn(v);
      } catch (e) { err = String(e && e.message || e); }
      results.libra.push({ id: inp.id, label: inp.label, returned: ret, isEmptyString: ret === '', err });
    }
    results.libraDiag = diag.snapshot();
  }

  const assert = require('node:assert/strict');
  for (const owner of ['hayaku', 'libra']) {
    const expected = ['정상 출력', '', '', '그냥 문자열', owner === 'libra' ? '조각1조각2' : ''];
    results[owner].forEach((row, index) => { assert.equal(row.err, null, owner + row.id); assert.equal(row.returned, expected[index], owner + row.id); });
    assert.equal(results[owner + 'Diag'][0].count, 2);
  }
  assert.equal(await buildLibra(makeDiag())(makeStream(['직접', '스트림'])), '직접스트림');
  process.stdout.write('===UNIT_JSON_BEGIN===\n' + JSON.stringify(results, null, 2) + '\n===UNIT_JSON_END===\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
