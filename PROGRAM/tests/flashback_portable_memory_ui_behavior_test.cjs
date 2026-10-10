'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js'), 'utf8');

const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.style = { cssText: '' };
    this.id = '';
    this.className = '';
    this.textContent = '';
    this.disabled = false;
    this.onclick = null;
    this.onchange = null;
    this.files = [];
    this._innerHTML = '';
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }

  appendChild(child) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  set innerHTML(value) {
    this._innerHTML = String(value || '');
    this.children = [];
    if (!this._innerHTML.includes('data-portable-backup')) return;
    const actions = this.ownerDocument.createElement('div');
    actions.className = 'portable-memory-actions';
    const backup = this.ownerDocument.createElement('button');
    backup.setAttribute('data-portable-backup', '');
    backup.textContent = '↓ JSON 백업 다운로드';
    const restore = this.ownerDocument.createElement('button');
    restore.setAttribute('data-portable-restore', '');
    restore.textContent = '↑ JSON 백업에서 복원';
    actions.appendChild(backup);
    actions.appendChild(restore);
    const input = this.ownerDocument.createElement('input');
    input.setAttribute('type', 'file');
    const status = this.ownerDocument.createElement('span');
    status.setAttribute('data-portable-status', '');
    this.appendChild(actions);
    this.appendChild(input);
    this.appendChild(status);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  matches(selector) {
    if (selector === 'button') return this.tagName === 'BUTTON';
    if (selector === '.vrmDesign') return this.className.split(/\s+/).includes('vrmDesign');
    if (selector === 'input[type=file]') return this.tagName === 'INPUT' && this.getAttribute('type') === 'file';
    const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attribute) {
      if (!this.attributes.has(attribute[1])) return false;
      return attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2];
    }
    return false;
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body', this);
    this.documentElement = this.body;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    let match = null;
    const visit = node => {
      if (match) return;
      if (node.id === id) match = node;
      for (const child of node.children) visit(child);
    };
    visit(this.body);
    return match;
  }

  querySelector(selector) {
    if (this.body.matches(selector)) return this.body;
    return this.body.querySelector(selector);
  }
}

class FakeMutationObserver {
  static latest = null;

  constructor(callback) {
    this.callback = callback;
    this.connected = true;
    FakeMutationObserver.latest = this;
  }

  observe() {}

  disconnect() {
    this.connected = false;
  }

  trigger() {
    if (this.connected) this.callback([]);
  }
}

const scheduled = new Map();
let nextTimer = 1;
const fakeSetTimeout = callback => {
  const id = nextTimer++;
  scheduled.set(id, callback);
  return id;
};
const fakeClearTimeout = id => scheduled.delete(id);
const flushTimers = () => {
  const pending = Array.from(scheduled.values());
  scheduled.clear();
  for (const callback of pending) callback();
};

const syncPortableUiStateSource = between('const syncPortableUiState = message => {', 'const setUiBusy = (busy, message = \'\') => {');
const ensureUiSource = between('const ensureUi = () => {', 'const startUiObserver = () => {');
const startObserverSource = between('const startUiObserver = () => {', 'const publicApi = Object.freeze({');
const syncPortableUiStateFactory = new Function('runtime', 'document', 'config', 'Runtime', 'textValue', `${syncPortableUiStateSource}\nreturn syncPortableUiState;`);
const ensureUiFactory = new Function('runtime', 'document', 'config', 'bindUi', 'syncPortableUiState', `${ensureUiSource}\nreturn ensureUi;`);
const startObserverFactory = new Function('runtime', 'document', 'ensureUi', 'MutationObserver', 'setTimeout', 'clearTimeout', `${startObserverSource}\nreturn startUiObserver;`);

const document = new FakeDocument();
const runtime = { unloaded: false, observer: null, uiRoot: null, input: null, busy: false };
const Runtime = { portableMemoryActiveOperationId: '', guiBusyDepth: 0, guiBusyLabel: '' };
const config = {
  uiId: 'flashback-portable-memory-backup-controls',
  pluginId: 'flashback_memory',
  rootSelectors: ['.vrmDesign']
};
let bindCount = 0;
const bindUi = root => {
  assert.ok(root.querySelector('[data-portable-backup]'));
  assert.ok(root.querySelector('[data-portable-restore]'));
  assert.ok(root.querySelector('input[type=file]'));
  bindCount += 1;
};
const syncPortableUiState = syncPortableUiStateFactory(runtime, document, config, Runtime, value => String(value || ''));
const ensureUi = ensureUiFactory(runtime, document, config, bindUi, syncPortableUiState);
const startUiObserver = startObserverFactory(runtime, document, ensureUi, FakeMutationObserver, fakeSetTimeout, fakeClearTimeout);

startUiObserver();
assert.equal(document.getElementById(config.uiId), null, 'no floating control mounts before the maintenance host exists');
assert.ok(runtime.observer, 'observer waits for the Flashback GUI mount');

const foreignGui = document.createElement('section');
foreignGui.className = 'hayaku-viewer';
const foreignHost = document.createElement('div');
foreignHost.setAttribute('data-portable-backup-host', 'hayaku_locator_continuity');
foreignGui.appendChild(foreignHost);
document.body.appendChild(foreignGui);
FakeMutationObserver.latest.trigger();
flushTimers();
assert.equal(document.getElementById(config.uiId), null, 'Flashback controls ignore the HAYAKU portable-memory host');

const mountMaintenanceGui = () => {
  const gui = document.createElement('section');
  gui.className = 'vrmDesign';
  gui.setAttribute('data-flashback-memory', 'flashback_memory');
  const host = document.createElement('div');
  host.setAttribute('data-portable-backup-host', 'flashback_memory');
  gui.appendChild(host);
  document.body.appendChild(gui);
  return { gui, host };
};

const first = mountMaintenanceGui();
FakeMutationObserver.latest.trigger();
flushTimers();
const firstControls = document.getElementById(config.uiId);
assert.ok(firstControls, 'observer mounts the portable controls after the GUI appears');
assert.equal(firstControls.parentNode, first.host, 'controls are nested in the maintenance card host');
assert.equal(firstControls.className, 'portable-memory-controls');
assert.equal(firstControls.style.cssText, '', 'dedicated controls do not use fixed body positioning');
assert.equal(document.body.children.includes(firstControls), false, 'controls are not appended directly to document.body');
assert.equal(firstControls.querySelectorAll('button').length, 2);
assert.ok(firstControls.querySelectorAll('button').every(button => button.disabled === false));
assert.equal(bindCount, 1);

Runtime.portableMemoryActiveOperationId = 'portable_restore_test';
Runtime.guiBusyDepth = 1;
Runtime.guiBusyLabel = 'JSON 기억 복원';
first.gui.remove();
const second = mountMaintenanceGui();
FakeMutationObserver.latest.trigger();
flushTimers();
const secondControls = document.getElementById(config.uiId);
assert.ok(secondControls, 'controls remount after the GUI root is rebuilt');
assert.notEqual(secondControls, firstControls);
assert.equal(secondControls.parentNode, second.host);
assert.equal(bindCount, 2);
assert.ok(secondControls.querySelectorAll('button').every(button => button.disabled === true), 'remounted controls inherit the active shared lock');
assert.equal(secondControls.querySelector('[data-portable-status]').textContent, 'JSON 기억 복원…');

Runtime.portableMemoryActiveOperationId = '';
Runtime.guiBusyDepth = 0;
Runtime.guiBusyLabel = '';
syncPortableUiState('');
assert.ok(secondControls.querySelectorAll('button').every(button => button.disabled === false), 'controls unlock after the shared operation ends');
assert.equal(secondControls.querySelector('[data-portable-status]').textContent, '');

console.log('flashback_portable_memory_ui_behavior_test: PASS');
