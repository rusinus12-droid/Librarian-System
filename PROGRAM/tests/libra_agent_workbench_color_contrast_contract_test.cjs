'use strict';
// Agent workbench stage-result contrast.
//
// Replaces the retired paper-scope contract: the old suite asserted literal
// ":is(.libra-book-page,.libra-book-drawer) .sga-result-label{...}" rules and the
// sga-result-code / sga-result-value classes, all removed by the approved GUI (5e1db38).
// The workbench rows now render with the theme's own classes, so this suite checks that
// semantic labels and the distinct value/code surfaces survive, that the markup carries no
// literal ink, and that the approved tokens keep readable contrast.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const theme = require('./helpers/approved_theme_contrast.cjs');

const source = fs.readFileSync(
  process.env.LIBRA_TEST_PLUGIN ? path.resolve(process.env.LIBRA_TEST_PLUGIN) : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'),
  'utf8'
);

const sliceBetween = (start, end, label) => {
  const at = source.indexOf(start);
  assert.ok(at > 0, `${label} exists`);
  const to = source.indexOf(end, at);
  assert.ok(to > at, `${label} boundary exists`);
  return source.slice(at, to);
};

const row = sliceBetween('const resultLineNode = (label, value, options = {}) => {', '\n  };\n', 'stage result row builder');

assert.ok(row.includes("class: `setting${options.wide ? ' wide' : ''}`"), 'stage result row keeps the themed setting class');
assert.ok(row.includes("class: 'setting__name'"), 'stage result label uses the themed label class');
assert.ok(row.includes("class: options.code ? 'code' : 'setting__desc'"), 'stage result keeps distinct value/code surfaces');
assert.ok(!theme.hasLiteralColour(row), 'stage result row markup carries no literal colour');

const panel = sliceBetween('const buildStageResultPanel', 'const executionResultTracesForStage', 'stage result panel');
assert.ok(panel.includes("rows.push(resultLineNode('호출'"), 'stage result keeps semantic labels');
assert.ok(panel.includes("text: '실제 값 JSON'"), 'stage result keeps the raw JSON disclosure');

const tokens = theme.productTokens('libra');
for (const selector of ['.setting', '.setting__desc']) {
  const rule = theme.assetRule('suite.css', selector);
  assert.ok(!theme.hasLiteralColour(rule), `${selector} is themed, not literal: ${rule}`);
  theme.embedded(source, rule, `${selector} rule`);
}

const measured = [];
for (const [foreground, background] of [
  ['--text', '--surface'], ['--text', '--surface2'], ['--text2', '--surface2'], ['--text2', '--surface']
]) {
  measured.push(`${foreground}/${background}=${theme.assertTokenContrast(source, tokens, foreground, background).toFixed(2)}:1`);
}

process.stdout.write(`libra_agent_workbench_color_contrast_contract_test: PASS (themed setting/desc rows; ${measured.join(' ')})\n`);
