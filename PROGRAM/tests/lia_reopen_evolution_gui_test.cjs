'use strict';

// The former JSDOM selectors belonged to the retired screen. Run and assert the
// same user-visible contracts in the mounted Chromium product view instead.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '../..');
const evidence = path.join(repo, 'PROGRAM/docs/gui-redesign/verification/lia-20261013');
const browserTest = path.join(__dirname, 'browser/lia_mockup_mounted_product_browser_test.cjs');
const run = spawnSync(process.execPath, [browserTest], {
  cwd: repo,
  encoding: 'utf8',
  env: { ...process.env, LIA_CAPTURE_DIR: evidence },
});
fs.mkdirSync(evidence, { recursive: true });
for (const [suffix, content] of [['stdout.log', run.stdout || ''], ['stderr.log', run.stderr || ''], ['exit.txt', `${run.status ?? 'spawn-error'}\n`]]) {
  fs.writeFileSync(path.join(evidence, `lia-reopen-evolution-mounted.${suffix}`), content);
}
assert.equal(run.error, undefined, `mounted Chromium runner launched: ${run.error || ''}`);
assert.equal(run.status, 0, 'mounted Chromium runner passes; inspect preserved stdout/stderr');
const results = JSON.parse(fs.readFileSync(path.join(evidence, 'lia-mounted-browser-results.json'), 'utf8'));
const cases = new Map((results.legacyGuiCases || []).map(item => [item.name, item]));
for (const name of [
  'LIA repeated UI entry preserves unsaved model and shell without silently saving',
  'LIA full-chat evolution displays review in editor and never applies it automatically',
]) assert.equal(cases.get(name)?.passed, true, `mounted Chromium migration passes: ${name}`);
console.log('lia_reopen_evolution_gui_test: PASS (2 migrated contracts in mounted Chromium)');
