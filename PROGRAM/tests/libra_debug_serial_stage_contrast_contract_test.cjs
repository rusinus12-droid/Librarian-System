'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../plugins/LIBRA.js'), 'utf8');

for (const expected of [
  ':is(.libra-book-page,.libra-book-drawer) .sga-summary-panel{background:#efe3d1;border-color:#c7b394;color:#493729',
  ':is(.libra-book-page,.libra-book-drawer) .sga-summary-pill{background:#fffaf1;border-color:#baa486;color:#3b2c21',
  ':is(.libra-book-page,.libra-book-drawer) .sga-summary-pill.ok .sga-summary-state{background:#e3eadc;color:#405b40',
  ':is(.libra-book-page,.libra-book-drawer) .sga-summary-pill.fallback .sga-summary-state{background:#f1e1c6;color:#765020',
  ':is(.libra-book-page,.libra-book-drawer) .sga-summary-pill.error .sga-summary-state{background:#efdad5;color:#793f37'
]) assert.ok(source.includes(expected), `missing paper-theme debug contrast rule: ${expected}`);

assert.match(source, /class: 'sga-summary-label', text: '직렬 단계'/, 'serial-stage label remains connected to the contrast rules');
assert.match(source, /class: `sga-summary-pill \$\{state\}`/, 'stage outcome remains connected to state-specific contrast rules');

console.log('libra_debug_serial_stage_contrast_contract_test: PASS');
