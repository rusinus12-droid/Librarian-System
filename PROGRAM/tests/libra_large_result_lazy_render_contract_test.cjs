'use strict';
// Retirement + current-contract test. The legacy final-result renderer
// (`resultContentBlock`, with its inline/preview thresholds) was removed when the
// unified memory engine replaced the old retrieval pipeline (commit 9c03c35).
// What remains of the "large content must not be inserted eagerly" contract is the
// lazy details helper and the delivered-injection drawer, which only builds the
// full injected body when the user expands it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

assert.equal(source.includes('const resultContentBlock ='), false,
  'the retired legacy final-result renderer must stay removed');

const helperStart = source.indexOf('const guiLazyDetails =');
assert.notEqual(helperStart, -1, 'missing guiLazyDetails');
const helper = source.slice(helperStart, helperStart + 3000);
assert.match(helper, /buildChildren\(\)/, 'lazy details must defer child construction to a builder callback');
assert.match(helper, /hydrated/, 'lazy details must hydrate at most once');
assert.match(helper, /Gui\.renderMetrics\.detailReads/, 'lazy hydration must be measured');

const bodyAnchor = source.indexOf("text:'전체 전달 본문 보기'");
assert.notEqual(bodyAnchor, -1, 'missing full delivered-body drawer');
const line = source.slice(source.lastIndexOf('\n', bodyAnchor), source.indexOf('\n', bodyAnchor));
assert.match(line, /guiLazyDetails\(/, 'the full injected block must be a lazy details section');
assert.match(line, /\(\)\s*=>\s*\[/, 'the full injected block must be built only inside the lazy builder');
assert.match(line, /block\.length === Number\(delivery\.blockChars\)/,
  'the full body is shown only when it is exactly the delivered block');

console.log('libra_large_result_lazy_render_contract_test: PASS');
