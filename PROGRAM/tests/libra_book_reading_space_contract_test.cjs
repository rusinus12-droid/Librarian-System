'use strict';
// The previous paper-reader shell has been replaced by the approved mockup DOM.
// Runtime visual structure and responsive behavior are exercised by the browser adoption test.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.env.LIBRA_TEST_PLUGIN || path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const between = (a, b) => {
  const i = source.indexOf(a), j = source.indexOf(b, i);
  assert.ok(i >= 0 && j > i, `missing source range: ${a} .. ${b}`);
  return source.slice(i, j);
};

const desk = between('const buildApprovedMockupDesk =', 'const buildApprovedMockupMemory =');
assert.match(desk, /class: 'spread'/);
assert.match(desk, /class: 'leaf'/);
assert.match(desk, /class: 'anno anno--final'/);
assert.match(desk, /bookFinalDeliveryView\(\)/);
assert.match(desk, /worldManagerSnapshotView\(\)/);
assert.match(desk, /const used = finalView\.rows/);
assert.match(desk, /finalView\.status === 'verified'/);
const receipt = between('const bookFinalDeliveryView =', 'const openBookFinalEvidenceDialog =');
assert.match(receipt, /LibraMemoryCore\.getLastRecallViewer\(\)/);
assert.match(receipt, /delivery\.scopeKey !== binding\.scopeKey/);
assert.match(receipt, /worldline !== binding\.worldlineId/);
assert.match(receipt, /rows\.filter\(row => row\.injected === true\)/);
assert.doesNotMatch(receipt, /LibraMemoryCore\.getLastRecall\(\)/,
  'an older successful selection must not replace the last request delivery receipt');
assert.doesNotMatch(desk, /북쪽 정원|은색 열쇠|M-25|1,248/,
  'desk content must come from the current product snapshot and delivery receipt');

const render = between('async function renderSettingsGuiOnce()', 'const hideSettingsGui =');
assert.match(render, /buildApprovedMockupDestinationDetail\(page\)/);
// Only route pages participate in route visibility; the original drawer also
// has a nested .page body and must remain visible through settings redraws.
assert.match(render, /app\.querySelectorAll\('\.page\[data-page\]'\)/);
assert.doesNotMatch(render, /app\.querySelectorAll\('\.page'\)/);
assert.match(render, /app\.querySelectorAll\('\.nav-item\[data-go\]'\)/);
assert.match(source, /const LIBRA_APPROVED_MOCKUP_STYLE =/);
assert.match(source, /const LIBRA_APPROVED_MOCKUP_APP_HTML =/);
assert.doesNotMatch(source, /\.libra-book-page\s*\{/,
  'the old paper page renderer stylesheet must not ship');
require('./helpers/libra_active_book_routes.cjs')(source);
console.log('PASS: approved mockup reading desk structure, current snapshot/recall binding, and six destination routes');
