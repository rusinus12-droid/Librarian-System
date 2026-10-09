'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

assert.match(source, /const GUI_RESULT_INLINE_CHAR_LIMIT = 48000;/,
  'large result rendering must have a bounded inline threshold');
assert.match(source, /const GUI_RESULT_PREVIEW_CHAR_LIMIT = 12000;/,
  'large result rendering must use a bounded initial preview');

const start = source.indexOf('const resultContentBlock =');
const end = source.indexOf('/* LIBRA PROMPT STUDIO OOC BUILDER START', start);
assert.notEqual(start, -1, 'missing resultContentBlock');
assert.notEqual(end, -1, 'missing resultContentBlock end marker');
const block = source.slice(start, end);
assert.match(block, /guiLazyDetails/,
  'large result content must defer full DOM insertion until the user expands it');
assert.match(block, /body\.slice\(0, GUI_RESULT_PREVIEW_CHAR_LIMIT\)/,
  'large result content must render only a preview initially');
assert.match(block, /copyTextWithFallback\(body\)/,
  'copy must preserve the complete untruncated result');

console.log('libra_large_result_lazy_render_contract_test: PASS');
