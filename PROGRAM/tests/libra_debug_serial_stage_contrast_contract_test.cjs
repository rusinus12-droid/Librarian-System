'use strict';
// Debug serial-stage summary contrast.
//
// Replaces the retired paper-scope contract: the old suite asserted literal
// ":is(.libra-book-page,.libra-book-drawer) .sga-summary-pill{...}" rules, which the
// approved GUI (5e1db38) removed together with the sga-* vocabulary. The stage summary
// now renders with the theme's own classes, so this suite checks that those classes stay
// themed (no literal ink) and that the approved tokens keep readable contrast.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const theme = require('./helpers/approved_theme_contrast.cjs');

const source = fs.readFileSync(path.resolve(__dirname, '../plugins/LIBRA.js'), 'utf8');

const sliceBetween = (start, end, label) => {
  const at = source.indexOf(start);
  assert.ok(at > 0, `${label} exists`);
  const to = source.indexOf(end, at);
  assert.ok(to > at, `${label} boundary exists`);
  return source.slice(at, to);
};

const pill = sliceBetween('const tracePill = (t) => {', '\n    };\n', 'serial-stage pill builder');

assert.ok(pill.includes('class: `chip ${state}`'), 'stage outcome keeps the themed chip class');
assert.ok(pill.includes("class: 'setting__name'"), 'stage label uses the themed label class');
assert.ok(pill.includes("class: 'badge'"), 'stage state keeps the themed state badge');
assert.ok(pill.includes("class: 'hint'"), 'stage elapsed time uses the themed hint class');
assert.ok(source.includes("text: '직렬 단계'"), 'serial-stage label stays connected to the summary rows');
assert.ok(!theme.hasLiteralColour(pill), 'stage pill markup carries no literal colour');

const tokens = theme.productTokens('libra');
for (const selector of ['.chip', '.hint', '.setting__name']) {
  const rule = theme.assetRule('suite.css', selector);
  assert.ok(!theme.hasLiteralColour(rule), `${selector} is themed, not literal: ${rule}`);
  theme.embedded(source, rule, `${selector} rule`);
}

const measured = [];
for (const [foreground, background] of [
  ['--text2', '--surface'], ['--text2', '--surface2'], ['--text3', '--surface'],
  ['--ok-ink', '--ok-soft'], ['--warn-ink', '--warn-soft'], ['--danger-ink', '--danger-soft']
]) {
  measured.push(`${foreground}/${background}=${theme.assertTokenContrast(source, tokens, foreground, background).toFixed(2)}:1`);
}

console.log(`libra_debug_serial_stage_contrast_contract_test: PASS (themed chip/badge/hint; ${measured.join(' ')})`);
