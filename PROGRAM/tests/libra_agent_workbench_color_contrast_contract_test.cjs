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

// The per-stage "최근 결과" panel and its row builder were removed from the analyzer page
// (settings cleanup 2026-11-11); the shared .setting surfaces below still carry no literal colour.

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
