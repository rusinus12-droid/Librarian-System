'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

assert.match(source, releasePattern("^\\/\\/@display-name LIBRA v{libra}\\s*$", "m"));
assert.match(source, releasePattern("^\\/\\/@version {libra}\\s*$", "m"));

const navigationQueue = between('const syncGuiNavigationFeedback =', 'const cloneJson =');
assert.match(navigationQueue, /Gui\.invalidations\.add\('body'\)/,
  'navigation replaces the main page');
assert.doesNotMatch(navigationQueue, /invalidations\.add\(['"](?:sidebar|mobile-navigation|rail)['"]\)/,
  'navigation must not remount stable navigation controls');
assert.match(navigationQueue, /syncGuiNavigationFeedback\(\);[\s\S]*cancelQueuedGuiFrame\(\);[\s\S]*setTimeout\(\(\) => \{[\s\S]*void renderSettingsGui\(\)/,
  'active feedback is committed before the body render is deferred to another task');
assert.match(navigationQueue, /navigationCoalesces/,
  'rapid navigation records coalesced work');
assert.match(navigationQueue, /const serial = \+\+Gui\.navigationRenderSerial;[\s\S]*serial !== Gui\.navigationRenderSerial/,
  'rapid navigation must coalesce stale body renders');
assert.doesNotMatch(navigationQueue, /if \(Gui\.visible\) void renderSettingsGui\(\);/,
  'large pages must not rebuild in the originating click task');
assert.match(navigationQueue, /\.sidebar button\[data-go\]/,
  'desktop sidebar selection updates in place');
assert.match(navigationQueue, /\.tabbar button\[data-go\]/,
  'mobile navigation selection updates in place');

const hubTabs = between('const syncGuiTabSelectionFeedback =', 'const canonicalReaderIdentityKey =');
assert.match(hubTabs, /syncGuiTabSelectionFeedback\(event\.currentTarget\);\s*queueGuiNavigationRender\(\);/,
  'internal tab selection changes before its page is rebuilt');
assert.match(hubTabs, /classList\.toggle\('is-on', ?active\)/);
assert.match(hubTabs, /setAttribute\('aria-selected', String\(active\)\)/);

const nativeSelectGuard = between('const nativeSelectInteractionActive =', 'const guiEl =');
assert.match(nativeSelectGuard, /pointerdown[\s\S]*keydown[\s\S]*change[\s\S]*blur/,
  'native select interaction is guarded for pointer, keyboard, commit, and dismissal paths');
assert.match(nativeSelectGuard, /nativeSelectDeferredNavigation[\s\S]*nativeSelectDeferredBodyRender[\s\S]*canonicalJobRenderDeferredForSelect/,
  'select dismissal flushes each deferred render owner exactly once');

const selectHelper = between('const selectNode =', 'const checkboxNode =');
assert.match(selectHelper, /onChange: commit/);
assert.doesNotMatch(selectHelper, /onInput: commit/,
  'native select previews must not commit and rebuild before the browser closes its popup');

const worldManagerSelect = between('const worldManagerSelect =', 'const openWorldManagerCorrectionEditor =');
assert.match(worldManagerSelect, /onChange:event=>onInput\(event\.target\.value\)/);
assert.doesNotMatch(worldManagerSelect, /onInput:/,
  'World Manager correction filters commit only on the final change event');

const canonicalJobSurface = between('function renderCanonicalJobSurface', 'function scheduleGuiTraceRefresh');
assert.match(canonicalJobSurface, /nativeSelectInteractionActive\(\) && portal\.contains\(Gui\.nativeSelectInteraction\)[\s\S]*canonicalJobRenderDeferredForSelect = true/,
  'canonical comparison refresh cannot replace an open disposition selector');

const rendererGate = between('async function renderSettingsGui()', 'async function renderSettingsGuiOnce()');
assert.match(rendererGate, /nativeSelectInteractionActive\(\)[\s\S]*nativeSelectDeferredBodyRender = true[\s\S]*return false/,
  'background or async body renders wait for an active native selector to settle');

const renderer = between('async function renderSettingsGuiOnce()', 'const hideSettingsGui = async');
assert.match(renderer, /if \(!Gui\.state\) await ensureGuiState\(\);/,
  'a hydrated GUI does not cross an async state-load boundary before navigation paint');
assert.doesNotMatch(renderer, /^\s*await ensureGuiState\(\);/m,
  'every navigation must not await an already-hydrated state');

// The prior paper hover overrides are obsolete; original approved navigation
// and chapter rules repaint colors without moving the target or adding filters.
const css=require('./helpers/libra_approved_gui_contract.cjs').literal(source,'LIBRA_APPROVED_MOCKUP_STYLE');
for(const selector of ['nav-item:hover','chapter:hover']){const rule=css.slice(css.indexOf('.'+selector),css.indexOf('}',css.indexOf('.'+selector))+1);assert.ok(rule.includes('background'),selector+' repaints a solid background');assert.doesNotMatch(rule,/transform:|filter:/,selector+' keeps pointer geometry stable');}
assert.match(source, /if \(Gui\.navigationRenderTimer\) \{ clearTimeout\(Gui\.navigationRenderTimer\); Gui\.navigationRenderTimer = null; \}/,
  'closing the GUI cancels deferred navigation work');

process.stdout.write('libra_gui_interaction_stability_contract_test: PASS\n');
