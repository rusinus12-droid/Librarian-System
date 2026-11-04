'use strict';
// A data refresh redraws the LIA page; the person stays where they were looking.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIA_Persona_Linker.js'), 'utf8');
const at = source.indexOf('  const LIA_VIEW_SCROLLERS = ');
const end = source.indexOf('  async function refreshPreview(options = {}) {', at);
assert.ok(at > 0 && end > at, 'view position helpers exist right before refreshPreview');

let frame = null;
const box = { requestAnimationFrame: callback => { frame = callback; return 1; }, Number, Object };
vm.runInNewContext(`${source.slice(at, end)};globalThis.capture=captureLiaViewPosition;globalThis.restore=restoreLiaViewPosition;`, box);

const fakeRoot = ({ page = 'mine', scroll = {}, folds = [] }) => {
  const scrollers = new Map(Object.entries(scroll).map(([selector, top]) => [selector, { scrollTop: top }]));
  const details = folds.map(open => ({ open }));
  const active = { dataset: { page }, querySelectorAll: selector => (selector === 'details' ? details : []) };
  return {
    scrollers, details,
    querySelector: selector => (selector === '.page.is-active[data-page]' ? active : scrollers.get(selector) || null),
    querySelectorAll: selector => (selector === '.page.is-active details' ? { length: details.length, forEach: fn => details.forEach(fn) } : [])
  };
};

// The same page after a redraw: scroll and open folds come back, also once layout has settled.
const before = fakeRoot({ scroll: { '.page-body': 480, '.sidebar': 30 }, folds: [true, false] });
const position = box.capture(before);
const after = fakeRoot({ scroll: { '.page-body': 0, '.sidebar': 0 }, folds: [false, false] });
box.restore(after, position);
assert.equal(after.scrollers.get('.page-body').scrollTop, 480, 'page scroll is kept');
assert.equal(after.scrollers.get('.sidebar').scrollTop, 30, 'sidebar scroll is kept');
assert.deepEqual(after.details.map(fold => fold.open), [true, false], 'open folds are kept');
after.scrollers.get('.page-body').scrollTop = 200;
assert.equal(typeof frame, 'function', 'position is applied again after layout');
frame();
assert.equal(after.scrollers.get('.page-body').scrollTop, 480, 'a clamped position recovers after layout');

// Moving to another page starts at the top, and a changed fold list is not guessed at.
frame = null;
const other = fakeRoot({ page: 'edit', scroll: { '.page-body': 0 }, folds: [] });
box.restore(other, position);
assert.equal(other.scrollers.get('.page-body').scrollTop, 0, 'another page is not scrolled');
assert.equal(frame, null);
const changed = fakeRoot({ scroll: { '.page-body': 0 }, folds: [false] });
box.restore(changed, position);
assert.deepEqual(changed.details.map(fold => fold.open), [false], 'a different fold list stays as drawn');
assert.equal(changed.scrollers.get('.page-body').scrollTop, 480, 'scroll is still kept');

// While new data is read, the page on screen stays; the blank state is only for a first draw.
const refresh = source.slice(end, source.indexOf('\n  }\n', end));
assert.match(refresh, /const viewPosition = captureLiaViewPosition\(root\);/);
assert.match(refresh, /if \(!root\.querySelector\("\.page\[data-page\]"\)\) renderLiaPreviewState\(root\);/);
assert.match(refresh, /restoreLiaViewPosition\(root, viewPosition\);/);

console.log('lia_view_position_retained_test: PASS');
