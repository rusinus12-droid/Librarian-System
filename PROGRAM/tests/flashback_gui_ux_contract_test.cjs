'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js'), 'utf8');
const mockup = fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'gui-redesign', 'flashback.html'), 'utf8');
const suiteCss = fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'gui-redesign', 'assets', 'suite.css'), 'utf8');
const themesCss = fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'gui-redesign', 'assets', 'themes.css'), 'utf8');
assert.ok(source.includes('const FLASHBACK_GUI_MOCKUP_STYLES ='), 'product embeds the approved mockup styles');
for (const snippet of [':root{', '.app{', '.sidebar{', '.tabbar{', '@container app (max-width:900px)', '@container app (max-width:640px)']) {
  assert.ok(suiteCss.includes(snippet), `suite mockup has required responsive rule ${snippet}`);
}
assert.ok(themesCss.includes('.t-flashback'), 'Flashback theme is included');
assert.ok(mockup.includes('data-page="lab"') && mockup.includes('data-page="vault"'), 'source mockup defines product route contract');
for (const route of ['lab', 'vault', 'care', 'connect', 'log', 'settings']) {
  assert.ok(source.includes(`data-page=\"${route}\"`), `${route} is part of the generated product GUI`);
}
assert.ok(source.includes("[['lab','eye'"), 'sidebar is assembled from the six route map');
for (const detailFlow of ['data-subtabs="v"', 'data-subtabs="c"', 'data-subtabs="l"']) {
  assert.ok(source.includes(detailFlow), `${detailFlow} preserves an explicit detail flow`);
}
assert.ok(source.includes('const hydrateFlashbackMockupIcons ='), 'mockup icons are rendered without importing demo behavior');
assert.ok(source.includes("menu.classList?.toggle('is-open', expanded)"), 'menu uses the mockup open state');
assert.ok(source.includes("backdrop.className = 'overlay is-open'"), 'confirmations use the mockup overlay surface');
assert.ok(!source.includes('vrmDialogBackdrop') && !source.includes('vrmDialogStyle'), 'old dialog skin is removed');
assert.ok(!source.includes("Runtime.guiTab || 'provider'"), 'no legacy provider fallback');
console.log('flashback_gui_ux_contract_test: PASS');
