'use strict';
// HAYAKU settings easy/full view: presentation only. Every setting control stays wired,
// enum option values stay canonical while their visible text becomes Korean, and the
// view choice never changes what the draft collector would save.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const H = fs.readFileSync(path.join(__dirname, '../plugins/HAYAKU_Locator_Continuity.js'), 'utf8');
const part = (a, b) => { const i = H.indexOf(a), j = H.indexOf(b, i + a.length); assert(i >= 0 && j > i, `${a}/${b}`); return H.slice(i, j); };

const dom = new JSDOM('<!doctype html><body></body>');
const storage = new Map();
const c = vm.createContext({
  Memory: { ledgerViewer: { root: null } }, PACKET_CORE_RECALL_ROW_LIMIT: 16,
  HAYAKU_TEMPORAL_ARGUMENTS: ['hayaku_recall_short_max_age', 'hayaku_recall_medium_max_age', 'hayaku_recall_short_turn_quota', 'hayaku_recall_medium_turn_quota', 'hayaku_recall_long_turn_quota'],
  ensureArray: x => Array.isArray(x) ? x : [], text: x => String(x ?? ''), Object, Map, Set, String, Number,
  localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) }
});
c.globalThis = c;
vm.runInContext(part('const HAYAKU_MOCKUP_SETTINGS_PAGE =', 'const viewerSettingsValues =')
  + part('  const HAYAKU_SETTINGS_ESSENTIAL_ARGUMENTS =', '  const viewerRenderSettingSources =')
  + '\nObject.assign(globalThis,{HAYAKU_MOCKUP_SETTINGS_PAGE,HAYAKU_GUI_SETTING_SPECS,HAYAKU_SETTINGS_ESSENTIAL_ARGUMENTS,viewerWireSettingsMarkup,viewerInstallSettingsEasyView,viewerSetSettingsView,hayakuSettingValueLabel});', c);

const root = dom.window.document.body;
root.innerHTML = c.HAYAKU_MOCKUP_SETTINGS_PAGE;
c.Memory.ledgerViewer.root = root;
assert.equal(c.viewerWireSettingsMarkup(root).missing.length, 0, 'all settings wired before the view layer');
const before = [...root.querySelectorAll('[name]')].map(node => `${node.name}=${node.value}`).sort();
const { advanced } = c.viewerInstallSettingsEasyView(root);

const form = root.querySelector('#hayakuSettingsForm');
assert.ok(form.classList.contains('hayaku-settings-easy'), 'easy view is the default');
assert.equal(storage.get('hayaku.settingsView.v1'), 'easy');
const rows = [...form.querySelectorAll('.setting')];
const visible = rows.filter(row => !row.hasAttribute('data-hayaku-advanced')).map(row => row.querySelector('.argtag')?.textContent.trim());
assert.deepEqual(visible.sort(), Array.from(c.HAYAKU_SETTINGS_ESSENTIAL_ARGUMENTS).sort(), 'easy view keeps exactly the essential settings');
assert.equal(advanced, rows.length - visible.length);
assert.ok(form.querySelectorAll('.hayaku-easy-note').length >= 3, 'each section with hidden rows explains how to reveal them');

// Controls, names and values are unchanged; only visible text is humanized.
assert.deepEqual([...root.querySelectorAll('[name]')].map(node => `${node.name}=${node.value}`).sort(), before, 'view layer never changes control values');
const slot = form.querySelector('select[name="hayaku_packet_output_slot"]');
assert.deepEqual([...slot.options].map(o => o.value), ['auto', 'tail', 'wrapper', 'footer']);
assert.equal(slot.options[0].textContent, '자동 (본문 뒤)');
const lang = form.querySelector('select[name="hayaku_memory_language"]');
assert.deepEqual([...lang.options].map(o => o.value), ['source', 'ko', 'en', 'ja', 'zh']);
assert.equal(lang.options[1].textContent, '한국어');
assert.deepEqual([...form.querySelectorAll('[data-hayaku-mode-value]')].map(b => `${b.getAttribute('data-hayaku-mode-value')}:${b.textContent}`),
  ['auto:자동', 'fast:빠르게', 'balanced:균형', 'deep:깊게']);
assert.equal(c.hayakuSettingValueLabel('hayaku_mode', 'Balanced'), '균형');
assert.equal(c.hayakuSettingValueLabel('hayaku_mode', 'unknown_mode'), 'unknown_mode', 'unknown values are shown verbatim');

// Switching views is remembered and idempotent.
form.querySelector('[data-hayaku-settings-view="full"]').click();
assert.ok(!form.classList.contains('hayaku-settings-easy'));
assert.equal(storage.get('hayaku.settingsView.v1'), 'full');
assert.equal(form.querySelector('[data-hayaku-settings-view="full"]').getAttribute('aria-pressed'), 'true');
c.viewerInstallSettingsEasyView(root);
assert.equal(form.querySelectorAll('.hayaku-view-bar').length, 1, 'installing twice does not duplicate the toolbar');

// A fresh mount restores the remembered full view.
const second = new JSDOM('<!doctype html><body></body>').window.document.body;
second.innerHTML = c.HAYAKU_MOCKUP_SETTINGS_PAGE;
c.Memory.ledgerViewer.root = second;
c.viewerWireSettingsMarkup(second);
c.viewerInstallSettingsEasyView(second);
assert.ok(!second.querySelector('#hayakuSettingsForm').classList.contains('hayaku-settings-easy'), 'remembered view is restored');

console.log('PASS hayaku_settings_easy_view_test');
